'use client';

import { useEffect, useMemo, useState } from 'react';
import { assemble, type Answers, type Question } from '@/lib/assemble.ts';
import type { Connection } from '@/lib/loopfour.ts';
import type { Draft, Force } from '@/lib/planner.ts';
import { Badge, Fields, Metric, QuestionRow } from './ui.tsx';

type PlanResponse = {
  draft: Draft;
  connections: Connection[];
  timing: { totalMs: number; loopfourMs: number; jevMs: number };
};

const EXAMPLES = [
  'Scan Stripe events daily for duplicate charges, pricing mismatches, failed renewals and unexpected plan changes.',
  'Extract the invoice number, vendor, total and due date from the invoice, then create a bill in QuickBooks.',
  'Search Gmail for new emails every hour, classify them as invoice, receipt or other and add the results to a Google Sheet.',
  'If the deal amount is over $50,000, ask cfo@acme.com for approval. Then create a customer in Stripe and notify #sales in Slack saying "New enterprise customer".',
  'Every Monday at 9am, run the QuickBooks profit and loss report and email it to cfo@acme.com with Gmail.',
];

const KIND_LABEL: Record<string, string> = { integration: 'Action', agent: 'AI step (LLM at run time)', jev: 'Jev step (no LLM)' };

export function Builder({ apiKey, jevKey, seed }: { apiKey: string; jevKey: string; seed?: { text: string; n: number } }) {
  const [description, setDescription] = useState('');
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [force, setForce] = useState<Force>({});
  const [wallMs, setWallMs] = useState<number | null>(null);
  const [busy, setBusy] = useState<'plan' | 'create' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; url: string; ms: number; jevSecret: boolean | null } | null>(null);
  const [showJson, setShowJson] = useState(false);

  const assembled = useMemo(() => (plan ? assemble(plan.draft, plan.connections, answers) : null), [plan, answers]);

  // "Build with Jev" from the templates tab: fill the description and build right away.
  useEffect(() => {
    if (!seed) return;
    setDescription(seed.text);
    if (apiKey && jevKey) void build({}, seed.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.n]);

  async function build(nextForce: Force = {}, text = description) {
    setBusy('plan');
    setError(null);
    setCreated(null);
    const t0 = performance.now();
    try {
      const res = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, jevKey, description: text, force: nextForce }),
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
        body: JSON.stringify({ apiKey, jevKey, workflow: assembled.workflow, canvasState: assembled.canvasState }),
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
    if (q.id === '__scratch' || q.id === 'template_back') {
      setAnswers((a) => ({ ...a, __scratch: q.id === '__scratch' ? '1' : '0' }));
      return;
    }
    if (q.replan && plan && q.forceKey) {
      const step = plan.draft.steps.find((s) => s.id === q.stepId);
      const entry =
        value === '__remove__'
          ? { remove: true }
          : q.id.endsWith('_action') && step && (step.action?.def || q.allOptions?.some((o) => o.id === value))
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
  const missingKeys = !apiKey ? 'Enter your Loopfour API key in the API keys box.' : !jevKey ? 'Enter your Jev API key in the API keys box.' : null;

  return (
    <>
      <section className="card">
        <p className="lead">
          Describe a workflow in plain language. Jev maps every part of it to a Loopfour block, choosing only from your workspace&apos;s
          live block catalog, or recognizes one of Loopfour&apos;s templates and recreates it exactly. The workflow is then created in
          Studio through the <a href="https://loopfour.ai/docs/api-reference/workflows" target="_blank" rel="noreferrer">Loopfour Workflows API</a>{' '}
          (<code>POST /workflows</code> plus the canvas). Extraction and classification steps run on Jev; the AI Agent is only used for
          open-ended work.
        </p>
        <label htmlFor="desc">What should the workflow do?</label>
        <textarea
          id="desc"
          rows={4}
          placeholder="e.g. Every Monday at 9am, run the QuickBooks profit and loss report and email it to cfo@acme.com with Gmail."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !missingKeys && description) void build();
          }}
        />
        <div className="examples">
          {EXAMPLES.map((ex) => (
            <button key={ex} className="chip" onClick={() => setDescription(ex)} title={ex}>
              {ex.length > 62 ? `${ex.slice(0, 60)}…` : ex}
            </button>
          ))}
        </div>
        <button className="primary" disabled={!!missingKeys || !description || busy !== null} onClick={() => build()}>
          {busy === 'plan' ? 'Jev is mapping…' : 'Build workflow'}
        </button>
        {missingKeys && <p className="hint">{missingKeys}</p>}
        {error && <p className="error">{error}</p>}
      </section>

      {plan && assembled && usage && (
        <>
          <section className="metrics">
            <Metric label="Jev time" value={`${Math.round(usage.jevMs)} ms`} />
            <Metric label="End to end" value={`${((wallMs ?? plan.timing.totalMs) / 1000).toFixed(2)} s`} />
            <Metric label="Jev cost" value={`$${usage.usd.toFixed(5)}`} />
            <Metric label="Requests · questions" value={`${usage.rounds} · ${usage.questions}`} />
            <Metric label="LLM calls to build" value="0" />
          </section>

          <section className="card">
            <h2>Workflow</h2>
            {assembled.template && (
              <p className="template-note">
                Recreated from Loopfour&apos;s <strong>{assembled.template.name}</strong> template (<code>{assembled.template.slug}</code>), step
                for step. Jev match: {Math.round(assembled.template.fit * 100)}%.
              </p>
            )}
            <ol className="flow">
              <li className="node trigger">
                <span className="kind">Trigger</span>
                <strong>{assembled.view.trigger.title}</strong>
                <span className="detail">{assembled.view.trigger.detail}</span>
                <Badge c={assembled.view.trigger.confidence} />
              </li>
              {assembled.view.steps.map((s) => (
                <li key={s.id} className={`node ${s.branch ?? ''} ${s.kind}`}>
                  {s.branch && <span className={`branch ${s.branch}`}>{s.branch === 'then' ? 'if true' : 'otherwise'}</span>}
                  <span className="kind">{KIND_LABEL[s.kind] ?? s.kind}</span>
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
                {created.jevSecret === true && <span className="hint block">Your Jev key was saved as the workflow secret JEV_API_KEY.</span>}
                {created.jevSecret === false && (
                  <span className="hint block">
                    Add a workflow secret named JEV_API_KEY with your Jev key in Studio (your Loopfour key lacks secrets:write).
                  </span>
                )}
              </p>
            )}
            <button className="link" onClick={() => setShowJson((v) => !v)}>
              {showJson ? 'Hide' : 'Show'} the JSON sent to Loopfour
            </button>
            {showJson && <pre>{JSON.stringify(assembled.workflow, null, 2)}</pre>}
          </section>
        </>
      )}
    </>
  );
}
