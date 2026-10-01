'use client';

import { useState } from 'react';
import { Badge, CopyBlock, Metric, pct } from './ui.tsx';

const SITE = 'https://l4-jev-workflow-builder.vercel.app';

const SAMPLE_CONTRACT = `SUBSCRIPTION ORDER FORM
Order Form No. BP-OF-2026-0417 · Order Form Date: September 30, 2026
Provider: Brightpath Commerce Cloud, Inc., 1200 Harbor Way, Suite 400, Oakland, CA 94607 · billing@brightpath.example
Customer: Northwind Outfitters, Inc., 500 Congress Avenue, Austin, TX 78701 · Attn: Jordan Lee, Accounts Payable
1. Subscription Term
The Subscription Start Date is November 1, 2026. The initial term of this Order Form is thirty-six (36) months from the Subscription Start Date. Thereafter this Order Form renews for successive twelve (12) month renewal terms unless either party gives notice of non-renewal at least sixty (60) days before the end of the then-current term.
2. Subscription Fees
1 Brightpath Retail Platform subscription (40 stores) Annual $48,000.00
2 POS Connect module Annual $18,000.00
3 Premium Support (24x7) Annual $6,000.00
The Annual Subscription Fee is $72,000.00 per year, invoiced quarterly in advance in four equal installments of $18,000.00. The total contract value for the Initial Term is $216,000.00.
3. Invoicing and Payment
All invoices are payable within thirty (30) days of the invoice date. Late amounts accrue interest at 1.5% per month.`;

const SAMPLE_SCHEMA = JSON.stringify(
  {
    type: 'object',
    required: ['customer_name', 'acv', 'start_date'],
    properties: {
      customer_name: { type: 'string', description: 'legal name of the customer' },
      acv: { type: 'number', description: 'annual subscription fee' },
      total_contract_value: { type: 'number' },
      term_months: { type: 'integer', description: 'length of the initial term in months' },
      start_date: { type: 'string', format: 'date', description: 'subscription start date' },
      billing_frequency: { type: 'string', enum: ['monthly', 'quarterly', 'annual', 'one_time'] },
      net_terms_days: { type: 'integer', description: 'days the customer has to pay an invoice' },
      auto_renews: { type: 'boolean', description: 'the order form renews automatically' },
      line_items: { type: 'array', items: { type: 'object', properties: { description: { type: 'string' }, annual_fee: { type: 'number' } } } },
    },
  },
  null,
  2,
);

const SAMPLE_TICKETS = [
  'Hi, I was charged twice for order A-104 this month. Please refund one of them.',
  'The dashboard shows a 500 error every time I try to log in since this morning.',
  'Can you send me pricing for 50 seats and book a demo next week?',
  'Charged twice and now I cannot log in to download the invoice.',
];
const SAMPLE_LABELS = `billing: charges, invoices, refunds, payments
technical: bugs, errors, outages, login problems
sales: pricing, quotes, demos, new seats`;

type Usage = { requests: number; questions: number; jev_ms: number; input_tokens: number; usd: number };

async function post(path: string, jevKey: string, body: unknown) {
  const t0 = performance.now();
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-jev-key': jevKey }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok || !json.ok) throw new Error(json.error ?? `Error ${res.status}`);
  return { json, wall: performance.now() - t0 };
}

function UsageRow({ usage, wall }: { usage: Usage; wall: number }) {
  return (
    <section className="metrics">
      <Metric label="Jev time" value={`${usage.jev_ms} ms`} />
      <Metric label="End to end" value={`${(wall / 1000).toFixed(2)} s`} />
      <Metric label="Jev cost" value={`$${usage.usd.toFixed(6)}`} />
      <Metric label="Requests · questions" value={`${usage.requests} · ${usage.questions}`} />
      <Metric label="LLM calls" value="0" />
    </section>
  );
}

/** The API Request block a Loopfour workflow uses to call this function. */
function studioConfig(endpoint: 'extract' | 'classify', body: Record<string, unknown>) {
  return {
    block: 'API Request',
    url: `${SITE}/api/${endpoint}`,
    method: 'POST',
    headers: [{ Key: 'x-jev-key', Value: '{{secrets.JEV_API_KEY}}' }],
    body: { ...body, document: '{{steps.<previous_step>.result}}' },
    responseFormat: 'json',
    retries: 2,
    retryNonIdempotent: true,
  };
}

export function ExtractPanel({ jevKey }: { jevKey: string }) {
  const [document, setDocument] = useState(SAMPLE_CONTRACT);
  const [instructions, setInstructions] = useState('Extract the billing terms from this order form.');
  const [schema, setSchema] = useState(SAMPLE_SCHEMA);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ json: { output: Record<string, unknown>; fields: Record<string, { value: unknown; confidence: number | null; source: string | null; review: boolean }>; needs_review: string[]; usage: Usage }; wall: number } | null>(null);

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(schema);
  } catch {
    parsed = schema.split(',').map((s) => s.trim()).filter(Boolean); // a plain field list also works
  }

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setResult(await post('/api/extract', jevKey, { document, instructions, schema: parsed }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="card">
        <p className="lead">
          Turn any document into JSON with the fields you define, like the AI Agent block&apos;s Output Schema, but every value is
          picked by Jev from candidates found in the text and copied verbatim. Nothing is generated, so nothing can be invented.
        </p>
        <label htmlFor="ex-doc">Document</label>
        <textarea id="ex-doc" rows={9} value={document} onChange={(e) => setDocument(e.target.value)} />
        <label htmlFor="ex-ins">Instructions</label>
        <input id="ex-ins" value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        <label htmlFor="ex-schema">Output schema (JSON Schema, or a comma-separated list of field names)</label>
        <textarea id="ex-schema" className="mono" rows={9} value={schema} onChange={(e) => setSchema(e.target.value)} />
        <button className="primary" disabled={!jevKey || !document || busy} onClick={run}>
          {busy ? 'Jev is extracting…' : 'Extract'}
        </button>
        {!jevKey && <p className="hint">Enter your Jev API key above.</p>}
        {error && <p className="error">{error}</p>}
      </section>

      {result && (
        <>
          <UsageRow usage={result.json.usage} wall={result.wall} />
          <section className="card">
            <h2>Result{result.json.needs_review.length ? ` · ${result.json.needs_review.length} to review` : ''}</h2>
            <ol className="flow">
              {Object.entries(result.json.fields).map(([name, f]) => (
                <li key={name} className="node">
                  <span className="kind">{name}</span>
                  <strong className="value">{typeof f.value === 'string' ? f.value : JSON.stringify(f.value)}</strong>
                  {f.source && <span className="detail">from: {f.source}</span>}
                  {f.review && <span className="branch else">review</span>}
                  <Badge c={f.confidence} />
                </li>
              ))}
            </ol>
          </section>
          <section className="card">
            <CopyBlock title="Output (what the next workflow step receives as data.output)" value={result.json.output} />
            <CopyBlock title="Use it in a Loopfour workflow: API Request block" value={studioConfig('extract', { instructions, schema: parsed })} />
          </section>
        </>
      )}
    </>
  );
}

export function ClassifyPanel({ jevKey }: { jevKey: string }) {
  const [document, setDocument] = useState(SAMPLE_TICKETS[0]);
  const [instructions, setInstructions] = useState('Route this support ticket to the right team.');
  const [labels, setLabels] = useState(SAMPLE_LABELS);
  const [multi, setMulti] = useState(false);
  const [allowNone, setAllowNone] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ json: { label: string | null; labels: string[]; confidence: number | null; probabilities: Record<string, number>; applies: Record<string, number>; needs_review: boolean; usage: Usage }; wall: number } | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setResult(await post('/api/classify', jevKey, { document, instructions, labels, multi_label: multi, allow_none: allowNone }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const scores = result ? (multi ? result.json.applies : result.json.probabilities) : {};
  return (
    <>
      <section className="card">
        <p className="lead">
          Assign a document to your labels with calibrated probabilities. One label (with a check that it really applies, so
          &quot;none fits&quot; is possible) or several at once. Low-confidence results are flagged for review instead of guessed.
        </p>
        <label htmlFor="cl-doc">Document</label>
        <textarea id="cl-doc" rows={4} value={document} onChange={(e) => setDocument(e.target.value)} />
        <div className="examples">
          {SAMPLE_TICKETS.map((t) => (
            <button key={t} className="chip" onClick={() => setDocument(t)} title={t}>
              {t.length > 48 ? `${t.slice(0, 46)}…` : t}
            </button>
          ))}
        </div>
        <label htmlFor="cl-ins">Instructions</label>
        <input id="cl-ins" value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        <label htmlFor="cl-labels">Labels (one per line, optional &quot;label: description&quot;)</label>
        <textarea id="cl-labels" className="mono" rows={5} value={labels} onChange={(e) => setLabels(e.target.value)} />
        <div className="checks">
          <label>
            <input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} /> several labels can apply
          </label>
          <label>
            <input type="checkbox" checked={allowNone} onChange={(e) => setAllowNone(e.target.checked)} disabled={multi} /> allow &quot;none
            fits&quot;
          </label>
        </div>
        <button className="primary" disabled={!jevKey || !document || busy} onClick={run}>
          {busy ? 'Jev is classifying…' : 'Classify'}
        </button>
        {!jevKey && <p className="hint">Enter your Jev API key above.</p>}
        {error && <p className="error">{error}</p>}
      </section>

      {result && (
        <>
          <UsageRow usage={result.json.usage} wall={result.wall} />
          <section className="card">
            <h2>
              {result.json.labels.length ? result.json.labels.join(' + ') : 'No label fits'}
              {result.json.needs_review && <span className="branch else"> · review</span>}
            </h2>
            <div className="bars">
              {Object.entries(scores)
                .sort((a, b) => b[1] - a[1])
                .map(([label, p]) => (
                  <div key={label} className="bar">
                    <span>{label}</span>
                    <div className="track">
                      <div className={`fill ${result.json.labels.includes(label) ? 'on' : ''}`} style={{ width: `${Math.round(p * 100)}%` }} />
                    </div>
                    <small>{pct(p)}</small>
                  </div>
                ))}
            </div>
            <p className="hint">{multi ? 'P(label applies), each judged on its own.' : 'Probability across the labels (they add up to 100%).'}</p>
          </section>
          <section className="card">
            <CopyBlock title="Use it in a Loopfour workflow: API Request block" value={studioConfig('classify', { instructions, labels, multi_label: multi, allow_none: allowNone })} />
          </section>
        </>
      )}
    </>
  );
}
