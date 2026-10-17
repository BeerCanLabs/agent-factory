import { AI_PROVIDER_TEMPLATES } from '@beercanlabs/factory-contract';
import type { SystemsStore } from '@beercanlabs/factory-registrar';

/** `google` is already the OAuth system id. The Gemini vendor is `gemini`. */
const BUILTIN_AI_PROVIDERS = [
  ['openai', 'openai'],
  ['anthropic', 'anthropic'],
  ['xai', 'xai'],
  ['gemini', 'google'],
] as const;

/**
 * Records the four built-in model vendors as approved systems once. An existing system is left alone.
 * The request path reads these records; it does not read FACTORY_GATEKEEPER_EGRESS_HELD_SECRETS.
 */
export async function seedBuiltinAiProviders(store: SystemsStore): Promise<string[]> {
  const seeded: string[] = [];
  for (const [id, templateId] of BUILTIN_AI_PROVIDERS) {
    if (store.get(id)) continue;
    const template = AI_PROVIDER_TEMPLATES[templateId];
    await store.propose({
      id,
      name: template.name,
      description: template.description,
      kind: 'ai-provider',
      upstream: template.upstream,
      aiProvider: { adapter: template.adapter, discoveryPath: template.discoveryPath },
      credential: {
        secret: template.heldSecret,
        header: template.credentialHeader,
        ...(template.credentialFormat ? { format: template.credentialFormat } : {}),
      },
    }, 'migration:builtin-ai-provider');
    await store.approve(id, undefined, 'migration:builtin-ai-provider');
    seeded.push(id);
  }
  return seeded;
}
