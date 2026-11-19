/**
 * Multi-owner apps (Dale, 2026-11-18): an agent holds any number of GitHub Apps, one per owner (an org or a personal account),
 * beside its original ("legacy") app. Each owner app has its own secrets (`githubAppSecretNames(agentId, owner)`), and
 * the owners that have one are recorded (not secret) in the agent's `<registryDir>/github-apps/<agentId>.json`:
 *
 *   { "orgs": ["BeerCanLabs"],                                   owners the legacy app was chosen for
 *     "owners": { "getdraft": { "type": "org" }, "dsackr": { "type": "user" } } }   owners with their own app
 *
 * Keys are minted, and webhooks verified, by the owner of the repo a call or delivery is for; an owner without its own
 * app keeps using the legacy app. Owner logins are compared case-insensitively and stored lower-case.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FactoryState } from './app.js';

/** A GitHub org or user login (GitHub logins never carry `_`, so `-` -> `_` in secret names cannot collide). */
export const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export type OwnerType = 'org' | 'user';
export type AppRecord = { orgs: string[]; owners: Record<string, { type: OwnerType; at?: string; by?: string }>; [k: string]: unknown };

// The record lives beside the registry, as the chosen-orgs file always has (not the Registrar's agent records).
const appsDir = (s: FactoryState) => (s.registryDir ? join(s.registryDir, 'github-apps') : undefined);
const recordPath = (s: FactoryState, agentId: string) => { const d = appsDir(s); return d ? join(d, `${agentId}.json`) : undefined; };

/** The agent's app record; empty lists when none was written. */
export function readAppRecord(state: FactoryState, agentId: string): AppRecord {
  const p = recordPath(state, agentId);
  let v: Record<string, unknown> = {};
  if (p) {
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) v = parsed;
    } catch {
      /* no record yet */
    }
  }
  const orgs = Array.isArray(v.orgs) ? v.orgs.filter((o): o is string => typeof o === 'string' && OWNER.test(o)) : [];
  const owners: AppRecord['owners'] = {};
  if (v.owners && typeof v.owners === 'object' && !Array.isArray(v.owners)) {
    for (const [k, o] of Object.entries(v.owners as Record<string, unknown>)) {
      if (!OWNER.test(k) || !o || typeof o !== 'object') continue;
      const t = (o as { type?: unknown }).type;
      owners[k.toLowerCase()] = { ...(o as object), type: t === 'user' ? 'user' : 'org' };
    }
  }
  return { ...v, orgs, owners };
}

/** Writes the record (read-modify-write by the caller). Returns false when the factory has no registry dir. */
export function writeAppRecord(state: FactoryState, agentId: string, rec: AppRecord): boolean {
  const d = appsDir(state);
  if (!d) return false;
  const p = join(d, `${agentId}.json`);
  mkdirSync(d, { recursive: true });
  writeFileSync(p, JSON.stringify(rec, null, 2));
  return true;
}

/** The owner's own app, when the agent has one recorded for that owner. */
export function ownerApp(state: FactoryState, agentId: string, owner: string): { owner: string; type: OwnerType } | undefined {
  const lower = owner.toLowerCase();
  const o = readAppRecord(state, agentId).owners[lower];
  return o ? { owner: lower, type: o.type } : undefined;
}

/** Every owner with its own app. */
export function ownerApps(state: FactoryState, agentId: string): Array<{ owner: string; type: OwnerType }> {
  return Object.entries(readAppRecord(state, agentId).owners).map(([owner, o]) => ({ owner, type: o.type }));
}

/**
 * Jury #522 B1: the owners the agent's original app serves: the chosen `orgs` minus any owner with its own app (an owner
 * app owner can also land in `orgs`, e.g. through the installations route). A call with no owner (GraphQL with no hint)
 * defaults only to these, so adding owner apps never makes the original app's default ambiguous.
 */
export function legacyOrgs(state: FactoryState, agentId: string): string[] {
  const rec = readAppRecord(state, agentId);
  const out: string[] = [];
  for (const o of rec.orgs) {
    const lower = o.toLowerCase();
    if (rec.owners[lower] || out.some((x) => x.toLowerCase() === lower)) continue;
    out.push(o);
  }
  return out;
}
