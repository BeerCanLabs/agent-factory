# Creating an agent

New agents are created from a configuration in the factory and run on the shared agent runtime
(DESIGN_AUTHORITY.md §6.18 CF6, RT1). The factory no longer registers a new agent id from a repository. An agent that is
already registered keeps its repository, its image and its admission flow exactly as before, including a new commit and a
redeploy; a retired agent can be reinstated the same way, and ids the operator names in `FACTORY_REPOSITORY_AGENT_IDS` (house
staff admitted from source) keep that flow too. An id that was purged for good counts as new.

## Create

An admin creates the agent; the creator becomes its owner.

```
POST /api/v1/agents
{
  "id": "nova",                                   letters, digits, dot, dash, underscore
  "name": "Nova",
  "soul": "You are Nova, ...",                    the agent's persona, up to 64 KiB
  "memory": { "archetype": "personal-assistant" } purpose-built | personal-assistant | team-member (AM1)
  "roles": [ { "name": "Family", "skills": { "*": { "allow": ["*"] } } } ]
}
```

The agent has no repository: its pinned source is the pinned runtime version. It has no egress, no credentials and no
trigger of its own. Everything it may reach is an admin's grant: `PUT /api/v1/agents/:id/policy` (E7). Its roles may name only
skills it has adopted, so a new agent's roles use `*` until it adopts some. Its soul, roles and memory settings are changed
by its owner with `PUT /api/v1/agents/:id/settings`.

## Deploy

`POST /api/v1/registry/agents/:id/deploy` registers the agent's compute on the pinned shared runtime image, once its policy has
at least one route. There is no build. An agent that has adopted skills needs an image built with them (SK4); that build is
not provided yet, so deploying such an agent is refused with `skills_image_not_supported`.

## What a deployment needs

`FACTORY_RUNTIME_IMAGE` (the shared runtime image) and `FACTORY_RUNTIME_COMMIT` (the full commit it was built from) pin the
runtime; `FACTORY_RUNTIME_REPO` names its repository (default `BeerCanLabs/agent-factory`). Without them no agent can be
created. On a compose host the control plane also needs `FACTORY_RUNTIME_IMAGE` for its Docker runtime, which is the same
variable.
