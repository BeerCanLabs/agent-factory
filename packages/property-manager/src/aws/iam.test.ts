import { describe, it, afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IAMClient } from '@aws-sdk/client-iam';
import {
  awsMindProbe, checkMindPrefix, listAgentTaskRoleIds, mindBucketName, mindPolicyDocument, MIND_POLICY, provisionAgentRoles, reconcileAgentTaskRole,
  retireAgentTaskRole, type MindProbe,
} from './iam.js';
import { ECSClient } from '@aws-sdk/client-ecs';
import { MindPrefixRefusedError } from '../mind-prefix.js';

// live: agent id -> its task definition's MEMORY_PREFIX (null: none); used: prefixes holding data.
const probe = (live: Record<string, string | null> = {}, used: string[] = []): MindProbe & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    async liveMindPrefix(id) {
      asked.push(`live:${id}`);
      const p = id in live ? live[id] : id;
      return p === null ? { found: false } : { found: true, prefix: p };
    },
    async prefixHasObjects(_b, prefix) {
      asked.push(`objects:${prefix}`);
      return used.includes(prefix);
    },
  };
};

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
    const r = await provisionAgentRoles('castle', [], { probe: probe() });
    assert.equal(r.executionRoleArn, 'arn:aws:iam::1:role/AgentExecutionRole-castle');
    assert.ok(!calls.some((c) => c === 'DeleteRolePolicyCommand:AgentExecutionRole-castle'), calls.join(','));
  });

  it('redeploy of an existing role with no container secrets still revokes SecretsAccess', async () => {
    const calls = fakeIam(true);
    await provisionAgentRoles('castle', [], { probe: probe() });
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

// GAP-263: every agent task role could reach every agent's mind, and call Bedrock directly.
type Call = { name: string; input: Record<string, any> };
type Pol = { PolicyName: string; PolicyArn: string };
const err = (name: string, msg = name) => Object.assign(new Error(msg), { name });
const page = (pages: any[][], marker?: string) => {
  const at = marker ? Number(marker) : 0;
  const more = at + 1 < pages.length;
  return { items: pages[at], IsTruncated: more, Marker: more ? String(at + 1) : undefined };
};
function recordingIam(o: { roleExists?: boolean; attached?: Pol[][]; roles?: string[][]; fail?: (c: Call) => Error | undefined } = {}) {
  const calls: Call[] = [];
  const inline = new Set(['BedrockConverseAccess', 'MindPersistenceAccess']);
  mock.method(IAMClient.prototype, 'send', async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
    const c = { name: cmd.constructor.name.replace(/Command$/, ''), input: cmd.input };
    calls.push(c);
    const f = o.fail?.(c);
    if (f) throw f;
    switch (c.name) {
      case 'GetRole':
        if (o.roleExists === false) throw err('NoSuchEntityException');
        return { Role: { Arn: `arn:aws:iam::1:role/${c.input.RoleName}` } };
      case 'CreateRole':
        throw err('EntityAlreadyExistsException');
      case 'DeleteRolePolicy':
        if (!inline.delete(c.input.PolicyName)) throw err('NoSuchEntityException');
        return {};
      case 'ListAttachedRolePolicies': {
        const p = page(o.attached ?? [[]], c.input.Marker);
        return { ...p, AttachedPolicies: p.items };
      }
      case 'ListRoles': {
        const p = page(o.roles ?? [[]], c.input.Marker);
        return { ...p, Roles: p.items.map((RoleName: string) => ({ RoleName })) };
      }
    }
    return {};
  });
  return calls;
}
const bedrock = { PolicyName: 'AgentBedrockModelInvocation', PolicyArn: 'arn:aws:iam::1:policy/AgentBedrockModelInvocation' };
const mindPuts = (calls: Call[]) => calls.filter((c) => c.name === 'PutRolePolicy' && c.input.PolicyName === MIND_POLICY);
const mindDeleted = (calls: Call[]) => calls.some((c) => c.name === 'DeleteRolePolicy' && c.input.PolicyName === MIND_POLICY);
const B = 'agent-factory-mind-prod-abcd1234';

describe('agent task roles: own mind prefix only, no direct model access (GAP-263)', () => {
  const env = process.env.FACTORY_MIND_BUCKET;
  beforeEach(() => {
    process.env.FACTORY_MIND_BUCKET = B;
  });
  afterEach(() => {
    mock.restoreAll();
    if (env === undefined) delete process.env.FACTORY_MIND_BUCKET;
    else process.env.FACTORY_MIND_BUCKET = env;
  });

  it('scopes the mind policy to the one bucket and the agent\'s own prefix (default its id), never the bare prefix', async () => {
    const calls = recordingIam();
    await provisionAgentRoles('archie', [], { memoryPrefix: 'archie-state', probe: probe({ archie: 'archie-state' }) });
    await provisionAgentRoles('castle', [], { probe: probe() });
    const [archie, castle] = mindPuts(calls);
    assert.equal(archie.input.RoleName, 'AgentTaskRole-archie');
    const doc = JSON.parse(archie.input.PolicyDocument);
    assert.deepEqual(doc.Statement.map((s: any) => [s.Action, s.Resource, s.Condition]), [
      [['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload'], [`arn:aws:s3:::${B}/archie-state/*`], undefined],
      // The bare prefix would also list `archie-state-backups/` and other prefixes that start with it.
      [['s3:ListBucket'], [`arn:aws:s3:::${B}`], { StringLike: { 's3:prefix': ['archie-state/', 'archie-state/*'] } }],
    ]);
    assert.match(castle.input.PolicyDocument, /abcd1234\/castle\/\*/);
  });

  it('removes the old inline and hand-attached model grants on every page, and grants no model action', async () => {
    const full = { PolicyName: 'AmazonBedrockFullAccess', PolicyArn: 'arn:aws:iam::aws:policy/AmazonBedrockFullAccess' };
    const calls = recordingIam({ attached: [[{ PolicyName: 'Other', PolicyArn: 'arn:aws:iam::1:policy/Other' }], [bedrock, full]] });
    await provisionAgentRoles('donna', [], { memoryPrefix: 'donna-state', probe: probe({ donna: 'donna-state' }) });
    assert.ok(calls.some((c) => c.name === 'DeleteRolePolicy' && c.input.RoleName === 'AgentTaskRole-donna' && c.input.PolicyName === 'BedrockConverseAccess'));
    assert.equal(calls.filter((c) => c.name === 'ListAttachedRolePolicies').length, 2);
    assert.deepEqual(calls.filter((c) => c.name === 'DetachRolePolicy').map((c) => c.input.PolicyArn), [bedrock.PolicyArn, full.PolicyArn]);
    for (const c of calls.filter((x) => x.name === 'PutRolePolicy')) assert.doesNotMatch(c.input.PolicyDocument, /bedrock/i);
    assert.doesNotMatch(readFileSync(fileURLToPath(new URL('./iam.ts', import.meta.url)), 'utf8'), /"bedrock:/);
  });

  it('AccessDenied on a revoke or the mind-policy write fails the deploy instead of leaving a grant', async () => {
    for (const step of ['DetachRolePolicy', 'PutRolePolicy']) {
      mock.restoreAll();
      recordingIam({ attached: [[bedrock]], fail: (c) => (c.name === step ? err('AccessDenied', 'denied') : undefined) });
      await assert.rejects(provisionAgentRoles('donna', [], { memoryPrefix: 'donna-state', probe: probe({ donna: 'donna-state' }) }), /denied/);
    }
  });

  it('a helper role (memory: false) loses its mind policy, gets none, and needs no prefix check', async () => {
    const calls = recordingIam();
    const p = probe();
    await provisionAgentRoles('__helper_x', [], { memory: false, probe: p });
    assert.ok(!mindPuts(calls).length && mindDeleted(calls));
    assert.deepEqual(p.asked, []);
  });

  it('refuses a prefix or bucket that would widen the grant, before writing anything', async () => {
    for (const bad of ['', '*', 'a*', 'a/../b', '/a', 'a/', 'team/archie-state', 'a..b', '.a', 'a b']) assert.throws(() => checkMindPrefix(bad), /invalid mind prefix/, bad);
    assert.equal(checkMindPrefix('x.helper.0a1b2c'), 'x.helper.0a1b2c');
    assert.throws(() => mindPolicyDocument('b', '*'), /invalid mind prefix/);
    const calls = recordingIam();
    await assert.rejects(provisionAgentRoles('archie', [], { memoryPrefix: 'archie/state', probe: probe() }), /invalid mind prefix/);
    delete process.env.FACTORY_MIND_BUCKET;
    assert.throws(() => mindBucketName({ FACTORY_MIND_BUCKET: 'agent-factory-mind-*' }), /FACTORY_MIND_BUCKET/);
    assert.equal(mindBucketName({ FACTORY_MIND_BUCKET: `s3://${B}/` }), B);
    await assert.rejects(provisionAgentRoles('archie', [], { probe: probe() }), /FACTORY_MIND_BUCKET/);
    assert.deepEqual(calls, [], 'nothing is created or written');
  });

  it('refuses a prefix holding data the agent does not own, before creating anything', async () => {
    let calls = recordingIam();
    const p = probe({ mallory: null }, ['donna-state']);
    await assert.rejects(provisionAgentRoles('mallory', [], { memoryPrefix: 'donna-state', probe: p }), MindPrefixRefusedError);
    assert.deepEqual([calls, p.asked], [[], ['live:mallory', 'objects:donna-state']]);
    // Moving an existing agent onto a prefix with data is refused too.
    await assert.rejects(provisionAgentRoles('archie', [], { memoryPrefix: 'donna-state', probe: probe({ archie: 'archie-state' }, ['donna-state']) }), /does not own/);
    // A new agent on an empty prefix, and an agent on the prefix its live task definition uses, are fine.
    mock.restoreAll();
    calls = recordingIam();
    await provisionAgentRoles('newbie', [], { probe: probe({ newbie: null }) });
    await provisionAgentRoles('archie', [], { memoryPrefix: 'archie-state', probe: probe({ archie: 'archie-state' }, ['archie-state']) });
    assert.equal(mindPuts(calls).length, 2);
  });

  it('reconcile narrows only when the task definition uses the same prefix; it still revokes Bedrock, and skips a missing role', async () => {
    let calls = recordingIam({ attached: [[bedrock]] });
    const r = await reconcileAgentTaskRole('higgins', { memoryPrefix: 'higgins-state', probe: probe({ higgins: 'higgins-state' }) });
    assert.deepEqual(r, { role: 'AgentTaskRole-higgins', outcome: 'updated', revoked: ['BedrockConverseAccess', 'AgentBedrockModelInvocation'] });
    assert.match(mindPuts(calls)[0].input.PolicyDocument, /\/higgins-state\/\*/);
    assert.ok(!calls.some((c) => c.name === 'CreateRole'));
    for (const live of ['skippy-old', null]) {
      mock.restoreAll();
      calls = recordingIam({ attached: [[bedrock]] });
      const m = await reconcileAgentTaskRole('skippy', { memoryPrefix: 'skippy', probe: probe({ skippy: live }) });
      assert.equal(m.outcome, 'mismatch');
      assert.match(m.detail!, live ? /agent-skippy uses "skippy-old"/ : /no ACTIVE task definition/);
      assert.ok(!mindPuts(calls).length && !mindDeleted(calls), 'mind grant untouched');
      assert.deepEqual(m.revoked, ['BedrockConverseAccess', 'AgentBedrockModelInvocation']);
    }
    mock.restoreAll();
    recordingIam();
    const p = probe();
    assert.equal((await reconcileAgentTaskRole('a', { memoryPrefix: 'shared', narrow: false, probe: p })).outcome, 'not-narrowed');
    assert.deepEqual(p.asked, []);
    mock.restoreAll();
    calls = recordingIam({ roleExists: false });
    assert.equal((await reconcileAgentTaskRole('echo-agent', { probe: probe() })).outcome, 'no-role');
    assert.deepEqual(calls.map((c) => c.name), ['GetRole']);
  });

  it('lists agent task roles across pages, and retires one with no record without guessing a prefix', async () => {
    let calls = recordingIam({ roles: [['AgentTaskRole-archie', 'factory-prod-control-plane'], ['AgentExecutionRole-ghost', 'AgentTaskRole-ghost']] });
    assert.deepEqual(await listAgentTaskRoleIds(), ['archie', 'ghost']);
    assert.equal(calls.length, 2);
    mock.restoreAll();
    calls = recordingIam({ attached: [[bedrock]] });
    assert.deepEqual((await retireAgentTaskRole('ghost')).revoked, ['BedrockConverseAccess', 'AgentBedrockModelInvocation']);
    assert.ok(mindDeleted(calls) && !calls.some((c) => c.name === 'PutRolePolicy'));
  });

  it('the AWS probe reads MEMORY_PREFIX from the live task definition and tells a missing one from a denied read', async () => {
    const ecs = new ECSClient({ region: 'us-east-1' });
    mock.method(ecs, 'send', async (cmd: { input: { taskDefinition: string } }) => {
      if (cmd.input.taskDefinition === 'agent-gone') throw err('ClientException', 'Unable to describe task definition.');
      if (cmd.input.taskDefinition === 'agent-denied') throw err('AccessDeniedException', 'not authorized');
      return { taskDefinition: { containerDefinitions: [{ environment: [{ name: 'MEMORY_STORE_URI', value: 's3://b' }, { name: 'MEMORY_PREFIX', value: 'donna-state' }] }] } };
    });
    const p = awsMindProbe(ecs);
    assert.deepEqual(await p.liveMindPrefix('donna'), { found: true, prefix: 'donna-state' });
    assert.deepEqual(await p.liveMindPrefix('gone'), { found: false });
    await assert.rejects(p.liveMindPrefix('denied'), /not authorized/);
  });

  it('the landing zone gives the control plane only what this needs', () => {
    const tf = readFileSync(fileURLToPath(new URL('../../../../landing-zones/aws/iam.tf', import.meta.url)), 'utf8');
    const block = (sid: string) => {
      const at = tf.indexOf(`Sid      = "${sid}"`);
      assert.ok(at > 0, sid);
      return tf.slice(at, tf.indexOf('\n      }', tf.indexOf('Resource', at)) + 8);
    };
    const actions = (b: string) => /Action\s*=\s*\[([^\]]+)\]/.exec(b)![1].split(',').map((s) => s.trim().replace(/"/g, '')).filter(Boolean).sort();
    const role = /Resource\s*=\s*"arn:aws:iam::\$\{var.account_id\}:role\/AgentTaskRole-\*"/;
    const revoke = block('RevokeAgentTaskRoleGrants');
    assert.deepEqual(actions(revoke), ['iam:DeleteRolePolicy', 'iam:ListAttachedRolePolicies']);
    assert.match(revoke, role);
    const detach = block('DetachDirectModelPolicies');
    assert.deepEqual(actions(detach), ['iam:DetachRolePolicy']);
    assert.match(detach, role);
    assert.match(detach, /ArnEquals = \{\s*"iam:PolicyARN"/);
    const arns = [...detach.matchAll(/"arn:aws:iam::[^"]+:policy\/([^"]+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual(arns, ['AgentBedrockModelInvocation', 'AmazonBedrockFullAccess', 'AmazonBedrockLimitedAccess']);
    assert.deepEqual(actions(block('ReadAgentIdentities')), ['ecs:DescribeTaskDefinition', 'iam:ListRoles']);
    const list = block('ListMindKeys');
    assert.deepEqual(actions(list), ['s3:ListBucket']);
    assert.match(list, /Resource = aws_s3_bucket\.mind\.arn\n/);
    assert.match(tf, /"s3:prefix" = \["\$\{each.key\}\/", "\$\{each.key\}\/\*"\]/, 'landing-zone agents list only their own prefix');
  });
});
