'use client';

import { useState } from 'react';
import { Builder } from './builder.tsx';
import { ClassifyPanel, ExtractPanel } from './functions.tsx';
import { Articles, JustPaid, WhyJev } from './info.tsx';
import { GitHubIcon } from './ui.tsx';

const REPO_NAME = 'jfelipeff/l4-jev-workflows';
const REPO_URL = `https://github.com/${REPO_NAME}`;

const TABS = [
  { id: 'builder', label: 'Workflow builder' },
  { id: 'extract', label: 'Extraction' },
  { id: 'classify', label: 'Classification' },
] as const;
type Tab = (typeof TABS)[number]['id'];

export default function Home() {
  const [apiKey, setApiKey] = useState('');
  const [jevKey, setJevKey] = useState('');
  const [tab, setTab] = useState<Tab>('builder');

  return (
    <main>
      <header>
        <div className="topbar">
          <div className="brand">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/loopfour-logo-light.png" alt="Loopfour" width={91} height={20} className="l4logo" />
            <span className="times">×</span>
            <span className="jev">Jev</span>
          </div>
          <a className="repo" href={REPO_URL} target="_blank" rel="noreferrer" aria-label="Source code on GitHub">
            <GitHubIcon />
            <span>{REPO_NAME}</span>
          </a>
        </div>
        <h1>Workflows, extraction and classification for Loopfour Studio, in about a second.</h1>
        <p className="sub">
          Jev (TypeSafe&apos;s System One model) makes the decisions an LLM usually makes in a workflow, as typed choices with calibrated
          confidence. No LLM is called to build a workflow, extract a field or classify a document.{' '}
          <a href="#why">Why it matters for Studio ↓</a>
        </p>
      </header>

      <section className="card">
        <div className="keys">
          <div>
            <label htmlFor="key">Loopfour API key</label>
            <input id="key" type="password" autoComplete="off" placeholder="wfk_live_…" value={apiKey} onChange={(e) => setApiKey(e.target.value.trim())} />
            <p className="hint">Workflow builder only. Needs workflows:read/write, connections:read (and secrets:write to store your Jev key).</p>
          </div>
          <div>
            <label htmlFor="jev">Jev (TypeSafe) API key</label>
            <input id="jev" type="password" autoComplete="off" placeholder="From console.typesafe.ai" value={jevKey} onChange={(e) => setJevKey(e.target.value.trim())} />
            <p className="hint">
              Every function. Get one at{' '}
              <a href="https://console.typesafe.ai/" target="_blank" rel="noreferrer">
                console.typesafe.ai
              </a>
              .
            </p>
          </div>
        </div>
        <p className="hint">
          Keys stay in this tab only (refreshing clears them). They pass through this site&apos;s server for each request, because
          Loopfour does not accept keys from browsers, and are never stored or logged. This site has no keys of its own.
        </p>
      </section>

      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      {/* Panels stay mounted so switching tabs keeps their inputs and results. */}
      <div hidden={tab !== 'builder'}>
        <Builder apiKey={apiKey} jevKey={jevKey} />
      </div>
      <div hidden={tab !== 'extract'}>
        <ExtractPanel jevKey={jevKey} />
      </div>
      <div hidden={tab !== 'classify'}>
        <ClassifyPanel jevKey={jevKey} />
      </div>

      <WhyJev />
      <JustPaid />
      <Articles />

      <footer>
        Built with Jev (TypeSafe System One). Every app, action and field comes from Loopfour&apos;s <code>GET /api/v1/blocks</code>{' '}
        catalog · <a href={REPO_URL}>source on GitHub</a>
      </footer>
    </main>
  );
}
