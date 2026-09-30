Build a TEST version of the contract-to-invoice workflow that uses no integrations (no DocuSign, QuickBooks or Slack accounts are connected). It must run end to end when I press Run with empty input. Do not add any Agent (LLM) block: the billing-terms extraction is done by an external HTTP endpoint.

Blocks, in order:

1. API Trigger (manual Run, no input needed).

2. Code block, id `simulate_pdf_text`, name "Simulated DocuSign + PDF readText". It stands in for docusign.downloadDocument + PDF block readText. It must return exactly this object, with the contract text copied verbatim (keep the line breaks, curly quotes and the "..." lines):

```javascript
const text = `NSB SOFTWARE AS A SERVICE MASTER AGREEMENT
THIS AGREEMENT is by and between:
NSB Retail Solutions Inc. , having its principal place of business at:
2800 Trans Canada Highway
Pointe Claire, Quebec, Canada
H9R 1B1
(Hereinafter referred to as “NSB”)
AND
Boot Barn, Inc. , having its principal place of business at:
1636 West Collins Avenue
Orange, CA 92867
(Hereinafter referred to as the “Client”)
WHEREAS , Client wishes to procure from NSB and NSB wishes to provide to Client NSB’s Connected Retailer ® Software in the form of Software as a Service (“SaaS”); and
NOW, THEREFORE , in consideration of the promises hereof, and the mutual obligations herein made and undertaken, the parties hereto agree as follows:
...
11. PAYMENT TERMS.
11.1. The SaaS Fees including, but not limited to, POS Equipment Maintenance are due and payable quarterly in advance. The first payment shall be due when Client is Live. All undisputed sums due under this Agreement will be paid by Client (without any set off or deduction) within thirty (30) days from the date of Client’s receipt of invoice. Any additional charges for services not covered by the SaaS fee shall be due and payable within thirty (30) days from the date of Client’s receipt of invoice. For avoidance of doubt, implementation services and equipment shall be invoiced as per the payment schedule set forth in Schedule “A”.
11.2. If any fault or problem is found under investigation to be due to unauthorized use of the Software, Client shall pay NSB all reasonable costs and expenses incurred by NSB in consequence of such investigation, calculated on a time and materials basis at NSB’s then prevailing rates.
...
Schedule “A” — Payment Schedule in Respect of Annual Software as a Service and POS Equipment Support & Maintenance Fees Payment Stage | Due Date | Amount Due | 1 | Fees are due and payable quarterly in advance, commencing from Live date of SaaS. | $245,085`;

return {
  envelopeId: 'test-envelope-0001',
  name: 'NSB SaaS Master Agreement - Boot Barn.pdf',
  text,
};
```

3. API Request (HTTP) block, id `jev_extract`, name "Extract billing terms (Jev)":
   - Method: POST
   - URL: https://l4-jev-contract-to-invoice.vercel.app/api/extract
   - Headers: `Content-Type: application/json` and `Authorization: Bearer {{ secrets.L4_JEV_TOKEN }}`
   - Create the workflow secret `L4_JEV_TOKEN` with the value `<L4_JEV_TOKEN>`. If a secret cannot be created, put the value directly in the header: `Authorization: Bearer <L4_JEV_TOKEN>`.
   - Body: the whole object returned by `simulate_pdf_text` (its `envelopeId`, `name` and `text` fields), sent as JSON. Pass the object itself; do NOT build the JSON by pasting the text into a string template, because the text contains line breaks and quotes.
   - Timeout 30 seconds, retry 2 times on failure.
   - The response looks like: `{ "ok": true, "envelopeId": "...", "needs_review": true|false, "documents": [ { "name": "...", "terms": { "document_type", "amount": {"value","currency","source","confidence","review"}, "billing_frequency": {...}, "start_date": {...}, "net_terms_days": {...}, "tax_jurisdiction": {...}, "line_items": [ {"text","amount","p","review"} ] }, "needs_review": ["field", ...], "meta": {"model","jev_ms","input_tokens","usd"} } ], "total_ms": 300 }`. Each field's `value` is null when the contract does not state it.

4. Code block, id `invoice_draft`, name "QuickBooks invoice draft + close summary (mock)". It stands in for the QuickBooks and Slack steps and returns what they would receive, from `documents[0]` of the `jev_extract` response:
   - `quickbooksInvoice`: `{ CustomerRef: { name: "Boot Barn, Inc." }, TxnDate: terms.start_date.value, SalesTermRef: { name: "Net " + terms.net_terms_days.value }, Line: [ { Amount: terms.amount.value, DetailType: "SalesItemLineDetail", Description: "SaaS fees (" + terms.billing_frequency.value + ")" } ], CurrencyRef: { value: terms.amount.currency }, PrivateNote: "Contract " + envelopeId + ", tax jurisdiction " + terms.tax_jurisdiction.value }`
   - `slackMessage`: a short text for #finance-close listing each extracted field with its value and confidence, the fields in `needs_review`, and `meta.jev_ms` / `meta.usd`.
   - `needsReview`: the top-level `needs_review` boolean, and `reviewFields`: `documents[0].needs_review`.
   Handle null values (show "not stated") instead of failing.

5. Condition block on `needsReview` from `invoice_draft`:
   - true → Approval block "Review extracted billing terms", showing `slackMessage` and `reviewFields`, approver: me.
   - false → end.

Wire the edges 1 → 2 → 3 → 4 → 5. Then tell me how to run it and where to see the output of the `jev_extract` step.
