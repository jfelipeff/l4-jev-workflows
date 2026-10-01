// Cascade (https://docs.typesafe.ai/cookbooks/sde_cascade, https://www.shipwithjev.com/blog/llm-routing):
// Jev answers everything; ONLY the answers Jev is unsure about go to an LLM, and the LLM's answer is
// accepted only if Jev confirms it. Opt-in, per request.
//
// The LLM is the one Loopfour already uses (claude-opus-5), run as a custom agent in the caller's own
// Loopfour workspace through the Agents API, so no extra LLM key is needed and Loopfour bills it as usual.

import { createHash } from 'node:crypto';
import type { FieldSpec } from './extract.ts';
import { askJev, noul, type Question } from './jev.ts';

const API = 'https://workflow.loopfour.ai/api/v1';
export const ESCALATION_MODEL = 'claude-opus-5';
const ACCEPT = 0.7; // Jev must give the LLM's answer at least this probability to replace "needs review"

type AgentKind = 'extraction' | 'classification';
const AGENTS: Record<AgentKind, { name: string; systemPrompt: string; outputSchema: unknown }> = {
  extraction: {
    name: '[jev-escalation] extraction',
    systemPrompt:
      'You extract field values from a document. Return a value only when the document states it, and copy the exact ' +
      'words of the document that state it into "quote" (verbatim, no paraphrasing). Normalize numbers to plain numbers ' +
      'and dates to YYYY-MM-DD. If the document does not state a field, return null for both value and quote.',
    outputSchema: {
      type: 'object',
      required: ['fields'],
      properties: {
        fields: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'value', 'quote'],
            properties: { name: { type: 'string' }, value: { type: ['string', 'number', 'boolean', 'null'] }, quote: { type: ['string', 'null'] } },
          },
        },
      },
    },
  },
  classification: {
    name: '[jev-escalation] classification',
    systemPrompt:
      'You classify a document into exactly one of the given labels, or "none" if none applies. Return the label exactly ' +
      'as given and quote the words of the document that justify it.',
    outputSchema: { type: 'object', required: ['label', 'quote'], properties: { label: { type: 'string' }, quote: { type: ['string', 'null'] } } },
  },
};

async function l4<T>(key: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.success === false) throw new Error(`Loopfour ${res.status}: ${json?.error?.message ?? 'agent call failed'}`);
  return json.data as T;
}

// One agent per workspace and kind, created the first time and then reused (cached by key hash).
const agentIds = new Map<string, string>();
async function agentFor(key: string, kind: AgentKind): Promise<string> {
  const cacheKey = `${createHash('sha256').update(key).digest('hex').slice(0, 16)}:${kind}`;
  const cached = agentIds.get(cacheKey);
  if (cached) return cached;
  const spec = AGENTS[kind];
  const existing = await l4<{ id: string; name: string }[]>(key, 'GET', `/agents?search=${encodeURIComponent('jev-escalation')}&includeBuiltIn=false`);
  const found = existing.find((a) => a.name === spec.name);
  const id =
    found?.id ??
    (
      await l4<{ id: string }>(key, 'POST', '/agents', {
        name: spec.name,
        description: 'LLM fallback for the Jev workflow builder: only receives answers Jev was unsure about.',
        type: kind,
        provider: 'anthropic',
        model: ESCALATION_MODEL,
        systemPrompt: spec.systemPrompt,
        outputSchema: spec.outputSchema,
        temperature: 0,
        maxTokens: 2048,
      })
    ).id;
  agentIds.set(cacheKey, id);
  return id;
}

type AgentRun = { output: Record<string, unknown> | null; latencyMs?: number; cost?: { totalCost?: number } };

export type EscalationReport = {
  model: string;
  escalated: string[]; // what was sent to the LLM
  accepted: string[]; // LLM answers Jev confirmed
  rejected: { name: string; reason: string }[]; // LLM answers that stay "needs review"
  llm_ms: number;
  llm_usd: number;
  jev_ms: number; // the verification request
};

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9.%$€£]+/g, ' ').trim();

/** Fields Jev was unsure about -> LLM -> keep only values quoted verbatim from the document AND confirmed by Jev. */
export async function escalateFields(
  loopfourKey: string,
  jevKey: string,
  text: string,
  instructions: string,
  specs: FieldSpec[],
): Promise<{ values: Record<string, { value: unknown; quote: string; p: number }>; report: EscalationReport }> {
  const report: EscalationReport = { model: ESCALATION_MODEL, escalated: specs.map((s) => s.name), accepted: [], rejected: [], llm_ms: 0, llm_usd: 0, jev_ms: 0 };
  const values: Record<string, { value: unknown; quote: string; p: number }> = {};
  if (!specs.length) return { values, report };

  const t0 = performance.now();
  const run = await l4<AgentRun>(loopfourKey, 'POST', `/agents/${await agentFor(loopfourKey, 'extraction')}/execute`, {
    // The agent's model only sees userMessage, so the fields and the document go in it.
    input: {},
    userMessage: [
      instructions || 'Extract these fields from the document.',
      'Fields (name, type, meaning):',
      ...specs.map((s) => `- ${s.name} (${s.kind}${s.enum ? `: one of ${s.enum.join(', ')}` : ''})${s.description ? `: ${s.description}` : ''}`),
      '<document>',
      text,
      '</document>',
    ].join('\n'),
  });
  report.llm_ms = Math.round(run.latencyMs ?? performance.now() - t0);
  report.llm_usd = run.cost?.totalCost ?? 0;

  // Grounding: the quote must be in the document. Then Jev judges whether the quote states that value.
  const doc = squash(text);
  const answers = (run.output?.fields as { name: string; value: unknown; quote: string | null }[] | undefined) ?? [];
  const checks: Record<string, Question> = {};
  const candidates: Record<string, { value: unknown; quote: string }> = {};
  for (const spec of specs) {
    const a = answers.find((x) => x.name === spec.name);
    if (!a || a.value === null || a.value === undefined || a.value === '<UNKNOWN>' || !a.quote) {
      report.rejected.push({ name: spec.name, reason: 'the LLM found no value either' });
      continue;
    }
    if (!doc.includes(squash(a.quote))) {
      report.rejected.push({ name: spec.name, reason: 'the LLM quote is not in the document' });
      continue;
    }
    if (spec.enum && !spec.enum.includes(String(a.value))) {
      report.rejected.push({ name: spec.name, reason: 'not one of the allowed values' });
      continue;
    }
    candidates[spec.name] = { value: a.value, quote: a.quote };
    checks[`ok__${spec.name}`] = {
      type: 'noul',
      instructions: {
        question: 'Does the quoted text from `document` state that this field has this value?',
        field: spec.name.replace(/_/g, ' '),
        ...(spec.description && { meaning: spec.description }),
        value: a.value,
        quote: a.quote,
      },
    };
  }
  if (Object.keys(checks).length) {
    const v = await askJev({ document: text }, checks, undefined, jevKey);
    report.jev_ms = Math.round(v.ms);
    for (const [name, c] of Object.entries(candidates)) {
      const p = noul(v.answers, `ok__${name}`) ?? 0;
      if (p >= ACCEPT) {
        values[name] = { ...c, p };
        report.accepted.push(name);
      } else report.rejected.push({ name, reason: `Jev did not confirm it (${Math.round(p * 100)}%)` });
    }
  }
  return { values, report };
}

/** A classification Jev flagged -> LLM picks a label -> accepted only if Jev agrees the label applies. */
export async function escalateLabel(
  loopfourKey: string,
  text: string,
  instructions: string,
  labels: { label: string; description: string }[],
  jevApplies: Record<string, number>,
): Promise<{ label: string | null; report: EscalationReport }> {
  const report: EscalationReport = { model: ESCALATION_MODEL, escalated: ['label'], accepted: [], rejected: [], llm_ms: 0, llm_usd: 0, jev_ms: 0 };
  const t0 = performance.now();
  const run = await l4<AgentRun>(loopfourKey, 'POST', `/agents/${await agentFor(loopfourKey, 'classification')}/execute`, {
    input: {},
    userMessage: [
      instructions || 'Classify the document.',
      'Labels (pick exactly one, or "none"):',
      ...labels.map((l) => `- ${l.label}${l.description ? `: ${l.description}` : ''}`),
      '<document>',
      text,
      '</document>',
    ].join('\n'),
  });
  report.llm_ms = Math.round(run.latencyMs ?? performance.now() - t0);
  report.llm_usd = run.cost?.totalCost ?? 0;
  const label = String(run.output?.label ?? '');
  const known = labels.find((l) => l.label.toLowerCase() === label.toLowerCase());
  if (!known) {
    report.rejected.push({ name: 'label', reason: label ? `"${label}" is not one of the labels` : 'no label' });
    return { label: null, report };
  }
  // Jev already scored every label; the LLM's pick must not be one Jev clearly rejected.
  const p = jevApplies[known.label] ?? 0;
  if (p >= 0.35) {
    report.accepted.push(known.label);
    return { label: known.label, report };
  }
  report.rejected.push({ name: 'label', reason: `Jev gives "${known.label}" only ${Math.round(p * 100)}%` });
  return { label: null, report };
}
