// Offline test: 5 descriptions -> workflow JSON, checked against expectations. Uses a saved snapshot
// of the Loopfour catalog and fake connections, so Loopfour is never called. Jev answers are cached
// in test/fixtures/jev-cache.json: delete it to ask Jev live again.
//
//   npm test              run all cases
//   npm test -- 2         run case 2 only, and print its full workflow JSON

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { assemble } from '../lib/assemble.ts';
import { buildCatalog } from '../lib/catalog.ts';
import type { JevCache, JevCall } from '../lib/jev.ts';
import { plan } from '../lib/planner.ts';
import { CASES } from './cases.ts';

const here = new URL('.', import.meta.url).pathname;
const catalog = buildCatalog(JSON.parse(readFileSync(`${here}fixtures/catalog.json`, 'utf8')));
const connections = JSON.parse(readFileSync(`${here}fixtures/connections.json`, 'utf8'));
const cachePath = `${here}fixtures/jev-cache.json`;
const store: Record<string, JevCall> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
const cache: JevCache = { get: (k) => store[k], set: (k, v) => void (store[k] = v) };

function check(actual: unknown, expected: unknown, path: string, errors: string[]) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    for (const [k, v] of Object.entries(expected)) check((actual as Record<string, unknown>)?.[k], v, `${path}.${k}`, errors);
  } else if (Array.isArray(expected)) {
    if (!expected.includes(actual)) errors.push(`${path}: got ${JSON.stringify(actual)}, want one of ${JSON.stringify(expected)}`);
  } else if (String(actual) !== String(expected)) {
    errors.push(`${path}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

const only = process.argv[2] ? Number(process.argv[2]) : null;
let passed = 0;
let totalMs = 0;
let totalUsd = 0;
for (const [i, c] of CASES.entries()) {
  if (only && only !== i + 1) continue;
  const t0 = performance.now();
  const draft = await plan(c.description, catalog, { cache });
  const out = assemble(draft, connections);
  const ms = performance.now() - t0;
  totalMs += draft.usage.jevMs;
  totalUsd += draft.usage.usd;

  const errors: string[] = [];
  check(out.workflow.trigger, c.expect.trigger, 'trigger', errors);
  if (out.workflow.steps.length !== c.expect.steps.length) {
    errors.push(`steps: got ${out.workflow.steps.length} (${out.workflow.steps.map((s) => s.action ?? s.type).join(', ')}), want ${c.expect.steps.length}`);
  }
  c.expect.steps.forEach((e, k) => check(out.workflow.steps[k], e, `steps[${k}]`, errors));
  // Every action and config key must exist in the catalog.
  for (const s of out.workflow.steps) {
    if (s.type !== 'action' || s.action === 'api.request') continue;
    const [type] = String(s.action).split('.');
    const def = catalog.byType[type]?.actions.find((a) => a.id === s.action);
    if (!def) errors.push(`${s.id}: action ${s.action} is not in the catalog`);
    for (const key of Object.keys(s.config as object)) {
      if (!['connection', 'operation', 'action'].includes(key) && !def?.fields.some((f) => f.id === key)) errors.push(`${s.id}: config.${key} is not a field of ${s.action}`);
    }
  }

  const ok = errors.length === 0;
  passed += ok ? 1 : 0;
  console.log(`\n${ok ? 'PASS' : 'FAIL'} ${i + 1}. ${c.description}`);
  console.log(`  trigger: ${JSON.stringify(out.workflow.trigger)}`);
  for (const v of out.view.steps) {
    console.log(`  ${v.branch ? `[${v.branch}] ` : ''}${v.title} (${v.confidence == null ? 'n/a' : v.confidence.toFixed(2)})  ${JSON.stringify(v.config)}`);
  }
  for (const q of out.questions) console.log(`  ? ${q.kind}: ${q.prompt}`);
  for (const e of errors) console.log(`  ✗ ${e}`);
  console.log(`  Jev: ${draft.usage.rounds} requests, ${draft.usage.questions} questions, ${draft.usage.jevMs.toFixed(0)} ms, ${draft.usage.inputTokens} tokens, $${draft.usage.usd.toFixed(5)} · total ${ms.toFixed(0)} ms`);
  if (only) console.log(JSON.stringify({ workflow: out.workflow, canvasState: out.canvasState }, null, 2));
}
writeFileSync(cachePath, JSON.stringify(store));
console.log(`\n${passed}/${only ? 1 : CASES.length} passed · Jev ${totalMs.toFixed(0)} ms, $${totalUsd.toFixed(5)} total`);
process.exitCode = passed === (only ? 1 : CASES.length) ? 0 : 1;
