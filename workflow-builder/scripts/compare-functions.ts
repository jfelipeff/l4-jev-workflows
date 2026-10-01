// Jev vs an LLM on the site's two functions: extraction (the sample order form) and classification
// (the sample support tickets). Same inputs as the Extract/Classify panels, same scoring for both sides.
//
// The LLM side runs ON LOOPFOUR: custom agents (claude-opus-5) created through the Agents API, with the
// same JSON Schema / labels as structured output. Cost is what Loopfour reports for each run. Times are
// wall-clock for both sides (each includes its network round trip).
//
//   npm run compare:functions    (needs LOOPFOUR_API_KEY and TYPESAFE_API_KEY in .env.local)

import { writeFileSync } from 'node:fs';
import { classify, readLabels } from '../lib/classify.ts';
import { extract, readSchema } from '../lib/extract.ts';
import { SAMPLE_CONTRACT, SAMPLE_LABELS, SAMPLE_SCHEMA, SAMPLE_TICKETS } from '../lib/samples.ts';

const API = 'https://workflow.loopfour.ai/api/v1';
const KEY = process.env.LOOPFOUR_API_KEY!;
const JEV_KEY = process.env.TYPESAFE_API_KEY!;
const RUNS = 3; // extraction runs per side
const TICKET_RUNS = 2; // classification runs per ticket per side

async function l4<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: { 'x-api-key': KEY, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.success === false) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json?.error ?? json)}`);
  return json.data as T;
}

// One baseline agent per task, reused on reruns.
async function agent(name: string, type: string, systemPrompt: string, outputSchema: unknown) {
  const found = (await l4<{ id: string; name: string }[]>('GET', `/agents?search=${encodeURIComponent('jev-compare')}&includeBuiltIn=false`)).find((a) => a.name === name);
  if (found) {
    await l4('PUT', `/agents/${found.id}`, { systemPrompt, outputSchema });
    return found.id;
  }
  const created = await l4<{ id: string }>('POST', '/agents', {
    name,
    description: 'Baseline for the Jev extraction/classification comparison. Safe to delete.',
    type,
    provider: 'anthropic',
    model: 'claude-opus-5',
    systemPrompt,
    outputSchema,
    temperature: 0,
    maxTokens: 2048,
  });
  return created.id;
}

type Run = { output: Record<string, unknown> | null; cost?: { totalCost?: number } };
async function runAgent(id: string, userMessage: string) {
  const t0 = performance.now();
  const r = await l4<Run>('POST', `/agents/${id}/execute`, { input: {}, userMessage });
  return { out: r.output ?? {}, ms: performance.now() - t0, usd: r.cost?.totalCost ?? 0 };
}

// ---- extraction: 8 fields + 3 line items = 11 checks -------------------------------------------------
// Exact values: text must match the document word for word (case and spacing aside).
const EXPECTED_ITEMS = [
  ['Brightpath Retail Platform subscription (40 stores)', 48000],
  ['POS Connect module', 18000],
  ['Premium Support (24x7)', 6000],
] as const;
const norm = (v: unknown) => String(v ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

function scoreExtraction(o: Record<string, unknown>) {
  const misses: string[] = [];
  const num = (v: unknown) => (typeof v === 'string' ? Number(v.replace(/[$,]/g, '')) : v);
  const check = (name: string, ok: boolean) => ok || misses.push(`${name}=${JSON.stringify(o[name])}`);
  check('customer_name', norm(o.customer_name) === norm('Northwind Outfitters, Inc.'));
  check('acv', num(o.acv) === 72000);
  check('total_contract_value', num(o.total_contract_value) === 216000);
  check('term_months', num(o.term_months) === 36);
  check('start_date', String(o.start_date ?? '').startsWith('2026-11-01'));
  check('billing_frequency', o.billing_frequency === 'quarterly');
  check('net_terms_days', num(o.net_terms_days) === 30);
  check('auto_renews', o.auto_renews === true || o.auto_renews === 'true');
  const items = (Array.isArray(o.line_items) ? o.line_items : []) as Record<string, unknown>[];
  for (const [desc, fee] of EXPECTED_ITEMS) {
    const ok = items.some((i) => norm(i.description) === norm(desc) && num(i.annual_fee) === fee);
    if (!ok) misses.push(`line item "${desc}"`);
  }
  return { correct: 11 - misses.length, misses };
}

// ---- classification ------------------------------------------------------------------------------------
// The 4th ticket mentions both a double charge and a login problem: either label counts.
const EXPECTED_LABELS = [['billing'], ['technical'], ['sales'], ['billing', 'technical']];

const schema = JSON.parse(SAMPLE_SCHEMA);
const specs = readSchema(schema);
const labels = readLabels(SAMPLE_LABELS);
const extractInstructions = 'Extract the billing terms from this order form.';
const classifyInstructions = 'Route this support ticket to the right team.';

const extractAgent = await agent(
  '[jev-compare] extraction baseline',
  'extraction',
  'You extract fields from a document into the JSON output schema. Use only what the document states; use null when it does not state a field. Numbers as plain numbers, dates as YYYY-MM-DD.',
  schema,
);
const classifyAgent = await agent(
  '[jev-compare] classification baseline',
  'classification',
  'You classify a document into exactly one of the given labels, or "none" if none applies. Return the label exactly as given.',
  { type: 'object', required: ['label'], properties: { label: { type: 'string', enum: [...labels.map((l) => l.label), 'none'] } } },
);

const lines: string[] = [];
const log = (s: string) => (console.log(s), lines.push(s));
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const range = (xs: number[]) => `${(Math.min(...xs) / 1000).toFixed(2)}–${(Math.max(...xs) / 1000).toFixed(2)} s`;

// Extraction
const ex = { jev: { ms: [] as number[], usd: [] as number[], ok: [] as number[] }, llm: { ms: [] as number[], usd: [] as number[], ok: [] as number[] } };
log(`Extraction: sample order form, ${specs.length} fields (11 checks incl. 3 line items), ${RUNS} runs per side`);
for (let i = 0; i < RUNS; i++) {
  const t0 = performance.now();
  const j = await extract(SAMPLE_CONTRACT, extractInstructions, specs, JEV_KEY);
  const jMs = performance.now() - t0;
  const js = scoreExtraction(j.output);
  ex.jev.ms.push(jMs), ex.jev.usd.push(j.usage.usd), ex.jev.ok.push(js.correct);

  const l = await runAgent(extractAgent, `${extractInstructions}\n<document>\n${SAMPLE_CONTRACT}\n</document>`);
  const ls = scoreExtraction(l.out);
  ex.llm.ms.push(l.ms), ex.llm.usd.push(l.usd), ex.llm.ok.push(ls.correct);
  log(`  run ${i + 1}: Jev ${(jMs / 1000).toFixed(2)} s $${j.usage.usd.toFixed(5)} ${js.correct}/11${js.misses.length ? ' ✗ ' + js.misses.join('; ') : ''}`);
  log(`         LLM ${(l.ms / 1000).toFixed(2)} s $${l.usd.toFixed(4)} ${ls.correct}/11${ls.misses.length ? ' ✗ ' + ls.misses.join('; ') : ''}`);
}

// Classification
const cl = { jev: { ms: [] as number[], usd: [] as number[], ok: 0 }, llm: { ms: [] as number[], usd: [] as number[], ok: 0 } };
log(`\nClassification: ${SAMPLE_TICKETS.length} sample tickets × ${TICKET_RUNS} runs per side, labels ${labels.map((l) => l.label).join(' / ')}`);
for (const [t, ticket] of SAMPLE_TICKETS.entries()) {
  for (let r = 0; r < TICKET_RUNS; r++) {
    const t0 = performance.now();
    const j = await classify(ticket, classifyInstructions, labels, { allowNone: true, jevKey: JEV_KEY });
    const jMs = performance.now() - t0;
    const jOk = EXPECTED_LABELS[t].includes(j.label ?? 'none');
    cl.jev.ms.push(jMs), cl.jev.usd.push(j.usage.usd), (cl.jev.ok += jOk ? 1 : 0);

    const msg = [classifyInstructions, 'Labels:', ...labels.map((l) => `- ${l.label}: ${l.description}`), '<document>', ticket, '</document>'].join('\n');
    const l = await runAgent(classifyAgent, msg);
    const lLabel = String(l.out.label ?? 'none');
    const lOk = EXPECTED_LABELS[t].includes(lLabel);
    cl.llm.ms.push(l.ms), cl.llm.usd.push(l.usd), (cl.llm.ok += lOk ? 1 : 0);
    log(`  ticket ${t + 1} run ${r + 1}: Jev ${j.label} ${(jMs / 1000).toFixed(2)} s ${jOk ? '✓' : '✗'} | LLM ${lLabel} ${(l.ms / 1000).toFixed(2)} s $${l.usd.toFixed(4)} ${lOk ? '✓' : '✗'}`);
  }
}
const n = SAMPLE_TICKETS.length * TICKET_RUNS;

log(`
                         Jev (TypeSafe)                          LLM (claude-opus-5 on Loopfour)
extraction  time         avg ${(avg(ex.jev.ms) / 1000).toFixed(2)} s (${range(ex.jev.ms)})              avg ${(avg(ex.llm.ms) / 1000).toFixed(2)} s (${range(ex.llm.ms)})   ${(avg(ex.llm.ms) / avg(ex.jev.ms)).toFixed(1)}x
            cost         $${avg(ex.jev.usd).toFixed(5)}                                $${avg(ex.llm.usd).toFixed(4)}   ${(avg(ex.llm.usd) / avg(ex.jev.usd)).toFixed(0)}x
            correct      ${ex.jev.ok.join(', ')} of 11                            ${ex.llm.ok.join(', ')} of 11
classify    time         avg ${(avg(cl.jev.ms) / 1000).toFixed(2)} s (${range(cl.jev.ms)})              avg ${(avg(cl.llm.ms) / 1000).toFixed(2)} s (${range(cl.llm.ms)})   ${(avg(cl.llm.ms) / avg(cl.jev.ms)).toFixed(1)}x
            cost         $${avg(cl.jev.usd).toFixed(6)}                               $${avg(cl.llm.usd).toFixed(4)}   ${(avg(cl.llm.usd) / avg(cl.jev.usd)).toFixed(0)}x
            correct      ${cl.jev.ok}/${n}                                       ${cl.llm.ok}/${n}`);
writeFileSync('research/compare-functions.txt', lines.join('\n') + '\n');
