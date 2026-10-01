'use client';

import { useState } from 'react';
import { SAMPLE_CONTRACT, SAMPLE_LABELS, SAMPLE_SCHEMA, SAMPLE_TICKETS } from '@/lib/samples.ts';
import { Badge, CopyBlock, Metric, pct } from './ui.tsx';

const SITE = 'https://l4-jev-workflow-builder.vercel.app';

type Usage = { requests: number; questions: number; jev_ms: number; input_tokens: number; usd: number };
type Escalation = { model: string; escalated: string[]; accepted: string[]; rejected: { name: string; reason: string }[]; llm_ms: number; llm_usd: number };

async function post(path: string, jevKey: string, body: unknown, loopfourKey?: string) {
  const t0 = performance.now();
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-jev-key': jevKey };
  if (loopfourKey) headers['x-loopfour-key'] = loopfourKey; // opt-in cascade
  const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok || !json.ok) throw new Error(json.error ?? `Error ${res.status}`);
  return { json, wall: performance.now() - t0 };
}

/** Cascade toggle: only answers Jev is unsure about go to an LLM, and Jev must confirm them. */
function CascadeToggle({ on, set, apiKey }: { on: boolean; set: (v: boolean) => void; apiKey: string }) {
  return (
    <div className="checks">
      <label title="Uses your Loopfour key: runs Loopfour's claude-opus-5 as an agent in your workspace">
        <input type="checkbox" checked={on && !!apiKey} disabled={!apiKey} onChange={(e) => set(e.target.checked)} /> Send only uncertain answers to
        an LLM (Loopfour&apos;s claude-opus-5); Jev must confirm its answer{!apiKey && ' (enter your Loopfour key in the API keys box)'}
      </label>
    </div>
  );
}

function EscalationNote({ e }: { e?: Escalation }) {
  if (!e) return <p className="hint">No LLM call: Jev settled every answer.</p>;
  return (
    <p className="hint">
      LLM fallback ({e.model}) for {e.escalated.join(', ')}: {e.llm_ms} ms, ${e.llm_usd.toFixed(4)}.{' '}
      {e.accepted.length ? `Accepted after Jev confirmed: ${e.accepted.join(', ')}. ` : ''}
      {e.rejected.length ? `Still for review: ${e.rejected.map((r) => `${r.name} (${r.reason})`).join('; ')}.` : ''}
    </p>
  );
}

function UsageRow({ usage, wall }: { usage: Usage; wall: number }) {
  return (
    <section className="metrics">
      <Metric label="Jev time" value={`${usage.jev_ms} ms`} />
      <Metric label="End to end" value={`${(wall / 1000).toFixed(2)} s`} />
      <Metric label="Jev cost" value={`$${usage.usd.toFixed(6)}`} />
      <Metric label="Requests · questions" value={`${usage.requests} · ${usage.questions}`} />
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

export function ExtractPanel({ jevKey, apiKey }: { jevKey: string; apiKey: string }) {
  const [cascade, setCascade] = useState(false);
  const [document, setDocument] = useState(SAMPLE_CONTRACT);
  const [instructions, setInstructions] = useState('Extract the billing terms from this order form.');
  const [schema, setSchema] = useState(SAMPLE_SCHEMA);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ json: { output: Record<string, unknown>; fields: Record<string, { value: unknown; confidence: number | null; source: string | null; review: boolean; by?: string }>; needs_review: string[]; escalation?: Escalation; usage: Usage }; wall: number } | null>(null);

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
      setResult(await post('/api/extract', jevKey, { document, instructions, schema: parsed }, cascade && apiKey ? apiKey : undefined));
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
        <CascadeToggle on={cascade} set={setCascade} apiKey={apiKey} />
        <button className="primary" disabled={!jevKey || !document || busy} onClick={run}>
          {busy ? 'Jev is extracting…' : 'Extract'}
        </button>
        {!jevKey && <p className="hint">Enter your Jev API key in the API keys box.</p>}
        {error && <p className="error">{error}</p>}
      </section>

      {result && (
        <>
          <UsageRow usage={result.json.usage} wall={result.wall} />
          <section className="card">
            <h2>Result{result.json.needs_review.length ? ` · ${result.json.needs_review.length} to review` : ''}</h2>
            {cascade && <EscalationNote e={result.json.escalation} />}
            <ol className="flow">
              {Object.entries(result.json.fields).map(([name, f]) => (
                <li key={name} className="node">
                  <span className="kind">{name}</span>
                  <strong className="value">{typeof f.value === 'string' ? f.value : JSON.stringify(f.value)}</strong>
                  {f.source && <span className="detail">from: {f.source}</span>}
                  {f.by === 'llm+jev' && <span className="branch then">LLM answer, confirmed by Jev</span>}
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

export function ClassifyPanel({ jevKey, apiKey }: { jevKey: string; apiKey: string }) {
  const [cascade, setCascade] = useState(false);
  const [document, setDocument] = useState(SAMPLE_TICKETS[0]);
  const [instructions, setInstructions] = useState('Route this support ticket to the right team.');
  const [labels, setLabels] = useState(SAMPLE_LABELS);
  const [multi, setMulti] = useState(false);
  const [allowNone, setAllowNone] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ json: { label: string | null; labels: string[]; confidence: number | null; probabilities: Record<string, number>; applies: Record<string, number>; needs_review: boolean; by?: string; escalation?: Escalation; usage: Usage }; wall: number } | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setResult(await post('/api/classify', jevKey, { document, instructions, labels, multi_label: multi, allow_none: allowNone }, cascade && apiKey ? apiKey : undefined));
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
        <CascadeToggle on={cascade} set={setCascade} apiKey={apiKey} />
        <button className="primary" disabled={!jevKey || !document || busy} onClick={run}>
          {busy ? 'Jev is classifying…' : 'Classify'}
        </button>
        {!jevKey && <p className="hint">Enter your Jev API key in the API keys box.</p>}
        {error && <p className="error">{error}</p>}
      </section>

      {result && (
        <>
          <UsageRow usage={result.json.usage} wall={result.wall} />
          <section className="card">
            <h2>
              {result.json.labels.length ? result.json.labels.join(' + ') : 'No label fits'}
              {result.json.needs_review && <span className="branch else"> · review</span>}
              {result.json.by === 'llm+jev' && <span className="branch then"> · LLM answer, confirmed by Jev</span>}
            </h2>
            {cascade && <EscalationNote e={result.json.escalation} />}
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
