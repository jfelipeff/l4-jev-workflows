// POST /api/create  { apiKey, workflow, canvasState } -> creates the workflow in Loopfour Studio as a
// draft (POST /workflows, then PATCH /canvas so it appears as blocks). The key is not stored.
import { createWorkflow, LoopfourError, setWorkflowSecret } from '@/lib/loopfour.ts';

export async function POST(request: Request) {
  const t0 = performance.now();
  const { apiKey, jevKey, workflow, canvasState } = (await request.json().catch(() => ({}))) as {
    apiKey?: string;
    jevKey?: string;
    workflow?: Parameters<typeof createWorkflow>[1];
    canvasState?: unknown;
  };
  if (!apiKey?.startsWith('wfk_') || !workflow || !canvasState) return Response.json({ error: 'Missing key or workflow.' }, { status: 400 });
  try {
    const created = await createWorkflow(apiKey, workflow, canvasState);
    // Jev steps read the caller's Jev key from the workflow secret JEV_API_KEY.
    const usesJev = JSON.stringify(workflow.steps).includes('{{secrets.JEV_API_KEY}}');
    const secret = usesJev ? (jevKey ? await setWorkflowSecret(apiKey, created.id, 'JEV_API_KEY', jevKey) : false) : null;
    return Response.json({ ...created, jevSecret: secret, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    const status = err instanceof LoopfourError ? err.status : 502;
    const msg = status === 401 || status === 403 ? 'Loopfour rejected the API key (it needs workflows:write).' : (err as Error).message;
    return Response.json({ error: msg }, { status });
  }
}
