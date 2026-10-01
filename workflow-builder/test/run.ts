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
import { toTemplateDef } from '../lib/loopfour.ts';
import { plan } from '../lib/planner.ts';
import { fillVariables, instantiate } from '../lib/templates.ts';
import { CASES as BASE, type Expect } from './cases.ts';



const here = new URL('.', import.meta.url).pathname;
const catalog = buildCatalog(JSON.parse(readFileSync(`${here}fixtures/catalog.json`, 'utf8')));
const connections = JSON.parse(readFileSync(`${here}fixtures/connections.json`, 'utf8'));
const templates = JSON.parse(readFileSync(`${here}fixtures/templates-full.json`, 'utf8')).map(toTemplateDef);
// Every Loopfour template, phrased two ways: its own description, and its steps in plain words (like a
// recipe card). Each must be recreated as exactly that template, every time.
const stepsSentence = (t: { steps: Record<string, unknown>[] }) => t.steps.map((s) => String(s.name)).join(', ') + '.';
const CASES: { description: string; expect: Expect }[] = [
  ...BASE.map((c) => ({ ...c, expect: { ...c.expect, template: c.expect.template ?? null } })),
  ...templates.flatMap((t: { slug: string; description: string; steps: Record<string, unknown>[] }) => [
    { description: t.description, expect: { trigger: {}, template: t.slug } },
    { description: stepsSentence(t), expect: { trigger: {}, template: t.slug } },
  ]),
];

const cachePath = `${here}fixtures/jev-cache.json`;
const store: Record<string, JevCall> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
const cache: JevCache = { get: (k) => store[k], set: (k, v) => void (store[k] = v) };

function check(actual: unknown, expected: unknown, path: string, errors: string[]) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    for (const [k, v] of Object.entries(expected)) check((actual as Record<string, unknown>)?.[k], v, `${path}.${k}`, errors);
  } else if (Array.isArray(expected) && Array.isArray(actual)) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) errors.push(`${path}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
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
  const draft = await plan(c.description, catalog, { cache, templates });
  // Same decision as the /api/plan route.
  const def = draft.template && draft.template.fit >= 0.7 && draft.template.confidence >= 0.5 ? templates.find((t: { slug: string }) => t.slug === draft.template!.slug) : undefined;
  if (def) draft.templateMode = { def, values: (await fillVariables(c.description, def, undefined)).values };
  const out = assemble(draft, connections);
  const ms = performance.now() - t0;
  totalMs += draft.usage.jevMs;
  totalUsd += draft.usage.usd;

  const errors: string[] = [];
  check(out.workflow.trigger, c.expect.trigger, 'trigger', errors);
  if (c.expect.template !== undefined) {
    const got = out.template?.slug ?? null;
    if (got !== c.expect.template) errors.push(`template: got ${got} (choice ${draft.template?.slug} ${draft.template?.confidence?.toFixed(2)}, fit ${draft.template?.fit?.toFixed(2)}), want ${c.expect.template}`);
    else if (got) {
      // exactly the template's steps (same ids, types and actions, in order)
      const want = instantiate(def!, {}).steps.map((x) => `${x.id}:${x.type}:${x.action ?? ''}`).join(' > ');
      const have = out.workflow.steps.map((x) => `${x.id}:${x.type}:${x.action ?? ''}`).join(' > ');
      if (want !== have) errors.push(`steps differ from the template:\n      want ${want}\n      got  ${have}`);
    }
  }
  const got = out.workflow.steps;
  const summary = got.map((s) => s.action ?? s.type).join(', ');
  if (c.expect.steps) {
    if (got.length !== c.expect.steps.length) errors.push(`steps: got ${got.length} (${summary}), want ${c.expect.steps.length}`);
    c.expect.steps.forEach((e, k) => check(got[k], e, `steps[${k}]`, errors));
  }
  if (c.expect.stepsInclude) {
    // ordered subsequence: each expected step must appear after the previous match
    let from = 0;
    for (const [k, e] of c.expect.stepsInclude.entries()) {
      const idx = got.findIndex((s, j) => j >= from && (() => { const errs: string[] = []; check(s, e, '', errs); return errs.length === 0; })());
      if (idx < 0) errors.push(`stepsInclude[${k}] ${JSON.stringify(e)} not found in order (got: ${summary})`);
      else from = idx + 1;
    }
  }
  for (const id of c.expect.questions ?? []) {
    if (!out.questions.some((q) => q.id === id)) errors.push(`question ${id} was not asked`);
  }
  // Every action and config key must exist in the catalog.
  for (const s of out.template ? [] : out.workflow.steps) {
    if (s.type !== 'action' || s.action === 'api.request') continue; // agent/condition/approval/wait are core steps
    const [type] = String(s.action).split('.');
    const def = catalog.byType[type]?.actions.find((a) => a.id === s.action);
    if (!def) errors.push(`${s.id}: action ${s.action} is not in the catalog`);
    for (const key of Object.keys(s.config as object)) {
      if (!['connection', 'operation', 'action'].includes(key) && !def?.fields.some((f) => f.id === key)) errors.push(`${s.id}: config.${key} is not a field of ${s.action}`);
    }
  }

  const ok = errors.length === 0;
  passed += ok ? 1 : 0;
  if (ok && CASES.length > 20 && !only) {
    console.log(`PASS ${i + 1}. ${c.description.slice(0, 110)}${out.template ? `  -> template ${out.template.slug}` : ''}`);
    continue;
  }
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
