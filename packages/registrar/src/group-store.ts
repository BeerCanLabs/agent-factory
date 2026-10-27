/**
 * Factory user groups and membership store (DESIGN_AUTHORITY.md H6, A10, A17, A26).
 *
 * Groups allow factory admins to organize users, assign roles to groups, and assign skills to groups.
 * - Stored at `<dir>/<groupId>.json` with atomic writes.
 * - In-memory cache for fast synchronous reads (GAP-056).
 * - Enforces group ID, member ID, and role restrictions (A17: non-admin, no skills.decide or skills.transfer).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  validateGroupId,
  validateMemberId,
  validateGroupRoles,
  type Group,
  type CreateGroupInput,
  type UpdateGroupInput,
} from '@beercanlabs/factory-contract';

export class GroupStore {
  private readonly groups = new Map<string, Group>();

  constructor(private readonly dir: string) {}

  /**
   * Opens the group store at `dir`, creating the directory if needed and loading existing records into memory.
   */
  static async open(dir: string): Promise<GroupStore> {
    const store = new GroupStore(dir);
    mkdirSync(dir, { recursive: true });

    const entries = readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith('.json') || ent.name.startsWith('.')) continue;
      try {
        const raw = JSON.parse(readFileSync(join(dir, ent.name), 'utf8')) as Group;
        if (raw && typeof raw.id === 'string' && typeof raw.name === 'string') {
          store.groups.set(raw.id, {
            id: raw.id,
            name: raw.name,
            description: raw.description,
            roles: Array.isArray(raw.roles) ? [...raw.roles].sort() : [],
            members: Array.isArray(raw.members) ? [...raw.members].sort() : [],
            createdAt: raw.createdAt || new Date().toISOString(),
            updatedAt: raw.updatedAt || new Date().toISOString(),
          });
        }
      } catch {
        // Skip unparseable or corrupted files
      }
    }

    return store;
  }

  private filePath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private persist(group: Group): void {
    const target = this.filePath(group.id);
    const tmp = `${target}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    writeFileSync(tmp, JSON.stringify(group, null, 2), 'utf8');
    renameSync(tmp, target);
  }

  /** Retrieve a group by ID. */
  getGroup(id: string): Group | undefined {
    const cleanId = id.trim().toLowerCase();
    const g = this.groups.get(cleanId);
    return g ? { ...g, roles: [...g.roles], members: [...g.members] } : undefined;
  }

  /** List all groups, sorted by ID. */
  listGroups(): Group[] {
    return Array.from(this.groups.values())
      .map((g) => ({ ...g, roles: [...g.roles], members: [...g.members] }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Create a new group. Throws if group already exists or inputs fail validation. */
  createGroup(input: CreateGroupInput): Group {
    const id = validateGroupId(input.id);
    if (this.groups.has(id)) {
      throw new Error(`group ${JSON.stringify(id)} already exists`);
    }

    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 255) {
      throw new Error('group name must be a non-empty string up to 255 characters');
    }

    let description: string | undefined;
    if (input.description !== undefined) {
      if (typeof input.description !== 'string' || input.description.length > 1000) {
        throw new Error('group description must be a string up to 1000 characters');
      }
      description = input.description.trim() || undefined;
    }

    const roles = validateGroupRoles(input.roles);

    const members: string[] = [];
    if (input.members) {
      if (!Array.isArray(input.members)) throw new Error('members must be an array of strings');
      for (const m of input.members) {
        const member = validateMemberId(m);
        if (!members.includes(member)) members.push(member);
      }
    }
    members.sort();

    const now = new Date().toISOString();
    const group: Group = {
      id,
      name,
      ...(description !== undefined ? { description } : {}),
      roles,
      members,
      createdAt: now,
      updatedAt: now,
    };

    this.persist(group);
    this.groups.set(id, group);

    return { ...group, roles: [...group.roles], members: [...group.members] };
  }

  /** Update an existing group. */
  updateGroup(id: string, input: UpdateGroupInput): Group {
    const cleanId = validateGroupId(id);
    const existing = this.groups.get(cleanId);
    if (!existing) {
      throw new Error(`group ${JSON.stringify(cleanId)} not found`);
    }

    let name = existing.name;
    if (input.name !== undefined) {
      const trimmed = typeof input.name === 'string' ? input.name.trim() : '';
      if (!trimmed || trimmed.length > 255) {
        throw new Error('group name must be a non-empty string up to 255 characters');
      }
      name = trimmed;
    }

    let description = existing.description;
    if (input.description !== undefined) {
      if (typeof input.description !== 'string' || input.description.length > 1000) {
        throw new Error('group description must be a string up to 1000 characters');
      }
      description = input.description.trim() || undefined;
    }

    let roles = existing.roles;
    if (input.roles !== undefined) {
      roles = validateGroupRoles(input.roles);
    }

    const now = new Date().toISOString();
    const updated: Group = {
      ...existing,
      name,
      description,
      roles,
      updatedAt: now,
    };

    this.persist(updated);
    this.groups.set(cleanId, updated);

    return { ...updated, roles: [...updated.roles], members: [...updated.members] };
  }

  /** Delete a group. Returns true if deleted, false if not found. */
  deleteGroup(id: string): boolean {
    const cleanId = id.trim().toLowerCase();
    const existing = this.groups.get(cleanId);
    if (!existing) return false;

    const file = this.filePath(cleanId);
    if (existsSync(file)) {
      rmSync(file, { force: true });
    }
    this.groups.delete(cleanId);
    return true;
  }

  /** Add a member to a group. Returns updated group. */
  addMember(groupId: string, memberId: string): Group {
    const cleanGroupId = validateGroupId(groupId);
    const existing = this.groups.get(cleanGroupId);
    if (!existing) {
      throw new Error(`group ${JSON.stringify(cleanGroupId)} not found`);
    }

    const cleanMemberId = validateMemberId(memberId);
    if (existing.members.includes(cleanMemberId)) {
      return { ...existing, roles: [...existing.roles], members: [...existing.members] };
    }

    const members = [...existing.members, cleanMemberId].sort();
    const now = new Date().toISOString();
    const updated: Group = {
      ...existing,
      members,
      updatedAt: now,
    };

    this.persist(updated);
    this.groups.set(cleanGroupId, updated);

    return { ...updated, roles: [...updated.roles], members: [...updated.members] };
  }

  /** Remove a member from a group. Returns updated group. */
  removeMember(groupId: string, memberId: string): Group {
    const cleanGroupId = validateGroupId(groupId);
    const existing = this.groups.get(cleanGroupId);
    if (!existing) {
      throw new Error(`group ${JSON.stringify(cleanGroupId)} not found`);
    }

    const cleanMemberId = validateMemberId(memberId);
    if (!existing.members.includes(cleanMemberId)) {
      return { ...existing, roles: [...existing.roles], members: [...existing.members] };
    }

    const members = existing.members.filter((m) => m !== cleanMemberId);
    const now = new Date().toISOString();
    const updated: Group = {
      ...existing,
      members,
      updatedAt: now,
    };

    this.persist(updated);
    this.groups.set(cleanGroupId, updated);

    return { ...updated, roles: [...updated.roles], members: [...updated.members] };
  }

  /** Find all groups a member belongs to. */
  listUserGroups(memberId: string): Group[] {
    const cleanMember = validateMemberId(memberId);
    return this.listGroups().filter((g) => g.members.includes(cleanMember));
  }

  /** Get the consolidated roles assigned to a user through all their group memberships. */
  getUserRoles(memberId: string): string[] {
    const groups = this.listUserGroups(memberId);
    const rolesSet = new Set<string>();
    for (const g of groups) {
      for (const r of g.roles) {
        rolesSet.add(r);
      }
    }
    return Array.from(rolesSet).sort();
  }
}
