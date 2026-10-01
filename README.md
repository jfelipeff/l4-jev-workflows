# l4-jev-workflows

Loopfour Studio features rebuilt with [Jev](https://docs.typesafe.ai) (TypeSafe's System One model)
instead of an LLM: code finds the candidate answers, Jev picks the right one with a calibrated
confidence, and code assembles the result.

![Code finds the candidate values in the document, Jev picks the right one with a confidence, code copies it into the result](assets/readme-illustrations/01-jev-picks-code-assembles.png)

| Folder | What it is |
|---|---|
| [`workflow-builder`](workflow-builder) | Website (https://l4-jev-workflow-builder.vercel.app): plain-language description → Loopfour Studio workflow, plus schema-driven **extraction** and **classification** endpoints that workflows call, all on Jev (no LLM) |

The workflow builder works the same way: the description is cut into parts, and Jev files each part under a
block from your workspace's live Loopfour catalog, so a block that does not exist is never used.

![The description is cut into parts and Jev files each one under a real block from the live catalog, then the workflow is created in Loopfour Studio](assets/readme-illustrations/02-workflow-builder.png)
