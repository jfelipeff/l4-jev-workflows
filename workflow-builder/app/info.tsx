// Static sections: why Jev helps Loopfour Studio, where else it fits in Loopfour, and further reading.

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

      <div className="figures">
        <figure>
          <a href="/jev-picks.png" target="_blank" rel="noreferrer"><img src="/jev-picks.png" width={2000} height={1125} alt="Code finds the candidate values in the document, Jev picks the right one with a confidence, code copies it into the result" /></a>
          <figcaption>Extraction and classification: code finds the candidates, Jev picks one with a confidence, code assembles the result.</figcaption>
        </figure>
        <figure>
          <a href="/jev-builder.png" target="_blank" rel="noreferrer"><img src="/jev-builder.png" width={2000} height={1125} alt="The description is cut into parts and Jev files each one under a real block from the live catalog, then the workflow is created in Loopfour Studio" /></a>
          <figcaption>Workflow builder: each part of the description is filed under a real block from your live catalog, never an invented one.</figcaption>
        </figure>
      </div>

      <h3>What this site implements</h3>
      <div className="grid3">
        <div className="tile">
          <strong>Workflow builder</strong>
          <p>
            Plain language to a Studio workflow: every part of the description is classified against what each block does, using
            your workspace&apos;s live block catalog, so actions and fields are never invented; descriptions of Loopfour&apos;s own
            templates are recreated exactly. Workflows are created through the Loopfour Workflows API.
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
          <strong>An LLM only for what Jev cannot settle (optional):</strong> following the{' '}
          <a href="https://docs.typesafe.ai/cookbooks/sde_cascade" target="_blank" rel="noreferrer">
            cascade
          </a>{' '}
          pattern, only answers Jev is unsure about go to Loopfour&apos;s own claude-opus-5, and its answer is kept only if it quotes
          the document and Jev confirms it. In our tests a memo with &quot;the 1st of Nov. &apos;26&quot; escalated just that one
          field (2.4 s, $0.006) while a fully readable contract made no LLM call at all; values that are not in the document stay
          flagged instead of being invented.
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

// Every Loopfour use case (https://loopfour.ai/solutions/use-cases) and where a Jev judgment fits in it.
const L4 = 'https://loopfour.ai/solutions';
const CASES: Record<string, [slug: string, name: string]> = {
  deposition: ['legal-billing-deposition-automation', 'Legal billing (depositions)'],
  everyset: ['entertainment-staffing-payroll-journal-entries', 'Everyset (payroll invoices)'],
  vendor: ['healthcare-tech-four-way-vendor-reconciliation', 'Healthcare tech (four-way vendor match)'],
  estate: ['legal-services-estate-planning-revenue-recognition', 'Estate planning (rev rec)'],
  asc606: ['manufacturing-asc-606-revenue-recognition-epicor', 'Manufacturing (ASC 606 on Epicor)'],
  credits: ['health-diagnostics-usage-based-revenue-recognition', 'Health diagnostics (usage credits)'],
  partners: ['accounting-services-rd-tax-partner-billing', 'Accounting services (partner billing)'],
  rails: ['fintech-multi-rail-payment-reconciliation', 'Fintech ($5.6B, five rails)'],
  cyber: ['cybersecurity-enterprise-cash-application', 'Cybersecurity (cash application)'],
  aiinfra: ['ai-infrastructure-contract-to-reconciliation', 'AI infrastructure (contract to reconciliation)'],
  foodhall: ['food-hall-tenant-billing-bank-reconciliation', 'Food hall (tenant billing)'],
  msb: ['fintech-money-services-business-contract-to-cash', 'Money services (contract to cash)'],
  creator: ['creator-economy-billing-payout-automation', 'Creator economy (billing and payouts)'],
  hra: ['hra-reimbursement-processing-automation', 'HRA reimbursements'],
  signage: ['digital-signage-media-month-end-billing-automation', 'Digital signage (Salesforce to NetSuite)'],
  senior: ['senior-living-saas-billing-automation', 'Senior living SaaS (billing)'],
  lending: ['lending-marketplace-loan-lifecycle-notifications', 'Lending marketplace (loan notifications)'],
  travel: ['travel-technology-month-end-workbook-automation', 'Travel tech (month-end workbook)'],
  proptech: ['proptech-lease-to-payment-automation', 'PropTech (lease to payment)'],
};

function CaseLink({ k }: { k: string }) {
  return (
    <a href={`${L4}/use-cases/${CASES[k][0]}`} target="_blank" rel="noreferrer">
      {CASES[k][1]}
    </a>
  );
}

const AREAS: { title: string; solution?: [string, string]; today: string; jev: string; cases: string[] }[] = [
  {
    title: 'Reading contracts and order forms',
    solution: ['Revenue recognition', 'revenue-recognition-automation'],
    today:
      'Signed contracts arrive from DocuSign, SignNow, HelloSign or an API, and "AI parses the terms": amounts, cadence, discounts, minimums, renewal, milestones and splits. Loopfour promises that this AI is "scoped and confidence-gated" and that "every number traces back to a clause".',
    jev: 'This is exactly what /api/extract does: code finds every candidate value in the contract, Jev picks the one each field asks for, and code copies it verbatim with its source line and a calibrated confidence. Ambiguous terms go to a person instead of being guessed, and a value cannot be invented.',
    cases: ['aiinfra', 'msb', 'proptech', 'partners', 'estate', 'credits', 'signage'],
  },
  {
    title: 'Cash application and remittance',
    solution: ['Payment reconciliation', 'payment-reconciliation-automation'],
    today:
      'Payments land as lump sums with remittance "in whatever shape they arrive": Wise and bank notifications, partner remittances covering fifty invoices, short-pays with no reason. "Scoped AI parses it into structured data" and a match clears "only above the confidence threshold you choose".',
    jev: 'Code proposes the candidate invoices (amount, date, customer); Jev reads the memo or remittance and picks among them with a calibrated probability, which is the confidence threshold. One Noul per reason explains a short-pay (withholding tax, FX, deduction, dispute).',
    cases: ['cyber', 'creator', 'aiinfra', 'foodhall', 'rails', 'msb'],
  },
  {
    title: 'Collections replies and disputes',
    solution: ['Accounts receivable', 'accounts-receivable-automation'],
    today:
      'Collection emails go out on schedule, but the replies still need reading: "manual searches through a shared inbox", disputes with "no paper trail", and "accounts that need escalation and accounts that need patience get treated identically".',
    jev: 'Classify every reply (promise to pay, payment sent, dispute, remittance advice, wrong contact, out of office), extract the promised date or amount, route it to the right collector, and score urgency so the dunning sequence pauses or escalates on what the customer actually said.',
    cases: ['cyber', 'lending', 'msb', 'aiinfra'],
  },
  {
    title: 'Categorizing and routing records',
    solution: ['Month-end close', 'month-end-close-automation'],
    today:
      'Invoices route to the union or non-union QuickBooks entity "based on their characteristics", opportunities are "categorized by sales team", pharmacy subsidy lines are stripped for multi-state tax, and expenses split across entities, branches and currencies.',
    jev: 'One Choice per record or line: the entity, the GL account (hierarchical classification handles large charts of accounts), the team, or the tax treatment, each with a confidence that sends only the unclear lines to review.',
    cases: ['everyset', 'signage', 'senior', 'travel', 'foodhall', 'hra'],
  },
  {
    title: 'Mapping between systems',
    today:
      'Salesforce opportunities "mapped to NetSuite requirements", "HubSpot fields that don\'t map natively", delivery-platform stores matched to tenant contracts, vendor invoice lines matched "at the line-item level" to order forms.',
    jev: 'Pairing two lists whose names differ is a Choice per item over the other list, the same way the builder maps each part of a description to a block in the catalog. It runs once at setup or on every new item, and the probabilities show which pairs a person should confirm.',
    cases: ['signage', 'senior', 'foodhall', 'vendor', 'travel'],
  },
  {
    title: 'Long documents, messages and exceptions',
    today:
      'Deposition PDFs where only the first and last three pages matter, 120–180-page invoice packages checked seven ways against payroll, an estate value confirmed in a Slack reply, and exceptions that need "the right owner with everything they need attached".',
    jev: 'Line search finds the few lines that answer each question in a long document, so code can read the numbers and apply rules like "whichever start time is earlier". For exceptions, Jev picks the owner or queue and checks whether a note explains a variance, so reviewers start with the ones that matter.',
    cases: ['deposition', 'everyset', 'estate', 'rails', 'proptech', 'asc606'],
  },
];

const BY_CASE: [string, string][] = [
  ['deposition', 'Pick the start and end timestamps among those found in the first and last three pages (code applies "whichever is earlier"); low confidence goes to the existing Slack review.'],
  ['everyset', "Route each invoice package to the union or non-union entity, and locate the gross, tax, workers' comp and fee lines the seven payroll checks need."],
  ['vendor', 'Pair vendor invoice lines with order-form and pricing-calculator lines when the descriptions differ. The variance math stays rule-based, as the controller wants.'],
  ['estate', 'Read the confirmed estate value from the Slack reply at month 6 and check it is a confirmation, not an estimate, before the mid-term invoice is drafted.'],
  ['asc606', "The recognition math stays code; Jev reads the CFO's reply to the review email (approve, reject, needs changes) so posting doesn't wait on a button."],
  ['credits', 'Read the tier and credit quantity from the signed HelloSign contract, and classify design-review replies as approved or changes requested.'],
  ['partners', 'Extract milestones, percentages and completion criteria from partner contracts with no standard format (one row per milestone), and classify tax one-off requests for routing.'],
  ['rails', 'Suggest the client trust account from a deposit memo, flag out-of-pattern deposits, and pick the exception queue with the reason attached.'],
  ['cyber', 'Classify inbox replies and route them to the collector, map partner remittance lines to customer invoices, spot withholding-tax short-pays, and read portal dispute reasons.'],
  ['aiinfra', 'Extract amount, cadence, discounts and auto-renewal from DocuSign contracts, and match Airwallex payment references to invoices, one-to-one or one-to-many.'],
  ['foodhall', 'Read fee terms (percentage, minimum, common area fee, waivers) from 70 tenant contracts, and map delivery-platform store names to tenants.'],
  ['msb', 'Extract setup fees, platform fees, minimums and renewal from SignNow contracts, tell volume-based from fee-based minimums, and name the client behind an ACH or wire description.'],
  ['creator', 'Parse each Wise notification (amount and brand) and pick the deal it pays among the open ones in Airtable.'],
  ['hra', "Check each employee spending line against the plan's eligible categories before the statement and ACH are built, sending unclear lines to review."],
  ['signage', 'Read contract PDFs into Salesforce fields instead of reps transcribing them, categorize opportunities by sales team, and map fields to NetSuite.'],
  ['senior', 'Flag pharmacy subsidy line items for the tax rules, map HubSpot custom fields to NetSuite, and recognize module-addition requests that need an addendum.'],
  ['lending', 'Classify borrower replies (paid, will pay on a date, dispute, hardship) to cancel or escalate the Day 1, 5 and 14 reminders, and read counter-proposal terms.'],
  ['travel', 'Classify Expensify lines by entity and GL account, and map Salesforce products to NetSuite items for billing and the rev rec schedule.'],
  ['proptech', 'Extract rent, deposit, pet and parking fees, start date and term from the lease with ambiguous terms flagged (what /api/extract already does), and read maintenance invoices for approval.'],
];

export function WhereElse() {
  return (
    <section className="card prose" id="where-else">
      <h2>Other parts of Loopfour where Jev works great</h2>
      <p>
        Loopfour&apos;s rule is deterministic workflows with AI only where it helps, &quot;scoped and confidence-gated&quot;. Jev is
        that kind of AI: it answers a typed question with a calibrated probability and never writes free text. Going through all{' '}
        <a href={`${L4}/use-cases`} target="_blank" rel="noreferrer">
          19 case studies
        </a>{' '}
        and the four solution pages, the same few judgments keep coming back:
      </p>
      <div className="grid2">
        {AREAS.map((a) => (
          <div key={a.title} className="tile">
            <strong>{a.title}</strong>
            {a.solution && (
              <a className="tag" href={`${L4}/${a.solution[1]}`} target="_blank" rel="noreferrer">
                {a.solution[0]}
              </a>
            )}
            <p>
              <em>Today:</em> {a.today}
            </p>
            <p>
              <em>With Jev:</em> {a.jev}
            </p>
            <p className="cases">
              {a.cases.map((k, i) => (
                <span key={k}>
                  {i > 0 && ' · '}
                  <CaseLink k={k} />
                </span>
              ))}
            </p>
          </div>
        ))}
      </div>

      <h3>What stays code</h3>
      <p>
        Rent and split calculations, ASC 606 schedules, four-way-match math, dunning schedules, ACH and postings stay deterministic
        rules, as they are today. Jev only answers the questions those rules need from text (which value, which invoice, which
        entity, which owner), and each answer is logged with its probability like any other step, so the audit trail Loopfour sells
        on stays intact.
      </p>

      <details>
        <summary>Case by case: all 19 Loopfour case studies</summary>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Case study</th>
                <th>Where Jev fits</th>
              </tr>
            </thead>
            <tbody>
              {BY_CASE.map(([k, text]) => (
                <tr key={k}>
                  <td>
                    <CaseLink k={k} />
                  </td>
                  <td>{text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
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
