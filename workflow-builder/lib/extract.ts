// Schema-driven extraction with Jev, no LLM: JSON Schema (or a field list) + document -> JSON.
//
//   enum            Choice over the allowed values (+ none)
//   boolean         Noul
//   date            Choice over every date in the text, normalized to YYYY-MM-DD
//   number/integer  Choice over every amount / number / percent / duration in the text
//   email/url/phone Choice over the matches of that pattern
//   string          round 1: Choice over the document's line ids ("which line says it?")
//                   round 2: Choice over the word sequences of that line ("which exact words?")
//   array<string>   Noul per line ("is this line one of the items?")
//   array<object>   Noul per line ("is this line one entry?"), then numbers/dates per kept row
//
// Values are always copied from the document, never written by a model. At most 2 requests.

import { find, phrases, type Candidate } from './finders.ts';
import { tagLines, taggedText, type Line } from './document.ts';
import { escalateFields, type EscalationReport } from './escalate.ts';
import { askJev, choice, JEV_PRICE_PER_TOKEN, noul, type Question } from './jev.ts';

export const REVIEW_BELOW = 0.6;
const NONE = 'none';
const MAX_ROW_LINES = 120;

type Kind = 'string' | 'number' | 'integer' | 'boolean' | 'date' | 'email' | 'url' | 'phone' | 'enum' | 'list' | 'rows';
export type FieldSpec = { name: string; kind: Kind; description: string; required: boolean; enum?: string[]; items?: FieldSpec[] };
export type FieldResult = { value: unknown; confidence: number | null; source: string | null; review: boolean; by?: 'jev' | 'llm+jev' };
export type Extraction = {
  output: Record<string, unknown>;
  fields: Record<string, FieldResult>;
  needs_review: string[];
  escalation?: EscalationReport;
  usage: { requests: number; questions: number; jev_ms: number; input_tokens: number; usd: number; model: string };
};

/** A row's text without its amounts (with a currency sign or cents) and its leading row number. */
const rowText = (text: string) =>
  text
    .replace(/(?:USD|EUR|GBP|[$€£])\s?\d[\d,]*(?:\.\d+)?|\b\d{1,3}(?:,\d{3})*\.\d{2}\b/g, ' ')
    .replace(/^\s*\d{1,3}[.)]?\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();

const human = (name: string) => name.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

function kindOf(name: string, s: Record<string, unknown>): Kind {
  const type = Array.isArray(s.type) ? (s.type as string[]).find((t) => t !== 'null') : (s.type as string | undefined);
  const n = name.toLowerCase();
  if (Array.isArray(s.enum)) return 'enum';
  if (type === 'boolean') return 'boolean';
  if (type === 'integer') return 'integer';
  if (type === 'number') return 'number';
  if (type === 'array') return (s.items as Record<string, unknown> | undefined)?.type === 'object' ? 'rows' : 'list';
  if (s.format === 'date' || s.format === 'date-time' || /(^|_)(date|deadline|due|expir|start|end)|_at$/i.test(name) || /[a-z](At|On|Date)$/.test(name)) return 'date';
  if (s.format === 'email' || /email/.test(n)) return 'email';
  if (s.format === 'uri' || /(url|link|website)/.test(n)) return 'url';
  if (/phone|mobile|fax/.test(n)) return 'phone';
  if (!type && /(amount|total|price|cost|value|qty|quantity|count|days|rate|tax|balance|fee)/.test(n)) return 'number';
  return 'string';
}

/** JSON Schema object, or a list of names / {name, type, description, enum}. */
export function readSchema(schema: unknown): FieldSpec[] {
  if (Array.isArray(schema)) {
    return schema.map((f) => {
      const o = typeof f === 'string' ? { name: f } : (f as Record<string, unknown>);
      const name = String(o.name);
      return { name, kind: kindOf(name, o), description: String(o.description ?? ''), required: !!o.required, enum: o.enum as string[] | undefined };
    });
  }
  const s = schema as Record<string, unknown> | undefined;
  const props = (s?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((s?.required as string[] | undefined) ?? []);
  return Object.entries(props).map(([name, p]) => {
    const kind = kindOf(name, p);
    const items = kind === 'rows' ? readSchema(p.items) : undefined;
    return { name, kind, description: String(p.description ?? ''), required: required.has(name), enum: p.enum as string[] | undefined, items };
  });
}

/** A month/day/week field reads a duration in its own unit: "three years" -> 36 for term_months. */
function inUnitsOf(name: string, cands: Candidate[]): Candidate[] {
  const want = /month/i.test(name) ? 'month' : /week/i.test(name) ? 'week' : /day/i.test(name) ? 'day' : /year/i.test(name) ? 'year' : null;
  if (!want) return cands;
  const days: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
  const out = [...cands];
  for (const c of cands) {
    const unit = c.raw.toLowerCase().match(/\b(day|week|month|year)s?\b/)?.[1];
    if (!unit || unit === want || typeof c.value !== 'number') continue;
    const converted =
      want === 'month' && unit === 'year' ? c.value * 12 : want === 'year' && unit === 'month' ? c.value / 12 : Math.round((c.value * days[unit]) / days[want]);
    if (!out.some((x) => x.value === converted)) out.push({ ...c, value: converted, raw: `${c.raw} (= ${converted} ${want}s)` });
  }
  return out;
}

const options = (cands: Candidate[]) => Object.fromEntries(cands.slice(0, 254).map((c) => [String(c.value), `${c.raw} (in: "…${c.context}…")`]));

export async function extract(
  text: string,
  instructions: string,
  specs: FieldSpec[],
  jevKey?: string,
  opts: { escalateWith?: string } = {}, // a Loopfour key: send only the uncertain fields to claude-opus-5
): Promise<Extraction> {
  const usage = { requests: 0, questions: 0, jev_ms: 0, input_tokens: 0, usd: 0, model: '' };
  const ask = async (state: unknown, qs: Record<string, Question>) => {
    const r = await askJev(state, qs, undefined, jevKey);
    if (r.questions) Object.assign(usage, { requests: usage.requests + 1, questions: usage.questions + r.questions, jev_ms: usage.jev_ms + r.ms, input_tokens: usage.input_tokens + r.inputTokens, model: r.model });
    return r.answers;
  };
  const lines = tagLines(text);
  const document = taggedText(lines);
  const ask1 = (spec: FieldSpec) => ({
    task: instructions || 'Extract data from `document`.',
    field: human(spec.name),
    ...(spec.description && { meaning: spec.description }),
  });

  // ---------------------------------------------------------------- round 1
  const q1: Record<string, Question> = {};
  const cands: Record<string, Candidate[]> = {};
  const rowLines = lines.slice(0, MAX_ROW_LINES);
  for (const f of specs) {
    const k = `f__${f.name}`;
    if (f.kind === 'enum') {
      q1[k] = { type: 'choice', instructions: { question: 'Which value does `document` give for this field?', ...ask1(f) }, criteria: { ...Object.fromEntries((f.enum ?? []).map((v) => [v, null])), [NONE]: 'not stated' } };
    } else if (f.kind === 'boolean') {
      q1[k] = { type: 'noul', instructions: { question: 'According to `document`, is this field true?', ...ask1(f) } };
    } else if (['date', 'number', 'integer', 'email', 'url', 'phone'].includes(f.kind)) {
      const kind = f.kind === 'number' || f.kind === 'integer' ? 'numeric' : (f.kind as 'date' | 'email' | 'url' | 'phone');
      cands[f.name] = kind === 'numeric' ? inUnitsOf(f.name, find(kind, text)) : find(kind, text);
      if (cands[f.name].length) {
        q1[k] = { type: 'choice', instructions: { question: 'Which of these values in `document` is this field?', ...ask1(f) }, criteria: { ...options(cands[f.name]), [NONE]: 'none of these: the document does not state it' } };
      }
    } else if (f.kind === 'string') {
      q1[k] = { type: 'choice', instructions: { question: 'Which line of `document` states this field? (lines are tagged L001, L002, ...)', ...ask1(f) }, criteria: { ...Object.fromEntries(lines.map((l) => [l.id, null])), [NONE]: 'no line states it' } };
    } else {
      // list / rows: one yes/no per line
      for (const l of rowLines) {
        q1[`${k}__${l.id}`] = {
          type: 'noul',
          instructions: {
            question: f.kind === 'rows' ? `Is line ${l.id} of \`document\` one entry of this field (one row or item)?` : `Is line ${l.id} of \`document\` one of the items of this field?`,
            ...ask1(f),
            ...(f.items && { entry_has: f.items.map((i) => human(i.name)) }),
          },
          criteria: { true: 'the line is one entry', false: 'the line is a heading, a total, other text, or not part of this field' },
        };
      }
    }
  }
  const a1 = await ask({ instructions, document }, q1);

  // ---------------------------------------------------------------- round 2
  const q2: Record<string, Question> = {};
  const chosenLine: Record<string, Line> = {};
  const kept: Record<string, Line[]> = {};
  for (const f of specs) {
    const k = `f__${f.name}`;
    if (f.kind === 'string') {
      const c = choice(a1, k);
      const line = c && c.choice !== NONE ? lines.find((l) => l.id === c.choice) : undefined;
      if (line && c!.confidence >= 0.3) {
        chosenLine[f.name] = line;
        q2[k] = {
          type: 'choice',
          instructions: { question: `Which exact words in line ${line.id} of \`document\` are this field's value?`, ...ask1(f), line: line.text },
          criteria: { ...Object.fromEntries(phrases(line.text).map((p) => [p, null])), [NONE]: 'the line does not contain the value' },
        };
      }
    }
    if (f.kind === 'rows' && f.items?.length) {
      kept[f.name] = rowLines.filter((l) => (noul(a1, `${k}__${l.id}`) ?? 0) >= 0.5).slice(0, 40);
      for (const [r, row] of kept[f.name].entries()) {
        for (const item of f.items) {
          if (!['number', 'integer', 'date'].includes(item.kind)) {
            // text column: Jev picks the phrase of the row that is this column (copied verbatim)
            const opts = phrases(rowText(row.text));
            if (opts.length > 1)
              q2[`${k}__${r}__${item.name}`] = {
                type: 'choice',
                instructions: { question: `Which part of this row is the ${human(item.name)}? Pick the whole value and nothing else.`, row: row.text, ...(item.description && { meaning: item.description }) },
                criteria: { ...Object.fromEntries(opts.map((p) => [p, null])), [NONE]: 'not in this row' },
              };
            continue;
          }
          const rc = find(item.kind === 'date' ? 'date' : 'numeric', row.text);
          if (rc.length > 1) {
            q2[`${k}__${r}__${item.name}`] = {
              type: 'choice',
              instructions: { question: `Which value in this row is the ${human(item.name)}?`, row: row.text, ...(item.description && { meaning: item.description }) },
              criteria: { ...options(rc), [NONE]: 'not in this row' },
            };
          }
        }
      }
    }
  }
  const a2 = await ask({ instructions, document }, q2);

  // ---------------------------------------------------------------- assemble
  const output: Record<string, unknown> = {};
  const fields: Record<string, FieldResult> = {};
  for (const f of specs) {
    const k = `f__${f.name}`;
    let value: unknown = null;
    let confidence: number | null = null;
    let source: string | null = null;
    if (f.kind === 'enum') {
      const c = choice(a1, k);
      if (c && c.choice !== NONE) [value, confidence, source] = [c.choice, c.confidence, c.choice];
      else confidence = c?.confidence ?? null;
    } else if (f.kind === 'boolean') {
      const p = noul(a1, k) ?? null;
      if (p !== null) [value, confidence, source] = [p >= 0.5, Math.abs(p - 0.5) * 2, `P(true)=${p.toFixed(2)}`];
    } else if (cands[f.name]) {
      const c = choice(a1, k);
      const hit = c && c.choice !== NONE ? cands[f.name].find((x) => String(x.value) === c.choice) : undefined;
      confidence = c?.confidence ?? null;
      if (hit) {
        value = f.kind === 'integer' ? Math.round(Number(hit.value)) : hit.value;
        source = hit.raw;
      }
    } else if (f.kind === 'string') {
      const c = choice(a2, k);
      const line = chosenLine[f.name];
      const lineConf = choice(a1, k)?.confidence ?? null;
      if (line && c && c.choice !== NONE) [value, confidence, source] = [c.choice, Math.min(c.confidence, lineConf ?? 1), line.id];
      else confidence = lineConf;
    } else if (f.kind === 'list') {
      const items = rowLines.map((l) => ({ l, p: noul(a1, `${k}__${l.id}`) ?? 0 })).filter((x) => x.p >= 0.5);
      value = items.map((x) => x.l.text.replace(/^[-*•\d.)\s]+/, ''));
      confidence = items.length ? Math.min(...items.map((x) => x.p)) : null;
      source = items.map((x) => x.l.id).join(',') || null;
    } else if (f.kind === 'rows') {
      const rows = kept[f.name] ?? rowLines.filter((l) => (noul(a1, `${k}__${l.id}`) ?? 0) >= 0.5);
      value = rows.map((row, r) => {
        const entry: Record<string, unknown> = {};
        for (const item of f.items ?? []) {
          if (['number', 'integer', 'date'].includes(item.kind)) {
            const rc = find(item.kind === 'date' ? 'date' : 'numeric', row.text);
            const c = choice(a2, `${k}__${r}__${item.name}`);
            const pick = c ? rc.find((x) => String(x.value) === c.choice) : rc.length === 1 ? rc[0] : rc[rc.length - 1];
            entry[item.name] = pick ? pick.value : null;
          } else {
            // text columns: the phrase Jev picked, else the row without its amounts and row number
            const c = choice(a2, `${k}__${r}__${item.name}`);
            entry[item.name] = c && c.choice !== NONE ? c.choice : rowText(row.text) || row.text;
          }
        }
        return entry;
      });
      const ps = rows.map((l) => noul(a1, `${k}__${l.id}`) ?? 0);
      confidence = ps.length ? Math.min(...ps) : null;
      source = rows.map((l) => l.id).join(',') || null;
    }
    const empty = value === null || (Array.isArray(value) && value.length === 0);
    const review = (f.required && empty) || (!empty && confidence !== null && confidence < REVIEW_BELOW);
    output[f.name] = value;
    fields[f.name] = { value, confidence, source, review };
  }
  for (const r of Object.values(fields)) r.by = 'jev';

  // Cascade: only fields Jev could not settle go to the LLM (required but empty, unsure, or no candidate
  // of the right type in the text); an LLM value replaces them only if Jev confirms it.
  let escalation: EscalationReport | undefined;
  if (opts.escalateWith && jevKey) {
    const unsure = specs.filter((f) => {
      const r = fields[f.name];
      if (f.kind === 'list' || f.kind === 'rows') return false;
      const empty = r.value === null;
      return (empty && (f.required || r.confidence === null)) || (!empty && (r.confidence ?? 0) < REVIEW_BELOW);
    });
    if (unsure.length) {
      const { values, report } = await escalateFields(opts.escalateWith, jevKey, text, instructions, unsure);
      escalation = report;
      for (const [name, v] of Object.entries(values)) {
        const spec = specs.find((s) => s.name === name)!;
        const value = spec.kind === 'number' || spec.kind === 'integer' ? Number(v.value) : v.value;
        output[name] = value;
        fields[name] = { value, confidence: v.p, source: v.quote, review: false, by: 'llm+jev' };
      }
    }
  }
  usage.usd = usage.input_tokens * JEV_PRICE_PER_TOKEN;
  usage.jev_ms = Math.round(usage.jev_ms);
  return { output, fields, needs_review: Object.entries(fields).filter(([, r]) => r.review).map(([n]) => n), ...(escalation && { escalation }), usage };
}
