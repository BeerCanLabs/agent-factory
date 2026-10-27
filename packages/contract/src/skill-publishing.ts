/**
 * Skill publishing, unpublishing, and retirement contract types and validators.
 * DESIGN_AUTHORITY.md §6.14 (SK1, SK3, SK6), H7, H8, H9, H10, A7, A8, A12, A13, A26.
 */

export type SkillPublishStatus = 'unpublished' | 'pending' | 'published';

export type SkillPublishRequestInput = {
  notes?: string;
};

export type SkillPublishDecisionInput = {
  decision: 'approve' | 'reject';
  reason?: string;
};

export type SkillUnpublishInput = {
  reason?: string;
};

export type SkillRetireInput = {
  reason?: string;
  force?: boolean;
};

export function validatePublishRequestInput(raw: unknown): SkillPublishRequestInput {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw !== 'object') {
    throw new Error('publish request body must be an object');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.notes !== undefined) {
    if (typeof obj.notes !== 'string' || obj.notes.length > 2000) {
      throw new Error('notes must be a string up to 2000 characters');
    }
    return { notes: obj.notes.trim() };
  }
  return {};
}

export function validatePublishDecisionInput(raw: unknown): SkillPublishDecisionInput {
  if (!raw || typeof raw !== 'object') {
    throw new Error('publish decision body must be an object with decision ("approve" or "reject")');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.decision !== 'approve' && obj.decision !== 'reject') {
    throw new Error('decision must be "approve" or "reject"');
  }
  let reason: string | undefined;
  if (obj.reason !== undefined) {
    if (typeof obj.reason !== 'string' || obj.reason.length > 2000) {
      throw new Error('reason must be a string up to 2000 characters');
    }
    reason = obj.reason.trim();
  }
  return { decision: obj.decision, ...(reason ? { reason } : {}) };
}

export function validateUnpublishInput(raw: unknown): SkillUnpublishInput {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw !== 'object') {
    throw new Error('unpublish body must be an object');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.reason !== undefined) {
    if (typeof obj.reason !== 'string' || obj.reason.length > 2000) {
      throw new Error('reason must be a string up to 2000 characters');
    }
    return { reason: obj.reason.trim() };
  }
  return {};
}

export function validateRetireInput(raw: unknown): SkillRetireInput {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw !== 'object') {
    throw new Error('retire body must be an object');
  }
  const obj = raw as Record<string, unknown>;
  let reason: string | undefined;
  if (obj.reason !== undefined) {
    if (typeof obj.reason !== 'string' || obj.reason.length > 2000) {
      throw new Error('reason must be a string up to 2000 characters');
    }
    reason = obj.reason.trim();
  }
  let force: boolean | undefined;
  if (obj.force !== undefined) {
    if (typeof obj.force !== 'boolean') {
      throw new Error('force must be a boolean');
    }
    force = obj.force;
  }
  return {
    ...(reason ? { reason } : {}),
    ...(force !== undefined ? { force } : {}),
  };
}
