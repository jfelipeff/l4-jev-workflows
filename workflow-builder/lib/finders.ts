// Code side of extraction: every value in the text that COULD be the answer, normalized, with a
// little surrounding context so Jev can tell identical values apart. Jev only ever picks among these.

export type Candidate = { value: string | number; raw: string; context: string };

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH = String.raw`(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?`;
const NUM = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;

const PATTERNS: Record<string, RegExp> = {
  money: new RegExp(String.raw`(?:USD|US\$|CAD|EUR|GBP|[$€£])\s?(?:${NUM})(?:\s?[kKmM]\b)?|\b(?:${NUM})\s?(?:USD|EUR|GBP|CAD|dollars)\b`, 'g'),
  percent: new RegExp(String.raw`\b(?:${NUM})\s?%`, 'g'),
  number: new RegExp(String.raw`(?<![\w$€£.,/-])(?:${NUM})(?![\w%/]|[.,]\d)`, 'g'),
  date: new RegExp(
    [
      String.raw`\b${MONTH}\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b`,
      String.raw`\b\d{1,2}\s*(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH},?\s+\d{4}\b`,
      String.raw`\b\d{4}-\d{2}-\d{2}\b`,
      String.raw`\b\d{1,2}/\d{1,2}/\d{2,4}\b`,
    ].join('|'),
    'gi',
  ),
  email: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
  url: /https?:\/\/[^\s"'<>)]+/g,
  phone: /(?<!\w)\+?\(?\d{1,3}\)?[\s.-]?\(?\d{2,4}\)?[\s.-]\d{3,4}[\s.-]?\d{3,4}(?!\w)/g,
  duration: /\b(?:[a-z]+(?:-[a-z]+)?\s+)?\(?\d{1,3}\)?[\s-]+(?:days?|weeks?|months?|years?)\b/gi,
  code: /\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9]+(?:-[A-Z0-9]+)+\b|#\s?\d{3,}\b/g, // INV-2026-0417, #4471
};

function toNumber(raw: string): number | null {
  const m = raw.replace(/[^\d.,kKmM]/g, '').replace(/,/g, '').match(/^(\d+(?:\.\d+)?)([kKmM])?/);
  if (!m) return null;
  return Number(m[1]) * (m[2] ? (/k/i.test(m[2]) ? 1e3 : 1e6) : 1);
}

export function toIsoDate(raw: string): string | null {
  let y: number, mo: number, d: number;
  let m: RegExpMatchArray | null;
  if ((m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/))) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else if ((m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/))) {
    [mo, d, y] = [+m[1], +m[2], +m[3]];
    if (y < 100) y += y < 70 ? 2000 : 1900;
  } else {
    const month = raw.match(/[A-Za-z]{3}/g)?.find((w) => w.toLowerCase() in MONTHS);
    const nums = raw.match(/\d+/g)?.map(Number) ?? [];
    if (!month || nums.length < 2) return null;
    [mo, d, y] = [MONTHS[month.toLowerCase()], nums[0], nums[nums.length - 1]];
  }
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date.toISOString().slice(0, 10) : null;
}

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, thirty: 30, sixty: 60, ninety: 90 };

/** Candidates of one kind, deduplicated by normalized value (first contexts kept). */
export function find(kind: keyof typeof PATTERNS | 'numeric', text: string, limit = 120): Candidate[] {
  const kinds = kind === 'numeric' ? (['money', 'percent', 'number', 'duration'] as const) : [kind];
  const seen = new Map<string, Candidate>();
  for (const k of kinds) {
    for (const m of text.matchAll(PATTERNS[k])) {
      const raw = m[0].trim();
      let value: string | number | null = raw;
      if (k === 'money' || k === 'percent' || k === 'number') value = toNumber(raw);
      if (k === 'duration') {
        const n = raw.match(/\d+/)?.[0] ?? raw.toLowerCase().match(/^([a-z]+)/)?.[1];
        value = n ? (Number(n) || WORDS[n] || null) : null;
      }
      if (k === 'date') value = toIsoDate(raw);
      if (k === 'email') value = raw.toLowerCase().replace(/\.$/, '');
      if (value === null || value === '') continue;
      const key = `${value}`;
      if (seen.has(key)) continue;
      const at = m.index ?? 0;
      const context = text.slice(Math.max(0, at - 50), at + raw.length + 50).replace(/\s+/g, ' ').trim();
      seen.set(key, { value, raw, context });
      if (seen.size >= limit) break;
    }
  }
  return [...seen.values()];
}

/** Word sequences (1..max words) inside one line: the options for picking an exact name or phrase. */
export function phrases(line: string, max = 8, limit = 250): string[] {
  const words = line.split(/\s+/).filter(Boolean);
  const out = new Set<string>([line]);
  for (let n = 1; n <= Math.min(max, words.length); n++) {
    for (let i = 0; i + n <= words.length; i++) {
      const p = words.slice(i, i + n).join(' ').replace(/^[^\w$€£#@(]+|[^\w%)]+$/g, '');
      if (p) out.add(p);
      if (out.size >= limit) return [...out];
    }
  }
  return [...out];
}
