# Azure bind (pattern interview)

No Azure-specific kernel. After Draftsman picks a baseline pattern in `.draft/sdp.yaml`, map slots:

**Pattern 1 (default on Azure):** Container Apps for mailbox and for agents at min=0; Blob for mind; Key Vault for names in `secrets.manifest.yaml`; Entra for `FACTORY_AUTH=oidc`.

**Pattern 2:** AKS — Deployment for control plane + Doorman; Job for echo+sidecar; Blob + Azure Files; Key Vault CSI.

**Pattern 3:** Compose on a Linux VM (`landing-zones/compose`).

Do not require a Discord app. Do not install Hermes. Build images into ACR the same way other clouds use a registry.
