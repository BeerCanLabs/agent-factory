/** Point stock Anthropic/OpenAI SDKs at the factory gateway, with the run token as their key. */
export function gatewayEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const gw = env.FACTORY_GATEWAY_URL?.replace(/\/$/, '');
  const token = env.FACTORY_RUN_TOKEN;
  if (!gw || !token) return {};
  const out: Record<string, string> = {
    ANTHROPIC_BASE_URL: `${gw}/anthropic`,
    OPENAI_BASE_URL: `${gw}/openai/v1`,
    ANTHROPIC_API_KEY: token,
    OPENAI_API_KEY: token,
    DISCORD_BASE_URL: `${gw}/discord`,
    DISCORD_API_BASE: `${gw}/discord`,
    GOOGLE_CALENDAR_BASE_URL: `${gw}/google-calendar`,
    GOOGLE_OAUTH_BASE_URL: `${gw}/google-oauth`,
    GMAIL_BASE_URL: `${gw}/google-gmail`,
    GOOGLE_DRIVE_BASE_URL: `${gw}/google-drive`,
  };
  // An image that set its own values keeps them; the gateway still rejects anything but a run token.
  for (const k of Object.keys(out)) if (env[k]) delete out[k];
  return out;
}
