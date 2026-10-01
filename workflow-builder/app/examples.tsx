'use client';

// Prompts that build workflows with Jev extraction / classification steps. Each one was run through the
// builder against the live Loopfour catalog and templates; `steps` is what it produced.

export const JEV_EXAMPLES: { group: string; items: { prompt: string; steps: string[] }[] }[] = [
  {
    group: 'Extraction',
    items: [
      {
        prompt:
          'When a signed contract arrives, extract the customer name, annual fee, start date, billing frequency and payment terms, then create a customer in Stripe and notify #billing in Slack.',
        steps: ['Jev Extraction', 'Stripe: Create Customer', 'Slack: Send Message'],
      },
      {
        prompt: 'Extract the invoice number, vendor, total and due date from the invoice, then create a bill in QuickBooks.',
        steps: ['Jev Extraction', 'QuickBooks: Create Bill'],
      },
      {
        prompt:
          'Extract the vendor, amount and expense category from the receipt. If the amount is over $5,000, ask cfo@acme.com for approval, then create a bill in QuickBooks.',
        steps: ['Jev Extraction', 'Condition', 'Approval', 'QuickBooks: Create Bill'],
      },
      {
        prompt: 'Extract the payer, amount and invoice reference from the remittance email, then notify #cash-app in Slack with the result.',
        steps: ['Jev Extraction', 'Slack: Send Message'],
      },
    ],
  },
  {
    group: 'Classification',
    items: [
      {
        prompt: 'Classify the support ticket as billing, technical or sales, then post it to #support in Slack.',
        steps: ['Jev Classification', 'Slack: Send Message'],
      },
      {
        prompt:
          "Classify the customer's collections reply as promise to pay, dispute, payment sent or out of office, then notify #collections in Slack.",
        steps: ['Jev Classification', 'Slack: Send Message'],
      },
      {
        prompt: 'Search Gmail for new emails every hour, classify them as invoice, receipt or other and add the results to a Google Sheet.',
        steps: ['Schedule', 'Gmail: Search Emails', 'Jev Classification', 'Google Sheets: Append Values'],
      },
      {
        prompt: 'Classify each vendor invoice as software, travel, marketing or office supplies and add a row to the Google Sheet.',
        steps: ['Jev Classification', 'Google Sheets: Append Values'],
      },
    ],
  },
];

export function JevExamples({ onBuild }: { onBuild: (text: string) => void }) {
  return (
    <section className="card prose" id="jev-workflows">
      <h2>Workflows that use Jev extraction and classification</h2>
      <p>
        Describe a step that extracts fields or sorts a document into labels, and the builder adds a <strong>Jev Extraction</strong> or{' '}
        <strong>Jev Classification</strong> step: an API Request block that calls this site&apos;s <code>/api/extract</code> or{' '}
        <code>/api/classify</code> with your Jev key from the workflow secret <code>JEV_API_KEY</code>. No AI Agent, no LLM at run
        time. These prompts were checked against the live builder:
      </p>
      <div className="grid2">
        {JEV_EXAMPLES.map((g) => (
          <div key={g.group}>
            <h3>{g.group}</h3>
            <div className="examples-list">
              {g.items.map((e) => (
                <div key={e.prompt} className="tile">
                  <p className="prompt">“{e.prompt}”</p>
                  <p className="steps">
                    {e.steps.map((s, i) => (
                      <span key={s + i}>
                        {i > 0 && ' → '}
                        <span className={s.startsWith('Jev') ? 'jevstep' : undefined}>{s}</span>
                      </span>
                    ))}
                  </p>
                  <button className="secondary" onClick={() => onBuild(e.prompt)}>
                    Build it
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
