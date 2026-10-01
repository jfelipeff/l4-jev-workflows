// Jev vs an LLM on the same job: description -> Loopfour workflow structure.
//
// The LLM side runs ON LOOPFOUR: a custom agent (claude-opus-5, the model behind Studio's Copilot and
// Agent block) created through the Agents API and executed once per description. It is outside the
// builder's pipeline, which never calls an LLM; this script only exists to measure the difference.
//
// Both sides get the same live catalog (trigger types, apps, actions) and the same 5 descriptions
// from test/cases.ts, and are scored the same way: trigger type and each step's type/action.
//
//   npm run compare            (needs LOOPFOUR_API_KEY and TYPESAFE_API_KEY in .env.local)

import { writeFileSync } from 'node:fs';
import { assemble } from '../lib/assemble.ts';
import { buildCatalog, type Catalog } from '../lib/catalog.ts';
import { fetchCatalogRaw, fetchConnections } from '../lib/loopfour.ts';
import { plan } from '../lib/planner.ts';
import { CASES, type Expect } from '../test/cases.ts';

const API = 'https://workflow.loopfour.ai/api/v1';
const KEY = process.env.LOOPFOUR_API_KEY!;
const AGENT_NAME = '[jev-builder] LLM workflow planner (baseline)';

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

function systemPrompt(catalog: Catalog) {
  const triggers = catalog.triggers.map((t) => `- ${t.type}: ${t.description}`).join('\n');
  const apps = catalog.blocks
    .filter((b) => b.kind === 'integrations')
    .map((b) => `- ${b.type} (${b.name}): ${b.actions.map((a) => `${a.op}=${a.label}`).join('; ')}`)
    .join('\n');
  return `You turn a plain-language description into a Loopfour Studio workflow.
Return JSON only: {"trigger": {"type": "api" | "schedule", "cron"?: string}, "steps": [step, ...]} with steps in order.
Step formats:
- app action: {"id", "type": "action", "action": "<app>.<op>", "config": {...fields from the description}}
- condition: {"id", "type": "condition", "config": {"conditions": {"left": "{{input.<field>}}", "operator": "gt|gte|lt|lte|eq|ne|contains|exists|isEmpty", "right": "<value>"}, "then": [step ids], "else": [step ids]}}
- approval: {"id", "type": "approval", "action": "approval.request", "config": {"approvers": "<emails>", "reason": "..."}}
- wait: {"id", "type": "wait", "config": {"duration": <number>, "unit": "seconds|minutes|hours|days"}}
Use trigger "schedule" (with a 5-field cron) only for recurring schedules; otherwise "api".
Only use these trigger types:
${triggers}
Only use these apps and actions (app type, then op=label):
${apps}`;
}

const OUTPUT_SCHEMA = {
  type: 'object',
  required: ['trigger', 'steps'],
  properties: {
    trigger: { type: 'object', properties: { type: { type: 'string' }, cron: { type: 'string' } }, required: ['type'] },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'type'],
        properties: { id: { type: 'string' }, type: { type: 'string' }, action: { type: 'string' }, config: { type: 'object' } },
      },
    },
  },
};

/** Same scoring for both sides: trigger type + each step's type and action. */
function score(out: { trigger?: { type?: string }; steps?: { type?: string; action?: string }[] }, expect: Expect) {
  const misses: string[] = [];
  if (out?.trigger?.type !== expect.trigger.type) misses.push(`trigger ${out?.trigger?.type} != ${expect.trigger.type}`);
  const steps = out?.steps ?? [];
  if (steps.length !== expect.steps.length) misses.push(`${steps.length} steps != ${expect.steps.length}`);
  expect.steps.forEach((e, i) => {
    const s = steps[i];
    if (s?.type !== e.type) misses.push(`step ${i + 1} type ${s?.type} != ${e.type}`);
    if (e.action) {
      const ok = Array.isArray(e.action) ? e.action.includes(s?.action ?? '') : s?.action === e.action;
      if (!ok) misses.push(`step ${i + 1} action ${s?.action} != ${[e.action].flat().join('|')}`);
    }
  });
  return misses;
}

/** The agent's answer, wherever the execute response puts it. */
function parseAgentOutput(data: unknown): { out: Record<string, unknown> | null; tokens: number | null; usd: number | null } {
  const d = data as Record<string, unknown>;
  const usage = (d?.usage ?? (d?.output as Record<string, unknown>)?.usage ?? d?.tokenUsage) as Record<string, number> | undefined;
  const usd = typeof (d?.cost as Record<string, number>)?.totalCost === 'number' ? (d.cost as Record<string, number>).totalCost : null; // Loopfour reports it
  const tokens = usage ? (usage.totalTokens ?? usage.total_tokens ?? (usage.inputTokens ?? usage.input_tokens ?? 0) + (usage.outputTokens ?? usage.output_tokens ?? 0)) : null;
  for (const c of [d?.output, d?.result, (d?.output as Record<string, unknown>)?.result, d?.content, d?.text, d]) {
    if (c && typeof c === 'object' && 'steps' in (c as object)) return { out: c as Record<string, unknown>, tokens, usd };
    if (typeof c === 'string') {
      const m = c.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          return { out: JSON.parse(m[0]), tokens, usd };
        } catch {
          /* not JSON */
        }
      }
    }
  }
  return { out: null, tokens, usd };
}

const catalog = buildCatalog((await fetchCatalogRaw(KEY)) as Parameters<typeof buildCatalog>[0]);
const connections = await fetchConnections(KEY);

// Reuse the baseline agent if it already exists, so reruns do not pile up agents.
const agents = await l4<{ id: string; name: string }[]>('GET', `/agents?search=${encodeURIComponent('jev-builder')}&includeBuiltIn=false`);
let agent = agents.find((a) => a.name === AGENT_NAME);
const prompt = systemPrompt(catalog);
if (agent) {
  await l4('PUT', `/agents/${agent.id}`, { systemPrompt: prompt, outputSchema: OUTPUT_SCHEMA });
} else {
  agent = await l4<{ id: string; name: string }>('POST', '/agents', {
    name: AGENT_NAME,
    description: 'Baseline for the Jev workflow builder comparison. Safe to delete.',
    type: 'custom',
    provider: 'anthropic',
    model: 'claude-opus-5',
    systemPrompt: prompt,
    outputSchema: OUTPUT_SCHEMA,
    temperature: 0,
    maxTokens: 4096,
  });
}
console.log(`LLM baseline: Loopfour agent ${agent.id} (claude-opus-5), system prompt ${prompt.length.toLocaleString()} chars`);

const rows: string[] = [];
const totals = { jevMs: 0, llmMs: 0, jevOk: 0, llmOk: 0, jevUsd: 0, llmTokens: 0, llmUsd: 0 };
for (const [i, c] of CASES.entries()) {
  const t0 = performance.now();
  const draft = await plan(c.description, catalog); // live, no cache
  const jev = assemble(draft, connections);
  const jevMs = performance.now() - t0;
  const jevMiss = score(jev.workflow as never, c.expect);

  const t1 = performance.now();
  let llmMiss: string[];
  let llmTokens: number | null = null;
  let llmUsd: number | null = null;
  try {
    const data = await l4<unknown>('POST', `/agents/${agent.id}/execute`, { input: { description: c.description }, userMessage: c.description });
    if (i === 0) writeFileSync('research/agent_execute_sample.json', JSON.stringify(data, null, 2));
    const parsed = parseAgentOutput(data);
    llmTokens = parsed.tokens;
    llmUsd = parsed.usd;
    llmMiss = parsed.out ? score(parsed.out as never, c.expect) : ['could not read the agent output (see research/agent_execute_sample.json)'];
  } catch (err) {
    llmMiss = [`error: ${(err as Error).message.slice(0, 160)}`];
  }
  const llmMs = performance.now() - t1;

  totals.jevMs += jevMs;
  totals.llmMs += llmMs;
  totals.jevOk += jevMiss.length ? 0 : 1;
  totals.llmOk += llmMiss.length ? 0 : 1;
  totals.jevUsd += draft.usage.usd;
  totals.llmTokens += llmTokens ?? 0;
  totals.llmUsd += llmUsd ?? 0;
  rows.push(
    `${i + 1}. ${c.description.slice(0, 70)}…\n` +
      `   Jev  ${(jevMs / 1000).toFixed(2)} s  ${jevMiss.length ? '✗ ' + jevMiss.join('; ') : '✓'}  ($${draft.usage.usd.toFixed(5)})\n` +
      `   LLM  ${(llmMs / 1000).toFixed(2)} s  ${llmMiss.length ? '✗ ' + llmMiss.join('; ') : '✓'}${llmTokens ? `  (${llmTokens} tokens${llmUsd ? `, $${llmUsd.toFixed(4)}` : ''})` : ''}`,
  );
  console.log(rows[rows.length - 1]);
}

const n = CASES.length;
const summary = `
                 Jev (TypeSafe)          LLM (claude-opus-5 on Loopfour)
correct          ${totals.jevOk}/${n}                     ${totals.llmOk}/${n}
avg time         ${(totals.jevMs / n / 1000).toFixed(2)} s                  ${(totals.llmMs / n / 1000).toFixed(2)} s   (${(totals.llmMs / totals.jevMs).toFixed(1)}x)
cost             $${(totals.jevUsd / n).toFixed(5)} per workflow   ${totals.llmUsd ? `$${(totals.llmUsd / n).toFixed(4)} per workflow, as reported by Loopfour (${(totals.llmUsd / totals.jevUsd).toFixed(0)}x)` : `${Math.round(totals.llmTokens / n)} tokens per workflow`}`;
console.log(summary);
writeFileSync('research/compare-results.txt', rows.join('\n') + '\n' + summary + '\n');
