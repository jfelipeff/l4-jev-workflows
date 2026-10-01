# l4-jev-workflows

Loopfour Studio features rebuilt with [Jev](https://docs.typesafe.ai) (TypeSafe's System One model)
instead of an LLM: code finds the candidate answers, Jev picks the right one with a calibrated
confidence, and code assembles the result.

| Folder | What it is |
|---|---|
| [`workflow-builder`](workflow-builder) | Website (https://l4-jev-workflow-builder.vercel.app): plain-language description → Loopfour Studio workflow, plus schema-driven **extraction** and **classification** endpoints that workflows call, all on Jev (no LLM) |
