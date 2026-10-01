// POST /api/classify — classification with Jev (no LLM). Called by the website and by Loopfour
// workflows through an API Request block.
//
//   headers: x-jev-key: <the caller's TypeSafe key>   (in Studio: {{secrets.JEV_API_KEY}})
//   body:    { document, instructions?, labels, multi_label?, allow_none? }
//            labels: {label: description} | ["a", "b"] | [{label, description}] | "a, b, c"
// -> { ok, label, labels, confidence, probabilities, applies, needs_review, uncertain, usage, total_ms }
import { classify, readLabels } from '@/lib/classify.ts';
import { readDocument } from '@/lib/document.ts';
import { errorResponse, jevKeyOf, readBody } from '@/lib/http.ts';

export const maxDuration = 30;

export function GET() {
  return Response.json({
    endpoint: 'classify',
    usage: 'POST {document, instructions?, labels, multi_label?, allow_none?} with header x-jev-key',
    example: { document: 'Hi, I was charged twice for order A-104.', labels: { billing: 'charges, invoices, refunds', technical: 'bugs, errors, login problems', sales: 'pricing questions, demos' } },
  });
}

export async function POST(request: Request) {
  const t0 = performance.now();
  const body = await readBody(request);
  const jevKey = jevKeyOf(request, body);
  if (!jevKey) return Response.json({ ok: false, error: 'Send your Jev (TypeSafe) API key in the x-jev-key header.' }, { status: 401 });
  try {
    const { text, truncated } = readDocument(body);
    const labels = readLabels(body.labels ?? body.categories);
    if (labels.length < 2) return Response.json({ ok: false, error: 'Send at least 2 labels.' }, { status: 400 });
    if (labels.length > 120) return Response.json({ ok: false, error: 'At most 120 labels per request.' }, { status: 400 });
    const result = await classify(text, String(body.instructions ?? body.prompt ?? ''), labels, {
      multi: !!(body.multi_label ?? body.multiLabel),
      allowNone: !!(body.allow_none ?? body.allowNone),
      jevKey,
      escalateWith: request.headers.get('x-loopfour-key') ?? undefined, // optional cascade, see lib/escalate.ts
    });
    return Response.json({ ok: true, ...result, ...(truncated && { truncated: true }), total_ms: Math.round(performance.now() - t0) });
  } catch (err) {
    return errorResponse(err);
  }
}
