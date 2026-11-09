/**
 * Showing what the factory returned (§6.17 CL11). Display only: it chooses columns and truncates, it decides nothing and
 * adds no figure of its own. Everything that reaches the terminal has control characters removed (CL6 and the escape-sequence
 * rule), and values under secret-looking names were already hidden by `redact`.
 */
import { oneLine, stripControl } from './conversation.js';

const MAX_ROWS = 40;
const MAX_CELL = 48;
const PREFERRED = ['id', 'name', 'agentId', 'agent', 'state', 'status', 'type', 'action', 'trigger', 'category', 'actor', 'timestamp', 'at', 'model', 'costUsd', 'role'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isScalar = (v: unknown): v is string | number | boolean | null | undefined => v === null || v === undefined || typeof v !== 'object';

export function cell(v: unknown, max = MAX_CELL): string {
  const text = isScalar(v) ? String(v ?? '') : JSON.stringify(v);
  const clean = oneLine(text).replace(/\s+/g, ' ');
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function allColumns(rows: Record<string, unknown>[]): string[] {
  const keys = new Set<string>();
  for (const r of rows.slice(0, 20)) for (const k of Object.keys(r)) keys.add(k);
  return [...keys];
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
  const hidden = allColumns(rows).length - cols.length;
  if (hidden > 0) out.push(`(${hidden} more column${hidden === 1 ? '' : 's'} not shown; --json has everything)`);
  return out.join('\n');
}

export function keyValues(o: Record<string, unknown>, indent = ''): string {
  const entries = Object.entries(o);
  if (!entries.length) return `${indent}(empty)`;
  const width = Math.min(24, Math.max(...entries.map(([k]) => k.length)));
  return entries
    .map(([k, v]) => {
      if (isObj(v) && Object.keys(v).length && Object.values(v).every(isScalar) && indent.length < 4) return `${indent}${oneLine(k)}:\n${keyValues(v, `${indent}  `)}`;
      return `${indent}${oneLine(k).padEnd(width)}  ${cell(v, 100)}`;
    })
    .join('\n');
}

function renderSubscriptionSpendSection(s: Record<string, unknown>, heading = 'Subscription token usage'): string {
  const day = oneLine(String(s.day ?? ''));
  const month = oneLine(String(s.month ?? ''));
  const conns = isObj(s.connections) ? Object.entries(s.connections) : [];
  const agents = isObj(s.agents) ? Object.entries(s.agents) : [];
  const lines: string[] = [`${heading} (today ${day}, month ${month}):`];
  if (!conns.length && !agents.length) {
    lines.push('  (no subscription token usage recorded)');
    return lines.join('\n');
  }
  if (conns.length) {
    const connRows = conns.map(([id, raw]) => {
      const c = isObj(raw) ? raw : {};
      const d = isObj(c.day) ? c.day : {};
      const m = isObj(c.month) ? c.month : {};
      return {
        id,
        name: c.connectionName ?? id,
        scope: c.scope === 'personal' && c.ownerPrincipalId ? `personal (${oneLine(String(c.ownerPrincipalId))})` : (c.scope ?? 'factory'),
        dayTokens: d.totalTokens ?? 0,
        monthTokens: m.totalTokens ?? 0,
        dailyCap: typeof c.dailyTokenCap === 'number' ? c.dailyTokenCap : 'none',
      };
    });
    lines.push(table(connRows));
  }
  if (agents.length) {
    const agentRows = agents.map(([agentId, raw]) => {
      const a = isObj(raw) ? raw : {};
      const d = isObj(a.day) ? a.day : {};
      const m = isObj(a.month) ? a.month : {};
      return {
        agentId,
        dayTokens: d.totalTokens ?? 0,
        dayCalls: d.calls ?? 0,
        monthTokens: m.totalTokens ?? 0,
        monthCalls: m.calls ?? 0,
      };
    });
    lines.push('By agent:');
    lines.push(table(agentRows));
  }
  return lines.map((l) => stripControl(l)).join('\n');
}

function renderSubscriptionsList(body: Record<string, unknown>): string {
  const connections = (body.connections as unknown[]).filter(isObj);
  const templates = (body.templates as unknown[]).filter(isObj);
  const notOffered = Array.isArray(body.notOffered) ? body.notOffered.filter(isObj) : [];
  const parts: string[] = [];

  parts.push(`Connected subscriptions (${connections.length}):`);
  if (!connections.length) {
    parts.push('  (none)');
  } else {
    for (const c of connections) {
      const status = c.status === 'needs_reconsent' ? 'needs_reconsent [RECONSENT REQUIRED]' : String(c.status ?? 'active');
      const scope =
        c.scope === 'personal'
          ? `personal (${oneLine(String(c.ownerPrincipalId ?? 'owner'))})`
          : String(c.scope ?? 'factory');
      const cap = typeof c.dailyTokenCap === 'number' ? `${c.dailyTokenCap} tokens/day/agent` : 'uncapped';
      parts.push(
        `  - ${oneLine(String(c.name ?? c.id))} [${oneLine(String(c.id))}]  scope=${oneLine(scope)}  status=${oneLine(status)}  vendor=${oneLine(String(c.vendor ?? c.templateId ?? ''))}${c.tier ? `  tier=${oneLine(String(c.tier))}` : ''}${c.accountEmail ? `  account=${oneLine(String(c.accountEmail))}` : ''}  cap=${oneLine(cap)}`,
      );
      if (isObj(c.limitWindow)) {
        const w = c.limitWindow;
        parts.push(
          `      limit window: kind=${oneLine(String(w.kind ?? ''))} code=${oneLine(String(w.code ?? ''))} openedAt=${oneLine(String(w.openedAt ?? ''))}${w.resetAt ? ` resetAt=${oneLine(String(w.resetAt))}` : ''}`,
        );
      }
      if (Array.isArray(c.activeCaps) && c.activeCaps.length) {
        const capItems = c.activeCaps
          .filter(isObj)
          .map((ac) => `${oneLine(String(ac.agentId ?? ''))} (resetAt=${oneLine(String(ac.resetAt ?? ''))})`)
          .join(', ');
        if (capItems) parts.push(`      capped agents today: ${capItems}`);
      }
      if (isObj(c.discovery)) {
        const disc = c.discovery;
        const models = Array.isArray(c.discoveredModels)
          ? c.discoveredModels.filter(isObj).map((m) => oneLine(String(m.id ?? ''))).filter(Boolean)
          : [];
        parts.push(
          `      discovery: status=${oneLine(String(disc.status ?? 'ok'))} listAvailable=${String(Boolean(disc.listAvailable))}${disc.reason ? ` reason=${oneLine(String(disc.reason))}` : ''}${models.length ? ` models=[${models.join(', ')}]` : ''}`,
        );
      }
    }
  }

  parts.push('');
  parts.push(`Permitted vendor templates (${templates.length}):`);
  for (const t of templates) {
    const perm = isObj(t.permission) ? t.permission : {};
    const tiers = Array.isArray(perm.tiers) ? perm.tiers.map((x) => oneLine(String(x))).join(', ') : '';
    const urls = Array.isArray(perm.statementUrls) ? perm.statementUrls.map((x) => oneLine(String(x))).join(', ') : '';
    parts.push(
      `  - ${oneLine(String(t.id ?? ''))}: ${oneLine(String(t.name ?? ''))}${tiers ? ` (tiers: ${tiers})` : ''}${perm.checkedDate ? ` [checked ${oneLine(String(perm.checkedDate))}]` : ''}${urls ? ` — ${urls}` : ''}`,
    );
  }

  if (notOffered.length) {
    parts.push('');
    parts.push('Consumer subscriptions NOT offered (§6.9 M5(2)):');
    for (const v of notOffered) {
      const urls = Array.isArray(v.statementUrls) ? v.statementUrls.map((x) => oneLine(String(x))).join(', ') : '';
      parts.push(
        `  - ${oneLine(String(v.name ?? v.vendor ?? ''))} [NOT OFFERED, checked ${oneLine(String(v.checkedDate ?? ''))}]: ${oneLine(String(v.reason ?? ''))}${urls ? ` (${urls})` : ''}`,
      );
    }
  }

  return parts.map((l) => stripControl(l)).join('\n');
}

function renderModelsCatalog(body: Record<string, unknown>): string {
  const models = (body.models as unknown[]).filter(isObj);
  const def = body.default === null || body.default === undefined ? '(none)' : oneLine(String(body.default));
  if (!models.length) return `default: ${def}\n(none)`;
  const rows = models.map((m) => {
    const isSub = Boolean(m.subscription || m.credentialMode === 'subscription');
    const billing = isSub
      ? m.scope === 'personal'
        ? `subscription [personal BYOM${m.ownerPrincipalId ? ` ${oneLine(String(m.ownerPrincipalId))}` : ''}]`
        : 'subscription [factory]'
      : 'api-key';
    const p = isObj(m.price) ? `$${m.price.inputPerMTok ?? 0}/$${m.price.outputPerMTok ?? 0}` : 'unpriced';
    return {
      name: m.name,
      label: m.displayLabel ?? m.id ?? m.name,
      billing,
      price: p,
    };
  });
  return `default: ${def}\n${table(rows)}`;
}

/** A list of things as a table, a thing as key-value lines, anything else as it is. */
export function render(body: unknown): string {
  if (Array.isArray(body)) return body.every(isObj) ? table(body as Record<string, unknown>[]) : body.map((b) => cell(b, 120)).join('\n');
  if (isObj(body)) {
    if (Array.isArray(body.connections) && Array.isArray(body.templates)) {
      return renderSubscriptionsList(body);
    }
    if (Array.isArray(body.models) && 'default' in body) {
      return renderModelsCatalog(body);
    }
    if (isObj(body.signIn) && typeof body.signIn.verificationUrl === 'string' && typeof body.signIn.userCode === 'string') {
      const s = body.signIn;
      return [
        `Verification URL:  ${oneLine(String(s.verificationUrl))}`,
        `Device code:       ${oneLine(String(s.userCode))}`,
        `Sign-in ID:        ${oneLine(String(s.signInId ?? ''))}`,
        `Expires at:        ${oneLine(String(s.expiresAt ?? ''))}`,
      ].join('\n');
    }
    if (typeof body.day === 'string' && typeof body.month === 'string' && isObj(body.connections) && isObj(body.agents) && !('agents' in body && isObj((Object.values(body.agents)[0] ?? null)) && 'usd' in ((Object.values(body.agents)[0] as Record<string, unknown>)?.day as Record<string, unknown> ?? {}))) {
      return renderSubscriptionSpendSection(body);
    }
    if (isObj(body.subscriptions) && isObj(body.subscriptions.connections) && isObj(body.subscriptions.agents)) {
      const { subscriptions, ...rest } = body;
      return `${keyValues(rest)}\n\n${renderSubscriptionSpendSection(subscriptions)}`;
    }
    // The factory often wraps a list ({ replies: [...] }, { items: [...] }): show the list when that is the whole answer.
    const keys = Object.keys(body);
    if (keys.length === 1 && Array.isArray(body[keys[0]]) && (body[keys[0]] as unknown[]).every(isObj)) return table(body[keys[0]] as Record<string, unknown>[]);
    return keyValues(body);
  }
  return cell(body, 400);
}
