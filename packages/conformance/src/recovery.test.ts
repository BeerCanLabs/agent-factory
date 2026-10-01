// DESIGN_AUTHORITY.md §6.13 R1: everything only the factory holds is backed up and restorable.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { read } from './support.js';

describe('R1 the factory state is recoverable', () => {
  it('the AWS landing zone keeps automatic backups enabled on the control plane volume', () => {
    const tf = read('landing-zones/aws/storage.tf');
    const policy = tf.match(/resource "aws_efs_backup_policy" "\w+" \{[\s\S]*?\n\}/)?.[0] ?? '';
    assert.match(policy, /file_system_id\s*=\s*aws_efs_file_system\.ledger\.id/, 'the backup policy covers the control plane volume');
    assert.match(policy, /status\s*=\s*"ENABLED"/, 'automatic backups are enabled');
  });
});
