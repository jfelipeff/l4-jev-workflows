# l4-jev-workflows

Loopfour Studio workflow steps rebuilt with [Jev](https://docs.typesafe.ai) (TypeSafe's System One
model) instead of an LLM: code finds candidate values, Jev picks the right one and returns a
calibrated confidence, code normalizes it. Each folder is one workflow step, deployed as its own
HTTP endpoint that the Loopfour workflow calls.

| Folder | Loopfour step |
|---|---|
| [`contract-to-invoice`](contract-to-invoice) | "Extract the billing terms: amount, billing frequency, start date, NET terms, line items, and tax jurisdiction" from a signed DocuSign contract · `POST https://l4-jev-contract-to-invoice.vercel.app/api/extract` |
