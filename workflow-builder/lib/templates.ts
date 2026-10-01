// Loopfour's own workflow templates: when Jev recognizes that a description is one of them, the builder
// recreates that template exactly (its trigger and steps, as Studio's Copilot does), filling the template's
// variables (Slack channel, approver email, threshold, ...) from the description.

import { askJev, choice, type Question } from './jev.ts';
import { findValues, numeric } from './parse.ts';

export type TemplateVariable = { name: string; type: string; label: string; required: boolean };
export type TemplateDef = {
  slug: string;
  name: string;
  description: string;
  trigger: Record<string, unknown>;
  steps: Record<string, unknown>[];
  variables: TemplateVariable[];
  requiredConnections: string[];
};
export type VariableValue = { value: string | null; confidence: number | null };

const NONE = 'none';

/** Variables a template's steps actually use ({{billing_channel}}); declared-but-unused ones are skipped. */
export function usedVariables(def: TemplateDef): TemplateVariable[] {
  const text = JSON.stringify(def.steps);
  return def.variables.filter((v) => text.includes(`{{${v.name}}}`));
}

function kindsFor(v: TemplateVariable): string[] {
  const n = `${v.name} ${v.label}`.toLowerCase();
  if (/channel/.test(n)) return ['channel'];
  if (/email|approver|address|from|manager/.test(n)) return ['email'];
  if (/sheet|spreadsheet/.test(n)) return ['url', 'quoted'];
  if (v.type === 'number' || /threshold|days|amount|\$/.test(n)) return ['money', 'number', 'percent'];
  return ['quoted', 'channel', 'email', 'url', 'number'];
}

/** One Jev request: for each variable, a Choice among the values of the right kind found in the text. */
export async function fillVariables(description: string, def: TemplateDef, jevKey?: string) {
  const values: Record<string, VariableValue> = {};
  const found = findValues(description);
  const questions: Record<string, Question> = {};
  for (const v of usedVariables(def)) {
    const cands = found.filter((f) => kindsFor(v).includes(f.kind));
    if (!cands.length) {
      values[v.name] = { value: null, confidence: null };
      continue;
    }
    questions[v.name] = {
      type: 'choice',
      instructions: { question: `Which value from \`description\` is the "${v.label}" for the ${def.name} workflow?`, variable: v.label },
      criteria: { ...Object.fromEntries(cands.map((c) => [c.value, c.kind])), [NONE]: 'none of these: the description does not say' },
    };
  }
  const r = await askJev({ description }, questions, undefined, jevKey);
  for (const name of Object.keys(questions)) {
    const c = choice(r.answers, name);
    const v = def.variables.find((x) => x.name === name)!;
    const raw = c && c.choice !== NONE ? c.choice : null;
    // Sheet IDs come from a URL: keep the part between /spreadsheets/d/ and the next "/".
    const value = raw && /sheet/i.test(v.name) ? (raw.match(/spreadsheets\/d\/([\w-]+)/)?.[1] ?? raw) : raw && v.type === 'number' ? (numeric(raw) ?? raw) : raw;
    values[name] = { value, confidence: c?.confidence ?? null };
  }
  return { values, ms: r.ms, inputTokens: r.inputTokens, questions: r.questions };
}

/** Deep-copy the template's trigger and steps, replacing {{variable}} with the filled values. */
export function instantiate(def: TemplateDef, values: Record<string, string | null | undefined>) {
  const fill = (x: unknown): unknown => {
    if (typeof x === 'string') {
      const whole = x.match(/^\{\{\s*([a-z_]+)\s*\}\}$/);
      if (whole && values[whole[1]] != null) return values[whole[1]];
      return x.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, name) => (values[name] != null ? String(values[name]) : m));
    }
    if (Array.isArray(x)) return x.map(fill);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, fill(v)]));
    return x;
  };
  const steps = (fill(def.steps) as Record<string, unknown>[]).map((s) => {
    // Studio's Copilot names Slack building-block steps by their action, e.g. "slack.send_message".
    const config = s.config as Record<string, unknown> | undefined;
    return s.type === 'slack' && !s.action && config?.action ? { ...s, action: `slack.${config.action}` } : s;
  });
  return { trigger: def.trigger, steps };
}

const sub = (id: string, value: unknown) => ({
  id,
  type: typeof value === 'object' && value !== null ? 'code' : 'short-input',
  value: typeof value === 'object' && value !== null ? JSON.stringify(value) : value,
});

/** Studio canvas for template steps: one block per step, left to right, with condition branches and loops. */
export function templateCanvas(trigger: Record<string, unknown>, steps: Record<string, unknown>[]) {
  const COL = 360;
  const blocks: Record<string, unknown> = {};
  const edges: { id: string; source: string; target: string; sourceHandle?: string }[] = [];
  const loops: Record<string, unknown> = {};
  const byId = Object.fromEntries(steps.map((s) => [s.id as string, s]));
  const inLoop = new Set<string>();
  const inBranch = new Set<string>();
  for (const s of steps) {
    const c = s.config as Record<string, unknown>;
    if (s.type === 'loop') ((c.steps as string[]) ?? []).forEach((id) => inLoop.add(id));
    if (s.type === 'condition') [...((c.then as string[]) ?? []), ...((c.else as string[]) ?? [])].forEach((id) => inBranch.add(id));
  }
  const block = (s: Record<string, unknown>, x: number, y: number, parentId?: string) => {
    const action = s.action as string | undefined;
    const provider = action && s.type === 'action' ? action.split('.')[0].replace(/^sheets$/, 'google-sheets') : undefined;
    const type = provider ?? (s.type === 'email' ? 'resend' : (s.type as string));
    const config = (s.config ?? {}) as Record<string, unknown>;
    blocks[s.id as string] = {
      id: s.id,
      name: s.name,
      type,
      enabled: true,
      outputs: {},
      position: { x, y },
      subBlocks: Object.fromEntries(Object.entries(config).map(([k, v]) => [k, sub(k, v)])),
      horizontalHandles: true,
      ...(parentId && { data: { parentId, extent: 'parent' } }),
    };
  };
  const triggerType = trigger.type === 'schedule' ? 'schedule_trigger' : 'api_trigger';
  blocks.trigger = {
    id: 'trigger',
    name: trigger.type === 'schedule' ? 'Schedule Trigger' : trigger.type === 'webhook' ? 'Webhook Trigger' : 'API Trigger',
    type: triggerType,
    enabled: true,
    outputs: {},
    position: { x: 120, y: 220 },
    subBlocks: trigger.type === 'schedule' ? { cronExpression: sub('cronExpression', trigger.cron), timezone: sub('timezone', trigger.timezone ?? 'UTC') } : {},
    horizontalHandles: true,
  };
  let col = 1;
  let tails = ['trigger'];
  for (const s of steps) {
    const id = s.id as string;
    if (inLoop.has(id) || inBranch.has(id)) continue;
    block(s, 120 + col * COL, 220);
    tails.forEach((t) => edges.push({ id: `e-${t}-${id}`, source: t, target: id }));
    tails = [id];
    const c = s.config as Record<string, unknown>;
    if (s.type === 'loop') {
      const children = ((c.steps as string[]) ?? []).filter((x) => byId[x]);
      children.forEach((child, k) => {
        block(byId[child], 40 + k * 300, 80, id);
        if (k) edges.push({ id: `e-${children[k - 1]}-${child}`, source: children[k - 1], target: child });
      });
      loops[id] = { id, nodes: children, iterations: 1, loopType: 'forEach', forEachItems: c.collection };
    }
    if (s.type === 'condition') {
      const ends: string[] = [];
      for (const [branch, y, handle] of [['then', 80, 'true'], ['else', 360, 'false']] as const) {
        const ids = ((c[branch] as string[]) ?? []).filter((x) => byId[x]);
        ids.forEach((b, k) => {
          block(byId[b], 120 + (col + 1 + k) * COL, y);
          edges.push({ id: `e-${k ? ids[k - 1] : id}-${b}`, source: k ? ids[k - 1] : id, target: b, ...(k === 0 && { sourceHandle: handle }) });
        });
        if (ids.length) ends.push(ids[ids.length - 1]);
      }
      if (ends.length) tails = ends;
      col += 1;
    }
    col++;
  }
  return { blocks, edges, loops, parallels: {} };
}
