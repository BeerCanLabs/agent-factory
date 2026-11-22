# Hosting and setup

**Audience:** a mid-sized church with a preschool, and a local Sleep in Heavenly Peace chapter, neither with IT staff. This is the “how would we even get a factory?” guide.

**How to read status labels**

- **works today** — a path exists in the repo or on the live BeerCanLabs deployment.
- **needs the factory team** — possible only if BeerCanLabs (or an equivalent operator) does the work.
- **not possible yet** — no productized path.

---

## 1. The short answer

The Agent Factory is **not a multi-tenant SaaS you can sign up for**. It is software you (or someone you trust) **deploy as a complete stack** into a cloud account or onto a single host. One deployment is one factory: one control plane, one ledger, one systems catalog, one set of API keys, one dashboard.

The running dashboard at [https://factory-dashboard.dalesackrider.com/ui](https://factory-dashboard.dalesackrider.com/ui) (MCP at `/mcp`, health at `/api/v1/health`) is **BeerCanLabs’ own factory**. It is not an enrollment portal for a church or a SIP chapter.

**Can these two organizations stand one up themselves?** No. The documented AWS path requires an AWS account, Terraform, a domain and ACM certificate, a private ops GitHub repo, IAM, and usually Cloudflare Access (`landing-zones/aws/README.md`). That is professional engineering work. **Status: needs the factory team** to have a factory at all. **Status: not possible yet** as self-serve org creation.

---

## 2. Is it multi-tenant? Single-tenant per owner?

**Single-tenant per deployment. Status: works today** (that is the only model).

What “tenant” is *not*:

- There is no organization object, no signup, no “create my church’s factory” API, and no data plane that isolates Org A from Org B on one control plane.
- **Groups** (`/api/v1/groups`, `packages/control-plane/src/group-routes.ts`) are **RBAC groups inside one factory** (membership, roles). They are not customers, billing accounts, or isolation boundaries. Privilege required: `groups.manage`.
- **Principals** are people (`user:…`) and service actors inside that same factory (`packages/control-plane/src/grants-routes.ts`, MCP tools in `packages/control-plane/src/mcp.ts`). Multiple staff can be invited into one factory. That is “several logins,” not “several organizations.”
- **Agents** have owners and policies. Two churches should not share a factory just because they can each own some agents: they would share the ledger, the systems catalog, the platform OAuth clients (the factory’s Google app), spend reports, and admin surface.

Implications:

- Putting a church and a SIP chapter on Dale’s existing factory would mix their mail grants, documents, spend, and administrators. **Do not do that.**
- A production adopting org needs **its own deployment** (or a future multi-tenant product that does not exist). **Status: not possible yet** to host many orgs safely on one control plane.
- Billing per org is likewise **not possible yet** (see `costs-and-billing.md`).

---

## 3. What infrastructure a new org’s factory needs today

The kernel is cloud-neutral (`landing-zones/PATTERNS.md`, `README.md`). Draftsman (or an implementing engineer) picks one pattern, then binds a provider.

| Pattern | Where it lives | When you would use it |
|---|---|---|
| 1. Serverless containers | Interview slots; GCP Cloud Run is the fleshed-out bind (`landing-zones/gcp`) | Scale-to-zero mailbox; still needs a serious GCP project |
| 2. Orchestrated tasks | **`landing-zones/aws` is the reference bind** | The documented production shape; always-on control plane + Fargate tasks per run |
| 3. Compose on one host | `landing-zones/compose` | Labs, a single VM, or a tightly controlled mini. Weaker isolation; local ledger is not WORM unless you point it at an Object Lock bucket |

**Azure:** `landing-zones/azure/README.md` is a short interview note (Container Apps / AKS / Compose, Entra, Key Vault). There is no Terraform tree. **Status: not possible yet** as a turnkey Azure landing zone.

### 3.1 The AWS reference factory (what “production” means in this repo)

From `landing-zones/aws/README.md` and `ecs.tf` / `network.tf` / `cloudflare.tf` / `secrets.tf`:

Always-on in the **service** subnets (public, behind an HTTPS ALB):

- Control plane (API, MCP, webhooks, ledger writer) on port 8088
- Gatekeeper-egress (the only way agents call models or external APIs)
- Gatekeeper-ingress (Discord mailbox; optional in use, still deployed)
- Console / Garrison UI when an image is provided (port 3000)
- OTEL sidecar on house tasks

On demand in **private agent subnets with no NAT and no Internet Gateway**:

- One Fargate task per agent run. The task can reach only the control plane, the gatekeeper-egress, and VPC endpoints (ECR, S3, Secrets Manager, CloudWatch Logs).

Other required pieces:

- S3 for agent “mind” (memory) and ledger checkpoints
- EFS for the hot ledger, with S3 Object Lock (COMPLIANCE mode) for checkpoints
- AWS Secrets Manager for factory and provider secrets
- IAM roles: per-agent task roles limited to that agent’s mind prefix; only gatekeeper-egress may read provider keys
- An ACM certificate and DNS name for the ALB in `us-east-1`
- Optional but expected for a human dashboard: **Cloudflare Access** in front of the hostname

Fixed cost and token cost are covered in `costs-and-billing.md`. Plan for a **~$140–220/month** infrastructure floor on this pattern before AI use, unless credits or a host subsidize it.

### 3.2 Compose (cheaper, not equivalent)

`landing-zones/compose/README.md`: Docker Engine 26+, `docker compose up`, a gitignored `docker-secrets.env`, and `gatekeeper-egress.json` prices. Isolation is a Docker network, not a VPC. Creating containers on the host is still “root-equivalent”; treat the host as the trust boundary. Fine for a supervised pilot on a machine the operator controls; a poor default for children’s or pastoral data unless an operator accepts that tradeoff in writing.

---

## 4. Who deploys it, and what they actually do

The repo is explicit: if you are an implementing AI (or engineer), start with `AGENTS.md`. The AWS README’s two steps are:

1. **Bootstrap** (`landing-zones/aws/bootstrap`): Terraform state bucket and a CI deploy role. Only the `main` branch of a **private ops repo** (not the public `agent-factory` reference) may assume the role.
2. **Apply the landing zone** (`landing-zones/aws`): `terraform init` with the state backend, `terraform apply` with `account_id` and `certificate_arn`.

Then, still before anyone “uses agents”:

- Fill provider keys in Secrets Manager (for example `factory/prod/ANTHROPIC_API_KEY`) or enable Bedrock model access in the Bedrock console and rely on the default `model_catalog`
- Set prices; unpriced models are refused
- Configure operator identity (below)
- Import/approve systems (`FACTORY_SYSTEMS_IMPORT` is applied on control-plane boot)
- Store the Google (and any LinkedIn/X) OAuth client through the Keymaster write-only platform endpoint
- Issue API keys only from a signed-in admin session (API keys cannot mint API keys)
- Register agents, attach policies, budgets, and credentials

**None of this is a church-secretary wizard.** **Status: needs the factory team.** There is no installer, no “deploy for me” button in the console, and no hosted checkout.

Required skills and accounts the adopter (or their operator) must have:

- An AWS account (or GCP project) the org is willing to put a payment method on
- Permission to create a VPC, ECS, IAM, S3, EFS, Secrets Manager, ACM, and (for Cloudflare) a zone and Access applications
- A domain they control
- Terraform and a CI identity (GitHub Actions in the documented bootstrap)
- Someone who can complete Google Cloud OAuth consent-screen verification if staff will connect Gmail
- A named admin whose verified email is in `admin_emails` (Access) and/or in the factory’s grants

---

## 5. DNS, Cloudflare Access, and sign-in (OIDC)

### 5.1 DNS and TLS

The factory public URL (`factory_public_base_url` / the ALB certificate’s name) must resolve to the front door. On the AWS pattern that is typically:

- Registrar or Cloudflare DNS → ALB (or Cloudflare proxy in front of the ALB)
- ACM certificate attached to the ALB
- HTTP 80 redirects to HTTPS (`landing-zones/PATTERNS.md`: internet `0.0.0.0/0` on the ALB is forbidden; `ingress_cidrs` should be tightened — in practice Cloudflare or known ranges)

**Status: needs the factory team** plus the person who can change the org’s DNS.

### 5.2 Cloudflare Access (the usual front door)

`landing-zones/aws/cloudflare.tf` implements the Design Authority front door when `cloudflare_zone_id` is set:

1. A root Access application on `/*` requires a verified identity (optional service-token path for transitional non-identity tokens; never “everyone” or a blanket bypass).
2. Webhook paths (default `/api/v1/hooks/*`) bypass interactive Access so vendors can deliver signed webhooks.
3. Headless `Authorization: Bearer fk_…` calls to `/api/v1` and `/mcp` are rewritten through an internal `/.cf-fk-bypass/*` path so API keys work without a browser login, with `cf-access-*` headers stripped so a caller cannot spoof Access identity.

The control plane trusts **only** an Access JWT it verifies itself (`cf-access-jwt-assertion` or `CF_Authorization` cookie) against the team domain’s certs and `access_aud`. The email header alone grants nothing (`landing-zones/aws/README.md`, operator identity section).

Variables that must be set correctly:

- `access_team_domain`, `access_aud` — if both are empty, Access identity is disabled and **only factory tokens work; the dashboard cannot act for a person**
- `admin_emails` — verified emails that receive admin roles; everyone else is a viewer; empty means **no admins through Access**
- Access service tokens authenticate as `cloudflare-service:<name>` **with no roles**

**Status: works today** on a factory the team has wired this way (the live `factory-dashboard.dalesackrider.com` deployment is an example of that shape). **Status: needs the factory team** to create the zone, Access app, allowed-email list, and Terraform values. A church administrator cannot be asked to “just add Cloudflare Access.”

### 5.3 Built-in login and IdP configuration

Independently of Access, the control plane can run its own login (`packages/control-plane/src/login.ts`):

- `GET /login` and `GET /api/v1/auth/:idp/start` / `callback`
- Session cookie `factory_session` (random id; store keeps only a hash)
- A session is a verified email with **zero claim-derived roles**. Roles come from factory grants, not from the IdP.

Supported IdP kinds are configured as data, not hardcoded, at `GET`/`PUT /api/v1/setup/idp` (admin, `grants.manage`) (`packages/control-plane/src/idp-config.ts`):

- `google`
- `meta`
- `cloudflare`
- generic `oidc` (this is how **Microsoft Entra** would be attached as a *dashboard* login)

`GET /api/v1/setup/status` tells a signed-in caller whether setup is complete. A first-time factory still needs a break-glass token or the first Access admin to put IdP config in place.

Kernel auth also includes JWKS-verified OIDC and named service tokens (`packages/auth/src/index.ts`, `README.md`). Roles (`viewer`, `operator`, `approver`, `ingest`, `gatekeeper-egress`, `gatekeeper-ingress`, `admin`) are assigned *inside* the factory.

**Status: works today** once an operator has configured at least one IdP or Access. **Needs the factory team** for the first identity. **Not possible yet** as a self-serve “sign in with Google and your church is created.”

### 5.4 What a staff member experiences after that

If the operator has done the above, a church secretary or SIP volunteer coordinator can:

1. Open the dashboard URL
2. Sign in with the chosen IdP (or Cloudflare Access email)
3. See only what their grants allow (often viewer, or owner of specific agents)
4. Use Credentials, Approvals, and (if granted) FinOps, as described in the other guides

They never need Terraform again for day-to-day use. They will still need the factory team for new systems, new models, DNS changes, key rotation of platform OAuth clients, and incidents.

---

## 6. What a “hosted for you” option would need

This is the realistic offer to both example organizations. It does not exist as a product today. **Status: not possible yet** as a packaged plan; **needs the factory team** (and a business decision) to provide it as a service.

A minimum hosted offer, given the code as it stands, would be **one dedicated factory per organization** (or per legal entity), operated by BeerCanLabs or a partner:

1. **Contract and account.** Who owns the AWS account and the data? Who is the record-keeper for child, family, and pastoral information? Who is called when something goes wrong on a Sunday morning?
2. **Provisioning playbook.** Run (or clone) the AWS landing zone with the org’s domain, or a `factory.<chapter>.org` name on an operator-owned zone. Store Terraform state in the operator’s bootstrap, not in a repo the church must maintain.
3. **Identity.** Configure Access or Google/OIDC for the org’s staff domain. Map `admin_emails` to the pastor, office manager, or chapter president — not to a shared Gmail. Create principals and grants without asking the customer to call APIs.
4. **Platform connectors.** The operator creates and verifies the Google OAuth app (and later Microsoft, if built), pastes the client into Keymaster, and walks one staff member through the first Connect. See `connectors-and-integrations.md`.
5. **Budgets.** Set per-agent `budgetUsd` and factory alert budgets on day one; put an AWS billing alarm on the account; decide who pays after nonprofit credits end (`costs-and-billing.md`).
6. **Support.** A human channel that is not Discord-only. Approvals and incidents should reach email or SMS once those adapters exist; until then, the operator must watch the console with the customer.
7. **Backup, updates, and exit.** Ledger and mind backup, who can export grants and documents, and how the org leaves (DNS cut, secret rotation, deletion of child data).
8. **Pricing the service.** Because the factory cannot bill per org, the operator invoices by hand (flat monthly hosting + passthrough of AWS and model spend, or a bundled price that absorbs the infrastructure floor).

A **shared, multi-tenant “one control plane, many churches”** host would additionally need, at least:

- A first-class Organization (or tenant) with hard isolation of secrets, grants, ledger visibility, systems, and spend
- Self-serve org creation and domain/IdP binding
- Billing and caps per org, including infrastructure, not only per-agent tokens
- An admin surface that cannot see another tenant’s mail tokens or preschool data
- Support tooling

None of that is in the current control plane. Building it is a product program, not a landing-zone variable.

### 6.1 What “hosted for you” would *not* still require from the church or chapter

If the operator does the work above, the adopter should only need to:

- Designate two or three people and their emails
- Consent (Connect) to Gmail/Calendar/Drive for the office account, when Google is ready
- Decide approval rules (who may let an agent send mail)
- Pay an invoice or apply their own nonprofit credits in an account they own

They should not need Terraform, AWS, or Discord.

### 6.2 A cheaper hosted shape (tradeoffs)

For a SIP chapter or a pilot, an operator might run **Compose (or a small VM) per org** to avoid the VPC-endpoint floor, accepting the weaker isolation documented in the Compose README. That is an operator decision, not a supported self-serve product. Children’s data and pastoral counseling notes argue for the AWS isolation model — and then the hosted price must cover it, or credits must.

---

## 7. Recommended path for the two organizations (planning only)

1. **Do not** ask either org to deploy from this repo.
2. **Do not** onboard them onto the existing `factory-dashboard.dalesackrider.com` factory.
3. Treat adoption as a **hosted dedicated factory** (or decline until a multi-tenant product exists).
4. Start only with Google-workspace orgs (Gmail, Calendar, Drive) until Microsoft, Sheets, SMS, and ChMS gaps are closed ([GAPS.md](GAPS.md)).
5. Budget for the infrastructure floor or for a subsidized pilot; set agent caps on day one.
6. Write down who the org’s approvers are, and that no agent or outside assistant may approve spend or pastoral/child-data holds for them.
