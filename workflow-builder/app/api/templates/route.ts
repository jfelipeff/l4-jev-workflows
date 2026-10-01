// POST /api/templates { apiKey } -> Loopfour's workflow templates (read with the caller's key, cached).
import { fetchTemplates, LoopfourError } from '@/lib/loopfour.ts';

export async function POST(request: Request) {
  const { apiKey } = (await request.json().catch(() => ({}))) as { apiKey?: string };
  if (!apiKey?.startsWith('wfk_')) return Response.json({ error: 'Enter a Loopfour API key (starts with wfk_).' }, { status: 400 });
  try {
    const defs = await fetchTemplates(apiKey);
    return Response.json({
      templates: defs.map((t) => ({
        slug: t.slug,
        name: t.name,
        description: t.description,
        trigger: t.trigger,
        steps: t.steps.map((s) => ({ name: s.name, type: s.type, action: s.action ?? null })),
        variables: t.variables,
        requiredConnections: t.requiredConnections,
      })),
    });
  } catch (err) {
    const status = err instanceof LoopfourError ? err.status : 502;
    return Response.json({ error: (err as Error).message }, { status });
  }
}
