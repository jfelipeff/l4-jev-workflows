// Code side of the extraction: find every value that COULD be the answer, and normalize the one
// Jev picks. The regexes are tuned to over-find: Jev can reject a wrong candidate, but it can never
// pick a value that is missing from this list.

export type Candidates = {
  amounts: string[]; // "$28,481", "USD [****]" (redacted), "12,907.25 USD"
  dates: string[]; // "June 26, 2026", "11 February 2021", "10/09/12"
  netTerms: string[]; // "within thirty (30) days of the date of the invoice", "Net 30"
  durations: string[]; // "thirty-six (36) months", "Five (5) Years", "19-month" (term-length candidates)
  jurisdictions: string[]; // "Orange, CA 92867", "laws of England and Wales", "Quebec"
  lines: string[]; // document lines that mention a price or a fee (line-item candidates)
};

// ------------------------------------------------------------------ patterns

const NUMBER = String.raw`(?:\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)`; // no trailing comma
const MONEY = new RegExp(
  [
    String.raw`(?:USD|US\$|CAD|EUR|GBP|[$€£])\s?(?:${NUMBER}|\[\*+\])`, // $1,499 · USD [****]
    String.raw`\b${NUMBER}\s?(?:USD|dollars)\b`, // 1,499.00 USD
  ].join('|'),
  'gi',
);

const MONTH =
  String.raw`(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|` +
  String.raw`Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?`;
const DATE = new RegExp(
  [
    String.raw`\b${MONTH}\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b`, // June 26, 2026
    String.raw`\b\d{1,2}\s*(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH}\s+\d{4}\b`, // 11 February 2021 · 5 th March 2021
    String.raw`\b\d{1,2}/\d{1,2}/\d{2,4}\b`, // 10/09/12 (US order)
    String.raw`\b\d{4}-\d{2}-\d{2}\b`, // 2026-06-26
  ].join('|'),
  'gi',
);

// Each NET-terms candidate keeps a little of what the days are counted from ("...of the date of the
// invoice" vs "...of the date of Funding"): that tail is what lets Jev tell them apart.
const NUMBER_WORD = String.raw`(?:[a-z]+(?:-[a-z]+)?\s+)?`; // "thirty " · "forty-five "
const NET = new RegExp(
  [
    String.raw`\bnet[\s-]?\d{1,3}\b`, // Net 30 · NET-45
    String.raw`\bwithin\s+${NUMBER_WORD}\(?\d{1,3}\)?\s+(?:calendar\s+|business\s+)?days\b(?:\s+(?:of|from|after)(?:\s+[^\s.;|]+){1,8})?`, // + up to 8 words: counted from what
    String.raw`\b(?:payment\s+)?terms:?\s+\d{1,3}\s+days\b`, // Payment Terms 30 Days
    String.raw`\bdue\s+(?:up)?on\s+receipt\b`,
    String.raw`\b(?:settled|payable|due)\s+immediately(?:\s+[^\s.;|]+){0,6}`,
  ].join('|'),
  'gi',
);

// Durations, for the contract term. Payment windows ("30 days") are left out on purpose.
const DURATION = new RegExp(
  String.raw`\b(?:[a-z]+(?:-[a-z]+)?\s+)?\(?\d{1,3}\)?[\s-]+(?:calendar\s+)?(?:months?|years?)\b|` +
    String.raw`\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twelve|eighteen|twenty-four|thirty-six|forty-eight|sixty)[\s-]+(?:months?|years?)\b`,
  'gi',
);

const US_STATES = [
  'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'Florida',
  'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine',
  'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska',
  'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio',
  'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas',
  'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming',
];
const OTHER_REGIONS = [
  'Alberta', 'British Columbia', 'Manitoba', 'New Brunswick', 'Newfoundland', 'Nova Scotia', 'Ontario', 'Quebec',
  'Saskatchewan', 'Canada', 'United States', 'England and Wales', 'England', 'Scotland', 'Ireland',
  'United Kingdom', 'Germany', 'France', 'Netherlands', 'Mexico', 'Australia', 'Bahrain', 'Singapore', 'India',
];
const JURISDICTION = new RegExp(
  [
    String.raw`\b[A-Z][A-Za-z.'-]*(?: [A-Z][A-Za-z.'-]*){0,3},\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\b`, // Orange, CA 92867
    String.raw`\blaws\s+of\s+(?:the\s+)?(?:(?:State|Province|Commonwealth)\s+of\s+)?[A-Z][a-z]+(?:\s+(?:and\s+)?[A-Z][a-z]+)*`,
    `\\b(?:${[...US_STATES, ...OTHER_REGIONS].join('|')})\\b`,
  ].join('|'),
  'g',
);

const FEE_WORD = /\bfees?\b/i;
const DECIMAL_AMOUNT = /\b\d{1,3}(?:,\d{3})*\.\d{2}\b/g; // 3,468.00 in a table row without a currency sign
const MAX_LINES = 80; // one Noul per line; keeps the request small

// ------------------------------------------------------------------ finding

/** Every match of `pattern`, whitespace collapsed, deduplicated, in document order. */
function find(pattern: RegExp, text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    const span = match[0].replace(/\s+/g, ' ').trim();
    if (span) seen.add(span);
  }
  return [...seen];
}

/** Lines that mention an amount or a fee. Not deduplicated: two identical rows can be two items. */
function findLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0 && line.length <= 400)
    .filter((line) => new RegExp(MONEY.source, 'i').test(line) || line.match(DECIMAL_AMOUNT) || FEE_WORD.test(line))
    .slice(0, MAX_LINES);
}

export function findCandidates(document: string): Candidates {
  return {
    amounts: find(MONEY, document),
    dates: find(DATE, document),
    netTerms: find(NET, document),
    durations: find(DURATION, document),
    jurisdictions: find(JURISDICTION, document),
    lines: findLines(document),
  };
}

// ------------------------------------------------------------------ normalizing the pick

/** "$28,481" -> 28481 · "USD [****]" -> null (redacted in the source). */
export function parseAmount(span: string): number | null {
  if (/\[\*+\]/.test(span)) return null;
  const digits = span.replace(/[^\d.]/g, '');
  return digits ? Number(digits) : null;
}

export function parseCurrency(span: string): string | null {
  if (/USD|US\$|dollars/i.test(span)) return 'USD';
  if (/CAD/i.test(span)) return 'CAD';
  if (/EUR|€/i.test(span)) return 'EUR';
  if (/GBP|£/i.test(span)) return 'GBP';
  if (span.includes('$')) return 'USD'; // assumption: a bare "$" is US dollars
  return null;
}

const MONTH_INDEX: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Any format DATE matches -> "YYYY-MM-DD", or null when the parts are not a real date. */
export function parseDate(span: string): string | null {
  let y: number, m: number, d: number;
  let match: RegExpMatchArray | null;
  if ((match = span.match(/^(\d{4})-(\d{2})-(\d{2})$/))) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = span.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/))) {
    [m, d, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (y < 100) y += y < 70 ? 2000 : 1900; // "10/09/12" -> 2012
  } else {
    const month = span.match(/[A-Za-z]{3}/g)?.find((word) => word.toLowerCase() in MONTH_INDEX);
    const numbers = span.match(/\d+/g)?.map(Number) ?? [];
    if (!month || numbers.length < 2) return null;
    m = MONTH_INDEX[month.toLowerCase()];
    d = numbers[0];
    y = numbers[numbers.length - 1];
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null; // e.g. February 30
  return date.toISOString().slice(0, 10);
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  twelve: 12, eighteen: 18, 'twenty-four': 24, 'thirty-six': 36, 'forty-eight': 48, sixty: 60,
};

/** "thirty-six (36) months" -> 36 · "Five (5) Years" -> 60 · "three years" -> 36. */
export function parseMonths(span: string): number | null {
  const digits = span.match(/\d{1,3}/);
  const word = span.toLowerCase().match(/[a-z]+(?:-[a-z]+)?(?=[\s-]+(?:calendar\s+)?(?:months?|years?))/)?.[0];
  const n = digits ? Number(digits[0]) : word ? WORD_NUMBERS[word] : undefined;
  if (!n) return null;
  return /year/i.test(span) ? n * 12 : n;
}

/** "within thirty (30) days ..." -> 30 · "due on receipt" / "settled immediately" -> 0. */
export function parseNetDays(span: string): number | null {
  if (/due\s+(?:up)?on\s+receipt|immediately/i.test(span)) return 0;
  const digits = span.match(/\d{1,3}/);
  return digits ? Number(digits[0]) : null;
}

/** The amount on a line-item line: the first one with a currency, else the last number with cents
 * (in a table row the line total is usually the right-most column). */
export function amountInLine(line: string): string | null {
  return line.match(new RegExp(MONEY.source, 'i'))?.[0] ?? line.match(DECIMAL_AMOUNT)?.at(-1) ?? null;
}
