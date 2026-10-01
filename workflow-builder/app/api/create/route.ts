// POST /api/create  { apiKey, workflow, canvasState } -> creates the workflow in Loopfour Studio as a
// draft (POST /workflows, then PATCH /canvas so it appears as blocks). The key is not stored.
import { createWorkflow, LoopfourError } from '@/lib/loopfour.ts';

export async function POST(request: Request) {
  const t0 = performance.now();
  const { apiKey, workflow, canvasState } = (await request.json().catch(() => ({}))) as {
    apiKey?: string;
    workflow?: Parameters<typeof createWorkflow>[1];
    canvasState?: unknown;
  };
  if (!apiKey?.startsWith('wfk_') || !workflow || !canvasState) return Response.json({ error: 'Missing key or workflow.' }, { status: 400 });
  try {
    const created = await createWorkflow(apiKey, workflow, canvasState);
    return Response.json({ ...created, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    const status = err instanceof LoopfourError ? err.status : 502;
    const msg = status === 401 || status === 403 ? 'Loopfour rejected the API key (it needs workflows:write).' : (err as Error).message;
    return Response.json({ error: msg }, { status });
  }
}
