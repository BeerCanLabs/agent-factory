# Costs and billing

**Audience:** a mid-sized church with a preschool, and a local Sleep in Heavenly Peace chapter. Neither has IT staff. Both are cost-sensitive and may qualify for nonprofit programs — or may not (see §5).

**How to read status labels**

- **works today** — implemented in the factory repo or priced in the AWS landing zone.
- **needs the factory team** — the control exists, but a non-technical adopter cannot set it up or will need help applying it.
- **not possible yet** — no product path, or the control does not actually stop spending.

Figures below are **planning estimates**, not quotes. Model rates that appear in the repo are cited as such. AWS infrastructure list prices outside Fargate are **not** stored in the repo; those lines are labeled as external estimates. Nonprofit program details are from the vendors’ public pages as of 22 November 2026 (America/Phoenix) and can change; use the source links.

---

## 1. What costs money

A factory bill has three layers. They are easy to mix up.

### 1.1 Model (AI) usage

Every model call is priced from **operations data**: USD per million input and output tokens. The factory does not ship a built-in public price table (`packages/budget/src/pricing.ts`, comment M3; `packages/budget/README.md`).

Where prices *do* appear:

- The AWS landing zone’s default **factory model catalog** (Bedrock Converse) in `landing-zones/aws/variables.tf` (`model_catalog`):

  | Factory name | Bedrock model id | Standard (USD / million tokens) | `-flex` entry (USD / million tokens) |
  |---|---|---|---|
  | `deepseek-v3.2` | `deepseek.v3.2` | input $0.62, output $1.85 | input $0.31, output $0.925 |
  | `minimax-m2.5` | `minimax.minimax-m2.5` | input $0.30, output $1.20 | input $0.15, output $0.60 |
  | `kimi-k2.5` | `moonshotai.kimi-k2.5` | input $0.60, output $3.00 | input $0.30, output $1.50 |
  | `glm-5` | `zai.glm-5` | input $1.00, output $3.20 | input $0.50, output $1.60 |
  | `qwen3-coder-next` | `qwen.qwen3-coder-next` | input $0.50, output $1.20 | input $0.25, output $0.60 |
  | `gpt-oss-120b` | `openai.gpt-oss-120b-1:0` | input $0.15, output $0.60 | input $0.075, output $0.30 |
  | `gpt-oss-20b` | `openai.gpt-oss-20b-1:0` | input $0.07, output $0.30 | input $0.035, output $0.15 |

  Prices are the AWS us-east-1 on-demand list prices, checked on 2026-11-27. Each `-flex` entry sends Bedrock `serviceTier: { type: "flex" }`: about half the price, with slower responses when Bedrock is busy. It suits scheduled and background runs better than live chat. These models also accept `serviceTier: "priority"` (about 1.75x the standard price); no priority entries are seeded. Claude on Bedrock does not offer Flex. Claude is not seeded on Bedrock because the Anthropic API vendor serves newer, cheaper Claude models (for example `claude-haiku-5-5` at $0.10 / $0.50). Bedrock `us.` geo inference profiles for Claude bill 10% above the global rate.

- Unpriced models are **refused** (`landing-zones/aws/README.md`, `gatekeeper_egress_prices`). That is a safety feature, not a discount.

Built-in vendor templates also exist for **OpenAI**, **Anthropic** (direct), **xAI (Grok)**, **Google Gemini** (AI Studio), plus a custom OpenAI-compatible endpoint (`packages/contract/src/system.ts`, `AI_PROVIDER_TEMPLATES`; seeded as `ai-provider` systems by `packages/control-plane/src/ai-providers.ts`). Those templates do **not** include dollar rates. If a factory uses those vendors, an operator must enter prices or the calls will not go through.

On the AWS reference landing zone, agents call `${FACTORY_MODEL_BASE_URL}/chat/completions`. The gatekeeper-egress translates to Bedrock and signs with its task role; agents hold no AWS keys (`landing-zones/aws/README.md`). Bedrock charges then show up on the AWS bill. Direct Anthropic/OpenAI/xAI/Gemini keys, if used instead, show up on those vendors’ bills.

**Status: works today** to meter, price, and refuse unpriced or over-budget model calls (see §4).

### 1.2 Hosting (AWS, or another landing zone)

The documented production pattern is **AWS ECS Fargate**, pattern “orchestrated tasks” (`landing-zones/aws/README.md`, `landing-zones/PATTERNS.md`).

Always-on services (desired count 1 unless noted):

| Service | Task size in `ecs.tf` | Notes |
|---|---|---|
| Control plane | 512 CPU (0.5 vCPU), 1024 MB | Single ledger writer |
| Gatekeeper-egress | 512 CPU, 1024 MB | `gatekeeper_egress_count` default 1 |
| Gatekeeper-ingress | 256 CPU (0.25 vCPU), 512 MB | Discord mailbox; still runs even if unused |
| Console | 512 CPU, 1024 MB | Only if `console_image` is set |
| OTEL collector | Sidecar in the same task, not a separate service | Shares the task’s CPU/memory |

Agent runs start from zero and cost nothing while idle (`landing-zones/aws/README.md`: “Agents cost nothing while idle”). Default agent task size in `landing-zones/aws/variables.tf` is 512 CPU / 1024 MB if not overridden. The Accountant’s fallback size when it does not know a task size is 0.25 vCPU / 0.5 GB (`packages/control-plane/src/spend.ts`, `DEFAULT_AGENT_TASK_SIZE`).

The repo publishes Fargate **us-east-1 Linux/x86** rates used by the Accountant (`packages/budget/src/cloud.ts`, `FARGATE_US_EAST_1`):

- On-demand: $0.04048 per vCPU-hour, $0.004445 per GB-hour
- Spot figures in the same constant are “the effective rates billed to the BeerCanLabs account in October 2026” and may not match another account

Using those on-demand rates and 730 hours/month (`HOURS_PER_MONTH` in the same file):

| Always-on task | Approx. Fargate compute / month |
|---|---|
| Control plane (0.5 vCPU, 1 GB) | ~$18 |
| Gatekeeper-egress (same) | ~$18 |
| Gatekeeper-ingress (0.25 vCPU, 0.5 GB) | ~$9 |
| Console, if deployed (0.5 vCPU, 1 GB) | ~$18 |
| **Subtotal, Fargate house services (with console)** | **~$63** |

That is **not** the full AWS bill. The same README states there are no NAT gateways, and that fixed costs also include:

- An **Application Load Balancer**
- **Four interface VPC endpoints, billed hourly per AZ, in two AZs**
- **EFS** (ledger) and S3 (mind, ledger checkpoints with Object Lock)
- CloudWatch logs and metrics

Those line items are not priced in the repo. Using commonly published AWS *list* prices for us-east-1 (external estimate, confirm in the AWS calculator before promising a number):

- ALB: on the order of $16/month plus light LCU usage (~$5–15 for a small factory)
- Interface VPC endpoints: 4 endpoints × 2 AZs × ~$0.01/hour ≈ **$58/month**, plus per-GB data processing — often the single largest *fixed* line for a quiet factory
- EFS, S3, logs: typically a few dollars to a couple of tens of dollars at this scale, depending on log retention and ledger size

**Planning band for AWS infrastructure, quiet factory, us-east-1, no model spend, no credits: about $140–220/month.** The VPC endpoints and always-on tasks dominate. This is the most important cost surprise for a small nonprofit.

**Compose on one host** (`landing-zones/compose/README.md`) avoids most of that AWS fixed cost (you pay for the host only) but is a weaker trust boundary and the local ledger is not write-once unless pointed at an Object Lock bucket. **GCP** has a landing zone; **Azure** is interview notes only (`landing-zones/azure/README.md`). Neither publishes a cost table in-repo.

**Status: works today** to run on AWS or Compose if someone can provision it. **Needs the factory team** to actually provision and to read the live bill. A non-technical treasurer cannot “turn on a cheaper plan” from the dashboard.

### 1.3 Domains, certificates, and Cloudflare

- A **domain** (for example `factory.yourchurch.org`) is a registrar fee, typically on the order of $10–20/year. Not a factory feature.
- The AWS landing zone expects an **ACM TLS certificate** in `us-east-1` (`landing-zones/aws/README.md`). ACM certificates themselves are not charged; the ALB is.
- **Cloudflare** can front the factory (`landing-zones/aws/cloudflare.tf`): Access applications, webhook bypass, and API-key bypass for `fk_` Bearer tokens on `/api/v1` and `/mcp`. Cloudflare DNS on the Free plan is commonly $0. **Cloudflare Zero Trust Access** is a separate product; its current paid thresholds are not in the repo. Check [Cloudflare’s pricing](https://www.cloudflare.com/plans/) before assuming Access is free for every staff account.
- The live BeerCanLabs dashboard at `https://factory-dashboard.dalesackrider.com` is one existing deployment. It is not a billing portal for other organizations.

**Status: needs the factory team** (and a domain owner) to set DNS and Access. **Not possible yet** for an adopter to self-serve a hostname on someone else’s factory.

### 1.4 What does *not* appear as its own factory invoice

The factory does not bill adopters, take a card, or split costs by organization. There is no marketplace SKU and no per-seat SaaS price in the repo. Whoever owns the AWS (or GCP) account, and whichever model vendors hold API keys, receives the invoices. **Status: not possible yet** to “subscribe to the factory” as a product. See `hosting-and-setup.md` for a hosted-for-you option.

---

## 2. Realistic monthly estimates (stated assumptions)

Assumptions shared by both scenarios:

- One dedicated factory on the AWS reference landing zone in `us-east-1`, on-demand Fargate (not Spot), console deployed, quiet webhook traffic.
- Infrastructure mid-point **$180/month** (see the band in §1.2). This is the line that does not shrink when the agents are idle.
- Model mix is Bedrock catalog rates from `variables.tf`. No prompt caching discount is assumed (the pricer supports cache rates, but we do not have measured cache hit rates).
- Three to six agents, used on weekdays, with a person in the loop for outbound mail.
- No ChMS/SMS/Microsoft usage, because those integrations are not available (see `connectors-and-integrations.md`).
- USD, before tax. No AWS promotional credit applied in the “list” column.

### 2.1 Church (400 people) with preschool (100+ children)

**Light (recommended starting point).** Office assistant on Gmail/Calendar/Drive only. Mostly Haiku, occasional Sonnet for a long draft. About 3 million input tokens and 0.6 million output tokens per month, 80% Haiku / 20% Sonnet-class.

- Model: roughly (0.8×3×$1 + 0.2×3×$3) + (0.8×0.6×$5 + 0.2×0.6×$15) ≈ **$8–12/month**
- Infra: ~$180
- **Total: about $190–195/month**, almost all infrastructure

**Moderate (several staff-facing agents: office, volunteer roster, facilities calendar).** 8 million input / 1.5 million output, half Haiku, half Sonnet.

- Model: roughly $28–40/month
- **Total: about $210–220/month**

**Heavy (daily preschool-family and pastoral drafting on Sonnet/Opus, plus more runs).** 20 million input / 4 million output, mostly Sonnet with some Opus. This is only realistic if more integrations exist; today much of that work cannot actually reach preschool systems.

- Model: could reach **$120–200/month**
- **Total: about $300–380/month** plus any extra agent compute while tasks are running (report-only; see §4)

### 2.2 Sleep in Heavenly Peace chapter

**Light.** Weekly volunteer emails, Drive folder lookups, a few calendar holds. Similar to the church light profile: **about $190–200/month**, of which AI is a few dollars.

**Build-season moderate.** In the weeks around a large build or delivery push, traffic might resemble the church moderate profile: **about $210–230/month**. The missing Sheets and SMS integrations (not a cost item — they are a capability gap) matter more than the extra tokens.

### 2.3 How to talk about this with a treasurer

The honest sentence: **for a small org, the factory’s AWS “keep the lights on” cost is much larger than the AI cost**, unless you run a lot of expensive models or someone hosts the factory for you (shared or subsidized). An AWS nonprofit credit ( §5) can cover that infrastructure for a time. Agent-level token caps ( §4) will not stop the ALB or VPC endpoint charges.

A **Compose host** or a **hosted-for-you** shared platform (not built) would change this picture. Do not tell a chapter they can “try it for the cost of a few dollars of ChatGPT” if they are expected to run the reference AWS landing zone themselves.

---

## 3. How spend is visible

**Status: works today** for operators who can sign in with `spend.read` (typically a viewer or admin):

- `GET /api/v1/spend` — fleet spend summary
- `GET /api/v1/spend/report?period=current|last` — AI by agent, cloud bill summary, compute attribution (`packages/control-plane/src/spend.ts`)
- `GET /api/v1/spend/compute` — live house services and agent tasks, with estimated monthly Fargate cost from the rates in §1.2
- `GET /api/v1/spend/budgets` — factory-level budget documents
- Console **FinOps** view (`packages/console/src/views/FinOpsView.tsx`)

The AWS (or GCP) bill is read through a landing-zone adapter (`packages/control-plane/src/aws/accountant.ts`, `packages/budget/src/cloud.ts`). The Accountant splits **gross** vs **credits** vs **net**, and AI (Bedrock / Vertex / Gemini on the cloud bill) vs infrastructure. Cloud AI billed by AWS and the model ledger should be compared, never added together (`summarizeCloud` comments in `cloud.ts`). Cloud bill reads are cached for an hour because they can themselves cost money (`CLOUD_CACHE_MS`).

On AWS, a Data Export (CSV, gzip) under the landing-zone prefix is preferred once an object for the month has landed. The report's `allocation` maps every dollar to cost center `beercanlabs` (sub-center = the `project` tag, or `untagged`) and queues tag backfill for the operator without applying it. The checklist is `docs/aws-data-exports.md`. Cost Explorer remains the source until then. The GCP accountant already reads the BigQuery billing export; that path is unchanged.

**Status: needs the factory team** to attach the cloud-bill adapter and to teach a treasurer how to read FinOps. There is no “email me a PDF invoice” or parent-friendly digest.

---

## 4. Caps, budgets, and “budget holds” — what actually stops spend

There are several controls. They are not the same.

### 4.1 Per-agent token budget (enforced)

Each agent policy may set `budgetUsd` with any of `perRun`, `perDay`, `perMonth` (`packages/budget/src/limits.ts`, `packages/budget/src/index.ts`). Unset windows are not enforced.

The Accountant’s `checkStanding` is the only place that compares spend to those limits (`packages/budget/README.md`, `packages/budget/src/standing.ts`):

- Gatekeeper-egress asks before every model call and returns **402 `budget_exceeded`** when the agent is over.
- The control plane asks before every **wake** (`createRun`) and refuses with the same 402 and a ledger row `WAKE_REFUSED_BUDGET_EXCEEDED` (queued messages stay in the queue; a refused schedule does not retry that minute). See the TSK-088 notes in `DESIGN_AUTHORITY.md` and `packages/control-plane/src` wake-budget tests.
- Spend is rebuilt from ledger `llm` rows. Pending (not yet acknowledged) metered spend counts in every window.
- **Built-in factory agents are exempt.**
- **Agent compute (Fargate task time) is report-only and does not count against `budgetUsd`** (Dale, 2026-10-08, documented in `packages/budget/src/cloud.ts` `attributeCompute`).

A typical starting policy, as in the AWS README example, is `PUT /api/v1/agents/<id>/policy` with `"budgetUsd": { "perDay": 5 }`. The Fleet view can also submit a budget (`packages/console/src/views/FleetView.tsx`).

New work submitted for an agent can sit pending until a budget-owner allocates `perDay` / `perMonth` (`PUT /api/v1/budget/submissions/:id`, privilege `budget.allocate`, `packages/control-plane/src/submissions.ts`).

**Status: works today.** This is the right tool to keep a chatty agent from burning model dollars. It does **not** cap AWS infrastructure.

### 4.2 Factory-level monthly budgets (alert only)

Admins can set factory-wide caps with `PUT /api/v1/spend/budgets` (`spend.budget.set`): `aiMonthUsd`, `infraMonthUsd`, `totalMonthUsd`, and optional `alertAt` fractions (default 80% and 100%) (`packages/budget/src/cloud.ts`, `validateFactoryBudgets`; `packages/control-plane/src/spend.ts`, `checkFactoryBudgets`).

Judgment is on **gross** usage. **Credits are reported but never counted against a factory budget** (“they mask the bill,” `cloud.ts`).

When a threshold is crossed, the factory appends a `budget.alert` ledger event such as `FACTORY_BUDGET_AI_80PCT`. That is it. `checkFactoryBudgets` does **not** refuse wakes, does **not** shut down tasks, and does **not** disable the ALB. **Status: works today** as an alert; **not possible yet** as a hard factory-wide kill switch. Do not tell a treasurer the factory budget will “cut off the AWS account.”

### 4.3 Plan or SDLC “budget holds”

Human-in-the-loop holds for *work plans* (approve a story breakdown and its estimated cost before coding) are a different mechanism, used in BeerCanLabs’ own SDLC fleet. They are not a monthly spend limiter for a church secretary’s office agent. A configured approver may approve those holds in the console; that rule is operations policy, not a substitute for `budgetUsd`.

**Dale’s standing rule (not in the public product UI, but binding on operators): never approve a budget hold on his behalf.** An adopting org would need its *own* named approvers.

### 4.4 Cloud billing alarms outside the factory

AWS can alarm on estimated charges (CloudWatch billing alarm). The AWS nonprofit credit FAQ recommends this. It is not configured by the factory Terraform automatically in the material reviewed. **Status: needs the factory team** (or the account owner in the AWS console).

### 4.5 What a non-technical treasurer can do alone

If they can sign in: look at FinOps, ask an admin to lower an agent’s `perDay` / `perMonth`, and notice alerts. They cannot, from the factory UI, cap VPC endpoint cost, apply a nonprofit credit, or stop the always-on tasks. **Needs the factory team.**

---

## 5. Nonprofit discounts and credits (external programs)

These are **not factory features**. Eligibility is decided by Google, Microsoft, AWS, and TechSoup. Churches, preschool ministries, and local chapters under a group exemption often hit edge cases. Someone at the org must apply; a vendor’s “nonprofit” grant does not automatically attach to a factory.

### 5.1 Google for Nonprofits / Google Workspace for Nonprofits

- Landing page: [https://www.google.com/nonprofits/](https://www.google.com/nonprofits/)
- Eligibility and excluded types (government, hospitals, schools/universities; philanthropic arms may qualify): see Google’s current guidelines linked from that page. [Product availability by country](https://support.google.com/nonprofits/answer/1614602).
- [Google Workspace for Nonprofits](https://knowledge.workspace.google.com/admin/getting-started/editions/google-workspace-for-nonprofits-edition) is offered at no charge for qualifying orgs (features such as custom email, Calendar, Docs, and a stated user cap; confirm the live page — last updated 10 November 2026 on the help article retrieved for this draft). Paid Business/Enterprise editions have a nonprofit discount if they upgrade.
- Google’s FAQ states **fiscally sponsored** organizations are **not** eligible. A SIP chapter or church that only exists under a parent’s umbrella should read the [group-exemption notes](https://www.google.com/nonprofits/resources/faq/) carefully and expect a verification step (Google’s validation partner is named on those pages).
- A preschool that is legally a *school* may be pointed to Google for Education instead of Google for Nonprofits.

This program lowers the cost of **the church’s email and Drive**, not the factory’s AWS bill. It also makes the factory’s existing Google connectors useful. **Status: external; needs the org to apply.**

### 5.2 Microsoft nonprofit offers

- Offers: [https://www.microsoft.com/en-us/nonprofits/offers-for-nonprofits](https://www.microsoft.com/en-us/nonprofits/offers-for-nonprofits)
- Eligibility: [https://www.microsoft.com/en-us/nonprofits/eligibility](https://www.microsoft.com/en-us/nonprofits/eligibility)
- Pricing page: [https://www.microsoft.com/en-us/microsoft-365/business/nonprofit-plans-and-pricing](https://www.microsoft.com/en-us/microsoft-365/business/nonprofit-plans-and-pricing)
- Eligible orgs can receive **Microsoft 365 Business Basic granted (free) for up to 300 users**. Higher tiers are discounted (Business Standard and Business Premium were listed at nonprofit staff pricing on the page retrieved for this draft). Grants are for **paid employees and unpaid executive leadership**; volunteers may be eligible for *discounted*, not granted, licenses. Members, donors, and program participants (for example church members or families in the preschool) are not eligible for those licenses. Microsoft also states an **85% active-usage** expectation on granted licenses.
- India-specific rules on the eligibility page list faith-based organizations as ineligible there; US churches typically rely on 501(c)(3) or equivalent charitable status — verify, do not assume.
- Microsoft 365 access does **not** give the factory a Graph connector today (`connectors-and-integrations.md`).

### 5.3 AWS Nonprofit Credit Program

- [https://aws.amazon.com/government-education/nonprofits/nonprofit-credit-program/](https://aws.amazon.com/government-education/nonprofits/nonprofit-credit-program/)
- Up to **$5,000 USD** in AWS Promotional Credit, requested **once per fiscal year (1 July–30 June)**, valid at least a year or until exhausted.
- US distribution is through **TechSoup** (international orgs use TechSoup partner NGOs).
- Eligible US designations listed on the AWS page include 501(c)(1), **501(c)(3)**, and several other 501(c) types, plus some public libraries. **Educational institutions are not eligible** for this credit (AWS Educate is separate).
- Credit applies to on-demand pay-as-you-go services. It does **not** cover Route 53 domain registration, Marketplace, support plans that are ineligible, Reserved Instances, and other exclusions listed on that page.
- **$5,000 would cover on the order of two years of the quiet-factory infrastructure band in §1.2**, or less if model spend is heavy. After it expires, the account is billed at list. Put a billing alarm in place.
- Inside the factory, remember: **credits do not count toward factory budget caps** (`packages/budget/src/cloud.ts`). A factory `totalMonthUsd` can still alert (or fail to alert the way a treasurer expects) while the cash bill is $0 because of credit.

### 5.4 TechSoup

- Join (US): [https://support.techsoup.org/hc/en-us/articles/360055217213-How-to-Join-TechSoup-U-S](https://support.techsoup.org/hc/en-us/articles/360055217213-How-to-Join-TechSoup-U-S)
- TechSoup US eligibility is **IRS-recognized 501(c)(3) public charities** (and some group-exemption subordinates). TechSoup’s own article states that other tax-exempt types **and religious organizations as such** (citing IRS Publication 1828) are **not currently eligible** for TechSoup or many partner programs, unless the organization is a 501(c)(3) public charity.
- **This is a hard practical gate:** a church that is not a 501(c)(3) public charity may be unable to request the AWS credit *through TechSoup*. A SIP chapter should confirm whether it has its own 501(c)(3) or is covered by the national organization’s group exemption in a way TechSoup will accept.
- Microsoft cloud offers can also be requested through TechSoup ([cloud subscriptions article](https://support.techsoup.org/hc/en-us/articles/28638323879835-How-to-Request-Microsoft-Cloud-CSP-Subscriptions-Through-TechSoup)), or directly from Microsoft.

### 5.5 What this means for the two orgs

| Org | Likely path | Caveat |
|---|---|---|
| Church + preschool | Apply to Google for Nonprofits if legally a charitable org; Microsoft if they are Microsoft-first and eligible; AWS credit only if 501(c)(3) (or listed type) and TechSoup accepts them | A preschool legally organized as a school may be excluded from some “nonprofit” programs; a church without 501(c)(3) may be excluded from TechSoup |
| SIP chapter | National SIP is a charity; the *chapter* must check its own exemption and whether it can join TechSoup and request AWS credit in its own (or the parent’s) AWS account | Fiscally sponsored arrangements can fail Google’s rules; group exemptions need extra documentation |

None of these programs remove the need for a human owner of the cloud account, a credit card on file for when credits end, and the caps in §4.

---

## 6. Practical recommendation

1. Do not stand up a dedicated AWS reference landing zone for a first pilot unless credits, a sponsor, or a hosted operator will cover the **~$140–220/month** floor.
2. If a pilot factory is stood up, set **per-agent `budgetUsd.perDay` and `perMonth` immediately** (start stricter than you think, for example $2/day and $20/month on a Haiku-default agent). **Status: works today.**
3. Set factory `aiMonthUsd` / `infraMonthUsd` / `totalMonthUsd` for *visibility*, and add an **AWS billing alarm**. Do not rely on factory budgets to stop infrastructure spend. **Status: alerts work today; hard cap on infra is not possible yet.**
4. Prefer cheaper models (`claude-haiku-5-5`, or an open-weight Bedrock model such as `minimax-m2.5`) as the default; treat Sonnet/Opus as an exception. Unpriced models will simply fail, which is good.
5. Start nonprofit applications early; verification takes days to weeks and can fail for church and chapter structures.
6. Keep a named human as the AWS account root/email owner. The factory will not be the legal customer of AWS on the adopter’s behalf unless a hosted-for-you contract says so.
