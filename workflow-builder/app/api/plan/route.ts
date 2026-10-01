// POST /api/plan  { apiKey, jevKey, description, force? } -> Jev draft + assembled workflow (nothing is created).
// Both keys belong to the visitor and are used for this request only: the Loopfour key to read the block
// catalog and the workspace's connections, the Jev key to call TypeSafe. Neither is stored or logged,
// and the server has no key of its own to fall back to.
import { assemble } from '@/lib/assemble.ts';
import { buildCatalog } from '@/lib/catalog.ts';
import { JevKeyError } from '@/lib/jev.ts';
import { fetchCatalogRaw, fetchConnections, fetchTemplates, LoopfourError } from '@/lib/loopfour.ts';
import { plan, type Force } from '@/lib/planner.ts';

export const maxDuration = 30;

export async function POST(request: Request) {
  const t0 = performance.now();
  const { apiKey, jevKey, description, force } = (await request.json().catch(() => ({}))) as {
    apiKey?: string;
    jevKey?: string;
    description?: string;
    force?: Force;
  };
  if (!apiKey?.startsWith('wfk_')) return Response.json({ error: 'Enter a Loopfour API key (starts with wfk_).' }, { status: 400 });
  if (!description || description.trim().length < 8) return Response.json({ error: 'Describe the workflow first.' }, { status: 400 });
  if (!jevKey || jevKey.length < 20) return Response.json({ error: 'Enter your Jev (TypeSafe) API key.' }, { status: 400 });

  try {
    const t1 = performance.now();
    const [raw, connections, templates] = await Promise.all([fetchCatalogRaw(apiKey), fetchConnections(apiKey), fetchTemplates(apiKey)]);
    const loopfourMs = performance.now() - t1;
    const catalog = buildCatalog(raw as Parameters<typeof buildCatalog>[0]);
    const siteUrl = new URL(request.url).origin.replace('http://localhost', 'https://l4-jev-workflow-builder.vercel.app').replace(/:\d+$/, '');
    const draft = await plan(description.trim(), catalog, { force, jevKey, templates, siteUrl });
    const assembled = assemble(draft, connections);
    return Response.json({
      draft,
      connections: connections.map(({ id, provider, status, isDefault }) => ({ id, provider, status, isDefault })),
      assembled,
      timing: { totalMs: Math.round(performance.now() - t0), loopfourMs: Math.round(loopfourMs), jevMs: Math.round(draft.usage.jevMs) },
    });
  } catch (err) {
    if (err instanceof JevKeyError) return Response.json({ error: err.message }, { status: 401 });
    if (err instanceof LoopfourError) {
      const msg = err.status === 401 || err.status === 403 ? 'Loopfour rejected the API key (it needs workflows:read and connections:read).' : err.message;
      return Response.json({ error: msg }, { status: err.status });
    }
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
