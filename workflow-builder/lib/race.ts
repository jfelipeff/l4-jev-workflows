// The LLM opponent for the Jev vs LLM race (and for scripts/compare-llm.ts): claude-opus-5 run as a
// custom agent in the caller's own Loopfour workspace, through the Agents API. It never takes part in
// the Jev pipeline; it only exists so both can be timed on the same input.

import { createHash } from 'node:crypto';
import type { Catalog } from './catalog.ts';

const API = 'https://workflow.loopfour.ai/api/v1';
export const RACE_MODEL = 'claude-opus-5';
export type RaceKind = 'builder' | 'extract' | 'classify';

/** Same instructions the builder comparison uses: the live catalog's triggers, apps and actions. */
export function builderPrompt(catalog: Catalog) {
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
- extraction or classification of a document: {"id", "type": "agent", "config": {"prompt": "..."}}
Use trigger "schedule" (with a 5-field cron) only for recurring schedules; otherwise "api".
Only use these trigger types:
${triggers}
Only use these apps and actions (app type, then op=label):
${apps}`;
}

export const BUILDER_SCHEMA = {
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

const SPECS: Record<RaceKind, { name: string; systemPrompt?: string; outputSchema?: unknown }> = {
  builder: { name: '[jev-race] LLM workflow builder', outputSchema: BUILDER_SCHEMA },
  extract: {
    name: '[jev-race] LLM extraction',
    systemPrompt:
      'You extract fields from a document. The user gives the fields as a JSON Schema. Return only a JSON object with those ' +
      'fields, using only what the document states (null when it does not). Numbers as plain numbers, dates as YYYY-MM-DD.',
  },
  classify: {
    name: '[jev-race] LLM classification',
    systemPrompt: 'You classify a document into exactly one of the given labels, or "none" if none applies. Return the label exactly as given.',
    outputSchema: { type: 'object', required: ['label'], properties: { label: { type: 'string' } } },
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

// One agent per workspace and kind, created on first use and reused (cached by key hash).
const agentIds = new Map<string, string>();
async function agentFor(key: string, kind: RaceKind, systemPrompt: string) {
  const cacheKey = `${createHash('sha256').update(key).digest('hex').slice(0, 16)}:${kind}:${createHash('sha256').update(systemPrompt).digest('hex').slice(0, 8)}`;
  const cached = agentIds.get(cacheKey);
  if (cached) return cached;
  const spec = SPECS[kind];
  const existing = (await l4<{ id: string; name: string }[]>(key, 'GET', `/agents?search=${encodeURIComponent('jev-race')}&includeBuiltIn=false`)).find((a) => a.name === spec.name);
  let id: string;
  if (existing) {
    await l4(key, 'PUT', `/agents/${existing.id}`, { systemPrompt, ...(spec.outputSchema ? { outputSchema: spec.outputSchema } : {}) });
    id = existing.id;
  } else {
    id = (
      await l4<{ id: string }>(key, 'POST', '/agents', {
        name: spec.name,
        description: 'The LLM side of the Jev vs LLM race on l4-jev-workflow-builder. Safe to delete.',
        type: 'custom',
        provider: 'anthropic',
        model: RACE_MODEL,
        systemPrompt,
        ...(spec.outputSchema ? { outputSchema: spec.outputSchema } : {}),
        temperature: 0,
        maxTokens: 4096,
      })
    ).id;
  }
  agentIds.set(cacheKey, id);
  return id;
}

/** The agent's JSON answer, wherever the execute response puts it. */
export function parseAgentOutput(data: unknown): Record<string, unknown> | null {
  const d = data as Record<string, unknown>;
  for (const c of [d?.output, d?.result, (d?.output as Record<string, unknown>)?.result, d?.content, d?.text]) {
    if (c && typeof c === 'object' && !Array.isArray(c)) {
      const o = c as Record<string, unknown>;
      if (typeof o.text === 'string' || typeof o.content === 'string') {
        const inner = parseAgentOutput({ output: o.text ?? o.content });
        if (inner) return inner;
      }
      return o;
    }
    if (typeof c === 'string') {
      const m = c.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          return JSON.parse(m[0]);
        } catch {
          /* not JSON */
        }
      }
    }
  }
  return null;
}

export type RaceInput =
  | { kind: 'builder'; description: string; catalog: Catalog }
  | { kind: 'extract'; document: string; instructions: string; schema: unknown }
  | { kind: 'classify'; document: string; instructions: string; labels: { label: string; description: string }[] };

/** Run the LLM side once. Returns its answer and the cost Loopfour reports. */
export async function runLLM(key: string, input: RaceInput) {
  const systemPrompt = input.kind === 'builder' ? builderPrompt(input.catalog) : SPECS[input.kind].systemPrompt!;
  const id = await agentFor(key, input.kind, systemPrompt);
  const userMessage =
    input.kind === 'builder'
      ? input.description
      : input.kind === 'extract'
        ? [input.instructions || 'Extract these fields.', 'JSON Schema:', JSON.stringify(input.schema), '<document>', input.document, '</document>'].join('\n')
        : [input.instructions || 'Classify the document.', 'Labels:', ...input.labels.map((l) => `- ${l.label}${l.description ? `: ${l.description}` : ''}`), '<document>', input.document, '</document>'].join('\n');
  const t0 = performance.now();
  const run = await l4<Record<string, unknown>>(key, 'POST', `/agents/${id}/execute`, { input: {}, userMessage });
  return {
    output: parseAgentOutput(run),
    usd: (run.cost as { totalCost?: number } | undefined)?.totalCost ?? null,
    llm_ms: Math.round((run.latencyMs as number | undefined) ?? performance.now() - t0),
    model: RACE_MODEL,
  };
}
