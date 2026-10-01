'use client';

import { useState } from 'react';

type Template = {
  slug: string;
  name: string;
  description: string;
  trigger: { type?: string; cron?: string };
  steps: { name: string; type: string; action: string | null }[];
  requiredConnections: string[];
};

/** Loopfour's own templates, each one a click away from being recreated by Jev from plain language. */
export function TemplatesPanel({ apiKey, onBuild }: { apiKey: string; onBuild: (text: string) => void }) {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phrasing, setPhrasing] = useState<'description' | 'steps'>('description');

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `Error ${res.status}`);
      setTemplates(json.templates);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const text = (t: Template) => (phrasing === 'description' ? t.description : `${t.steps.map((s) => s.name).join(', ')}.`);

  return (
    <>
      <section className="card">
        <p className="lead">
          Every workflow template in Loopfour Studio, read live from your workspace. Pick one and Jev rebuilds it from plain language
          alone: it recognizes which template the text describes (checked against all {templates?.length ?? 29}, plus a second yes/no
          check) and recreates exactly its trigger and steps, filling variables like Slack channels from your words. In our tests all 29
          templates were recreated correctly from both their description and a bare list of their steps (58/58), and no ordinary
          description was mistaken for a template.
        </p>
        {!templates && (
          <button className="primary" disabled={!apiKey || busy} onClick={load}>
            {busy ? 'Loading…' : 'Load Loopfour templates'}
          </button>
        )}
        {!apiKey && <p className="hint">Enter your Loopfour API key in the API keys box.</p>}
        {error && <p className="error">{error}</p>}
        {templates && (
          <div className="checks">
            <span className="hint">Text sent to Jev:</span>
            <label>
              <input type="radio" checked={phrasing === 'description'} onChange={() => setPhrasing('description')} /> the template&apos;s description
            </label>
            <label>
              <input type="radio" checked={phrasing === 'steps'} onChange={() => setPhrasing('steps')} /> only its step names
            </label>
          </div>
        )}
      </section>
      {templates && (
        <div className="templates">
          {templates.map((t) => (
            <div key={t.slug} className="template">
              <div className="template-head">
                <strong>{t.name}</strong>
                <span className="hint">{t.trigger.type === 'schedule' ? `schedule ${t.trigger.cron}` : t.trigger.type}</span>
              </div>
              <p>{t.description}</p>
              <ol>
                {t.steps.map((s, i) => (
                  <li key={i}>
                    {s.name} <span className="hint">· {s.action ?? s.type}</span>
                  </li>
                ))}
              </ol>
              <p className="hint">“{text(t)}”</p>
              <button className="secondary" onClick={() => onBuild(text(t))}>
                Build with Jev
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
