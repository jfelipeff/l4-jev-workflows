# l4-jev-workflows

**Loopfour Studio features rebuilt with [Jev](https://docs.typesafe.ai) (TypeSafe's System One model) instead of an LLM.**

[Live site](https://l4-jev-workflow-builder.vercel.app) · [Jev docs](https://docs.typesafe.ai) · [Loopfour Studio](https://studio.loopfour.ai) · [Technical README](workflow-builder/README.md)

## How it works

Code finds the candidate answers, Jev picks the right one with a calibrated confidence, and code
assembles the result. Jev never writes text, so a total, a date or a block name cannot be invented.

![Code finds the candidate values in the document, Jev picks the right one with a confidence, code copies it into the result](assets/readme-illustrations/01-jev-picks-code-assembles.png)

- **Code finds candidates:** every amount, date, term or label the document could mean.
- **Jev picks:** one typed answer per question, with a probability. Low confidence goes to a person.
- **Code assembles:** each value is copied verbatim into the result and keeps its source line for the audit trail.

## What's inside

| Function | What it does | Endpoint |
|---|---|---|
| **Workflow builder** | Plain-language description → Loopfour Studio workflow, created through the Loopfour Workflows API | `POST /api/plan`, `POST /api/create` |
| **Extraction** | Document + JSON Schema (or a field list) → JSON, every value copied from the document | `POST /api/extract` |
| **Classification** | Document + labels → label(s) with probabilities and a review flag | `POST /api/classify` |

Extraction and classification plug into any Studio workflow through an **API Request** block. An
optional cascade sends only the answers Jev is unsure about to an LLM, and keeps an answer only if it
quotes the document and Jev confirms it.

## The workflow builder

The workflow builder works the same way: the description is cut into parts, and Jev files each part under a
block from your workspace's live Loopfour catalog, so a block that does not exist is never used.
Descriptions of Loopfour's own templates are recognized and recreated step for step.

![The description is cut into parts and Jev files each one under a real block from the live catalog, then the workflow is created in Loopfour Studio](assets/readme-illustrations/02-workflow-builder.png)

## Measured

| Task | Jev | LLM (claude-opus-5) |
|---|---|---|
| Build a workflow from a description (5 descriptions) | **0.64 s · $0.00042**, 5/5 correct | 5.52 s · $0.054, 5/5 correct |
| Extract 11 billing fields (incl. line items) from an order form | **0.5–0.75 s · $0.0007**, 11/11 correct | not measured |
| Classify a support ticket | **0.18–0.30 s · $0.000024** | not measured |

## Try it

Open the [live site](https://l4-jev-workflow-builder.vercel.app) and enter your own Loopfour and Jev
keys; the site stores none. To run it locally, see [`workflow-builder`](workflow-builder/README.md).

| Folder | What it is |
|---|---|
| [`workflow-builder`](workflow-builder) | The Next.js site and API: builder, extraction, classification, tests |
| [`assets`](assets) | README illustrations |
