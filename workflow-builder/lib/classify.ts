// Classification with Jev, no LLM: document + labels -> label(s) with probabilities, in one request.
//
//   single label  Choice over the labels (its distribution compares them), plus one yes/no per label
//                 that checks the winner really applies (so "none fits" is possible)
//   multi label   one yes/no per label; 0.3-0.7 is "uncertain" and goes to review

import { escalateLabel, type EscalationReport } from './escalate.ts';
import { askJev, choice, JEV_PRICE_PER_TOKEN, noul, type Question } from './jev.ts';

export const REVIEW_BELOW = 0.6;
export type Label = { label: string; description: string };
export type Classification = {
  label: string | null; // single-label: the winner (null when none applies)
  labels: string[]; // multi-label: every label that applies (single-label: [label])
  confidence: number | null;
  probabilities: Record<string, number>; // Choice distribution (single) or P(applies) per label (multi)
  applies: Record<string, number>; // P(label applies) for every label
  needs_review: boolean;
  uncertain: string[];
  by?: 'jev' | 'llm+jev';
  escalation?: EscalationReport;
  usage: { requests: number; questions: number; jev_ms: number; input_tokens: number; usd: number; model: string };
};

/** {label: description} | ["label", ...] | [{label, description}] | "a, b, c" | "a: desc\nb: desc" */
export function readLabels(raw: unknown): Label[] {
  if (typeof raw === 'string') {
    const parts = raw.includes('\n') ? raw.split('\n') : raw.split(',');
    return parts
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const [label, ...rest] = p.split(':');
        return { label: label.trim(), description: rest.join(':').trim() };
      });
  }
  if (Array.isArray(raw)) {
    return raw.map((x) => (typeof x === 'string' ? { label: x, description: '' } : { label: String(x.label ?? x.name), description: String(x.description ?? '') }));
  }
  if (raw && typeof raw === 'object') return Object.entries(raw).map(([label, d]) => ({ label, description: d ? String(d) : '' }));
  return [];
}

export async function classify(
  text: string,
  instructions: string,
  labels: Label[],
  opts: { multi?: boolean; allowNone?: boolean; jevKey?: string; escalateWith?: string } = {},
): Promise<Classification> {
  const task = instructions || 'Classify `document`.';
  const questions: Record<string, Question> = {};
  if (!opts.multi) {
    questions.label = {
      type: 'choice',
      instructions: { question: 'Which label fits `document` best?', task },
      criteria: {
        ...Object.fromEntries(labels.map((l) => [l.label, l.description || null])),
        ...(opts.allowNone && { none: 'none of these labels fits' }),
      },
    };
  }
  labels.forEach((l, i) => {
    questions[`applies_${i}`] = {
      type: 'noul',
      instructions: { question: 'Does this label apply to `document`?', task, label: l.label, ...(l.description && { meaning: l.description }) },
    };
  });
  const r = await askJev({ instructions: task, document: text }, questions, undefined, opts.jevKey);
  const applies = Object.fromEntries(labels.map((l, i) => [l.label, noul(r.answers, `applies_${i}`) ?? 0]));
  const uncertain = labels.filter((l) => applies[l.label] > 0.3 && applies[l.label] < 0.7).map((l) => l.label);
  const usage = {
    requests: 1,
    questions: r.questions,
    jev_ms: Math.round(r.ms),
    input_tokens: r.inputTokens,
    usd: r.inputTokens * JEV_PRICE_PER_TOKEN,
    model: r.model,
  };

  if (opts.multi) {
    const chosen = labels.filter((l) => applies[l.label] >= 0.5).map((l) => l.label);
    return {
      label: chosen[0] ?? null,
      labels: chosen,
      confidence: chosen.length ? Math.min(...chosen.map((l) => applies[l])) : null,
      probabilities: applies,
      applies,
      needs_review: uncertain.length > 0,
      uncertain,
      usage,
    };
  }
  const c = choice(r.answers, 'label');
  const winner = c && c.choice !== 'none' ? c.choice : null;
  // The Choice compares labels; the yes/no checks the winner applies at all.
  const verified = winner ? applies[winner] >= 0.5 : false;
  const label = winner && (verified || !opts.allowNone) ? winner : null;
  const needsReview = !label || (c?.confidence ?? 0) < REVIEW_BELOW || !verified;
  // Cascade: only a classification Jev flagged goes to the LLM; its label is kept if Jev does not reject it.
  // "No label fits" with every label clearly rejected is a confident answer, not an uncertain one.
  const clearNone = !label && Object.values(applies).every((p) => p < 0.3);
  if (needsReview && !clearNone && opts.escalateWith) {
    const { label: llmLabel, report } = await escalateLabel(opts.escalateWith, text, task, labels, applies);
    if (llmLabel) {
      return { label: llmLabel, labels: [llmLabel], confidence: applies[llmLabel], probabilities: c?.probabilities ?? {}, applies, needs_review: false, uncertain, by: 'llm+jev', escalation: report, usage };
    }
    return { label, labels: label ? [label] : [], confidence: c?.confidence ?? null, probabilities: c?.probabilities ?? {}, applies, needs_review: true, uncertain, by: 'jev', escalation: report, usage };
  }
  return {
    label,
    labels: label ? [label] : [],
    confidence: c?.confidence ?? null,
    probabilities: c?.probabilities ?? {},
    applies,
    needs_review: needsReview,
    uncertain,
    by: 'jev',
    usage,
  };
}
