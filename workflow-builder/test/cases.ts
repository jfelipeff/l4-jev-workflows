// The 5 sample descriptions and what each must produce. Shared by test/run.ts and scripts/compare-llm.ts.

export type Expect = {
  trigger: Record<string, unknown>;
  steps: { type: string; action?: string | string[]; config?: Record<string, unknown> }[];
};
export const CASES: { description: string; expect: Expect }[] = [
  {
    description:
      'When a payment comes in, if the amount is over $5,000, post a message to #finance in Slack saying "Large payment received", otherwise create a sales receipt in QuickBooks.',
    expect: {
      trigger: { type: 'api' },
      steps: [
        { type: 'condition', config: { conditions: { left: '{{input.amount}}', operator: 'gt', right: '5000' } } },
        { type: 'action', action: 'slack.sendMessage', config: { channel: '#finance', text: 'Large payment received' } },
        { type: 'action', action: 'quickbooks.createSalesReceipt' },
      ],
    },
  },
  {
    description: 'Every Monday at 9am, run the QuickBooks profit and loss report and email it to cfo@acme.com with Gmail.',
    expect: {
      trigger: { type: 'schedule', cron: '0 9 * * 1' },
      steps: [
        { type: 'action', action: 'quickbooks.runReport', config: { reportType: 'ProfitAndLoss' } },
        { type: 'action', action: 'gmail.sendEmail', config: { to: 'cfo@acme.com' } },
      ],
    },
  },
  {
    description: 'Look up the opportunity in Salesforce, wait 2 hours, then send the contract for signature with DocuSign.',
    expect: {
      trigger: { type: 'api' },
      steps: [
        { type: 'action', action: ['salesforce.getRecord', 'salesforce.query', 'salesforce.search'] },
        { type: 'wait', config: { duration: 2, unit: 'hours' } },
        { type: 'action', action: 'docusign.sendEnvelope' },
      ],
    },
  },
  {
    description: 'If the deal amount is over $50,000, ask cfo@acme.com for approval. Then create a customer in Stripe and notify #sales in Slack.',
    expect: {
      trigger: { type: 'api' },
      steps: [
        { type: 'condition', config: { conditions: { left: '{{input.dealAmount}}', operator: 'gt', right: '50000' } } },
        { type: 'approval', config: { approvers: 'cfo@acme.com' } },
        { type: 'action', action: 'stripe.createCustomer' },
        { type: 'action', action: 'slack.sendMessage', config: { channel: '#sales' } },
      ],
    },
  },
  {
    description: 'Create a contact in HubSpot, add the customer to a Google Sheet, and alert @maria in Slack.',
    expect: {
      trigger: { type: 'api' },
      steps: [
        { type: 'action', action: 'hubspot.createContact' },
        { type: 'action', action: ['google-sheets.appendValues', 'google-sheets.insertRow', 'google-sheets.upsertRow'] },
        { type: 'action', action: 'slack.sendMessage' },
      ],
    },
  },
];
