# contract-to-invoice

Replaces the Agent (LLM) block in the Loopfour step *"Extract the billing terms — amount, billing
frequency, start date, NET terms, line items, and tax jurisdiction"* with Jev. No LLM is involved.

1. **Find** (`regex.ts`): regexes list every amount, date, payment-terms phrase, location and
   priced line in the document.
2. **Pick** (`primitives.ts`): one request to the TypeSafe API asks, per field, which candidate is
   the answer (a `Choice` with a `none` option), plus one yes/no (`Noul`) per line: "is this a
   billable line item?". The amount uses speculative fan-out: the document type and three amount
   questions go in the same request, and code keeps the one that applies.
3. **Copy**: the picked span is copied verbatim and normalized in code (numbers, ISO dates, NET
   days). A field whose answer is `none` or whose confidence is below 0.6 is listed in
   `needs_review`, for the workflow's approval step.

| File | |
|---|---|
| `regex.ts` | candidate finders and normalizers |
| `primitives.ts` | the Jev questions, the API call, reading the answers |
| `payload.ts` | turns what Loopfour sends (text, PDF, DocuSign event) into document text |
| `api/extract.ts` | the HTTP endpoint (Vercel function) |
| `main.ts` | local CLI over `samples/` |

## Endpoint

`POST https://l4-jev-contract-to-invoice.vercel.app/api/extract` with `Authorization: Bearer <L4_JEV_TOKEN>` and a JSON
body in one of these shapes:

| Body | Where it comes from in Loopfour |
|---|---|
| `{"text": "..."}` | PDF block `readText` → `{{steps.<pdf step>.output.text}}` **(recommended)** |
| `{"pages": ["...", ...]}` | PDF block `readText` output, page by page |
| `{"pdfBase64": "...", "name": "contract.pdf"}` | the PDF itself, e.g. from `docusign.downloadDocument` |
| a DocuSign Connect event | `{{input}}` of the DocuSign webhook trigger, **only** if "Include Documents" is on in DocuSign Connect (`data.envelopeSummary.envelopeDocuments[].PDFBytes`) |

A wrapper such as `{"output": {...}}` or `{"input": {...}}` is unwrapped. A DocuSign event without the
document is **not** guessed at: the endpoint answers `422` saying what to add to the workflow. By
default the DocuSign trigger payload is envelope metadata only, so the usual chain is:

```
DocuSign trigger (envelope-completed)
  → docusign.downloadDocument   (envelopeId = {{input.data.envelopeId}})
  → PDF block readText
  → API Request: POST /api/extract  {"text": "{{steps.<pdf step>.output.text}}"}
  → Condition: {{steps.<api step>.output.needs_review}} → Approval, else continue
```

Response (`200`):

```json
{
  "ok": true,
  "envelopeId": "…",
  "needs_review": true,
  "documents": [{
    "name": "contract.pdf",
    "terms": {
      "document_type": "contract",
      "amount": { "value": 28481, "currency": "USD", "source": "$28,481", "confidence": 1, "review": false },
      "billing_frequency": { "value": "monthly", "source": "monthly", "confidence": 1, "review": false },
      "start_date": { "value": "2026-06-26", "source": "June 26, 2026", "confidence": 1, "review": false },
      "net_terms_days": { "value": null, "source": null, "confidence": null, "review": true },
      "tax_jurisdiction": { "value": "Orange, CA 92867", "source": "Orange, CA 92867", "confidence": 0.88, "review": false },
      "line_items": [{ "text": "…", "amount": 3468, "p": 0.98, "review": false }]
    },
    "needs_review": ["net_terms_days"],
    "meta": { "model": "jev-1.13.0", "regex_ms": 5.8, "jev_ms": 290, "input_tokens": 3694, "usd": 0.000155, "candidates": { "…": 0 } }
  }],
  "total_ms": 300
}
```

Errors: `401` wrong/missing token · `400` body is not JSON · `422` no document in the body ·
`502` TypeSafe API failed after 3 attempts (so the block's retry/fail handling applies).

## Run locally

```bash
npm install
echo "TYPESAFE_API_KEY=..." > .env
npm start                                  # every file in samples/
npm start -- samples/contract_nsb_pos_saas.txt some-contract.pdf
```

## Deploy (Vercel)

Vercel project with **Root Directory** = `contract-to-invoice` and two environment variables:
`TYPESAFE_API_KEY` and `L4_JEV_TOKEN` (any long random string; the same value goes in the Loopfour
API Request block's `Authorization: Bearer …` header, ideally stored as a Loopfour workflow secret).

## Known limits (v1)

- Line items: table rows whose description wraps onto a second line, and invoices that repeat each
  item in detail rows, come back split or flagged for review.
- Jev reads at most ~32k tokens of document per request; very long contracts need the relevant
  pages selected first (PDF block `pages`).
- Tax jurisdiction is the customer's delivery/service location as written in the document, not a
  tax-engine lookup (Avalara would do that downstream).
