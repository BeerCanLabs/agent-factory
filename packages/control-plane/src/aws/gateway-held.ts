/**
 * S1: secrets the gateway holds (`FACTORY_GATEWAY_HELD_SECRETS`, set by the landing zone from
 * `provider_secret_names`) are injected by the gateway at egress. They are never put in an agent task
 * definition, and the agent's execution role is never granted them.
 */
export function gatewayHeldSecrets(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env.FACTORY_GATEWAY_HELD_SECRETS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

/** The secret's bare name: `NOTION_API_KEY` for `NOTION_API_KEY`, `factory/prod/NOTION_API_KEY`, or its ARN. */
export function secretName(secretNameOrArn: string): string {
  const tail = secretNameOrArn.startsWith('arn:aws:') ? secretNameOrArn.split(':').pop() ?? '' : secretNameOrArn;
  // Secrets Manager ARNs end in `-XXXXXX` (6 random characters) after the name.
  const name = tail.replace(/^.*\//, '');
  return secretNameOrArn.startsWith('arn:aws:') ? name.replace(/-[A-Za-z0-9]{6}$/, '') : name;
}

/** The secrets that may be delivered to an agent container: every declared secret except gateway-held ones. */
export function agentContainerSecrets(secrets: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const held = gatewayHeldSecrets(env);
  return secrets.filter((s) => !held.has(secretName(s)));
}
