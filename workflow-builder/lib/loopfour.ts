// Loopfour Workflows API, called only from server routes. The user's key is passed per request and
// never stored or logged (Loopfour's docs: keys must not be sent from the browser).

import type { TemplateDef } from './templates.ts';

const API = 'https://workflow.loopfour.ai/api/v1';
export const STUDIO_URL = (id: string) => `https://studio.loopfour.ai/w/${id}`;

export class LoopfourError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(key: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) {
    throw new LoopfourError(res.status, json?.error?.message ?? `Loopfour API ${res.status}`);
  }
  return json.data as T;
}

export type Connection = { id: string; provider: string; status: string; isDefault: boolean };

// The catalog is the same for every workspace and holds no credentials, so one copy per server
// instance is enough. It is fetched with the caller's key the first time.
let catalogCache: { at: number; raw: Record<'core' | 'integrations' | 'triggers', unknown[]> } | null = null;
const CATALOG_TTL_MS = 10 * 60 * 1000;

export async function fetchCatalogRaw(key: string) {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.raw;
  const [core, integrations, triggers] = await Promise.all(
    (['core', 'integrations', 'triggers'] as const).map((kind) => call<unknown[]>(key, 'GET', `/blocks?kind=${kind}`)),
  );
  catalogCache = { at: Date.now(), raw: { core, integrations, triggers } };
  return catalogCache.raw;
}

export const fetchConnections = (key: string) => call<Connection[]>(key, 'GET', '/connections');

/** Loopfour's system templates with their full definitions (trigger, steps, variables). Shared by every
 * workspace and free of credentials, so one cached copy per server instance. */
let templateCache: { at: number; list: TemplateDef[] } | null = null;
export async function fetchTemplates(key: string): Promise<TemplateDef[]> {
  if (templateCache && Date.now() - templateCache.at < CATALOG_TTL_MS) return templateCache.list;
  const rows = await call<{ slug: string | null }[]>(key, 'GET', '/templates?limit=100').catch(() => []);
  const slugs = rows.map((t) => t.slug).filter((s): s is string => !!s);
  const defs = await Promise.all(slugs.map((slug) => call<Record<string, unknown>>(key, 'GET', `/templates/by-slug/${slug}`).catch(() => null)));
  const list = defs.filter((d): d is Record<string, unknown> => !!d).map(toTemplateDef);
  templateCache = { at: Date.now(), list };
  return list;
}

export function toTemplateDef(d: Record<string, unknown>): TemplateDef {
  return {
    slug: String(d.slug),
    name: String(d.name),
    description: String(d.description ?? ''),
    trigger: (d.trigger ?? d.triggerConfig ?? { type: 'api' }) as Record<string, unknown>,
    steps: (d.steps ?? []) as Record<string, unknown>[],
    variables: ((d.variables ?? []) as TemplateDef['variables']).map((v) => ({ ...v, label: v.label ?? v.name, required: !!v.required })),
    requiredConnections: (d.requiredConnections ?? []) as string[],
  };
}

/** Create the workflow (draft), then save the canvas so it shows up as blocks in Studio. */
export async function createWorkflow(
  key: string,
  workflow: { name: string; description: string; trigger: unknown; steps: unknown[] },
  canvasState: unknown,
) {
  const created = await call<{ id: string }>(key, 'POST', '/workflows', workflow);
  await call(key, 'PATCH', `/workflows/${created.id}/canvas`, { canvasState, steps: workflow.steps });
  return { id: created.id, url: STUDIO_URL(created.id) };
}

/** Store a value as a workflow secret (needs the secrets:write scope); false when the key lacks it. */
export async function setWorkflowSecret(key: string, workflowId: string, name: string, value: string) {
  try {
    await call(key, 'POST', `/workflows/${workflowId}/secrets`, { key: name, value });
    return true;
  } catch (err) {
    if (err instanceof LoopfourError && err.status === 409) {
      await call(key, 'PUT', `/workflows/${workflowId}/secrets/${name}`, { value }).catch(() => null);
      return true;
    }
    return false;
  }
}
