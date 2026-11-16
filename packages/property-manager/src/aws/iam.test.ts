import { describe, it, afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IAMClient } from '@aws-sdk/client-iam';
import { checkMindPrefix, mindBucketName, mindPolicyDocument, MIND_POLICY, provisionAgentRoles, reconcileAgentTaskRole } from './iam.js';

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
    if (name === 'ListAttachedRolePoliciesCommand') return { AttachedPolicies: [] };
    return {};
  });
  return calls;
}

describe('agent deploy IAM (S1 revoke, TSK-045)', () => {
  const env = process.env.FACTORY_MIND_BUCKET;
  beforeEach(() => {
    process.env.FACTORY_MIND_BUCKET = 'agent-factory-mind-test';
  });
  afterEach(() => {
    mock.restoreAll();
    if (env === undefined) delete process.env.FACTORY_MIND_BUCKET;
    else process.env.FACTORY_MIND_BUCKET = env;
  });

  it('first deploy with no container secrets does not call DeleteRolePolicy on the new role', async () => {
    const calls = fakeIam(false);
    const r = await provisionAgentRoles('castle', []);
    assert.equal(r.executionRoleArn, 'arn:aws:iam::1:role/AgentExecutionRole-castle');
    assert.ok(!calls.some((c) => c === 'DeleteRolePolicyCommand:AgentExecutionRole-castle'), calls.join(','));
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

// GAP-249: every agent task role could read, write and delete every agent's mind, and call Bedrock directly.
type Call = { name: string; input: Record<string, any> };
function recordingIam(opts: { roleExists?: boolean; attached?: Array<{ PolicyName: string; PolicyArn: string }>; inline?: string[] } = {}) {
  const calls: Call[] = [];
  const inline = new Set(opts.inline ?? ['BedrockConverseAccess', 'MindPersistenceAccess']);
  mock.method(IAMClient.prototype, 'send', async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
    const name = cmd.constructor.name;
    calls.push({ name, input: cmd.input });
    const noSuch = () => Object.assign(new Error('no such'), { name: 'NoSuchEntityException' });
    if (name === 'GetRoleCommand') {
      if (opts.roleExists === false) throw noSuch();
      return { Role: { Arn: `arn:aws:iam::1:role/${cmd.input.RoleName}` } };
    }
    if (name === 'CreateRoleCommand') throw Object.assign(new Error('exists'), { name: 'EntityAlreadyExistsException' });
    if (name === 'DeleteRolePolicyCommand') {
      if (!inline.delete(cmd.input.PolicyName)) throw noSuch();
      return {};
    }
    if (name === 'ListAttachedRolePoliciesCommand') return { AttachedPolicies: opts.attached ?? [], IsTruncated: false };
    return {};
  });
  return calls;
}

describe('agent task roles: own mind prefix only, no direct model access (GAP-249)', () => {
  const env = process.env.FACTORY_MIND_BUCKET;
  beforeEach(() => {
    process.env.FACTORY_MIND_BUCKET = 'agent-factory-mind-prod-abcd1234';
  });
  afterEach(() => {
    mock.restoreAll();
    if (env === undefined) delete process.env.FACTORY_MIND_BUCKET;
    else process.env.FACTORY_MIND_BUCKET = env;
  });

  it('scopes the mind policy to the one bucket and the agent\'s own prefix', async () => {
    const calls = recordingIam();
    await provisionAgentRoles('archie', [], { memoryPrefix: 'archie-state' });
    const put = calls.find((c) => c.name === 'PutRolePolicyCommand' && c.input.PolicyName === MIND_POLICY);
    assert.ok(put, 'mind policy written');
    assert.equal(put.input.RoleName, 'AgentTaskRole-archie');
    const doc = JSON.parse(put.input.PolicyDocument);
    const resources = doc.Statement.flatMap((s: { Resource: string[] }) => s.Resource);
    assert.deepEqual(resources, ['arn:aws:s3:::agent-factory-mind-prod-abcd1234/archie-state/*', 'arn:aws:s3:::agent-factory-mind-prod-abcd1234']);
    assert.ok(!JSON.stringify(doc).includes('mind-*'), 'no bucket wildcard');
    const list = doc.Statement.find((s: { Action: string[] }) => s.Action.includes('s3:ListBucket'));
    assert.deepEqual(list.Condition, { StringLike: { 's3:prefix': ['archie-state', 'archie-state/', 'archie-state/*'] } });
    assert.deepEqual(list.Action, ['s3:ListBucket'], 'listing is its own statement, never with object actions on the bucket');
  });

  it('defaults the prefix to the agent id', async () => {
    const calls = recordingIam();
    await provisionAgentRoles('castle', []);
    const put = calls.find((c) => c.name === 'PutRolePolicyCommand' && c.input.PolicyName === MIND_POLICY)!;
    assert.match(put.input.PolicyDocument, /mind-prod-abcd1234\/castle\/\*/);
  });

  it('never grants a Bedrock or other model action, and removes the old inline and hand-attached grants', async () => {
    const calls = recordingIam({
      attached: [
        { PolicyName: 'AgentBedrockModelInvocation', PolicyArn: 'arn:aws:iam::1:policy/AgentBedrockModelInvocation' },
        { PolicyName: 'SomethingElse', PolicyArn: 'arn:aws:iam::1:policy/SomethingElse' },
      ],
    });
    await provisionAgentRoles('donna', [], { memoryPrefix: 'donna-state' });
    for (const c of calls.filter((x) => x.name === 'PutRolePolicyCommand')) assert.doesNotMatch(c.input.PolicyDocument, /bedrock/i);
    assert.ok(calls.some((c) => c.name === 'DeleteRolePolicyCommand' && c.input.RoleName === 'AgentTaskRole-donna' && c.input.PolicyName === 'BedrockConverseAccess'));
    const detached = calls.filter((c) => c.name === 'DetachRolePolicyCommand').map((c) => `${c.input.RoleName} ${c.input.PolicyArn}`);
    assert.deepEqual(detached, ['AgentTaskRole-donna arn:aws:iam::1:policy/AgentBedrockModelInvocation'], 'only the direct model policy is detached');
    const src = readFileSync(fileURLToPath(new URL('./iam.ts', import.meta.url)), 'utf8');
    assert.doesNotMatch(src, /"bedrock:/, 'aws/iam.ts grants no bedrock action');
  });

  it('a helper role (memory: false) loses its mind policy and gets none', async () => {
    const calls = recordingIam();
    await provisionAgentRoles('__helper_x', [], { memory: false });
    assert.ok(!calls.some((c) => c.name === 'PutRolePolicyCommand' && c.input.PolicyName === MIND_POLICY));
    assert.ok(calls.some((c) => c.name === 'DeleteRolePolicyCommand' && c.input.PolicyName === MIND_POLICY));
  });

  it('refuses a prefix or bucket that would widen the grant, before writing anything', async () => {
    for (const bad of ['', '*', 'a*', 'a/../b', '/a', 'a/', 'a//b', 'a?']) assert.throws(() => checkMindPrefix(bad), /invalid mind prefix/, bad);
    assert.equal(checkMindPrefix('team/archie-state'), 'team/archie-state');
    assert.throws(() => mindPolicyDocument('b', '*'), /invalid mind prefix/);
    delete process.env.FACTORY_MIND_BUCKET;
    assert.throws(() => mindBucketName(), /FACTORY_MIND_BUCKET/);
    assert.throws(() => mindBucketName({ FACTORY_MIND_BUCKET: 'agent-factory-mind-*' }), /FACTORY_MIND_BUCKET/);
    assert.equal(mindBucketName({ FACTORY_MIND_BUCKET: 's3://agent-factory-mind-prod-abcd1234/' }), 'agent-factory-mind-prod-abcd1234');
    const calls = recordingIam();
    await assert.rejects(provisionAgentRoles('archie', [], { memoryPrefix: 'archie-state' }), /FACTORY_MIND_BUCKET/);
    assert.ok(!calls.some((c) => c.name === 'PutRolePolicyCommand' && c.input.PolicyName === MIND_POLICY));
  });

  it('a failed mind-policy write fails the deploy instead of leaving the wider grant', async () => {
    mock.method(IAMClient.prototype, 'send', async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
      if (cmd.constructor.name === 'CreateRoleCommand') return { Role: { Arn: 'arn:aws:iam::1:role/x' } };
      if (cmd.constructor.name === 'PutRolePolicyCommand') throw Object.assign(new Error('denied'), { name: 'AccessDenied' });
      return {};
    });
    await assert.rejects(provisionAgentRoles('archie', [], { memoryPrefix: 'archie-state' }), /denied/);
  });

  it('reconcileAgentTaskRole migrates an existing role and skips a missing one', async () => {
    let calls = recordingIam({ attached: [{ PolicyName: 'AgentBedrockModelInvocation', PolicyArn: 'arn:aws:iam::1:policy/AgentBedrockModelInvocation' }] });
    const r = await reconcileAgentTaskRole('higgins', { memoryPrefix: 'higgins-state' });
    assert.deepEqual(r, { role: 'AgentTaskRole-higgins', revoked: ['BedrockConverseAccess', 'AgentBedrockModelInvocation'] });
    assert.match(calls.find((c) => c.name === 'PutRolePolicyCommand')!.input.PolicyDocument, /\/higgins-state\/\*/);
    assert.ok(!calls.some((c) => c.name === 'CreateRoleCommand'), 'never creates a role');
    mock.restoreAll();
    calls = recordingIam({ roleExists: false });
    assert.deepEqual(await reconcileAgentTaskRole('echo-agent'), { role: 'AgentTaskRole-echo-agent', skipped: 'no-role', revoked: [] });
    assert.deepEqual(calls.map((c) => c.name), ['GetRoleCommand']);
  });

  it('the landing zone lets the control plane revoke grants on agent task roles only', () => {
    const tf = readFileSync(fileURLToPath(new URL('../../../../landing-zones/aws/iam.tf', import.meta.url)), 'utf8');
    const stmt = /Sid\s*=\s*"RevokeAgentTaskRoleGrants"[\s\S]*?Action\s*=\s*\[([^\]]+)\]\s*\n\s*Resource\s*=\s*"([^"]+)"/.exec(tf);
    assert.ok(stmt, 'RevokeAgentTaskRoleGrants statement');
    assert.deepEqual(stmt[1].split(',').map((s) => s.trim().replace(/"/g, '')).sort(), ['iam:DeleteRolePolicy', 'iam:DetachRolePolicy', 'iam:ListAttachedRolePolicies']);
    assert.equal(stmt[2], 'arn:aws:iam::${var.account_id}:role/AgentTaskRole-*');
  });
});
