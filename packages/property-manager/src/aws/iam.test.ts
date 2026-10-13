import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IAMClient } from '@aws-sdk/client-iam';
import { provisionAgentRoles } from './iam.js';

// TSK-045: the first deploy of an agent with no container secrets failed AGENT_DEPLOY_FAILED, because the
// control plane revoked SecretsAccess on AgentExecutionRole-<id> while the landing zone only allowed
// iam:DeleteRolePolicy on factory-agent-exec-*.
function fakeIam(existing: boolean) {
  const calls: string[] = [];
  mock.method(IAMClient.prototype, 'send', async (cmd: { constructor: { name: string }; input: { RoleName?: string } }) => {
    const name = cmd.constructor.name;
    calls.push(`${name}:${cmd.input.RoleName}`);
    if (name === 'CreateRoleCommand') {
      if (existing) throw Object.assign(new Error('exists'), { name: 'EntityAlreadyExistsException' });
      return { Role: { Arn: `arn:aws:iam::1:role/${cmd.input.RoleName}` } };
    }
    if (name === 'GetRoleCommand') return { Role: { Arn: `arn:aws:iam::1:role/${cmd.input.RoleName}` } };
    return {};
  });
  return calls;
}

describe('agent deploy IAM (S1 revoke, TSK-045)', () => {
  afterEach(() => mock.restoreAll());

  it('first deploy with no container secrets does not call DeleteRolePolicy on the new role', async () => {
    const calls = fakeIam(false);
    const r = await provisionAgentRoles('castle', []);
    assert.equal(r.executionRoleArn, 'arn:aws:iam::1:role/AgentExecutionRole-castle');
    assert.ok(!calls.some((c) => c.startsWith('DeleteRolePolicyCommand')), calls.join(','));
  });

  it('redeploy of an existing role with no container secrets still revokes SecretsAccess', async () => {
    const calls = fakeIam(true);
    await provisionAgentRoles('castle', []);
    assert.ok(calls.includes('DeleteRolePolicyCommand:AgentExecutionRole-castle'), calls.join(','));
  });

  it('the landing zone grants iam:DeleteRolePolicy on exactly the execution-role names the control plane uses', () => {
    const src = readFileSync(fileURLToPath(new URL('./iam.ts', import.meta.url)), 'utf8');
    const prefix = /const executionRoleName = `([A-Za-z-]+)\$\{agentId\}`/.exec(src)?.[1];
    assert.equal(prefix, 'AgentExecutionRole-');
    const tf = readFileSync(fileURLToPath(new URL('../../../../landing-zones/aws/iam.tf', import.meta.url)), 'utf8');
    const stmt = /Action\s*=\s*\["iam:DeleteRolePolicy"\]\s*\n\s*Resource\s*=\s*"([^"]+)"/.exec(tf)?.[1];
    assert.equal(stmt, `arn:aws:iam::\${var.account_id}:role/${prefix}*`);
  });
});
