// POST /api/warm { apiKey } -> loads the Loopfour catalog and templates into this server's cache, so the
// first build or race does not pay for those reads. Returns nothing else.
import { fetchCatalogRaw, fetchTemplates } from '@/lib/loopfour.ts';

export async function POST(request: Request) {
  const { apiKey } = (await request.json().catch(() => ({}))) as { apiKey?: string };
  if (!apiKey?.startsWith('wfk_')) return Response.json({ ok: false }, { status: 400 });
  try {
    await Promise.all([fetchCatalogRaw(apiKey), fetchTemplates(apiKey)]);
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 502 });
  }
}
