// Jev side of the extraction: one question per billing term, all sent in ONE request straight to the
// TypeSafe API. Jev only picks among the candidates regex.ts found (or "none"); it never writes a value.
//
//   document_type     Choice: invoice or contract (decides which amount question applies)
//   amount_due        Choice over the amounts found  } speculative fan-out: all three are asked,
//   total_value       Choice over the amounts found  } code keeps the one that applies to the
//   recurring_fee     Choice over the amounts found  } document type (see readAnswers)
//   billing_frequency Choice over a fixed list (no candidates needed)
//   start_date        Choice over the dates found
//   net_terms         Choice over the payment-term phrases found
//   tax_jurisdiction  Choice over the locations found
//   line_item::<i>    one Noul per candidate line: is this a billable line item?

import {
  amountInLine,
  findCandidates,
  parseAmount,
  parseCurrency,
  parseDate,
  parseNetDays,
  type Candidates,
} from './regex.js';

const API_URL = 'https://api.typesafe.ai/v1/systemone';
export const MODEL = 'jev-latest';
export const JEV_PRICE_PER_TOKEN = 0.042 / 1_000_000; // input tokens only; output tokens are free

export const REVIEW_BELOW = 0.6; // a Choice under this confidence goes to human review
const LINE_ITEM_YES = 0.5; // a line is a line item when P(yes) is at least this
const LINE_ITEM_UNSURE = [0.2, 0.8]; // ...and is flagged for review when P(yes) falls inside this band

const NONE = 'none';

// ------------------------------------------------------------------ questions

type Choice = { type: 'choice'; instructions: unknown; criteria: Record<string, string | null> };
type Noul = { type: 'noul'; instructions: unknown; criteria?: { true: string; false: string } };
type Question = Choice | Noul;

/** A Choice whose options are the candidate spans themselves, plus a "none" escape. */
function pick(instructions: unknown, candidates: string[], noneMeans: string): Choice {
  const criteria: Record<string, string | null> = {};
  for (const candidate of candidates.slice(0, 254)) criteria[candidate] = null; // 255 options max
  criteria[NONE] = noneMeans;
  return { type: 'choice', instructions, criteria };
}

const CANDIDATES_FOR = {
  amount_due: 'amounts',
  total_value: 'amounts',
  recurring_fee: 'amounts',
  start_date: 'dates',
  net_terms: 'netTerms',
  tax_jurisdiction: 'jurisdictions',
} as const;

export function buildQuestions(c: Candidates): Record<string, Question> {
  const questions: Record<string, Question> = {
    document_type: {
      type: 'choice',
      instructions: 'What kind of document is `document`?',
      criteria: {
        invoice: 'a bill for charges already incurred, with an amount due now',
        contract: 'an agreement, order form or amendment that sets fees for a term',
      },
    },
    // Speculative: each amount question is asked without knowing the document type, in the same
    // request. One conditional question ("if invoice... if contract...") is harder for Jev than
    // three direct ones.
    amount_due: pick(
      {
        question: 'Which amount is the final amount the customer must pay on this invoice?',
        not_this: 'a gross total or subtotal before commissions, discounts or credits are taken off, or a single line price',
      },
      c.amounts,
      'No amount is stated as the final amount due on an invoice.',
    ),
    total_value: pick(
      {
        question: 'Which amount is the total contract value: the total the customer pays over the whole term?',
        not_this: 'a superseded or replaced total, a savings figure, or a single period fee',
      },
      c.amounts,
      'No total contract value is stated.',
    ),
    recurring_fee: pick(
      {
        question: 'Which amount is the recurring fee the customer is charged each billing period?',
        not_this: 'a superseded or replaced rate, a one-time fee, or a total over the whole term',
      },
      c.amounts,
      'No recurring fee is stated.',
    ),
    billing_frequency: {
      type: 'choice',
      instructions:
        'How often is the customer invoiced for the main fee in `document`? ' +
        'If `document` is a single invoice, answer with the period that invoice covers.',
      criteria: {
        monthly: 'invoiced every month',
        quarterly: 'invoiced every three months',
        semi_annual: 'invoiced every six months',
        annual: 'invoiced once a year',
        one_time: 'a single charge that does not recur',
        [NONE]: 'the document does not say how often the customer is invoiced',
      },
    },
    start_date: pick(
      {
        question: 'Which date in `document` is the billing start date?',
        definition: 'the first day of the service or subscription term, or of the period being billed',
        not_this: 'a signing date, the date of an earlier agreement being amended, an invoice date, or a payment deadline',
      },
      c.dates,
      'The start date is not stated as a calendar date (for example it depends on a future event).',
    ),
    net_terms: pick(
      {
        question: 'Which phrase in `document` states how many days the customer has to pay an invoice after it is issued?',
        not_this: 'a deadline counted from some other event, such as funding, signing or go-live',
      },
      c.netTerms,
      'None of these phrases states the payment terms for invoices.',
    ),
    tax_jurisdiction: pick(
      {
        question: 'Which location in `document` is the tax jurisdiction for these charges?',
        definition:
          "the customer's location where the goods are delivered or the services are received (ship-to or service " +
          'address); the bill-to address only when no delivery or service location is given',
        not_this:
          "the vendor's address, a remit-to or payment address, a sales office, the state of incorporation, " +
          'or the governing-law jurisdiction, unless it is also the customer location',
      },
      c.jurisdictions,
      "None of these locations is the customer's location.",
    ),
  };
  // No candidates means nothing to pick from: skip the question, readAnswers reports "not found".
  for (const [id, candidates] of Object.entries(CANDIDATES_FOR)) if (c[candidates].length === 0) delete questions[id];

  c.lines.forEach((_, i) => {
    questions[`line_item::${i}`] = {
      type: 'noul',
      instructions:
        `Is \`candidate_lines[${i}]\` a billable line item: one product or service charged to the customer, ` +
        'listed with its own price or fee?',
      criteria: {
        true: 'the line is the main entry for one charged product or service',
        false:
          'the line is a total, subtotal, tax, commission, discount, payment instruction, a repeated detail row of ' +
          'an item already listed, or prose that only mentions an amount',
      },
    };
  });
  return questions;
}

// ------------------------------------------------------------------ the request

type ChoiceAnswer = { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> };
type NoulAnswer = { type: 'noul'; noul: number };
type Answer = ChoiceAnswer | NoulAnswer;

export type JevResult = {
  answers: Record<string, Answer>;
  model: string; // the versioned model that answered, e.g. "jev-1.13.0"
  inputTokens: number;
  ms: number;
};

/** One direct request to the TypeSafe API (no gateway) with every question. */
export async function askJev(document: string, candidates: Candidates): Promise<JevResult> {
  const t0 = performance.now();
  const request = JSON.stringify({
    model: MODEL,
    state: { document, candidate_lines: candidates.lines },
    questions: buildQuestions(candidates),
  });
  const res = await post(request);
  if (!res.ok) throw new Error(`TypeSafe API ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return { answers: body.answers, model: body.model, inputTokens: body.usage.input_tokens, ms: performance.now() - t0 };
}

/** POST with up to 2 retries on network errors, 429 and 5xx (short backoff: the workflow is waiting). */
async function post(body: string, attempts = 3): Promise<Response> {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
        body,
      });
      if ((res.status === 429 || res.status >= 500) && i < attempts) throw new Error(`TypeSafe API ${res.status}`);
      return res;
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 250 * i));
    }
  }
}

// ------------------------------------------------------------------ reading the answers

export type Field<T> = { value: T | null; source: string | null; confidence: number | null; review: boolean };
export type LineItem = { text: string; amount: number | null; p: number; review: boolean };

export type BillingTerms = {
  document_type: string;
  amount: Field<number> & { currency: string | null };
  billing_frequency: Field<string>;
  start_date: Field<string>;
  net_terms_days: Field<number>;
  tax_jurisdiction: Field<string>;
  line_items: LineItem[];
};

/** Copy the picked span and normalize it in code. "none" or low confidence -> human review. */
function field<T>(answer: Answer | undefined, normalize: (span: string) => T | null): Field<T> {
  if (!answer) return { value: null, source: null, confidence: null, review: true }; // no candidates found
  const a = answer as ChoiceAnswer;
  const source = a.choice === NONE ? null : a.choice;
  const value = source === null ? null : normalize(source);
  return { value, source, confidence: a.confidence, review: value === null || a.confidence < REVIEW_BELOW };
}

/**
 * Code routes the speculative amount answers: an invoice uses amount_due; a contract uses its total
 * value, falling back to the recurring fee when no total is stated. The other answers are ignored.
 * Confidence is the weakest of the judgments used (document type and the chosen amount).
 */
function chooseAmount(answers: Record<string, Answer>): Field<number> {
  const docType = answers.document_type as ChoiceAnswer;
  let amount: Field<number>;
  if (docType.choice === 'invoice') amount = field(answers.amount_due, parseAmount);
  else {
    amount = field(answers.total_value, parseAmount);
    if (amount.source === null) amount = field(answers.recurring_fee, parseAmount);
  }
  const confidence = Math.min(docType.confidence, amount.confidence ?? 1);
  return { ...amount, confidence, review: amount.review || confidence < REVIEW_BELOW };
}

export function readAnswers(answers: Record<string, Answer>, candidates: Candidates): BillingTerms {
  const amount = chooseAmount(answers);
  const lineItems = candidates.lines
    .map((text, i) => {
      const p = (answers[`line_item::${i}`] as NoulAnswer).noul;
      const amountSpan = amountInLine(text);
      return {
        text,
        amount: amountSpan ? parseAmount(amountSpan) : null,
        p,
        review: p > LINE_ITEM_UNSURE[0] && p < LINE_ITEM_UNSURE[1],
      };
    })
    .filter((item) => item.p >= LINE_ITEM_YES || item.review);

  return {
    document_type: (answers.document_type as ChoiceAnswer).choice,
    amount: { ...amount, currency: amount.source ? parseCurrency(amount.source) : null },
    billing_frequency: field(answers.billing_frequency, (choice) => choice),
    start_date: field(answers.start_date, parseDate),
    net_terms_days: field(answers.net_terms, parseNetDays),
    tax_jurisdiction: field(answers.tax_jurisdiction, (span) => span),
    line_items: lineItems,
  };
}

// ------------------------------------------------------------------ the whole step

export type Extraction = {
  terms: BillingTerms;
  needs_review: string[]; // fields a person should check (empty = straight through)
  meta: {
    model: string;
    candidates: Record<keyof Candidates, number>;
    regex_ms: number;
    jev_ms: number;
    input_tokens: number;
    usd: number;
  };
};

/** Find candidates (code) -> one Jev request -> copy and normalize the picks (code). */
export async function extractBillingTerms(document: string): Promise<Extraction> {
  const t0 = performance.now();
  const candidates = findCandidates(document);
  const regexMs = performance.now() - t0;
  const jev = await askJev(document, candidates);
  const terms = readAnswers(jev.answers, candidates);

  const needsReview = (['amount', 'billing_frequency', 'start_date', 'net_terms_days', 'tax_jurisdiction'] as const).filter(
    (key) => terms[key].review,
  ) as string[];
  if (terms.line_items.some((item) => item.review)) needsReview.push('line_items');

  return {
    terms,
    needs_review: needsReview,
    meta: {
      model: jev.model,
      candidates: Object.fromEntries(Object.entries(candidates).map(([k, v]) => [k, v.length])) as Extraction['meta']['candidates'],
      regex_ms: Math.round(regexMs * 10) / 10,
      jev_ms: Math.round(jev.ms),
      input_tokens: jev.inputTokens,
      usd: jev.inputTokens * JEV_PRICE_PER_TOKEN,
    },
  };
}
