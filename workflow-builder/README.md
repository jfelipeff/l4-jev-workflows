# workflow-builder

A website that turns a plain-language description into a Loopfour Studio workflow in about a second,
using **Jev** (TypeSafe's System One model) instead of an LLM. Jev only ever *chooses*: every trigger,
app, action and field comes from the workspace's live block catalog (`GET /api/v1/blocks`), and every
config value comes from the user's own words or from earlier steps' outputs.

## How it works

| Stage | Who | What |
|---|---|---|
| Split | code (`lib/parse.ts`) | description → clauses (one per step), if/otherwise branches, concrete values (#channels, emails, amounts, quoted text, durations, URLs) |
| Round 1 | Jev, 1 request | trigger type + schedule parts (frequency, weekday, hour, minute, time zone); per clause: step kind, app, and "same step as the previous clause?" |
| Round 2 | Jev, 1 request | per step: action of its top-2 apps (speculative), condition operator and operands, approvers |
| Round 3 | Jev, 1 request | each config field of the chosen action: a Choice among values from the text, earlier steps' outputs, or "none" |
| Assemble | code (`lib/assemble.ts`) | steps JSON + Studio canvas (positions, edges, true/false branches), connections from the workspace, questions for anything uncertain or missing |
| Create | Loopfour API | `POST /workflows` (draft), then `PATCH /workflows/:id/canvas` so it shows as blocks |

Low-confidence choices and missing required values become questions in the UI. Answering a field
re-assembles in the browser; changing an app or action re-plans with that choice forced.

## Formats verified against the live API

The docs and Studio disagree in places; these were checked by creating and running probe workflows:

- action step: `{type: "action", action: "slack.sendMessage", config: {operation, connection, ...}}`
- condition: `{type: "condition", config: {conditions: {left, operator: "gt", right}, then: [...], else: [...]}}`
  (documented operator names: `eq ne gt gte lt lte contains startsWith endsWith exists isEmpty`)
- trigger data: `{{input.amount}}` (not `{{trigger.input...}}`)
- step outputs: `{{steps.<stepId>.<field>}}` (not `{{steps.x.output.y}}`, which resolves to empty)
- a workflow created with `steps` only has no canvas; the `PATCH /canvas` call adds it

## Results (5 descriptions in `test/cases.ts`)

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

## Limits (v1)

- Triggers: API and schedule. Other catalog triggers (JustPaid, Airwallex, inbound email) and app
  events without a trigger block fall back to an API trigger, with a note.
- Steps: app actions, conditions (one comparison, then/else), approvals, waits, API requests.
  Loops, parallel branches, transforms, code and agent blocks are not generated yet.
- Fields that need structured JSON (e.g. QuickBooks "Data", Sheets "Values") are left for the user.
- In Studio's canvas, condition operators other than `equals` are stored with the API's names.
