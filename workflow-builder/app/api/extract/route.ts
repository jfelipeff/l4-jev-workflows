// POST /api/extract — schema-driven extraction with Jev (no LLM). Called by the website and by
// Loopfour workflows through an API Request block.
//
//   headers: x-jev-key: <the caller's TypeSafe key>   (in Studio: {{secrets.JEV_API_KEY}})
//   body:    { document, instructions?, schema | fields }
//            document: text, {text}, {pages} or a whole step output
//            schema:   JSON Schema object (like the AI Agent block's Output Schema) or a list of field names
// -> { ok, output, fields: {name: {value, confidence, source, review}}, needs_review, usage, total_ms }
import { readDocument } from '@/lib/document.ts';
import { extract, readSchema } from '@/lib/extract.ts';
import { errorResponse, jevKeyOf, readBody } from '@/lib/http.ts';

export const maxDuration = 30;

export function GET() {
  return Response.json({
    endpoint: 'extract',
    usage: 'POST {document, instructions?, schema | fields} with header x-jev-key',
    example: { document: 'Invoice INV-104 … Total due: $1,250.00 … Due date: Nov 1, 2026', schema: { type: 'object', properties: { invoice_number: { type: 'string' }, total: { type: 'number' }, due_date: { type: 'string', format: 'date' } } } },
  });
}

export async function POST(request: Request) {
  const t0 = performance.now();
  const body = await readBody(request);
  const jevKey = jevKeyOf(request, body);
  if (!jevKey) return Response.json({ ok: false, error: 'Send your Jev (TypeSafe) API key in the x-jev-key header.' }, { status: 401 });
  try {
    const { text, truncated } = readDocument(body);
    const specs = readSchema(body.schema ?? body.outputSchema ?? body.fields);
    if (!specs.length) return Response.json({ ok: false, error: 'Send "schema" (JSON Schema with properties) or "fields" (list of names).' }, { status: 400 });
    if (specs.length > 40) return Response.json({ ok: false, error: 'At most 40 fields per request.' }, { status: 400 });
    const result = await extract(text, String(body.instructions ?? body.prompt ?? ''), specs, jevKey);
    return Response.json({ ok: true, ...result, ...(truncated && { truncated: true }), total_ms: Math.round(performance.now() - t0) });
  } catch (err) {
    return errorResponse(err);
  }
}
