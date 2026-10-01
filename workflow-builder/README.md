# workflow-builder

Live: https://l4-jev-workflow-builder.vercel.app — three functions, all on Jev (TypeSafe), no LLM:

| Function | What it does | Endpoint |
|---|---|---|
| Workflow builder | plain-language description → Loopfour Studio workflow | `POST /api/plan`, `POST /api/create` |
| Extraction | document + JSON Schema (or field list) → JSON, every value copied from the document | `POST /api/extract` |
| Classification | document + labels → label(s) with probabilities and a review flag | `POST /api/classify` |
| Jev vs LLM race | the same input to Jev and to claude-opus-5 (an agent in the visitor's Loopfour workspace, `[jev-race] …`) at the same moment, timed in the browser | `POST /api/race` for the LLM side |

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

### Optional LLM fallback (cascade)

Send the header `x-loopfour-key` and only the answers Jev could not settle go to an LLM, following
TypeSafe's [SDE cascade](https://docs.typesafe.ai/cookbooks/sde_cascade): a required field that came back
empty, a field under 60% confidence, a field whose type no finder recognized in the text, or a flagged
classification. The LLM is Loopfour's own claude-opus-5, run as an agent in the caller's workspace
(`lib/escalate.ts`). Its answer is kept only if its quote appears verbatim in the document **and** Jev
confirms the quote states that value (≥ 70%); otherwise the field stays `review: true`. Measured:

| Document | LLM calls | Time | Cost |
|---|---|---|---|
| Messy contract (amounts in words, "three years", "due on receipt") | 0 (Jev got 7/7 after the finders learned number words) | 0.45 s | $0.0002 |
| Memo with "the 1st of Nov. '26" | 1, for that field only; accepted (Jev 98%) | 4.3 s | $0.006 |
| Fields that are not in the document | 1; nothing invented, both stay for review | 4.0 s | ~$0.006 |

Measured: 11 billing fields from an order form in 0.5–0.75 s for $0.0007; a support ticket classified in
0.18–0.30 s for $0.000024.

## Loopfour templates

Studio ships 29 workflow templates. When a description is one of them, the builder recreates **that exact
template** (trigger, steps, configuration) instead of assembling blocks, and fills its variables (Slack
channel, approver email, threshold, sheet ID) from the description with Jev, the way Studio's Copilot
instantiates templates. 19 of the 29 use actions that are not in the public block catalog
(`netsuite.suiteql`, `netsuite.createJournalEntry`, Bill.com, Ramp, ...), so a block-by-block build could
never reproduce them; Loopfour accepts and activates them when created through the Workflows API.

Recognition is two Jev judgments in the requests the builder already makes: a Choice over all 29
templates (name, description, step names, trigger) and a yes/no "same finance process?" check on the
winner; a template is used only when the Choice is ≥ 50% and the check ≥ 70%. `npm test` runs every
template phrased two ways (its description, and only its step names) plus the "Cash application"
recipe card pasted as one line: all 59 are recreated step for step, and none of the 11 ordinary
descriptions is mistaken for a template (70/70). The site's **Loopfour templates** tab lists them with a
"Build with Jev" button.

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

## Results: Jev vs an LLM on the same inputs

The LLM side is claude-opus-5 run as a custom Loopfour agent; cost is what Loopfour reports, times are wall-clock.

| Task | Jev | LLM (claude-opus-5) | Jev is |
|---|---|---|---|
| Build a workflow (first 5 descriptions in `test/cases.ts`) | **0.64 s · $0.00042**, 5/5 correct | 5.52 s · $0.054, 5/5 correct | 8.6× faster, 128× cheaper |
| Extract 11 checks (8 fields + 3 line items) from the sample order form, 3 runs | **0.47 s · $0.00049**, 11/11 every run | 5.00 s · $0.0154, 11/11 every run | 10.6× faster, 32× cheaper |
| Classify the 4 sample tickets (billing / technical / sales), 2 runs each | **0.20 s · $0.000025**, 8/8 | 2.85 s · $0.0041, 8/8 | 14.4× faster, 163× cheaper |

Reproduce with `npm run compare` (builder) and `npm run compare:functions` (extraction and classification, on the
samples in `lib/samples.ts`). Both create or reuse custom agents in the workspace (`[jev-builder] …`, `[jev-compare] …`);
that LLM runs on Loopfour, outside this project's pipeline.

## Run

```bash
npm install
# .env.local: TYPESAFE_API_KEY=... (server) and, for tests/compare only, LOOPFOUR_API_KEY=...
npm test          # 70 cases (incl. all 29 templates × 2 phrasings), saved catalog snapshot, cached Jev answers; never calls Loopfour
npm run dev       # http://localhost:3000, paste a Loopfour key in the page
npm run compare   # Jev vs claude-opus-5 on the same 5 descriptions
npm run compare:functions  # Jev vs claude-opus-5 on the sample order form and tickets
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
