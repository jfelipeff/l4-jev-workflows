// POST /api/extract — the endpoint the Loopfour workflow calls with its API Request block.
//
//   Authorization: Bearer <L4_JEV_TOKEN>
//   Content-Type: application/json
//   body: see payload.ts ({"text": ...}, {"pages": [...]}, {"pdfBase64": ...} or a DocuSign Connect event)
//
// Responds with one extraction per document (billing terms + which fields need human review).
// The code runs on Vercel, not in Loopfour's Code block sandbox, which blocks network calls.
import { extractBillingTerms, MODEL } from '../primitives.js';
import { parsePayload, PayloadError } from '../payload.js';

export const maxDuration = 30;

export function GET() {
  return Response.json({
    workflow: 'contract-to-invoice',
    usage: 'POST JSON with {"text": "..."}, {"pages": [...]}, {"pdfBase64": "..."} or a DocuSign Connect event',
    model: MODEL,
  });
}

export async function POST(request: Request) {
  const t0 = performance.now();
  const token = process.env.L4_JEV_TOKEN;
  if (!token || request.headers.get('authorization') !== `Bearer ${token}`) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  if (!process.env.TYPESAFE_API_KEY) {
    return Response.json({ ok: false, error: 'TYPESAFE_API_KEY is not configured' }, { status: 500 });
  }

  let body: unknown;
  try {
    const raw = await request.text();
    body = raw.trim().startsWith('{') ? JSON.parse(raw) : raw;
  } catch {
    return Response.json({ ok: false, error: 'Body is not valid JSON' }, { status: 400 });
  }

  try {
    const { documents, envelopeId } = await parsePayload(body);
    const results = await Promise.all(
      documents.map(async (doc) => ({ name: doc.name, ...(await extractBillingTerms(doc.text)) })),
    );
    return Response.json({
      ok: true,
      envelopeId,
      needs_review: results.some((r) => r.needs_review.length > 0),
      documents: results,
      total_ms: Math.round(performance.now() - t0),
    });
  } catch (err) {
    if (err instanceof PayloadError) return Response.json({ ok: false, error: err.message }, { status: 422 });
    // Jev / network failure: fail loudly so the workflow's error handling (retry or stop) kicks in.
    return Response.json({ ok: false, error: String((err as Error).message ?? err) }, { status: 502 });
  }
}
