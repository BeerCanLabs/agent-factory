import type { CliConfig } from './config.js';
import { DEFAULT_MANAGER } from './config.js';
import type { Style } from './theme.js';

export type SplashState = {
  version: string;
  config: CliConfig;
  /** Where the address came from when it is not the config file. */
  instanceFromEnv?: boolean;
  me?: { actor: string; roles: string[] };
  /** How this factory signs people in, when known. */
  signIn?: string;
};

const BANNER = [
  '  ┏━╸┏━┓┏━╸╺┳╸┏━┓┏━┓╻ ╻',
  '  ┣╸ ┣━┫┃   ┃ ┃ ┃┣┳┛┗┳┛',
  '  ╹  ╹ ╹┗━╸ ╹ ┗━┛╹┗╸ ╹ ',
];

/** The opening screen: what this is, what it is pointed at, who is signed in, and what to type next. */
export function splash(st: SplashState, style: Style): string {
  const lines = [...BANNER.map((l) => style.accent(l)), style.dim(`  Agent Factory CLI ${st.version}`), ''];
  const row = (k: string, v: string) => `  ${style.dim(k.padEnd(10))}${v}`;
  lines.push(row('Factory', st.config.instance ? `${st.config.instance}${st.instanceFromEnv ? style.dim(' (FACTORY_URL)') : ''}` : style.bad('not set')));
  if (st.config.instance) lines.push(row('Sign-in', st.signIn ?? style.dim('found out at /login')));
  lines.push(row('Signed in', st.me ? `${st.me.actor} ${style.dim(`(${st.me.roles.join(', ') || 'no role'})`)}` : style.bad('no')));
  lines.push(row('Manager', st.config.manager ?? DEFAULT_MANAGER));
  lines.push('');
  const next: string[] = [];
  if (!st.config.instance) next.push(`${style.bold('/config')} to set your factory address`);
  if (!st.me) next.push(`${style.bold('/login')} to sign in`);
  if (next.length) lines.push(`  Start: ${next.join(', then ')}.`);
  else lines.push('  Ask the Factory Manager anything about your factory.');
  lines.push(style.dim('  /help lists the commands, /exit leaves.'), '');
  return lines.join('\n');
}
