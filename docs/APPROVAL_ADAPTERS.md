# Approval adapters: where the factory can ask

Design Authority: §6.18 CF4 (approval happens where the person is, and the agent never carries it), E9 (held actions).

A held action, a role assignment an agent asked for, and every other elevated configuration change need a person's
approval. The factory decides who may approve (the run's verified requester, or an owner when no one asked, or, for a
configuration change, an owner or an admin, and the global approver role does not decide it; for a held action, the global approver or admin role in the console), writes the approver, the channel and the time to the ledger,
and only then lets the action go ahead or applies the change. An **adapter** is the part that shows the question to a
person in some channel and brings their answer back. This page says which adapters exist today and what a new one needs.

## What exists today

| Channel | Can ask? | How | Where it lives |
|---|---|---|---|
| Console | Yes | The Approvals view lists pending approvals, and the signed-in person with the global approver or admin role can use Approve and Reject (`POST /api/v1/approvals/:id`). For a held action it shows what will be sent. For a configuration change (a role assignment) it lists the item as `change:<type>` with tool-call wording and only the agent and run, not the provider, identity or roles being granted, so deciding a change in the console is blind today, and an approver-only person gets the buttons but the factory refuses them (only an admin or the agent's owner decides a change); decide a change by Discord reply, which shows it in full. | `packages/console/src/views/ApprovalsView.tsx` |
| Discord | Yes, by text reply | `gatekeeper-ingress` posts the factory's question in the direct message where a person who may decide it wrote to the agent in the last hour, with a one-time code (never in a server channel: the question shows what the agent wants to send). The person replies `approve CODE` or `reject CODE`. The ingress consumes the reply before any wake or hand-off, so the agent never sees it. Discord has no button handling in the ingress today, so there are no buttons. | `packages/gatekeeper/src/ingress/`, `packages/control-plane/src/channel-approvals.ts` |
| API | Yes | `POST /api/v1/approvals/:id` as a signed-in principal. | `packages/control-plane/src/app.ts` |
| Slack, Teams, web chat, email, a link | No | Not built. | |

## The contract every adapter keeps

1. **The agent never carries the approval.** The adapter reads the reply itself (the ingress for chat) and sends it to the
   factory under its own credential. Nothing the agent writes, and no agent credential, reaches the decision.
2. **The factory renders the question** from its stored copy of the request (method, path, body, or the role change).
   The agent's own description is never shown as the factory's.
3. **The adapter attests who answered**, as the channel verified it (a Discord author id, a signed-in session, a verified
   email address). The factory resolves that to a person through the identity link (TSK-107, TSK-108); an unlinked
   person decides nothing. Only the ingress holds the privilege to say who replied in a channel
   (`approvals.channel`, exclusive to the `gatekeeper-ingress` role), as only it says who asked.
4. **The person sees everything that will be sent.** A request the channel cannot show in full and as sent (a long path, route, method, header or body, a binary body, many headers, a role change with more than 20 roles, a role name over 64 or an identity over 128 characters, anything else it cannot render in full, any text that is not plain printable ASCII, or a backtick) is not asked there and gets no code; it waits for the console.
5. **A reply decides once, unchanged, in the place it was asked, within a day.** Another person's reply, another channel's,
   a spent or unknown code, all change nothing. An expired code, an unlinked replier and a replier who may not decide are refused and ledgered (once per approval, person and reason in ten minutes); an unknown or spent code, or a code from the wrong channel, agent or provider, is not ledgered and is passed on as an ordinary message.
6. **Chat approval is as good as any other.** There are no classes of change and no per-channel trust setting.

## What a link or email adapter needs

A person may not be in a chat channel at all (a background run, an email-only person). The adapter would need:

- A way to **deliver** the question to the person: the factory renders it, an email or notification service sends it.
  Nothing for this exists; it would be a new egress route or service, held to S1 (no secret in the agent).
- A **one-time, expiring link or code** bound to the approval id, the person, and the channel (the factory issues
  a code for each askable approval when the ingress asks for prompts; a link would carry one signed by the factory, valid for the same day).
- A **verified identity** at the other end: a sign-in (OIDC or the console's access assertion) or a verified mailbox,
  mapped through the identity link to the same people the rules allow. A bare link that anyone holding it can click is not
  an adapter; it must authenticate the person, not the link.
- A **new provider** on the identity link (today `discord`) and its own entry in `approvals.channel`'s attestation,
  held by the service that sees who clicked, never by an agent or an operator.
- The same **ledger rows**: asked (where), decided (approver, channel, time) before the action is allowed.

Until one of these is built, a person with no chat channel approves in the console or by the API.

## Known limits today

- A person who holds only a global admin or approver role, with no ownership of the agent and no part in the run, cannot
  decide by chat reply; they use the console. A chat reply carries no factory role.
- Approvals by an MCP tool call (a tool the agent calls that waits on its run) are not asked in a channel.
- A person who writes to the agent only in server channels is never asked in chat (a server channel would show the request
  to everyone in it); they use the console or a direct message.
- The ingress remembers where each person last wrote in memory only, for an hour: after a restart or a quiet hour, a
  pending question is asked when that person next writes to the agent.
- The console enables Approve and Reject only for the global approver or admin role. An agent owner or run requester
  with neither decides by Discord reply or the API (`mayDecide` allows them; the console buttons do not).
- Discord is the only provider, and the ingress asks only while the agent's Discord connection is up, at most ten
  prompts per agent per ten-second poll.
- A configuration change shown in the console has no preview (see the Console row); a console preview is not built.
