/** Every agent id that enters the CLI (a setting, `/connect`, the manager's say-so) passes this, so none can be a path. */
export const AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
export const isAgentId = (v: unknown): v is string => typeof v === 'string' && AGENT_ID.test(v) && !v.includes('..');
