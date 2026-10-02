/**
 * Point agents at the factory gatekeeper-egress, with the run token as their key: the factory model API
 * (`FACTORY_MODEL_BASE_URL`, OpenAI Chat Completions format, §6.9 M1) and stock Anthropic/OpenAI SDKs.
 */
export function gatekeeperEgressEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const gw = env.FACTORY_GATEKEEPER_EGRESS_URL?.replace(/\/$/, '');
  const token = env.FACTORY_RUN_TOKEN;
  if (!gw || !token) return {};
  // Credentials in the proxy URL make boto3/urllib send `Proxy-Authorization: Basic`, so the gatekeeper-egress can
  // attribute, gate, and ledger every tunnelled call (e.g. Bedrock, S3) to this run.
  const proxy = withCredentials(gw, token);
  const out: Record<string, string> = {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    NO_PROXY: 'localhost,127.0.0.1,.internal,169.254.169.254,169.254.170.2',
    no_proxy: 'localhost,127.0.0.1,.internal,169.254.169.254,169.254.170.2',
    FACTORY_MODEL_BASE_URL: `${gw}/models/v1`,
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
    // Drive media uploads are served under www.googleapis.com/upload/drive/v3, outside the google-drive route.
    GOOGLE_DRIVE_UPLOAD_BASE_URL: `${gw}/google-drive-upload`,
    // Keymaster connections (§6.11): the gatekeeper-egress injects the Google access token; the agent holds none.
    // Google Health API (health.googleapis.com; paths start with /v4). Cloud Storage JSON API root: /storage/v1 and
    // /upload/storage/v1 both live under it.
    GOOGLE_HEALTH_BASE_URL: `${gw}/google-health`,
    GOOGLE_STORAGE_BASE_URL: `${gw}/google-storage`,
    // S1: the gatekeeper-egress's `notion` route injects the shared Notion integration key; agents call
    // `$NOTION_BASE_URL/v1/...` with their run token and never hold the key.
    NOTION_BASE_URL: `${gw}/notion`,
    // TSK-045 (S1): the gatekeeper-egress injects the calling agent's own GitHub token (no shared fallback), the Motion
    // key, and deployment-specific service tokens. `<ROUTE_ID>_BASE_URL` = `${gw}/<route-id>`.
    GITHUB_BASE_URL: `${gw}/github`,
    MOTION_BASE_URL: `${gw}/motion`,
    CLOSING_CLIMB_BASE_URL: `${gw}/closing-climb`,
    // Keymaster LinkedIn connection; every write is held for the person's approval (E9).
    LINKEDIN_BASE_URL: `${gw}/linkedin`,
    HOME_ASSISTANT_BASE_URL: `${gw}/home-assistant`,
  };
  // An image that set its own values keeps them; the gatekeeper-egress still rejects anything but a run token.
  for (const k of Object.keys(out)) if (env[k]) delete out[k];
  return out;
}

function withCredentials(url: string, token: string): string {
  const u = new URL(url);
  u.username = 'run';
  u.password = token;
  return u.toString().replace(/\/$/, '');
}
