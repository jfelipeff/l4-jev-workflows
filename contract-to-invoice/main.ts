// Loopfour step: "extract the billing terms - amount, billing frequency, start date, NET terms,
// line items, and tax jurisdiction" with Jev only (no LLM):
//
//   1. FIND     regex.ts finds candidate values in the document (code)
//   2. PICK     primitives.ts asks Jev, in one request, which candidate each term is (or "none")
//   3. COPY     the picked span is copied verbatim and normalized in code; "none" or low confidence
//               -> human review, like the workflow's "route confidence < 90% to human review"
//
// Usage:
//   npm start                              # every file in samples/
//   npm start -- samples/contract_nsb_pos_saas.txt [more files...] [--json]
import { readdirSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pdfToText } from './payload.js';
import { extractBillingTerms, REVIEW_BELOW, type BillingTerms, type Field } from './primitives.js';

const { positionals, values } = parseArgs({ allowPositionals: true, options: { json: { type: 'boolean' } } });
if (!process.env.TYPESAFE_API_KEY) {
  console.error('TYPESAFE_API_KEY is not set. Add it to .env in this folder (or export it) and run again.');
  process.exit(1);
}
const SAMPLES = new URL('./samples/', import.meta.url);
const paths = positionals.length
  ? positionals
  : readdirSync(SAMPLES).sort().map((name) => new URL(name, SAMPLES).pathname);

/** PDFs are read the same way the endpoint reads them; anything else is read as text. */
async function readDocument(path: string): Promise<string> {
  if (path.toLowerCase().endsWith('.pdf')) return pdfToText(new Uint8Array(readFileSync(path)));
  return readFileSync(path, 'utf8');
}

function show<T>(label: string, f: Field<T>, extra = '') {
  const value = f.value === null ? '—' : `${f.value}${extra}`;
  const conf = f.confidence === null ? ' n/a' : f.confidence.toFixed(2);
  const flag = f.review ? '  <== review' : '';
  const source = f.source ? `  ← "${f.source.length > 70 ? f.source.slice(0, 67) + '...' : f.source}"` : '';
  console.log(`  ${label.padEnd(18)}${value.padEnd(22)}conf ${conf}${flag}${source}`);
}

function print(terms: BillingTerms) {
  console.log(`  document type     ${terms.document_type}`);
  show('amount', terms.amount, terms.amount.currency ? ` ${terms.amount.currency}` : '');
  show('billing frequency', terms.billing_frequency);
  show('start date', terms.start_date);
  show('NET terms (days)', terms.net_terms_days);
  show('tax jurisdiction', terms.tax_jurisdiction);
  console.log(`  line items (${terms.line_items.filter((item) => !item.review).length}):`);
  for (const item of terms.line_items) {
    const text = item.text.length > 80 ? item.text.slice(0, 77) + '...' : item.text;
    console.log(`    P=${item.p.toFixed(2)}  ${String(item.amount ?? '—').padStart(10)}  ${text}${item.review ? '  <== review' : ''}`);
  }
}

let totalMs = 0;
let totalUsd = 0;
for (const path of paths) {
  const { terms, meta } = await extractBillingTerms(await readDocument(path));
  totalMs += meta.regex_ms + meta.jev_ms;
  totalUsd += meta.usd;

  const c = meta.candidates;
  console.log(`\n=== ${path.split('/').pop()}`);
  console.log(
    `  candidates: ${c.amounts} amounts, ${c.dates} dates, ${c.netTerms} NET phrases, ${c.jurisdictions} locations, ${c.lines} lines`,
  );
  if (values.json) console.log(JSON.stringify(terms, null, 2));
  else print(terms);
  console.log(
    `  time: regex ${meta.regex_ms} ms + Jev ${meta.jev_ms} ms · ${meta.input_tokens} tokens · $${meta.usd.toFixed(6)} · ${meta.model}`,
  );
}
console.log(
  `\n${paths.length} document(s): ${totalMs.toFixed(0)} ms, $${totalUsd.toFixed(6)} total ` +
    `(review threshold: confidence < ${REVIEW_BELOW})`,
);
