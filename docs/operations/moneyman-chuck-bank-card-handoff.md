# MoneyMan to Chuck: read-only bank and card hand-off

Operator protocol for [agent-factory#453](https://github.com/BeerCanLabs/agent-factory/issues/453) (epic [#452](https://github.com/BeerCanLabs/agent-factory/issues/452)). The machine-checked account list, fields, and egress decision live in [`moneyman-chuck-bank-card-handoff.contract.json`](./moneyman-chuck-bank-card-handoff.contract.json).

MoneyMan is Dale's Grok Bot finance assistant. It already holds the read-only bank and card links and is the only party that reads those institutions. Chuck Finley (`finley`) is the factory FinOps agent. He reads the export from Notion through the gatekeeper-egress `notion` route he already has. This repository does not implement MoneyMan, does not wake Chuck, and does not change AWS.

Factory agents do not call the Grok Bot Finance plugin or hold Plaid items. A factory-native Plaid connection is the later optional story [#458](https://github.com/BeerCanLabs/agent-factory/issues/458).

## Accounts in scope

MoneyMan exports these accounts only. Identification in Notion is the nickname plus the last 4. Desert Financial checking and HELOC Savings do not have a last 4 recorded in this repository; MoneyMan fills those four digits from the existing link on the first export and writes them in `Last 4`.

| Display | Institution | Last 4 |
| --- | --- | --- |
| Desert Financial checking | Desert Financial | from the first export |
| HELOC Savings | Desert Financial | from the first export |
| Business 0402 | Desert Financial | 0402 |
| Kemba 6606 | Kemba | 6606 |
| Chase Marriott 4914 | Chase | 4914 |
| Citi 3530 | Citi | 3530 |
| Citi AAdvantage 4609 | Citi | 4609 |

Institutions already linked read-only at MoneyMan: Chase, Citi, Desert Financial, and Kemba.

## Accounts excluded

| Display | Institution | Last 4 |
| --- | --- | --- |
| Lexi Savings 0000 | Desert Financial | 0000 |

MoneyMan drops Lexi Savings 0000 before any Notion write. Match that account when the display name is `Lexi Savings 0000`, or when the nickname is Lexi Savings at Desert Financial and the last 4 is `0000`. A row that still arrives is a feed failure: the Feed status page records `Lexi Savings 0000 rows written` as greater than 0, and Chuck does not map the row. Other accounts stay in the export.

## Schema

Amounts are USD decimals. A charge is negative. A credit or payment is positive. `Last 4` is exactly four digits. MoneyMan refuses or masks a full card or account number (any 13- to 19-digit number) before writing, including a test row created to prove the rule. The same refusal applies to routing numbers, Plaid access tokens, Plaid item ids, bank passwords, login details, and factory run tokens. Those values are absent from Notion, from git, and from the factory.

`Feed ID` is MoneyMan's stable transaction id after hashing. Re-running an export upserts on `Feed ID` and keeps a single row. The stored value is that hash: the page holds neither the bank's raw transaction token nor a full account number.

`Vendor hint` is empty, or the single select value `AI/cloud/tech` when MoneyMan recognizes the merchant as one of: AWS, Cloudflare, Google Cloud, Google AI, GitHub, Cursor, xAI/Grok, OpenAI, Anthropic, Microsoft 365, or a domain registrar. Dale's standing rule is that AI, cloud, and tech spend maps to the BeerCanLabs cost center. Chuck treats the hint as a suggestion. The mapping skill itself is out of scope here (portable FinOps skill).

### Transactions

One row per transaction.

| Field | Notion type | Required | Rule |
| --- | --- | --- | --- |
| Date | date | yes | Transaction date from the institution. |
| Posted date | date | no | Empty while `Pending` is set. |
| Amount | number | yes | Signed USD. A charge is negative. |
| Merchant | rich text | yes | Merchant name or statement descriptor. |
| Account | rich text | yes | Nickname plus last 4. |
| Last 4 | rich text | yes | Four digits. |
| Institution | select | yes | Desert Financial, Kemba, Chase, or Citi. |
| Pending | checkbox | yes | Set until the institution posts the transaction. |
| Running balance | number | no | Present when the institution sends a running balance on the transaction. |
| Feed ID | rich text | yes | Hashed stable id. Upsert key. |
| Imported at | date | yes | Export timestamp in America/Phoenix. |
| Vendor hint | select | no | Empty, or `AI/cloud/tech`. |

### Balances

One row per in-scope account per calendar day in America/Phoenix.

| Field | Notion type | Required | Rule |
| --- | --- | --- | --- |
| Date | date | yes | Snapshot day. |
| Account | rich text | yes | Nickname plus last 4. |
| Last 4 | rich text | yes | Four digits. |
| Institution | select | yes | Desert Financial, Kemba, Chase, or Citi. |
| Current | number | yes | Current balance in USD. |
| Available | number | no | Present when the institution provides it. |
| Imported at | date | yes | Export timestamp in America/Phoenix. |

### Feed status

A page rewritten on every run, including a run that updates zero rows.

- Last run, in America/Phoenix.
- Result: `succeeded`, `partial`, or `failed`.
- Per account: rows added, rows updated, and whether a balance row was written.
- Accounts that failed, with a short error and no credentials. A failed account does not block the others.
- `Lexi Savings 0000 rows written`, which must be `0`.
- Window: the one-time backfill from 1 Jan 2026, or the daily last-7-days pull.
- After Dale approves creation: the page URL, the Transactions database id, and the Balances database id.
- The refresh request in the section below.

## Cadence

| Item | Value |
| --- | --- |
| Time zone | America/Phoenix |
| Daily run | 05:00 America/Phoenix (fixed MST, UTC-7, no daylight-saving shift; the approved 5:00 AM MST run) |
| Daily window | The last 7 days of transactions, plus current balances. The overlap lets a pending charge become a posted one without a duplicate `Feed ID`. |
| First run | One backfill from 1 Jan 2026, or a start date Dale names in the request. |
| Who starts it | Dale sends the request below, or Dale approves a MoneyMan routine that performs that export. The factory does not start it. |
| After the sample | MoneyMan shows Dale 10 rows with last-4 identification and no full numbers. Dale then approves the daily routine. |
| Freshness | The Feed status last-run time is within 26 hours of a healthy daily export. |

## Notion destination

MoneyMan creates one teamspace page titled **Chuck feed (read-only)** after Dale names the workspace and teamspace. On that page:

- Database **Transactions**, schema above.
- Database **Balances**, schema above.
- Page **Feed status**, rewritten each run.

Proposed default, still waiting on Dale: a new page in the Notion workspace the factory integration already serves. Chuck's Notion skill records that workspace as Dale Sackrider's Space, parent page The Submind (`3d80a48f-fae0-80cf-9e42-d5c8bd2595cd`). The feed page is a sibling destination. It is not The Submind Operations Board (database `3d80a48f-fae0-816b-bc00-e4cba96c85aa`) and it does not reuse that database's task schema.

Access:

- MoneyMan's Notion connection can write the two databases and the Feed status page, and nothing else.
- Chuck's factory Notion integration is shared on **Chuck feed (read-only)** with read permission. That share is what lets him read the destination. His operations-board tools stay pointed at the operations board.

`NOTION_DATABASE_ID` stays unset or stays on the operations board. Pointing that variable at the feed database would send task list, create, update, and complete calls at the bank feed.

## Chuck egress

Checked on 27 Nov 2026 from records already in git and in the knowledge note. Live AWS and the production control plane were left untouched, and Chuck was not woken.

| Record | What it says |
| --- | --- |
| [knowledge/agents/finley.md](https://github.com/BeerCanLabs/knowledge/blob/main/agents/finley.md) (verified 29 Oct 2026) | Configuration-hosted `finley`. Requested routes `models`, `discord`, `notion`. Internal grant `tools.factory-spend`. Skill `notion@1.0.0` lists, creates, updates, and completes tasks on The Submind Operations Board. Allowed hosts: none. |
| [SM-finley `cartridge.yaml`](https://github.com/BeerCanLabs/SM-finley/blob/main/cartridge.yaml) | `egress.routes`: `models`, `discord`, `notion`. `secrets.requires`: empty. The Notion skill is declared as gatekeeper-egress injection. |
| [SM-finley `skills/notion`](https://github.com/BeerCanLabs/SM-finley/blob/main/skills/notion/SKILL.md) | Commands talk to `$NOTION_BASE_URL/v1/...` with `Authorization: Bearer $FACTORY_RUN_TOKEN`. The default database id is the operations board. `list` queries that database. The worker has no command whose database id is the bank feed. |
| `landing-zones/aws/variables.tf` `systems_import` | Seeded `notion` route: `https://api.notion.com` with gatekeeper-held `NOTION_API_KEY`. The seed has no Plaid route and no finance-broker route. |

Grant decision: **none**. The `notion` route already reaches the Notion API, and the gatekeeper-egress holds the integration key (S1). Adding a route would be a Plaid or finance-broker path, which this hand-off does not use. Narrowing the `notion` route to a single HTTP method would break the operations board, because database query is `POST` and task updates are `PATCH`. Read-only on the bank feed is the Notion share on **Chuck feed (read-only)**, so a write aimed at that page fails in Notion while the operations board share stays as it is.

A later dry read, only when Dale asks and only after the page exists: through the existing `notion` route, query each feed database and read the Feed status page. Confirm every `Last 4` is four digits, Lexi Savings 0000 is absent, and the status page shows the last run. That read is not part of this change, and it does not by itself require a skill or policy edit. A dedicated feed-query command, if Dale wants one, belongs in the FinOps skill package rather than in factory kernel code.

Knowledge cross-link to add on [knowledge/agents/finley.md](https://github.com/BeerCanLabs/knowledge/blob/main/agents/finley.md) the next time that note is edited:

> Bank and card transactions reach Chuck only through the MoneyMan export in Notion, documented in agent-factory `docs/operations/moneyman-chuck-bank-card-handoff.md` ([#453](https://github.com/BeerCanLabs/agent-factory/issues/453)). Routes stay `models`, `discord`, and `notion`. Lexi Savings 0000 is excluded.

## Ready-to-send MoneyMan request

Dale sends this, or approves a routine that does the same work, after he fills in the workspace and teamspace. The factory does not send it.

> MoneyMan, please set up a read-only daily feed for Chuck Finley in Notion. Workspace and teamspace: `<Dale fills this in>`. Create a page titled "Chuck feed (read-only)" with a Transactions database, a Balances database, and a Feed status page. Use the schema in BeerCanLabs/agent-factory `docs/operations/moneyman-chuck-bank-card-handoff.md` (issue #453).
>
> Accounts: Desert Financial checking, HELOC Savings, and Business 0402; Kemba 6606; Chase Marriott 4914; Citi 3530; Citi AAdvantage 4609. Supply the last 4 for Desert Financial checking and HELOC Savings from the existing links. Never export Lexi Savings 0000.
>
> Store last 4 only. Refuse or mask any full card or account number, routing number, access token, or login. Upsert transactions by hashed Feed ID.
>
> Backfill from 1 Jan 2026, then run daily at 05:00 America/Phoenix over the last 7 days plus current balances. Mark known AI, cloud, and tech vendors with Vendor hint `AI/cloud/tech`.
>
> Write every run to the Feed status page: last run time, rows added and updated per account, accounts that failed, and `Lexi Savings 0000 rows written` (must be 0).
>
> Show me 10 sample rows before turning on the daily run. Your Notion connection may write only this page. Share the page read-only with the factory Notion integration Chuck already uses.

Refresh, after the daily run exists. Dale sends this to MoneyMan:

> MoneyMan, refresh the Chuck feed in Notion. Pull the last 7 days and current balances for the accounts in the #453 contract, upsert by Feed ID, keep Lexi Savings 0000 out, and rewrite the Feed status page with the time and the per-account counts.

## Operator note

This Notion export is the near-term bank and card path. Chuck's monthly close can read it once the page exists and Dale has seen the 10-row sample. A factory-native read-only Plaid connection is optional and later ([#458](https://github.com/BeerCanLabs/agent-factory/issues/458)). It needs its own consent and a deploy. It is not required for this feed, and it does not reuse MoneyMan's links.

To see whether the latest export succeeded, open the Feed status page. A healthy daily export has a last-run time within 26 hours, result `succeeded` or `partial` with the failed accounts named, and `Lexi Savings 0000 rows written` equal to 0. To ask for a refresh, Dale sends the refresh paragraph above. Chuck does not hold bank credentials, and this protocol does not wake him or change his policy.

Frontline Education is out of scope. Payments, transfers, card lock, and disputes are out of scope. Rollback of the factory side is empty, because no grant was added. MoneyMan's existing links stay as they are. If a Notion share is added later and must be undone, remove the read-only share on **Chuck feed (read-only)** and leave the `notion` route in place.
