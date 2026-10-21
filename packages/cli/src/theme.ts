/** Terminal preferences (§6.17 CL8). Colour is decoration only: every message reads the same without it. */
import type { ThemeName } from './config.js';

export type Style = {
  plain: boolean;
  bold(s: string): string;
  dim(s: string): string;
  accent(s: string): string;
  good(s: string): string;
  bad(s: string): string;
};

const wrap = (open: string, s: string) => `\x1b[${open}m${s}\x1b[0m`;

export const PLAIN: Style = { plain: true, bold: (s) => s, dim: (s) => s, accent: (s) => s, good: (s) => s, bad: (s) => s };

/**
 * `mono`, `NO_COLOR` and anything that is not a terminal are plain. `auto` and `dark` suit a dark background, `light`
 * a light one (darker accents).
 */
export function styleFor(theme: ThemeName | undefined, opts: { isTTY: boolean; env?: NodeJS.ProcessEnv }): Style {
  const env = opts.env ?? process.env;
  if (!opts.isTTY || theme === 'mono' || (env.NO_COLOR !== undefined && env.NO_COLOR !== '')) return PLAIN;
  const light = theme === 'light';
  return {
    plain: false,
    bold: (s) => wrap('1', s),
    dim: (s) => wrap('2', s),
    accent: (s) => wrap(light ? '34' : '36', s),
    good: (s) => wrap(light ? '32' : '92', s),
    bad: (s) => wrap(light ? '31' : '91', s),
  };
}
