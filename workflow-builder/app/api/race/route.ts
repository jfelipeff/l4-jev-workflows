// POST /api/race — the LLM side of the Jev vs LLM race. The Jev side is the normal /api/plan,
// /api/extract or /api/classify call, fired by the browser at the same moment.
//
//   body: { apiKey, kind: 'builder', description }
//       | { apiKey, kind: 'extract', document, instructions?, schema }
//       | { apiKey, kind: 'classify', document, instructions?, labels }
// -> { ok, output, usd, llm_ms, model }
//
// Runs claude-opus-5 as an agent in the caller's own Loopfour workspace (lib/race.ts), billed by Loopfour.
import { buildCatalog } from '@/lib/catalog.ts';
import { readLabels } from '@/lib/classify.ts';
import { errorResponse, readBody } from '@/lib/http.ts';
import { fetchCatalogRaw } from '@/lib/loopfour.ts';
import { runLLM } from '@/lib/race.ts';

export const maxDuration = 60;

export async function POST(request: Request) {
  const body = await readBody(request);
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (!apiKey) return Response.json({ ok: false, error: 'The LLM side runs on your Loopfour key: enter it above.' }, { status: 401 });
  try {
    const kind = body.kind;
    const document = String(body.document ?? '');
    const instructions = String(body.instructions ?? '');
    const result =
      kind === 'builder'
        ? await runLLM(apiKey, { kind, description: String(body.description ?? ''), catalog: buildCatalog((await fetchCatalogRaw(apiKey)) as Parameters<typeof buildCatalog>[0]) })
        : kind === 'extract'
          ? await runLLM(apiKey, { kind, document, instructions, schema: body.schema })
          : kind === 'classify'
            ? await runLLM(apiKey, { kind, document, instructions, labels: readLabels(body.labels) })
            : null;
    if (!result) return Response.json({ ok: false, error: 'kind must be builder, extract or classify.' }, { status: 400 });
    return Response.json({ ok: true, ...result });
  } catch (err) {
    return errorResponse(err);
  }
}
