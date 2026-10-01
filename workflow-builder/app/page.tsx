'use client';

import { useMemo, useState } from 'react';
import { assemble, type Answers, type Question } from '@/lib/assemble.ts';
import type { Connection } from '@/lib/loopfour.ts';
import type { Draft, Force } from '@/lib/planner.ts';

type PlanResponse = {
  draft: Draft;
  connections: Connection[];
  timing: { totalMs: number; loopfourMs: number; jevMs: number };
};

const EXAMPLES = [
  'When a payment comes in, if the amount is over $5,000, post a message to #finance in Slack saying "Large payment received", otherwise create a sales receipt in QuickBooks.',
  'Every Monday at 9am, run the QuickBooks profit and loss report and email it to cfo@acme.com with Gmail.',
  'Look up the opportunity in Salesforce, wait 2 hours, then send the contract for signature with DocuSign.',
  'If the deal amount is over $50,000, ask cfo@acme.com for approval. Then create a customer in Stripe and notify #sales in Slack saying "New enterprise customer".',
];

const pct = (c: number | null | undefined) => (c == null ? '—' : `${Math.round(c * 100)}%`);
const tone = (c: number | null | undefined) => (c == null ? 'muted' : c >= 0.8 ? 'good' : c >= 0.5 ? 'warn' : 'bad');

export default function Home() {
  const [apiKey, setApiKey] = useState('');
  const [jevKey, setJevKey] = useState('');
  const [description, setDescription] = useState('');
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [force, setForce] = useState<Force>({});
  const [wallMs, setWallMs] = useState<number | null>(null);
  const [busy, setBusy] = useState<'plan' | 'create' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; url: string; ms: number } | null>(null);
  const [showJson, setShowJson] = useState(false);

  const assembled = useMemo(() => (plan ? assemble(plan.draft, plan.connections, answers) : null), [plan, answers]);

  async function build(nextForce: Force = {}) {
    setBusy('plan');
    setError(null);
    setCreated(null);
    const t0 = performance.now();
    try {
      const res = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, jevKey, description, force: nextForce }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `Error ${res.status}`);
      setPlan(json);
      setForce(nextForce);
      if (!Object.keys(nextForce).length) setAnswers({});
      setWallMs(performance.now() - t0);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function create() {
    if (!assembled) return;
    setBusy('create');
    setError(null);
    try {
      const res = await fetch('/api/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, workflow: assembled.workflow, canvasState: assembled.canvasState }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `Error ${res.status}`);
      setCreated(json);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function answer(q: Question, value: string) {
    if (q.replan && plan && q.forceKey) {
      const step = plan.draft.steps.find((s) => s.id === q.stepId);
      const entry =
        value === '__remove__'
          ? { remove: true }
          : q.id.endsWith('_action') && step?.action?.def
            ? { action: `${step.blockType}.${value}` }
            : { block: value };
      void build({ ...force, [q.forceKey]: entry });
      return;
    }
    setAnswers((a) => ({ ...a, [q.id]: value }));
  }

  const usage = plan?.draft.usage;
  const open = assembled?.questions.filter((q) => q.kind !== 'info') ?? [];
  const notes = assembled?.questions.filter((q) => q.kind === 'info') ?? [];

  return (
    <main>
      <header>
        <div className="brand">
          <span className="logo">L4</span>
          <span>×</span>
          <span className="jev">Jev</span>
        </div>
        <h1>Describe a workflow. Get it in Studio in about a second.</h1>
        <p className="sub">
          Jev (TypeSafe&apos;s System One model) maps your words to Loopfour triggers, apps, actions and fields, picking only from your
          workspace&apos;s live block catalog. No LLM is called at any point.
        </p>
      </header>

      <section className="card">
        <label htmlFor="key">Loopfour API key</label>
        <input
          id="key"
          type="password"
          autoComplete="off"
          placeholder="wfk_live_…"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value.trim())}
        />
        <p className="hint">Needs workflows:read, workflows:write and connections:read.</p>

        <label htmlFor="jev">Jev (TypeSafe) API key</label>
        <input
          id="jev"
          type="password"
          autoComplete="off"
          placeholder="From console.typesafe.ai"
          value={jevKey}
          onChange={(e) => setJevKey(e.target.value.trim())}
        />
        <p className="hint">
          Both keys stay in this tab only (refreshing clears them). They pass through this site&apos;s server for each request,
          because Loopfour does not accept keys from browsers, and are never stored or logged. Get a Jev key at{' '}
          <a href="https://console.typesafe.ai/" target="_blank" rel="noreferrer">console.typesafe.ai</a>.
        </p>

        <label htmlFor="desc">What should the workflow do?</label>
        <textarea
          id="desc"
          rows={4}
          placeholder="e.g. Every Monday at 9am, run the QuickBooks profit and loss report and email it to cfo@acme.com with Gmail."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && apiKey && jevKey && description) void build();
          }}
        />
        <div className="examples">
          {EXAMPLES.map((ex) => (
            <button key={ex} className="chip" onClick={() => setDescription(ex)} title={ex}>
              {ex.length > 62 ? `${ex.slice(0, 60)}…` : ex}
            </button>
          ))}
        </div>
        <button className="primary" disabled={!apiKey || !jevKey || !description || busy !== null} onClick={() => build()}>
          {busy === 'plan' ? 'Jev is mapping…' : 'Build workflow'}
        </button>
        {error && <p className="error">{error}</p>}
      </section>

      {plan && assembled && usage && (
        <>
          <section className="metrics">
            <Metric label="Jev time" value={`${Math.round(usage.jevMs)} ms`} />
            <Metric label="End to end" value={`${((wallMs ?? plan.timing.totalMs) / 1000).toFixed(2)} s`} />
            <Metric label="Jev cost" value={`$${usage.usd.toFixed(5)}`} />
            <Metric label="Requests · questions" value={`${usage.rounds} · ${usage.questions}`} />
            <Metric label="LLM calls" value="0" />
          </section>

          <section className="card">
            <h2>Workflow</h2>
            <ol className="flow">
              <li className="node trigger">
                <span className="kind">Trigger</span>
                <strong>{assembled.view.trigger.title}</strong>
                <span className="detail">{assembled.view.trigger.detail}</span>
                <Badge c={assembled.view.trigger.confidence} />
              </li>
              {assembled.view.steps.map((s) => (
                <li key={s.id} className={`node ${s.branch ?? ''}`}>
                  {s.branch && <span className={`branch ${s.branch}`}>{s.branch === 'then' ? 'if true' : 'otherwise'}</span>}
                  <span className="kind">{s.kind === 'integration' ? 'Action' : s.kind === 'agent' ? 'AI step' : s.kind}</span>
                  <strong>{s.title}</strong>
                  <span className="detail">{s.detail}</span>
                  <Fields config={s.config} />
                  <Badge c={s.confidence} />
                </li>
              ))}
            </ol>
          </section>

          {(open.length > 0 || notes.length > 0) && (
            <section className="card">
              <h2>{open.length ? `Jev needs ${open.length} answer${open.length > 1 ? 's' : ''}` : 'Notes'}</h2>
              {open.map((q) => (
                <QuestionRow key={q.id} q={q} onAnswer={(v) => answer(q, v)} disabled={busy !== null} />
              ))}
              {notes.map((q) => (
                <p key={q.id} className="note">
                  {q.prompt}
                </p>
              ))}
            </section>
          )}

          <section className="card actions">
            <button className="primary" disabled={busy !== null || !!created} onClick={create}>
              {busy === 'create' ? 'Creating…' : created ? 'Created' : open.length ? 'Create draft anyway' : 'Create in Studio'}
            </button>
            {created && (
              <p className="created">
                Draft created in {created.ms} ms ·{' '}
                <a href={created.url} target="_blank" rel="noreferrer">
                  Open in Loopfour Studio ↗
                </a>
              </p>
            )}
            <button className="link" onClick={() => setShowJson((v) => !v)}>
              {showJson ? 'Hide' : 'Show'} the JSON sent to Loopfour
            </button>
            {showJson && <pre>{JSON.stringify(assembled.workflow, null, 2)}</pre>}
          </section>
        </>
      )}

      <footer>
        Questions are typed Choice / yes-no judgments answered by Jev in {plan?.draft.usage.rounds ?? 3} requests; every app, action and
        field comes from Loopfour&apos;s <code>GET /api/v1/blocks</code> catalog.
      </footer>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Badge({ c }: { c: number | null }) {
  return <span className={`badge ${tone(c)}`} title="Jev confidence">{pct(c)}</span>;
}

function Fields({ config }: { config: Record<string, unknown> }) {
  const entries = Object.entries(config).filter(([k]) => !['connection', 'operation', 'then', 'else', 'conditions'].includes(k));
  if (!entries.length) return null;
  return (
    <dl className="fields">
      {entries.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function QuestionRow({ q, onAnswer, disabled }: { q: Question; onAnswer: (v: string) => void; disabled: boolean }) {
  const [text, setText] = useState('');
  return (
    <div className="question">
      <p>{q.prompt}</p>
      {q.options?.length ? (
        <div className="options">
          {q.options.map((o) => (
            <button key={o.id} className="chip" disabled={disabled} onClick={() => onAnswer(o.id)}>
              {o.label} {o.p > 0 && <small>{pct(o.p)}</small>}
            </button>
          ))}
        </div>
      ) : null}
      {q.kind === 'input' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (text) onAnswer(text);
          }}
        >
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a value" />
          <button className="secondary" disabled={!text}>
            Set
          </button>
        </form>
      )}
    </div>
  );
}
