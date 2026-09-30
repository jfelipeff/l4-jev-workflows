// What the Loopfour workflow can send us, turned into plain document text.
//
// The workflow is triggered by DocuSign ({{input}} = the DocuSign Connect event). That event only
// carries the contract itself when "Include Documents" is on in DocuSign Connect; otherwise it is
// envelope metadata (ids, status, recipients) and there is nothing to extract from. So we accept,
// in this order:
//
//   1. { "text": "..." }                     PDF block readText output ({{steps.read.output.text}})
//   2. { "pages": ["...", "..."] }           PDF block readText output, page by page
//   3. { "pdfBase64": "..." }                raw PDF, e.g. from docusign.downloadDocument
//      (also "content" / "PDFBytes")
//   4. a DocuSign Connect event              data.envelopeSummary.envelopeDocuments[].PDFBytes
//
// Each shape may also arrive wrapped in { input }, { output } or { body } (a whole step output or
// trigger body passed through as-is). Anything else is rejected with a message saying what to add
// to the workflow, instead of extracting from nothing.
import { extractText, getDocumentProxy } from 'unpdf';

export type SourceDocument = { name: string; text: string };
export type Parsed = { documents: SourceDocument[]; envelopeId: string | null };

export class PayloadError extends Error {}

export async function pdfToText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

const base64ToBytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));

type Json = Record<string, any>;

export async function parsePayload(body: unknown): Promise<Parsed> {
  if (typeof body === 'string') return { documents: [{ name: 'document', text: body }], envelopeId: null };
  if (!body || typeof body !== 'object') throw new PayloadError('Request body must be JSON.');
  let b = body as Json;
  // Unwrap a step output / trigger body that was passed through whole.
  for (const key of ['input', 'output', 'body', 'result']) {
    if (b[key] && typeof b[key] === 'object' && !hasDocument(b)) b = b[key];
  }

  const envelopeId: string | null = b.envelopeId ?? b.data?.envelopeId ?? null;
  const name: string = b.name ?? b.fileName ?? b.documentName ?? 'document';

  if (typeof b.text === 'string' && b.text.trim()) return { documents: [{ name, text: b.text }], envelopeId };
  if (Array.isArray(b.pages) && b.pages.every((p: unknown) => typeof p === 'string')) {
    return { documents: [{ name, text: b.pages.join('\n') }], envelopeId };
  }
  const b64 = b.pdfBase64 ?? b.PDFBytes ?? b.content;
  if (typeof b64 === 'string' && b64.length > 100) {
    return { documents: [{ name, text: await pdfToText(base64ToBytes(b64)) }], envelopeId };
  }

  // DocuSign Connect event (JSON format) with "Include Documents" enabled.
  const envelopeDocs: Json[] = b.data?.envelopeSummary?.envelopeDocuments ?? [];
  const withBytes = envelopeDocs.filter((d) => typeof d.PDFBytes === 'string' && d.type !== 'summary');
  if (withBytes.length) {
    const documents = await Promise.all(
      withBytes.map(async (d) => ({ name: d.name ?? `document ${d.documentId}`, text: await pdfToText(base64ToBytes(d.PDFBytes)) })),
    );
    return { documents, envelopeId };
  }

  const keys = Object.keys(b).join(', ') || '(none)';
  const docusignHint = envelopeId
    ? ` This looks like a DocuSign event for envelope ${envelopeId} without the document. Either turn on ` +
      '"Include Documents" in the DocuSign Connect configuration, or add docusign.downloadDocument and a PDF ' +
      'block (readText) before this request and send {"text": "{{steps.<pdf step>.output.text}}"}.'
    : '';
  throw new PayloadError(
    `No document found in the request (top-level keys: ${keys}). Send {"text": "..."}, {"pages": [...]}, ` +
      `or {"pdfBase64": "..."}.${docusignHint}`,
  );
}

function hasDocument(b: Json): boolean {
  return ['text', 'pages', 'pdfBase64', 'PDFBytes', 'content'].some((k) => k in b) || !!b.data?.envelopeSummary;
}
