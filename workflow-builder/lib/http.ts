// Shared bits of the /api/extract and /api/classify routes.
import { InputError } from './document.ts';
import { JevKeyError } from './jev.ts';

/** The caller's own Jev key: `x-jev-key` header, `Authorization: Bearer`, or "jevKey" in the body. No fallback. */
export function jevKeyOf(request: Request, body: Record<string, unknown>): string | null {
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const key = request.headers.get('x-jev-key') ?? bearer ?? (typeof body.jevKey === 'string' ? body.jevKey : null);
  return key && key.trim().length >= 20 ? key.trim() : null;
}

export function errorResponse(err: unknown) {
  if (err instanceof InputError) return Response.json({ ok: false, error: err.message }, { status: 400 });
  if (err instanceof JevKeyError) return Response.json({ ok: false, error: err.message }, { status: 401 });
  return Response.json({ ok: false, error: (err as Error).message }, { status: 502 });
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (!raw.trim()) return {};
  try {
    const json = JSON.parse(raw);
    return json && typeof json === 'object' && !Array.isArray(json) ? json : { document: json };
  } catch {
    return { document: raw }; // plain text body = the document
  }
}
