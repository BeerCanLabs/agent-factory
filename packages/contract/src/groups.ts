/**
 * Factory user groups and group membership contract (DESIGN_AUTHORITY.md H6, A10, A17).
 *
 * Groups allow factory admins to organize users, assign roles to groups, and assign skills to groups.
 * - Group membership is kept in the factory (A10).
 * - A role given to a group may contain only scoped skill privileges + optionally skills.register (A17).
 * - Only human users hold content ownership; groups do not own content directly (H6).
 */

export const GROUP_ID = /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$|^[a-z0-9]$/;

export type Group = {
  id: string;
  name: string;
  description?: string;
  roles: string[];
  members: string[];
  createdAt: string;
  updatedAt: string;
};

export type CreateGroupInput = {
  id: string;
  name: string;
  description?: string;
  roles?: string[];
  members?: string[];
};

export type UpdateGroupInput = {
  name?: string;
  description?: string;
  roles?: string[];
};

/** Validate group ID format. */
export function validateGroupId(id: unknown): string {
  if (typeof id !== 'string' || !GROUP_ID.test(id)) {
    throw new Error(`group id ${JSON.stringify(id)} is invalid: must be 1-64 lowercase alphanumeric, dot, hyphen or underscore characters`);
  }
  return id;
}

/** Validate user identifier/email. */
export function validateMemberId(member: unknown): string {
  if (typeof member !== 'string' || !member.trim() || member.length > 255) {
    throw new Error(`member ${JSON.stringify(member)} is invalid: must be a non-empty string up to 255 characters`);
  }
  return member.trim().toLowerCase();
}

/**
 * Validates group roles per A17:
 * A role given to a group may contain only scoped skill privileges + optionally skills.register.
 * It may never be the built-in admin role or contain skills.decide or skills.transfer.
 */
const FORBIDDEN_GROUP_ROLES = new Set(['admin']);

export function validateGroupRoles(roles: unknown): string[] {
  if (!roles) return [];
  if (!Array.isArray(roles)) throw new Error('roles must be an array of strings');
  const out: string[] = [];
  for (const r of roles) {
    if (typeof r !== 'string' || !r.trim()) throw new Error('each role must be a non-empty string');
    const role = r.trim();
    if (FORBIDDEN_GROUP_ROLES.has(role)) {
      throw new Error(`role ${JSON.stringify(role)} cannot be assigned to a group (A17: admin role forbidden)`);
    }
    if (!out.includes(role)) out.push(role);
  }
  return out.sort();
}
