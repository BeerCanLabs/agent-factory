/**
 * Default skills catalog (DESIGN_AUTHORITY.md §6.14 SK3, §6.18 CF6, GAP-216).
 * Persisted in `skill-defaults.json` on the control plane's backed-up volume (R1).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SEMVER, SKILL_ID } from '@beercanlabs/factory-contract';
import type { RegistryWarn } from './registry.js';

export type DefaultSkillEntry = {
  id: string;
  version: string;
};

export type DefaultSkillsState = {
  skills: DefaultSkillEntry[];
  updatedAt?: string;
  updatedBy?: string;
};

function isValidEntry(entry: unknown): entry is DefaultSkillEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as { id?: unknown; version?: unknown };
  return (
    typeof e.id === 'string' &&
    SKILL_ID.test(e.id) &&
    typeof e.version === 'string' &&
    SEMVER.test(e.version)
  );
}

export class DefaultSkillsStore {
  private skills: DefaultSkillEntry[] = [];
  private updatedAt?: string;
  private updatedBy?: string;

  constructor(
    private readonly filePath?: string,
    private readonly warn: RegistryWarn = (message, err) => console.warn(`[registrar] ${message}`, err),
  ) {
    if (!filePath || !existsSync(filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8'));
      if (raw && typeof raw === 'object' && Array.isArray((raw as { skills?: unknown }).skills)) {
        const stateObj = raw as { skills: unknown[]; updatedAt?: unknown; updatedBy?: unknown };
        const seen = new Set<string>();
        const list: DefaultSkillEntry[] = [];
        for (const item of stateObj.skills) {
          if (isValidEntry(item)) {
            if (!seen.has(item.id)) {
              seen.add(item.id);
              list.push({ id: item.id, version: item.version });
            }
          } else {
            this.warn(`skipping invalid default skill item in ${filePath}`, item);
          }
        }
        this.skills = list;
        if (typeof stateObj.updatedAt === 'string') this.updatedAt = stateObj.updatedAt;
        if (typeof stateObj.updatedBy === 'string') this.updatedBy = stateObj.updatedBy;
      }
    } catch (err) {
      this.warn(`skipping unreadable default skills file ${filePath}:`, err);
    }
  }

  get(): DefaultSkillsState {
    return {
      skills: this.skills.map((s) => ({ id: s.id, version: s.version })),
      ...(this.updatedAt ? { updatedAt: this.updatedAt } : {}),
      ...(this.updatedBy ? { updatedBy: this.updatedBy } : {}),
    };
  }

  set(skills: readonly DefaultSkillEntry[], actor: string, now = new Date().toISOString()): DefaultSkillsState {
    const seen = new Set<string>();
    const deduplicated: DefaultSkillEntry[] = [];
    for (const item of skills) {
      if (!isValidEntry(item)) {
        throw new Error(`invalid default skill entry ${JSON.stringify(item)}`);
      }
      if (!seen.has(item.id)) {
        seen.add(item.id);
        deduplicated.push({ id: item.id, version: item.version });
      }
    }

    const newState: DefaultSkillsState = {
      skills: deduplicated,
      updatedAt: now,
      updatedBy: actor,
    };

    if (this.filePath) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(newState, null, 2), 'utf8');
      renameSync(tmp, this.filePath);
    }

    this.skills = deduplicated;
    this.updatedAt = now;
    this.updatedBy = actor;

    return this.get();
  }

  removeSkill(id: string, actor: string, version?: string): boolean {
    const idx = this.skills.findIndex(
      (s) => s.id === id && (version === undefined || s.version === version),
    );
    if (idx === -1) return false;

    const remaining = this.skills.filter(
      (s) => !(s.id === id && (version === undefined || s.version === version)),
    );
    const now = new Date().toISOString();
    const newState: DefaultSkillsState = {
      skills: remaining,
      updatedAt: now,
      updatedBy: actor,
    };

    if (this.filePath) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(newState, null, 2), 'utf8');
      renameSync(tmp, this.filePath);
    }

    this.skills = remaining;
    this.updatedAt = now;
    this.updatedBy = actor;

    return true;
  }
}
