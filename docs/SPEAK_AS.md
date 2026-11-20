# Speak-as: connected calls, errands, and household speakers

A client (Rosie, or the Reachy Mini robot using Rosie’s identity) may open a conversation **as** an enrolled person. The factory verifies a standing speak-as grant and stamps the delivered turn. The receiving agent sees the human as the speaker, not “Rosie on behalf of Dale.” There is no `onBehalfOf` field on the delivered caller.

Speaker identification (voice ID, a spoken name, or a PIN) happens on the robot / Rosie. The factory accepts an asserted enrolled user id or alias; it does not perform biometrics.

## Client interface

### Asserting the speaker

On every new turn the client **must** send `speaker` when it holds a speak-as grant.

Preferred: an explicit field on `ask` (MCP) or `POST /api/v1/agents/:id/conversation`:

```json
{
  "input": "who am I talking to?",
  "speaker": "dale",
  "mode": "call",
  "channel": "voice",
  "assurance": "voice-asserted",
  "waitSeconds": 20
}
```

`speaker` is either:

- a canonical principal id, `user:dale.sackrider`, or
- an enrolled alias on the grant, e.g. `dale` (case-insensitive).

Equivalent headers, used if the body omits the field:

| Header | Body field | Default |
| --- | --- | --- |
| `X-Factory-Speaker` | `speaker` (or `asUser`) | required for a new conversation when the client has a grant |
| `X-Factory-Mode` | `mode` | `call` |
| `X-Factory-Channel` | `channel` | `voice` |
| `X-Factory-Assurance` | `assurance` | `voice-asserted` |
| `X-Factory-Conversation-Id` | `conversationId` | set by the factory on the first turn; required to continue a live call |

`assurance` records how the client identified the person (for example `voice-asserted`, `pin`, `named`). It is metadata, not a second authorization check.

### What the factory checks

For a new conversation the factory:

1. Authenticates the client key and takes `actor` as the client (`agent:rosie` or `service:reachy-rosie-body`).
2. Loads an **active** speak-as grant for that client (unexpired, not revoked).
3. Resolves `speaker` to exactly one enrolled `user:<id>` (full id or unique alias).
4. Checks that member is allowed to be connected to the **target agent** (`targetAgents` allowlist; omitted or empty means every agent).
5. Stamps the delivered caller and, for a new conversation, mints `conversationId` (`convo_<uuid>`).

A follow-up live-call turn must send the same `conversationId` (and the same speaker, if provided). The factory refuses a speaker or mode change on an open call.

### Delivered caller (what the receiving agent must trust)

The factory strips any client-supplied `caller` / `onBehalfOf` and writes this block onto the turn and onto `GET /api/v1/runs/:id/input`:

```json
{
  "actor": "user:dale.sackrider",
  "verified": true,
  "channel": "voice",
  "via": "agent:rosie",
  "assurance": "voice-asserted",
  "mode": "call",
  "name": "Dale",
  "relationship": "owner"
}
```

or `"mode": "errand"`. `name` is the principal's display name when the factory has one. `relationship` is present only when it was set on the grant member (`owner`, `family`, or `child`).

`via` is transport metadata only (which client connected the call). Treat `actor` as the person speaking. Reply in the first person, to them. When `relationship` is `family`, they are a household family member of the owner, not the owner; help them as themselves and do not treat them as the owner. When `relationship` is `child`, they are a child in the household: use a kid-safe tone, and do not start agent-to-agent calls or errands on their behalf.

- **`mode: "call"`** — a live, multi-turn conversation. Talk with the person directly.
- **`mode: "errand"`** — a one-shot task sent by Rosie. Act on the requester’s authority (for example their calendar) and return a **result** Rosie can relay, not a chat opening.

### Rejection shape

Every refusal is HTTP 4xx/5xx with a JSON body `{ "error": "<code>", "message": "<human-readable>" }`. On MCP `tools/call`, the same object is `structuredContent` and `isError` is true.

| HTTP | `error` | When |
| --- | --- | --- |
| 400 | `speaker_required` | The client has a speak-as grant (or sent a speak-as field) but omitted `speaker` on a new conversation. |
| 400 | `invalid_principal` | A member id is not `user:<id>`. |
| 400 | `invalid_target_agent` | A target agent id is malformed. |
| 403 | `no_speak_as_grant` | No active grant for this client. |
| 403 | `person_not_enrolled` | `speaker` was a `user:<id>` that is not on the grant. |
| 403 | `agent_not_allowed` | That person is not allowed to be connected to this agent. |
| 404 | `unknown_speaker` | `speaker` was an alias that matches no enrolled person. |
| 404 | `conversation_not_found` | `conversationId` is unknown, or belongs to another client or agent. |
| 409 | `ambiguous_speaker` | The alias matches more than one enrolled person. |
| 409 | `speaker_mismatch` | `speaker` does not match the person this conversation was opened as. |
| 409 | `mode_mismatch` | A live call cannot be switched to an errand. |
| 503 | `speak_as_store_unavailable` | The grant store is unhealthy. |

Examples:

```json
{ "error": "speaker_required", "message": "speaker is required to open a conversation as an enrolled person" }
{ "error": "unknown_speaker", "message": "speaker 'bob' does not match an enrolled user id or alias" }
{ "error": "person_not_enrolled", "message": "'user:x' is not enrolled on a speak-as grant for client 'agent:rosie'" }
{ "error": "agent_not_allowed", "message": "'user:x' is not allowed to be connected to agent 'donna'" }
{ "error": "no_speak_as_grant", "message": "no active speak-as grant for client 'agent:rosie'" }
```

## Errands vs live calls (robot / Rosie split)

### Errands (`ask_agent`)

Rosie runs the errand **server-side**. The robot tells Rosie the task (on Rosie’s own turn, with `speaker` asserted). Rosie calls the target agent’s conversation API with:

- `speaker` = the verified enrolled person (from the stamped caller on Rosie’s turn, or the same asserted id)
- `mode` = `errand`
- `waitSeconds` set so she can return the result

She then speaks the result back to the person. The robot does not open a second conversation.

### Live calls (`call_agent`)

Rosie does **not** proxy the voice call. She returns a structured intent as the tool result (and as tagged JSON the robot can parse even if wrapped in speech):

```json
{ "action": "call", "agent": "donna", "speaker": "user:dale.sackrider" }
```

Tag: `FACTORY_CALL_INTENT:{"action":"call","agent":"donna","speaker":"user:dale.sackrider"}`.

The robot then opens `POST /mcp/agents/<id>` itself and holds the multi-turn conversation (`ask` with `speaker` and then `conversationId`, plus `get_replies`). The robot’s key must be able to speak as that person — typically the same `agent:rosie` identity, covered by the same grant. The speaker reaches Rosie in the first place because the robot asserted `speaker` on Rosie’s own turn.

## Agent discovery

`GET /api/v1/speak-as/callable-agents?speaker=<id-or-alias>`

Authenticated with the client key. Also available as the MCP tool `list_callable_agents` on `/mcp/agents/:id` (and via the contract catalog).

```json
{
  "speaker": "user:dale.sackrider",
  "client": "agent:rosie",
  "agents": [
    { "id": "donna", "name": "Donna", "description": "Executive Assistant & Orchestrator" }
  ]
}
```

The list is filtered by the grant and that speaker’s `targetAgents` allowlist (every non-retired agent if the allowlist is empty). The **per-agent voice map stays on the robot**.

## Admin API and CLI

All grant changes are admin-only (`grants.manage`), ledgered, and revocable.

```
POST   /api/v1/speak-as-grants
GET    /api/v1/speak-as-grants[?client=agent:rosie]
GET    /api/v1/speak-as-grants/:id
DELETE /api/v1/speak-as-grants/:id
POST   /api/v1/speak-as-grants/:id/members
DELETE /api/v1/speak-as-grants/:id/members/:principalId
```

Create body:

```json
{
  "client": "agent:rosie",
  "purpose": "household voice and errands",
  "expiresAt": "2027-02-17T19:00:00.000Z",
  "members": [
    { "principalId": "user:dale.sackrider", "aliases": ["dale"] }
  ]
}
```

A member may include `"targetAgents": ["higgins"]` to limit where they may be connected. Omit it (or pass an empty list) for every agent.

A member may include `"relationship": "owner"`, `"relationship": "family"`, or `"relationship": "child"`. The factory copies that value onto the delivered caller. It is optional; omitting it does not change who may be connected, except that a `child` member must have a non-empty `targetAgents` allowlist and cannot open errands or be connected to any agent outside that list (`403 child_restricted`).

CLI (signed in as an admin):

```
factory speak-as grant --client agent:rosie --member user:dale.sackrider --alias dale --relationship owner --days 90 --purpose "household voice and errands"
factory speak-as list --client agent:rosie
factory speak-as show sag_...
factory speak-as enroll sag_... --member user:<id> --alias <shortname> --agents higgins --relationship family
factory speak-as enroll sag_... --member user:<id> --alias <shortname> --agents rosie --relationship child
factory speak-as unenroll sag_... --member user:<id>
factory speak-as revoke sag_...
```

To enroll another household member later (for example to talk to Higgins), run `factory speak-as enroll` with their real `user:<id>`, an alias they will assert as `speaker`, and `--agents` if they should only reach some agents. Do not invent a name or email; create the principal first if they are not already in the factory directory.

## Agent-bound keys

An admin may issue a key owned by `agent:<id>` (the agent must already be registered), with admin-set roles, the same way as `service:<name>` keys. Scopes still only narrow the owner’s privileges. A typical Rosie / Reachy body key uses `agent:rosie` with `agents.converse`, `mcp.use`, and `agents.read`.
