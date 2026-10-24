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
at least one route. There is no build of the agent's own code. An agent that has adopted skills (SK4) runs the same runtime
image with its approved skills and their manifest layered on top: the deployment's provider builds that image (on AWS, the
`factory-skills-builder` CodeBuild project), tagged with the runtime commit and a hash of the skill pins, so one container
still runs one agent and nothing is shared at run time. The deploy then runs in the background (`202`, poll the agent). Adopting
or removing a skill on a deployed agent applies the same way, and removing the last one puts the agent back on the runtime
image. A provider that cannot build it refuses (`skills_image_not_supported`) rather than deploy the agent without its skills.
A new runtime version does not re-deploy agents that already run an older one.

## What a deployment needs

`FACTORY_RUNTIME_IMAGE` (the shared runtime image, by tag in the runtime's own registry, never a digest or `:latest`; a
runtime rebuilt under the same tag changes the base of agents built after it, so the tag names the commit) and
`FACTORY_RUNTIME_COMMIT` (the full commit it was built from) pin the runtime; `FACTORY_RUNTIME_REPO` names its repository
(default `BeerCanLabs/agent-factory`). Without them no agent can be created. On AWS the landing zone sets them from the
variables `shared_runtime_image`, `shared_runtime_commit` and `shared_runtime_repo`, creates the runtime's registry
(`factory-agent-runtime`) and the skills builder project, and tells the control plane its name
(`FACTORY_SKILLS_BUILDER_PROJECT`, default `factory-skills-builder`). A skill an agent adopts is Python using only the standard
library (nothing is installed for it), as a file, module or package in its folder, importing its own modules at the top of its entry (they are not importable later, and never shared with another skill; a module named `runtime` is the runtime's, not the skill's). On a compose host the control plane also needs `FACTORY_RUNTIME_IMAGE` for its Docker runtime, which is the same
variable.
