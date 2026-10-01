// Static sections: why Jev helps Loopfour Studio, JustPaid, and further reading.

const ARTICLES = [
  {
    title: 'AI Invoice Processing: The Back Office Meets the Verdict Machine',
    date: 'Sep 22, 2026',
    url: 'https://www.shipwithjev.com/blog/ai-invoice-processing',
    summary:
      'Invoice processing as a chain of judgments (categorize, match the vendor, check the PO, spot anomalies, route approvals) that cost fractions of a cent each, with humans kept on payments and bank changes.',
  },
  {
    title: 'Jev Pricing in Practice: What 600+ Real Builds Actually Cost',
    date: 'Sep 22, 2026',
    url: 'https://www.shipwithjev.com/blog/jev-pricing-what-builds-cost',
    summary: 'Real costs from 600+ builds, from $0.0004 to score a post to $0.035 to classify 500 emails: for decisions, the cost is per verdict, not per token of prose.',
  },
  {
    title: 'OCR + Jev: A Document Intake Pipeline',
    date: 'Sep 30, 2026',
    url: 'https://www.shipwithjev.com/blog/ocr-plus-jev-intake',
    summary: 'Scan, classify, route: OCR turns documents into text, Jev answers closed questions about type and quality, and confidence decides which queue each item goes to.',
  },
  {
    title: 'LLM Routing: The Cascade Architecture Eating Every AI Stack',
    date: 'Sep 22, 2026',
    url: 'https://www.shipwithjev.com/blog/llm-routing',
    summary: 'Decide with a cheap model first and escalate only the uncertain cases to a frontier LLM: 100 emails in 1.42 s, 96/100 correct, about $0.07 in total.',
  },
];

export function WhyJev() {
  return (
    <section className="card prose" id="why">
      <h2>Why Jev inside Loopfour Studio</h2>
      <p>
        Most steps an LLM does in a finance workflow are not writing: they are decisions. Which block does this request need? Which
        amount is the total? Is this email an invoice or a receipt? Jev (TypeSafe&apos;s System One model) answers exactly those typed
        questions, with calibrated probabilities, in milliseconds, without generating text.
      </p>

      <h3>What this site implements</h3>
      <div className="grid3">
        <div className="tile">
          <strong>Workflow builder</strong>
          <p>
            Plain language to a Studio workflow: every part of the description is classified against what each block does, using
            your workspace&apos;s live block catalog, so actions and fields are never invented.
          </p>
        </div>
        <div className="tile">
          <strong>Extraction</strong>
          <p>
            <code>POST /api/extract</code>: a JSON Schema in, JSON out. Values are found in the document and picked by Jev, then copied
            verbatim, each with its source line and a confidence.
          </p>
        </div>
        <div className="tile">
          <strong>Classification</strong>
          <p>
            <code>POST /api/classify</code>: labels in, the best label (or several) out, with a check that it really applies and a
            review flag when Jev is unsure.
          </p>
        </div>
      </div>

      <h3>Measured in this project</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Task</th>
              <th>Jev</th>
              <th>LLM (claude-opus-5)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Build a workflow from a description (5 test descriptions, same catalog, same scoring)</td>
              <td>
                <strong>0.64 s · $0.00042</strong>, 5/5 correct
              </td>
              <td>5.52 s · $0.054, 5/5 correct</td>
            </tr>
            <tr>
              <td>Extract 11 billing fields (incl. line items) from an order form</td>
              <td>
                <strong>0.5–0.75 s · $0.0007</strong>, 11/11 correct
              </td>
              <td>not measured</td>
            </tr>
            <tr>
              <td>Classify a support ticket into billing / technical / sales</td>
              <td>
                <strong>0.18–0.30 s · $0.000024</strong>
              </td>
              <td>not measured</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="hint">
        The builder comparison ran the same 5 descriptions through Jev and through a claude-opus-5 agent on Loopfour (cost as reported
        by Loopfour): 8.6× faster and about 128× cheaper. Studio&apos;s Copilot took 11 s to set up the billing-exceptions template.
      </p>

      <h3>What changes for Studio users</h3>
      <ul>
        <li>
          <strong>Speed:</strong> workflows and extractions in under a second instead of several seconds per LLM call.
        </li>
        <li>
          <strong>Cost:</strong> fractions of a cent per document, so every invoice and contract can be checked, not a sample.
        </li>
        <li>
          <strong>Nothing invented:</strong> Jev chooses among values found in the document (or blocks in the catalog) and code
          copies them, so a total, a date or an action name cannot be hallucinated. Each value keeps its source for the audit trail.
        </li>
        <li>
          <strong>Confidence you can route on:</strong> low-confidence fields go to Studio&apos;s Approval block; the rest flows
          straight through.
        </li>
        <li>
          <strong>LLMs where they help:</strong> the AI Agent block stays for open-ended work (summaries, anomaly hunting); the
          builder only uses it when a step needs it.
        </li>
      </ul>
      <p>
        Today these functions plug into any workflow through an <strong>API Request</strong> block (the builder sets it up, with your
        Jev key stored as the workflow secret <code>JEV_API_KEY</code>). Natively, they would be Studio blocks, and the Copilot could
        call the same block classifier before writing anything.
      </p>
    </section>
  );
}

export function JustPaid() {
  return (
    <section className="card prose" id="justpaid">
      <h2>The same approach fits JustPaid</h2>
      <p>
        <a href="https://justpaid.ai" target="_blank" rel="noreferrer">
          JustPaid
        </a>{' '}
        is an AI billing automation platform for B2B companies (invoicing, payment collection, revenue operations) and is already
        connected to Loopfour Studio: its contract, invoice, credit-memo and payment events start Loopfour workflows. Solutions like
        this one could run inside JustPaid as well: extract billing terms from new contracts, classify invoices, payments and
        collection replies, route disputes and flag anomalies, each in well under a second at a fraction of a cent, with the
        uncertain cases sent to a person.
      </p>
    </section>
  );
}

export function Articles() {
  return (
    <section className="card" id="articles">
      <h2>Relevant articles</h2>
      <div className="articles">
        {ARTICLES.map((a) => (
          <a key={a.url} className="article" href={a.url} target="_blank" rel="noreferrer">
            <span className="date">{a.date} · shipwithjev.com</span>
            <strong>{a.title}</strong>
            <span>{a.summary}</span>
          </a>
        ))}
      </div>
    </section>
  );
}
