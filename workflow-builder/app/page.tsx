'use client';

import { useState } from 'react';
import { Builder } from './builder.tsx';
import { JevExamples } from './examples.tsx';
import { RacePanel } from './race.tsx';
import { ClassifyPanel, ExtractPanel } from './functions.tsx';
import { Articles, WhereElse, WhyJev } from './info.tsx';
import { TemplatesPanel } from './templates.tsx';
import { GitHubIcon } from './ui.tsx';

const REPO_NAME = 'jfelipeff/l4-jev-workflows';
const REPO_URL = `https://github.com/${REPO_NAME}`;

const TABS = [
  { id: 'race', label: 'Jev vs LLM race' },
  { id: 'builder', label: 'Workflow builder' },
  { id: 'extract', label: 'Extraction' },
  { id: 'classify', label: 'Classification' },
  { id: 'templates', label: 'Loopfour templates' },
] as const;
type Tab = (typeof TABS)[number]['id'];

// Page sections, in order: the side nav and the numbered labels above each part use the same list.
const SECTIONS = [
  { id: 'try', label: 'Try it' },
  { id: 'why', label: 'Why Jev' },
  { id: 'jev-workflows', label: 'Example workflows' },
  { id: 'where-else', label: 'Across Loopfour' },
  { id: 'articles', label: 'Reading' },
] as const;

function SectionLabel({ n }: { n: number }) {
  return (
    <p className="section-label">
      <span>{String(n + 1).padStart(2, '0')}</span> {SECTIONS[n].label}
    </p>
  );
}

/** Scroll to a section, opening it first when it is collapsed. */
function goTo(id: string) {
  const el = document.getElementById(id);
  el?.querySelector<HTMLDetailsElement>(':scope > details.fold')?.setAttribute('open', '');
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const MEASURED = [
  { task: 'Build a workflow', jev: '0.64 s', llm: '5.52 s', cheaper: '128×' },
  { task: 'Extract fields', jev: '0.47 s', llm: '5.00 s', cheaper: '32×' },
  { task: 'Classify', jev: '0.20 s', llm: '2.85 s', cheaper: '163×' },
];

export default function Home() {
  const [apiKey, setApiKey] = useState('');
  const [jevKey, setJevKey] = useState('');
  const [tab, setTab] = useState<Tab>('race');
  const [seed, setSeed] = useState<{ text: string; n: number } | undefined>();

  return (
    <main className="layout">
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
          <a
              href="#why"
              onClick={(e) => {
                e.preventDefault();
                goTo('why');
              }}
            >
              Why it matters for Studio ↓
            </a>
        </p>
      </header>

      <nav className="toc" aria-label="On this page">
        <p className="toc-title">On this page</p>
        {SECTIONS.map((x, i) => (
          <div key={x.id}>
            <button className="toc-link" onClick={() => goTo(x.id)}>
              <span>{String(i + 1).padStart(2, '0')}</span> {x.label}
            </button>
            {x.id === 'try' && (
              <div className="toc-sub">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    className={`toc-link toc-tab ${tab === t.id ? 'on' : ''}`}
                    onClick={() => {
                      setTab(t.id);
                      goTo('try');
                    }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </nav>

      <aside className="rail">
        <section className="card" id="keys">
          <div className="keys">
            <div>
              <label htmlFor="key">Loopfour API key</label>
              <input id="key" type="password" autoComplete="off" placeholder="wfk_live_…" value={apiKey} onChange={(e) => setApiKey(e.target.value.trim())} />
              <p className="hint">For the workflow builder (workflows:read/write, connections:read, secrets:write to store your Jev key) and the optional LLM fallback.</p>
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
        <section className="card measured">
          <p className="toc-title">Jev vs claude-opus-5, measured</p>
          {MEASURED.map((m) => (
            <div key={m.task} className="measured-row">
              <span>{m.task}</span>
              <span>
                <strong>{m.jev}</strong> vs {m.llm}
              </span>
              <span className="hint">{m.cheaper} cheaper, same accuracy</span>
            </div>
          ))}
          <button
            className="link"
            onClick={() => {
              setTab('race');
              goTo('try');
            }}
          >
            Race them yourself →
          </button>
        </section>
      </aside>

      <div className="content">
        <div id="try">
          <SectionLabel n={0} />
          <nav className="tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>

          {/* Panels stay mounted so switching tabs keeps their inputs and results. */}
          <div hidden={tab !== 'race'}>
            <RacePanel apiKey={apiKey} jevKey={jevKey} />
          </div>
          <div hidden={tab !== 'builder'}>
            <Builder apiKey={apiKey} jevKey={jevKey} seed={seed} />
          </div>
          <div hidden={tab !== 'extract'}>
            <ExtractPanel jevKey={jevKey} apiKey={apiKey} />
          </div>
          <div hidden={tab !== 'classify'}>
            <ClassifyPanel jevKey={jevKey} apiKey={apiKey} />
          </div>
          <div hidden={tab !== 'templates'}>
            <TemplatesPanel
              apiKey={apiKey}
              onBuild={(text) => {
                setSeed((s) => ({ text, n: (s?.n ?? 0) + 1 }));
                setTab('builder');
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
            />
          </div>

        </div>

        <SectionLabel n={1} />
        <WhyJev />
        <SectionLabel n={2} />
        <JevExamples
          onBuild={(text) => {
            setSeed((x) => ({ text, n: (x?.n ?? 0) + 1 }));
            setTab('builder');
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        />
        <SectionLabel n={3} />
        <WhereElse />
        <SectionLabel n={4} />
        <Articles />

        <footer>
          Built with Jev (TypeSafe System One). Every app, action and field comes from Loopfour&apos;s <code>GET /api/v1/blocks</code>{' '}
          catalog · <a href={REPO_URL}>source on GitHub</a>
        </footer>
      </div>
    </main>
  );
}
