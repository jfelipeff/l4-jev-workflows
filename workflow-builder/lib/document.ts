// Document input shared by /api/extract and /api/classify: whatever a Loopfour step sends (plain text,
// a PDF block's {text} or {pages}, a whole step output), turned into text and numbered lines.

export const MAX_CHARS = 100_000; // Jev reads up to ~32k tokens of state; leave room for the questions

export class InputError extends Error {}

type Json = Record<string, unknown>;

/** Text from: "..." | {text} | {pages: [...]} | {document|input|output|data|body: <any of these>}. */
export function documentText(input: unknown, depth = 0): string {
  if (typeof input === 'string') return input;
  if (Array.isArray(input) && input.every((p) => typeof p === 'string')) return input.join('\n');
  if (input && typeof input === 'object' && depth < 4) {
    const o = input as Json;
    if (typeof o.text === 'string') return o.text;
    if (Array.isArray(o.pages)) return documentText(o.pages, depth + 1);
    for (const k of ['document', 'content', 'input', 'output', 'result', 'data', 'body']) {
      if (o[k] !== undefined) {
        const t = documentText(o[k], depth + 1);
        if (t) return t;
      }
    }
    return JSON.stringify(input, null, 1); // a record (e.g. a Stripe object): its JSON is the text
  }
  return '';
}

export type Line = { id: string; text: string };

/** Non-empty lines, tagged L001..; long documents are packed so there are at most `max` lines. */
export function tagLines(text: string, max = 240): Line[] {
  let lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (lines.length > max) {
    const per = Math.ceil(lines.length / max);
    const packed: string[] = [];
    for (let i = 0; i < lines.length; i += per) packed.push(lines.slice(i, i + per).join(' / '));
    lines = packed;
  }
  return lines.map((t, i) => ({ id: `L${String(i + 1).padStart(3, '0')}`, text: t }));
}

export const taggedText = (lines: Line[]) => lines.map((l) => `${l.id}| ${l.text}`).join('\n');

export function readDocument(body: Json): { text: string; truncated: boolean } {
  const raw = documentText(body.document ?? body.text ?? body.input ?? body.pages ?? body.data);
  if (!raw.trim()) throw new InputError('Send the document as "document" (text, {text}, {pages} or a step output).');
  return raw.length > MAX_CHARS ? { text: raw.slice(0, MAX_CHARS), truncated: true } : { text: raw, truncated: false };
}
