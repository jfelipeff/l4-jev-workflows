'use client';

// Jev vs LLM, live: the same input goes to Jev (this site's normal endpoint) and to claude-opus-5 (an agent
// in the visitor's Loopfour workspace) at the same moment, and both lanes are timed in the browser.

import { useEffect, useRef, useState } from 'react';
import { assemble } from '@/lib/assemble.ts';
import { SAMPLE_CONTRACT, SAMPLE_LABELS, SAMPLE_SCHEMA, SAMPLE_TICKETS } from '@/lib/samples.ts';
import { JEV_EXAMPLES } from './examples.tsx';
import { KeyHint } from './ui.tsx';

type Kind = 'builder' | 'extract' | 'classify';
type Lane = { start: number; end?: number; usd?: number | null; result?: Record<string, unknown>; error?: string };

const MODES: { id: Kind; label: string }[] = [
  { id: 'builder', label: 'Build a workflow' },
  { id: 'extract', label: 'Extract fields' },
  { id: 'classify', label: 'Classify a document' },
];
const PROMPTS = JEV_EXAMPLES.flatMap((g) => g.items.map((i) => i.prompt));

const secs = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
const money = (usd: number | null | undefined) => (usd == null ? '—' : usd < 0.001 ? `$${usd.toFixed(6)}` : `$${usd.toFixed(4)}`);
const show = (v: unknown) => (v == null ? '—' : typeof v === 'string' ? v : JSON.stringify(v));
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null).toLowerCase() === JSON.stringify(b ?? null).toLowerCase();

async function call(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw new Error(json.error ?? `Error ${res.status}`);
  return json as Record<string, unknown>;
}

export function RacePanel({ apiKey, jevKey }: { apiKey: string; jevKey: string }) {
  const [kind, setKind] = useState<Kind>('builder');
  const [description, setDescription] = useState(PROMPTS[1]);
  const [document, setDocument] = useState(SAMPLE_CONTRACT);
  const [schema, setSchema] = useState(SAMPLE_SCHEMA);
  const [ticket, setTicket] = useState(SAMPLE_TICKETS[0]);
  const [labels, setLabels] = useState(SAMPLE_LABELS);
  const [jev, setJev] = useState<Lane | null>(null);
  const [llm, setLlm] = useState<Lane | null>(null);
  const [raceKind, setRaceKind] = useState<Kind>('builder');
  const [now, setNow] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Load the Loopfour catalog and templates ahead of the first race, so neither lane pays for that read.
  useEffect(() => {
    if (!apiKey.startsWith('wfk_')) return;
    const t = setTimeout(() => void fetch('/api/warm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey }) }).catch(() => {}), 400);
    return () => clearTimeout(t);
  }, [apiKey]);

  // When a race starts, bring the two lanes to the middle of the screen.
  const lanesRef = useRef<HTMLElement>(null);
  const raceStart = jev?.start;
  useEffect(() => {
    if (raceStart) lanesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [raceStart]);

  const running = (jev && !jev.end) || (llm && !llm.end);
  useEffect(() => {
    if (!running) return;
    let frame = 0;
    const tick = () => {
      setNow(performance.now());
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [running]);

  async function race() {
    setError(null);
    let parsedSchema: unknown;
    if (kind === 'extract') {
      try {
        parsedSchema = JSON.parse(schema);
      } catch {
        setError('The schema is not valid JSON.');
        return;
      }
    }
    const t0 = performance.now();
    setRaceKind(kind);
    setNow(t0);
    setJev({ start: t0 });
    setLlm({ start: t0 });

    const jevCall =
      kind === 'builder'
        ? call('/api/plan', { apiKey, jevKey, description, force: {} })
        : kind === 'extract'
          ? call('/api/extract', { document, instructions: 'Extract the fields in the schema from this document.', schema: parsedSchema }, { 'x-jev-key': jevKey })
          : call('/api/classify', { document: ticket, instructions: 'Classify this document.', labels, allow_none: true }, { 'x-jev-key': jevKey });
    const llmCall =
      kind === 'builder'
        ? call('/api/race', { apiKey, kind, description })
        : kind === 'extract'
          ? call('/api/race', { apiKey, kind, document, instructions: 'Extract the fields in the schema from this document.', schema: parsedSchema })
          : call('/api/race', { apiKey, kind, document: ticket, instructions: 'Classify this document.', labels });

    const finish = (set: (l: Lane) => void, usdOf: (r: Record<string, unknown>) => number | null) => (p: Promise<Record<string, unknown>>) =>
      p.then(
        (r) => set({ start: t0, end: performance.now(), result: r, usd: usdOf(r) }),
        (e: Error) => set({ start: t0, end: performance.now(), error: e.message }),
      );
    finish(setJev, (r) => ((kind === 'builder' ? (r.draft as { usage: { usd: number } }).usage : (r.usage as { usd: number })).usd))(jevCall);
    finish(setLlm, (r) => (r.usd as number | null) ?? null)(llmCall);
  }

  const missing: 'loopfour' | 'jev' | null = !jevKey ? 'jev' : !apiKey ? 'loopfour' : null;
  const elapsed = (l: Lane | null) => (l ? (l.end ?? now) - l.start : 0);
  const scale = Math.max(3000, elapsed(jev), elapsed(llm));
  const done = jev?.end && llm?.end && !jev.error && !llm.error;

  return (
    <>
      <section className="card">
        <p className="lead">
          The same input goes to <strong>Jev</strong> and to <strong>claude-opus-5</strong> at the same moment, and both are timed here in
          your browser. The LLM runs as an agent in your own Loopfour workspace (the first race creates agents named{' '}
          <code>[jev-race] …</code>), so it is billed by Loopfour, a few cents per race at most.
        </p>
        <div className="checks">
          {MODES.map((m) => (
            <label key={m.id}>
              <input type="radio" name="race-kind" checked={kind === m.id} onChange={() => setKind(m.id)} /> {m.label}
            </label>
          ))}
        </div>

        {kind === 'builder' && (
          <>
            <label htmlFor="race-desc">Workflow description</label>
            <textarea id="race-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
            <div className="examples">
              {PROMPTS.map((p) => (
                <button key={p} className="chip" onClick={() => setDescription(p)} title={p}>
                  {p.length > 52 ? `${p.slice(0, 50)}…` : p}
                </button>
              ))}
            </div>
          </>
        )}
        {kind === 'extract' && (
          <div className="race-inputs">
            <div>
              <label htmlFor="race-doc">Document</label>
              <textarea id="race-doc" rows={9} value={document} onChange={(e) => setDocument(e.target.value)} />
            </div>
            <div>
              <label htmlFor="race-schema">Fields (JSON Schema)</label>
              <textarea id="race-schema" rows={9} value={schema} onChange={(e) => setSchema(e.target.value)} spellCheck={false} />
            </div>
          </div>
        )}
        {kind === 'classify' && (
          <div className="race-inputs">
            <div>
              <label htmlFor="race-ticket">Document</label>
              <textarea id="race-ticket" rows={4} value={ticket} onChange={(e) => setTicket(e.target.value)} />
              <div className="examples">
                {SAMPLE_TICKETS.map((t) => (
                  <button key={t} className="chip" onClick={() => setTicket(t)} title={t}>
                    {t.length > 40 ? `${t.slice(0, 38)}…` : t}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label htmlFor="race-labels">Labels</label>
              <textarea id="race-labels" rows={4} value={labels} onChange={(e) => setLabels(e.target.value)} />
            </div>
          </div>
        )}

        <button className="primary" disabled={!!missing || !!running} onClick={race}>
          {running ? 'Racing…' : 'Start the race'}
        </button>
        {missing && <KeyHint which={missing} why={missing === 'loopfour' ? 'the LLM side runs in your workspace.' : undefined} />}
        {error && <p className="error">{error}</p>}
      </section>

      {jev && llm && (
        <section className="card" ref={lanesRef}>
          <div className="race">
            {[
              { name: 'Jev', sub: 'TypeSafe System One', lane: jev, cls: 'jev' },
              { name: 'LLM', sub: 'claude-opus-5 on Loopfour', lane: llm, cls: 'llm' },
            ].map(({ name, sub, lane, cls }) => (
              <div key={name} className={`lane ${cls}`}>
                <div className="lane-head">
                  <strong>{name}</strong>
                  <span className="hint">{sub}</span>
                  <span className="clock">{secs(elapsed(lane))}</span>
                </div>
                <div className="track">
                  <div className={`runner ${lane.end ? 'done' : ''}`} style={{ width: `${Math.max(1.5, (elapsed(lane) / scale) * 100)}%` }} />
                </div>
                <p className="hint">
                  {lane.error ? <span className="error">{lane.error}</span> : lane.end ? `Finished · ${money(lane.usd)}` : 'Running…'}
                  {cls === 'jev' && lane.end && raceKind === 'builder' && lane.result?.timing ? (
                    <> · Jev itself {secs((lane.result.timing as { jevMs: number }).jevMs)}, the rest is reading your Loopfour workspace</>
                  ) : null}
                </p>
              </div>
            ))}
          </div>

          {done && (
            <p className="verdict">
              Jev finished in <strong>{secs(elapsed(jev))}</strong>, the LLM in <strong>{secs(elapsed(llm))}</strong>:{' '}
              <strong>{(elapsed(llm) / elapsed(jev)).toFixed(1)}× faster</strong>
              {jev.usd && llm.usd ? (
                <>
                  {' '}
                  and <strong>{Math.round(llm.usd / jev.usd).toLocaleString()}× cheaper</strong>
                </>
              ) : null}
              .
            </p>
          )}

          {done && <Answers kind={raceKind} jev={jev.result!} llm={llm.result!} />}
          {done && raceKind === 'builder' && (
            <CreateFromRace key={jev.start} result={jev.result!} apiKey={apiKey} jevKey={jevKey} />
          )}
        </section>
      )}
    </>
  );
}

function Answers({ kind, jev, llm }: { kind: Kind; jev: Record<string, unknown>; llm: Record<string, unknown> }) {
  const out = (llm.output ?? {}) as Record<string, unknown>;
  if (kind === 'classify') {
    return (
      <div className="race-answers">
        <div>
          <h3>Jev</h3>
          <p>
            <strong>{show(jev.label ?? 'none')}</strong> {typeof jev.confidence === 'number' && <span className="hint">({Math.round(jev.confidence * 100)}% confidence)</span>}
          </p>
        </div>
        <div>
          <h3>LLM</h3>
          <p>
            <strong>{show(out.label ?? 'none')}</strong>
          </p>
        </div>
      </div>
    );
  }
  if (kind === 'extract') {
    const j = (jev.output ?? {}) as Record<string, unknown>;
    const fields = [...new Set([...Object.keys(j), ...Object.keys(out)])];
    const agree = fields.filter((f) => same(j[f], out[f])).length;
    return (
      <>
        <p className="hint">
          Same value on {agree} of {fields.length} fields.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Field</th>
                <th>Jev</th>
                <th>LLM</th>
              </tr>
            </thead>
            <tbody>
              {fields.map((f) => (
                <tr key={f} className={same(j[f], out[f]) ? '' : 'differs'}>
                  <td>{f}</td>
                  <td className="value">{show(j[f])}</td>
                  <td className="value">{show(out[f])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }
  // builder
  const a = assemble(jev.draft as never, jev.connections as never, {});
  const llmSteps = ((out.steps ?? []) as { type?: string; action?: string; config?: { prompt?: string } }[]).map((s) =>
    s.action ? s.action : s.type === 'agent' ? 'AI Agent (LLM at run time)' : (s.type ?? '?'),
  );
  return (
    <div className="race-answers">
      <div>
        <h3>Jev</h3>
        <ol>
          <li>{a.view.trigger.title}</li>
          {a.view.steps.map((s) => (
            <li key={s.id} className={s.kind === 'jev' ? 'jevstep' : undefined}>
              {s.title}
            </li>
          ))}
        </ol>
      </div>
      <div>
        <h3>LLM</h3>
        <ol>
          <li>{show((out.trigger as { type?: string } | undefined)?.type ?? '?')} trigger</li>
          {llmSteps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** After a builder race: create the workflow Jev built in Studio as it is, from what the description gives.
 *  Nothing is asked; details the description leaves out (or apps not connected yet) are finished in Studio. */
function CreateFromRace({ result, apiKey, jevKey }: { result: Record<string, unknown>; apiKey: string; jevKey: string }) {
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ url: string; jevSecret: boolean | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const a = assemble(result.draft as never, result.connections as never, {});
      const res = await fetch('/api/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, jevKey, workflow: a.workflow, canvasState: a.canvasState }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `Error ${res.status}`);
      setCreated(json);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="race-create">
      <p className="hint">
        The workflow is created in your Loopfour Studio with the information provided in the prompt. Anything the prompt doesn&apos;t
        say, or apps you haven&apos;t connected yet, can be filled in there.
      </p>
      <button className="primary" disabled={busy || !!created} onClick={create}>
        {busy ? 'Creating…' : created ? 'Created' : "Create Jev's workflow in Studio"}
      </button>
      {created && (
        <p className="created">
          Created with the information in your prompt ·{' '}
          <a href={created.url} target="_blank" rel="noreferrer">
            See it in Loopfour Studio ↗
          </a>
          {created.jevSecret === false && (
            <span className="hint block">Add a workflow secret named JEV_API_KEY with your Jev key in Studio (your Loopfour key lacks secrets:write).</span>
          )}
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
