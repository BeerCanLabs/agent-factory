# Agent Builder

Headless house staff agent shipped with the Agent Factory. It stays out of the baked agent catalog (`agents/staff` is not loaded by `loadCatalog`). Deploy it by admitting this directory the same way you admit any other cartridge.

The builder talks on the conversation API (`POST /wake` with a message or structured payload). It has no Discord surface and incurs no model/LLM spend. The factory injects `FACTORY_URL`, `FACTORY_RUN_ID`, and `FACTORY_RUN_TOKEN`. The builder calls the run-scoped endpoint `POST /api/v1/runs/:id/builder`.

The builder assists human users holding the `agents.create` privilege (held by `operator` and `admin` roles) to build, validate, and publish configuration agents on the shared runtime without writing raw JSON directly to the factory API.

When published, the new agent starts in `PENDING_BUDGET` with the human caller recorded as owner.

## Talk to it

Interactive text commands:
```
catalog
set id my-assistant
set name My Assistant
set archetype personal-assistant
set soul You are a helpful assistant.
add skill discord-progress
show
validate
publish
```

Or submit a structured JSON payload:
```json
{
  "op": "validate",
  "spec": {
    "id": "my-assistant",
    "name": "My Assistant",
    "memory": { "archetype": "personal-assistant" },
    "soul": "You are a helpful assistant."
  }
}
```

## Tests

```bash
python3 -m unittest discover -s agents/staff/agent-builder/tests
```
