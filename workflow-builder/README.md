# workflow-builder

Live: https://l4-jev-workflow-builder.vercel.app — three functions, all on Jev (TypeSafe), no LLM:

| Function | What it does | Endpoint |
|---|---|---|
| Workflow builder | plain-language description → Loopfour Studio workflow | `POST /api/plan`, `POST /api/create` |
| Extraction | document + JSON Schema (or field list) → JSON, every value copied from the document | `POST /api/extract` |
| Classification | document + labels → label(s) with probabilities and a review flag | `POST /api/classify` |

Visitors bring their own keys (Loopfour for the builder, Jev for everything); the site stores none.

### Calling extraction / classification from a Loopfour workflow

Use an **API Request** block (the builder creates it for you):

```json
{
  "url": "https://l4-jev-workflow-builder.vercel.app/api/extract",
  "method": "POST",
  "headers": [{ "Key": "x-jev-key", "Value": "{{secrets.JEV_API_KEY}}" }],
  "body": {
    "document": "{{steps.<previous step>.result}}",
    "instructions": "Extract the invoice fields.",
    "schema": { "type": "object", "properties": { "invoice_number": { "type": "string" }, "total": { "type": "number" }, "due_date": { "type": "string", "format": "date" } } }
  },
  "responseFormat": "json"
}
```

`/api/classify` takes `{document, instructions?, labels, multi_label?, allow_none?}` the same way. The workflow
needs a secret `JEV_API_KEY` (Loopfour checks it before the run starts); the builder stores it when your
Loopfour key has the `secrets:write` scope, otherwise add it in Studio.

Measured: 11 billing fields from an order form in 0.5–0.75 s for $0.0007; a support ticket classified in
0.18–0.30 s for $0.000024.

## Workflow builder

A website that turns a plain-language description into a Loopfour Studio workflow in about a second,
using **Jev** (TypeSafe's System One model) instead of an LLM. Jev only ever *chooses*: every trigger,
app, action and field comes from the workspace's live block catalog (`GET /api/v1/blocks`), and every
config value comes from the user's own words or from earlier steps' outputs.

## How it works

Every part of the description is classified against what each block **does**: the 23 apps in the
catalog plus the core blocks (AI Agent, Condition, Approval, Wait, API Request), each described by
when to use it. One clause can need several blocks: "Scan Stripe events daily for duplicate charges..."
is Stripe (read the data) + AI Agent (detect the anomalies).

| Stage | Who | What |
|---|---|---|
| Split | code (`lib/parse.ts`) | description → clauses, if/otherwise branches, concrete values (#channels, emails, amounts, quoted text, durations, URLs) |
| Round 1 | Jev, 1 request | trigger + schedule parts; per clause: main block (Choice over all blocks), one yes/no per block ("does this part need it?"), "does it ask to judge/classify/detect?", "only the trigger?", "same step as before?"; whole description: "should results reach someone?", closest Loopfour template |
| Select | code | a clause gets Jev's main pick plus blocks whose yes/no is backed by the text: apps must score ≥0.85 **and** be named; Condition/Wait/Approval/API need their cue ("if", a duration, "approve", a URL); AI Agent ≥0.5 except on rule clauses |
| Round 2 | Jev, 1 request | the action of each app (read vs write, from the wording), condition operator/operands, approvers; does the closest template really fit |
| Order + wire | code | per clause: fetch → analyze → decide → approve → wait → act → notify; the AI Agent reads the previous fetch step, a following message carries the AI's findings |
| Round 3 | Jev, 1 request | each config field: a Choice among values from the text, earlier steps' outputs, or "none" |
| Assemble | code (`lib/assemble.ts`) | steps JSON + Studio canvas, connections, questions (uncertain picks, missing values, "send the results with Slack/Gmail/Outlook/none?", destination channel) |
| Create | Loopfour API | `POST /workflows` (draft), then `PATCH /workflows/:id/canvas` so it shows as blocks |

The selection thresholds come from measurements on the test cases (named apps score ~0.95, unnamed
apps 0.4–0.6; control blocks score high next to an "if" or a delay). Answering a field re-assembles in
the browser; changing a block, adding a destination or removing a step re-plans with that choice forced.

## Formats verified against the live API

The docs and Studio disagree in places; these were checked by creating and running probe workflows:

- action step: `{type: "action", action: "slack.sendMessage", config: {operation, connection, ...}}`
- condition: `{type: "condition", config: {conditions: {left, operator: "gt", right}, then: [...], else: [...]}}`
  (documented operator names: `eq ne gt gte lt lte contains startsWith endsWith exists isEmpty`)
- trigger data: `{{input.amount}}` (not `{{trigger.input...}}`)
- step outputs: `{{steps.<stepId>.<field>}}` (not `{{steps.x.output.y}}`, which resolves to empty)
- a workflow created with `steps` only has no canvas; the `PATCH /canvas` call adds it

## Results (first 5 descriptions in `test/cases.ts`)

| | Jev (this builder) | LLM: claude-opus-5 as a Loopfour agent |
|---|---|---|
| correct structure | 5/5 | 5/5 |
| time per workflow | **0.64 s** | 5.52 s (8.6x slower) |
| cost per workflow | **$0.00042** | $0.054, as reported by Loopfour (~128x more) |
| LLM calls | 0 | 1 |

Reproduce with `npm run compare` (creates or reuses a custom agent `[jev-builder] LLM workflow planner (baseline)`
in the workspace; that LLM runs on Loopfour, outside this builder).

## Run

```bash
npm install
# .env.local: TYPESAFE_API_KEY=... (server) and, for tests/compare only, LOOPFOUR_API_KEY=...
npm test          # 5 cases, saved catalog snapshot, cached Jev answers; never calls Loopfour
npm run dev       # http://localhost:3000, paste a Loopfour key in the page
npm run compare   # Jev vs claude-opus-5 on the same 5 descriptions
```

The deployed site has **no keys of its own**: each visitor enters their Loopfour key and their Jev
(TypeSafe) key in the page. Both stay in memory in that tab and are forwarded per request (Loopfour's
docs forbid sending keys from browsers); they are never stored or logged. `TYPESAFE_API_KEY` in
`.env.local` is only used by `npm test` and `npm run compare`.

`npm test` also runs 4 descriptions taken word for word from Loopfour's own templates
(billing-exceptions, invoice-aging-analysis, subscription-mrr-tracking, dso-monitor): 9/9 pass.

## Limits (v1)

- Triggers: API and schedule. Other catalog triggers (JustPaid, Airwallex, inbound email) and app
  events without a trigger block fall back to an API trigger, with a note.
- Steps: app actions, AI Agent (runs at workflow time), conditions (one comparison, then/else), approvals, waits, API requests.
  Loops, parallel branches, transforms, code and agent blocks are not generated yet.
- Fields that need structured JSON (e.g. QuickBooks "Data", Sheets "Values") are left for the user.
- In Studio's canvas, condition operators other than `equals` are stored with the API's names.
