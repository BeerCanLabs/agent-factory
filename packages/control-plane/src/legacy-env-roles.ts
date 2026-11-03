import type { Role } from '@beercanlabs/factory-auth';

/**
 * S4 (R1, D4, migration step 1-2): the one control-plane module allowed to read the legacy env role lists
 * `FACTORY_ADMIN_EMAILS` and `FACTORY_TOKENS`. It is the source the S8 migration importer converts into principals,
 * grants and `service:<name>` keys, and it is deleted at cutover (S10). Every other module asks this one; the
 * conformance suite (packages/conformance/src/authorization.test.ts) fails on any new direct read.
 */

/** Admin emails named by the deployment, lowercased and trimmed. */
export function legacyAdminEmails(): string[] {
  return (process.env.FACTORY_ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** The parsed `FACTORY_TOKENS` entries; an unset or malformed value is an empty list. */
function legacyTokenEntries(): Array<{ name: string; roles?: unknown }> {
  const raw = process.env.FACTORY_TOKENS;
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((t: any) => t && typeof t.name === 'string') : [];
  } catch {
    return [];
  }
}

/** The `FACTORY_TOKENS` entry with this name (case-insensitive unless `exact`), or undefined. */
export function legacyTokenEntry(name: string, exact = false): { name: string; roles?: unknown } | undefined {
  const want = exact ? name : name.toLowerCase();
  return legacyTokenEntries().find((t) => (exact ? t.name : t.name.toLowerCase()) === want);
}

/** The roles a named legacy token carries, or undefined when no entry (or no role list) exists. */
export function legacyTokenRoles(name: string, exact = false): Role[] | undefined {
  const match = legacyTokenEntry(name, exact);
  return match && Array.isArray(match.roles) ? (match.roles as Role[]) : undefined;
}

/** S8: the names of every legacy `FACTORY_TOKENS` entry, for the importer. */
export function legacyTokenNames(): string[] {
  return legacyTokenEntries().map((t) => t.name);
}
