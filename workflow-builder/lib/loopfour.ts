// Loopfour Workflows API, called only from server routes. The user's key is passed per request and
// never stored or logged (Loopfour's docs: keys must not be sent from the browser).

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
