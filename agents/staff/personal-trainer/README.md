# Personal Trainer

Optional house staff. It ships in this repository and stays out of the baked agent catalog (`agents/staff` is not loaded by `loadCatalog`). Deploy it by admitting this directory the same way you admit any other cartridge. Leave it unregistered and the factory has no trainer.

The trainer talks on the conversation API (`POST /wake` with a message). It has no Discord surface. Set `FACTORY_CONTROL_URL` and `FACTORY_API_TOKEN` so it can read the skill's training cap and post trials. It does not score on its own.

It trains a **skill**, not an agent. The builder sets a training cap on the skill (`PUT /api/v1/skills/:id/training-account`), and this cartridge walks them through a baseline and the trial reports. The control plane scores posted outputs and charges that skill account. Adopting the skill later spends the adopting agent's own budget. The trainer recommends a model. It does not rewrite the skill and it does not deploy.

## Talk to it

```
skill summarize
case short | a long note | contains:brief
models small, large
trial small | short | a brief note | 0.20
trial large | short | a brief note | 0.90
recommend
```

## Tests

```
cd agents/staff/personal-trainer && python3 -m unittest tests/test_session.py
```
