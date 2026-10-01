// Sample inputs shared by the Extract/Classify panels and scripts/compare-functions.ts.

export const SAMPLE_CONTRACT = `SUBSCRIPTION ORDER FORM
Order Form No. BP-OF-2026-0417 · Order Form Date: September 30, 2026
Provider: Brightpath Commerce Cloud, Inc., 1200 Harbor Way, Suite 400, Oakland, CA 94607 · billing@brightpath.example
Customer: Northwind Outfitters, Inc., 500 Congress Avenue, Austin, TX 78701 · Attn: Jordan Lee, Accounts Payable
1. Subscription Term
The Subscription Start Date is November 1, 2026. The initial term of this Order Form is thirty-six (36) months from the Subscription Start Date. Thereafter this Order Form renews for successive twelve (12) month renewal terms unless either party gives notice of non-renewal at least sixty (60) days before the end of the then-current term.
2. Subscription Fees
1 Brightpath Retail Platform subscription (40 stores) Annual $48,000.00
2 POS Connect module Annual $18,000.00
3 Premium Support (24x7) Annual $6,000.00
The Annual Subscription Fee is $72,000.00 per year, invoiced quarterly in advance in four equal installments of $18,000.00. The total contract value for the Initial Term is $216,000.00.
3. Invoicing and Payment
All invoices are payable within thirty (30) days of the invoice date. Late amounts accrue interest at 1.5% per month.`;

export const SAMPLE_SCHEMA = JSON.stringify(
  {
    type: 'object',
    required: ['customer_name', 'acv', 'start_date'],
    properties: {
      customer_name: { type: 'string', description: 'legal name of the customer' },
      acv: { type: 'number', description: 'annual subscription fee' },
      total_contract_value: { type: 'number' },
      term_months: { type: 'integer', description: 'length of the initial term in months' },
      start_date: { type: 'string', format: 'date', description: 'subscription start date' },
      billing_frequency: { type: 'string', enum: ['monthly', 'quarterly', 'annual', 'one_time'] },
      net_terms_days: { type: 'integer', description: 'days the customer has to pay an invoice' },
      auto_renews: { type: 'boolean', description: 'the order form renews automatically' },
      line_items: { type: 'array', items: { type: 'object', properties: { description: { type: 'string' }, annual_fee: { type: 'number' } } } },
    },
  },
  null,
  2,
);

export const SAMPLE_TICKETS = [
  'Hi, I was charged twice for order A-104 this month. Please refund one of them.',
  'The dashboard shows a 500 error every time I try to log in since this morning.',
  'Can you send me pricing for 50 seats and book a demo next week?',
  'Charged twice and now I cannot log in to download the invoice.',
];
export const SAMPLE_LABELS = `billing: charges, invoices, refunds, payments
technical: bugs, errors, outages, login problems
sales: pricing, quotes, demos, new seats`;
