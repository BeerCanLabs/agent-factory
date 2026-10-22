# Factory Manager

Optional house staff. It ships in this repository and stays out of the baked agent catalog (`agents/staff` is not loaded by `loadCatalog`). Deploy it by admitting this directory the same way you admit any other cartridge. Leave it unregistered and the factory has no manager, and `factory` (the command-line client) has nobody to talk to. See `docs/CLI.md` and `DESIGN_AUTHORITY.md` §6.17.

It is the front desk of the factory for the people who run it. It answers questions about cost, agents, budgets, approvals and runs, and can connect a person to an agent.

**It holds no factory power.** Each turn the CLI sends the tools the signed-in person may use. The manager asks for one by calling it; the CLI runs it as that person, asks them first when it changes something, and sends the result back as the next turn. A person can do through the manager only what their own roles allow (CL3). The manager reaches its model through the factory model API with its run token, like any cartridge (E5), and keeps a notebook of each person's conversation in `$MEMORY_DIR`.

## Wire protocol

Turn in (`content` is the person's words; `toolResults` answers the manager's last requests):

```json
{ "content": "what did we spend this month?", "tools": [{ "name": "get_spend_report", "description": "...", "parameters": { "type": "object", "properties": {} }, "mutating": false }], "toolResults": [{ "id": "c1", "name": "get_spend", "ok": true, "result": {} }], "client": { "name": "factory-cli", "version": "0.1.0" } }
```

Reply (sent with `POST /api/v1/runs/:id/reply`, as the JSON in `content`):

```json
{ "type": "message", "text": "..." }
{ "type": "tool_calls", "calls": [{ "id": "c1", "name": "get_spend", "arguments": {} }], "text": "optional" }
{ "type": "connect", "agent": "donna", "text": "optional" }
```

## To admit it

The factory needs a policy for the manager before it can think: grant the `models` route and a budget (E7). Give the manager's policy a small daily budget; each question costs a few model calls.

## Tests

```
cd agents/staff/factory-manager && python3 -m unittest discover -s tests
```
