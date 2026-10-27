/**
 * Skill user ownership, transfer, group assignment, and package inspection contract.
 * DESIGN_AUTHORITY.md §6.14 (SK1, SK3), H3, H4, H5, A8, A9, A11, A18, A21, A24, A26.
 *
 * Rules:
 * - Whoever registers content owns it: one named human user (H4, A11).
 * - Transfer is pending until the recipient (who must hold `skills.register`) accepts it (A24).
 * - Admin can transfer without acceptance if owner rights are revoked (A24).
 * - Skills can be assigned to a group (H5, A18).
 * - Scoped skill privileges and built-in `skill-owner` role manage content (A8, A9).
 * - Read-only package view allows inspecting package contents without bulk download (A21).
 */

import { validateGroupId } from './groups.js';

export type SkillTransferPending = {
  recipient: string;
  requestedAt: string;
  requestedBy: string;
};

export type RequestSkillTransferInput = {
  recipient: string;
};

export type AdminSkillTransferInput = {
  recipient: string;
};

export type AssignSkillGroupInput = {
  groupId: string;
};

export type PackageFileListEntry = {
  path: string;
  size: number;
};

export type PackageFileList = {
  packageHash: string;
  files: PackageFileListEntry[];
};

export type PackageFileContent = {
  path: string;
  size: number;
  content: string;
};

/**
 * Validates a transfer recipient identifier (e.g. email or actor).
 * Must be a non-empty string up to 255 chars.
 */
export function validateTransferRecipient(recipient: unknown): string {
  if (typeof recipient !== 'string' || !recipient.trim() || recipient.length > 255) {
    throw new Error(`transfer recipient ${JSON.stringify(recipient)} is invalid: must be a non-empty string up to 255 characters`);
  }
  return recipient.trim().toLowerCase();
}

/**
 * Validates group assignment input.
 */
export function validateAssignGroupInput(input: unknown): AssignSkillGroupInput {
  if (!input || typeof input !== 'object') {
    throw new Error('assignment input must be an object with groupId');
  }
  const raw = input as Record<string, unknown>;
  const groupId = validateGroupId(raw.groupId);
  return { groupId };
}
