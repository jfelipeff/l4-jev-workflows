'use client';

import { useState } from 'react';
import type { Question } from '@/lib/assemble.ts';

export const pct = (c: number | null | undefined) => (c == null ? '—' : `${Math.round(c * 100)}%`);
export const tone = (c: number | null | undefined) => (c == null ? 'muted' : c >= 0.8 ? 'good' : c >= 0.5 ? 'warn' : 'bad');

export function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function Badge({ c, title = 'Jev confidence' }: { c: number | null; title?: string }) {
  return (
    <span className={`badge ${tone(c)}`} title={title}>
      {pct(c)}
    </span>
  );
}

export function Fields({ config }: { config: Record<string, unknown> }) {
  const entries = Object.entries(config).filter(([k]) => !['connection', 'operation', 'then', 'else', 'conditions', 'headers'].includes(k));
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

export function QuestionRow({ q, onAnswer, disabled }: { q: Question; onAnswer: (v: string) => void; disabled: boolean }) {
  const [text, setText] = useState('');
  const [all, setAll] = useState(false);
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
      {q.allOptions?.length ? (
        <div className="alloptions">
          <button className="link" onClick={() => setAll((v) => !v)}>
            {all ? 'Hide' : 'Show'} all {q.allOptions.length} options
          </button>
          {all && (
            <div className="options">
              {[...q.allOptions]
                .sort((a, b) => a.label.localeCompare(b.label))
                .map((o) => (
                  <button key={o.id} className="chip" disabled={disabled} onClick={() => onAnswer(o.id)}>
                    {o.label}
                  </button>
                ))}
            </div>
          )}
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

/** Copyable JSON block, e.g. the API Request block config to paste into Loopfour Studio. */
export function CopyBlock({ title, value }: { title: string; value: unknown }) {
  const [copied, setCopied] = useState(false);
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <div className="copyblock">
      <div className="copyhead">
        <span>{title}</span>
        <button
          className="link"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>{text}</pre>
    </div>
  );
}

export function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/** Scroll to the API keys card, light it up for a moment and put the cursor in the right field. */
export function showKeys(which: 'loopfour' | 'jev') {
  const card = document.getElementById('keys');
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.remove('glow');
  void card.offsetWidth; // restart the animation
  card.classList.add('glow');
  setTimeout(() => card.classList.remove('glow'), 2600);
  document.getElementById(which === 'jev' ? 'jev' : 'key')?.focus({ preventScroll: true });
}

/** "Enter your … API key in the API keys box", where "API keys box" lights up the box. */
export function KeyHint({ which, why }: { which: 'loopfour' | 'jev'; why?: string }) {
  return (
    <p className="hint">
      Enter your {which === 'jev' ? 'Jev' : 'Loopfour'} API key in the{' '}
      <button className="keylink" onClick={() => showKeys(which)}>
        API keys box
      </button>
      {why ? `: ${why}` : '.'}
    </p>
  );
}
