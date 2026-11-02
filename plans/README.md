# Plans

Each plan for this repo is a JSON file, `plans/<slug>.json`, valid against the agentic-sdlc
[plan schema](https://github.com/BeerCanLabs/agentic-sdlc/blob/main/shared/schemas/plan.schema.json).
Detail the schema can't hold (requirements, decisions, story drafts) goes in `plans/<slug>.md`.

Flow ([PROCESS.md section 1](https://github.com/BeerCanLabs/agentic-sdlc/blob/main/docs/PROCESS.md#1-plan)):

1. The planner adds the plan by a PR against the default branch.
2. The plan gate reviews that PR: reviewer plus 3 jurors, at most 3 send-backs. FinOps is recorded as `not built, estimate pending` until that agent exists.
3. Dale approves by merging.
4. The story-breaker creates epic and story issues only from the merged file; each issue links back to it.
