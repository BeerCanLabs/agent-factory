/**
 * Showing what the factory returned (§6.17 CL11). Display only: it chooses columns and truncates, it decides nothing and
 * adds no figure of its own. Everything that reaches the terminal has control characters removed (CL6 and the escape-sequence
 * rule), and values under secret-looking names were already hidden by `redact`.
 */
import { stripControl } from './conversation.js';

const MAX_ROWS = 40;
const MAX_CELL = 48;
const PREFERRED = ['id', 'name', 'agentId', 'agent', 'state', 'status', 'type', 'action', 'trigger', 'category', 'actor', 'timestamp', 'at', 'model', 'costUsd', 'role'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isScalar = (v: unknown): v is string | number | boolean | null | undefined => v === null || v === undefined || typeof v !== 'object';

export function cell(v: unknown, max = MAX_CELL): string {
  const text = isScalar(v) ? String(v ?? '') : JSON.stringify(v);
  const clean = stripControl(text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function columnsFor(rows: Record<string, unknown>[]): string[] {
  const keys = new Set<string>();
  for (const r of rows.slice(0, 20)) for (const [k, v] of Object.entries(r)) if (isScalar(v)) keys.add(k);
  const preferred = PREFERRED.filter((k) => keys.has(k));
  const rest = [...keys].filter((k) => !preferred.includes(k));
  return [...preferred, ...rest].slice(0, 6);
}

export function table(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '(none)';
  const cols = columnsFor(rows);
  if (!cols.length) return rows.map((r) => cell(r, 120)).join('\n');
  const shown = rows.slice(0, MAX_ROWS);
  const cells = shown.map((r) => cols.map((c) => cell(r[c])));
  const widths = cols.map((c, i) => Math.max(c.length, ...cells.map((row) => row[i].length)));
  const line = (parts: string[]) => parts.map((p, i) => p.padEnd(widths[i])).join('  ').trimEnd();
  const out = [line(cols.map((c) => c.toUpperCase())), ...cells.map(line)];
  if (rows.length > shown.length) out.push(`… ${rows.length - shown.length} more (use --limit, or --json for all of it)`);
  return out.join('\n');
}

export function keyValues(o: Record<string, unknown>, indent = ''): string {
  const entries = Object.entries(o);
  if (!entries.length) return `${indent}(empty)`;
  const width = Math.min(24, Math.max(...entries.map(([k]) => k.length)));
  return entries
    .map(([k, v]) => {
      if (isObj(v) && Object.keys(v).length && Object.values(v).every(isScalar) && indent.length < 4) return `${indent}${stripControl(k)}:\n${keyValues(v, `${indent}  `)}`;
      return `${indent}${stripControl(k).padEnd(width)}  ${cell(v, 100)}`;
    })
    .join('\n');
}

/** A list of things as a table, a thing as key-value lines, anything else as it is. */
export function render(body: unknown): string {
  if (Array.isArray(body)) return body.every(isObj) ? table(body as Record<string, unknown>[]) : body.map((b) => cell(b, 120)).join('\n');
  if (isObj(body)) {
    // The factory often wraps a list ({ replies: [...] }, { items: [...] }): show the list when that is the whole answer.
    const keys = Object.keys(body);
    if (keys.length === 1 && Array.isArray(body[keys[0]]) && (body[keys[0]] as unknown[]).every(isObj)) return table(body[keys[0]] as Record<string, unknown>[]);
    return keyValues(body);
  }
  return cell(body, 400);
}
