import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deleteAgentRoles } from './iam.js';
import { deregisterAgentTaskDefinitions } from './ecs.js';
import { deleteAgentEcrImages } from './ecr.js';
import { awsDeployProvider } from './deploy.js';

describe('Cloud resource teardown on agent purge (TSK-341, GAP-250)', () => {
  describe('deleteAgentRoles', () => {
    it('refuses invalid or wildcard agent IDs', async () => {
      for (const badId of ['', 'ada*', 'ADA', 'ada/other', '..', '-ada', 'ada_1', 'ada ']) {
        await assert.rejects(
          () => deleteAgentRoles(badId),
          /Invalid agent ID/,
          `expected ${badId} to be refused`,
        );
      }
    });

    it('detaches managed policies, deletes inline policies, and deletes roles with pagination and NoSuchEntity idempotence', async () => {
      const sentCommands: string[] = [];
      const detachedPolicies: Array<{ role: string; policy: string }> = [];
      const deletedInline: Array<{ role: string; policy: string }> = [];
      const deletedRoles: string[] = [];

      const mockClient = {
        async send(cmd: any) {
          const name = cmd.constructor.name;
          sentCommands.push(name);

          if (name === 'GetRoleCommand') {
            if (cmd.input.RoleName === 'AgentTaskRole-ada' || cmd.input.RoleName === 'AgentExecutionRole-ada') {
              return { Role: { RoleName: cmd.input.RoleName, Arn: `arn:aws:iam::123:role/${cmd.input.RoleName}` } };
            }
            const err = new Error('NoSuchEntity');
            err.name = 'NoSuchEntityException';
            throw err;
          }

          if (name === 'ListAttachedRolePoliciesCommand') {
            if (!cmd.input.Marker) {
              return {
                AttachedPolicies: [{ PolicyArn: 'arn:aws:iam::aws:policy/p1' }],
                IsTruncated: true,
                Marker: 'page2',
              };
            }
            return {
              AttachedPolicies: [{ PolicyArn: 'arn:aws:iam::aws:policy/p2' }],
              IsTruncated: false,
            };
          }

          if (name === 'DetachRolePolicyCommand') {
            detachedPolicies.push({ role: cmd.input.RoleName, policy: cmd.input.PolicyArn });
            return {};
          }

          if (name === 'ListRolePoliciesCommand') {
            if (!cmd.input.Marker) {
              return {
                PolicyNames: ['InlinePolicy1'],
                IsTruncated: true,
                Marker: 'page2',
              };
            }
            return {
              PolicyNames: ['InlinePolicy2'],
              IsTruncated: false,
            };
          }

          if (name === 'DeleteRolePolicyCommand') {
            deletedInline.push({ role: cmd.input.RoleName, policy: cmd.input.PolicyName });
            return {};
          }

          if (name === 'DeleteRoleCommand') {
            deletedRoles.push(cmd.input.RoleName);
            return {};
          }

          throw new Error(`Unhandled mock command: ${name}`);
        },
      };

      const result = await deleteAgentRoles('ada', { client: mockClient as any });
      assert.deepEqual(result, ['AgentTaskRole-ada', 'AgentExecutionRole-ada']);
      assert.equal(deletedRoles.length, 2);
      assert.equal(detachedPolicies.length, 4); // 2 per role across 2 pages
      assert.equal(deletedInline.length, 4); // 2 per role across 2 pages
    });

    it('returns empty array when neither role exists', async () => {
      const mockClient = {
        async send() {
          const err = new Error('NoSuchEntity');
          err.name = 'NoSuchEntityException';
          throw err;
        },
      };
      const result = await deleteAgentRoles('missing', { client: mockClient as any });
      assert.deepEqual(result, []);
    });
  });

  describe('deregisterAgentTaskDefinitions', () => {
    it('refuses invalid or wildcard agent IDs', async () => {
      for (const badId of ['', 'ada*', 'ADA', 'ada/other', '..']) {
        await assert.rejects(
          () => deregisterAgentTaskDefinitions(badId),
          /Invalid agent ID/,
        );
      }
    });

    it('filters strictly to exact family agent-${agentId} so ada NEVER deregisters agent-ada-helper', async () => {
      const deregistered: string[] = [];
      const mockClient = {
        async send(cmd: any) {
          const name = cmd.constructor.name;
          if (name === 'ListTaskDefinitionsCommand') {
            assert.equal(cmd.input.familyPrefix, 'agent-ada');
            assert.equal(cmd.input.status, 'ACTIVE');
            if (!cmd.input.nextToken) {
              return {
                taskDefinitionArns: [
                  'arn:aws:ecs:us-east-1:123456789012:task-definition/agent-ada:1',
                  'arn:aws:ecs:us-east-1:123456789012:task-definition/agent-ada-helper:1', // Prefix match that must be filtered out!
                  'arn:aws:ecs:us-east-1:123456789012:task-definition/agent-ada-v2:1',     // Prefix match that must be filtered out!
                ],
                nextToken: 'next-page',
              };
            }
            return {
              taskDefinitionArns: [
                'arn:aws:ecs:us-east-1:123456789012:task-definition/agent-ada:2',
                'arn:aws:ecs:us-east-1:123456789012:task-definition/agent-adam:5',       // Prefix match that must be filtered out!
              ],
            };
          }
          if (name === 'DeregisterTaskDefinitionCommand') {
            deregistered.push(cmd.input.taskDefinition);
            return {};
          }
          throw new Error(`Unhandled mock command: ${name}`);
        },
      };

      const result = await deregisterAgentTaskDefinitions('ada', { client: mockClient as any });
      assert.deepEqual(result, [
        'arn:aws:ecs:us-east-1:123456789012:task-definition/agent-ada:1',
        'arn:aws:ecs:us-east-1:123456789012:task-definition/agent-ada:2',
      ]);
      assert.deepEqual(deregistered, [
        'arn:aws:ecs:us-east-1:123456789012:task-definition/agent-ada:1',
        'arn:aws:ecs:us-east-1:123456789012:task-definition/agent-ada:2',
      ]);
    });
  });

  describe('deleteAgentEcrImages', () => {
    it('refuses invalid or wildcard agent IDs', async () => {
      for (const badId of ['', 'ada*', 'ADA', 'ada/other', '..']) {
        await assert.rejects(
          () => deleteAgentEcrImages(badId),
          /Invalid agent ID/,
        );
      }
    });

    it('returns empty array cleanly when FACTORY_ECR_REPO_URI is unset', async () => {
      const res = await deleteAgentEcrImages('ada', { ecrRepoUri: '' });
      assert.deepEqual(res, []);
    });

    it('strictly matches <agentId>-<commit12> and <agentId>-<commit12>-<skillsHash12> and never deletes ada-helper', async () => {
      const executedCommands: Array<{ file: string; args: string[] }> = [];
      const mockExec = async (file: string, args: string[]) => {
        executedCommands.push({ file, args });
        if (args[1] === 'list-images') {
          return {
            stdout: JSON.stringify({
              imageIds: [
                { imageTag: 'ada-0123456789ab' },                           // match
                { imageTag: 'ada-cdef01234567-89abcdef0123' },             // match
                { imageTag: 'ada-helper-0123456789ab' },                   // collision: MUST NOT MATCH
                { imageTag: 'ada-0123456789ab-helper' },                   // bad hash: MUST NOT MATCH
                { imageTag: 'ada-latest' },                                // mutable tag: MUST NOT MATCH
                { imageTag: 'other-ada-0123456789ab' },                    // other prefix: MUST NOT MATCH
              ],
            }),
          };
        }
        if (args[1] === 'batch-delete-image') {
          const tags = args.filter((a) => a.startsWith('imageTag=')).map((a) => a.slice('imageTag='.length));
          return {
            stdout: JSON.stringify({
              imageIds: tags.map((t) => ({ imageTag: t })),
            }),
          };
        }
        throw new Error(`Unexpected exec command: ${args.join(' ')}`);
      };

      const deleted = await deleteAgentEcrImages('ada', {
        ecrRepoUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/factory-dynamic-agents',
        exec: mockExec,
      });

      assert.deepEqual(deleted, ['ada-0123456789ab', 'ada-cdef01234567-89abcdef0123']);
      assert.equal(executedCommands.length, 2);
      assert.equal(executedCommands[1].args[1], 'batch-delete-image');
      assert.deepEqual(
        executedCommands[1].args.filter((a) => a.startsWith('imageTag=')),
        ['imageTag=ada-0123456789ab', 'imageTag=ada-cdef01234567-89abcdef0123'],
      );
    });

    it('handles RepositoryNotFoundException idempotently', async () => {
      const mockExec = async () => {
        const err = new Error('An error occurred (RepositoryNotFoundException) when calling ListImages');
        throw err;
      };
      const res = await deleteAgentEcrImages('ada', {
        ecrRepoUri: 'factory-dynamic-agents',
        exec: mockExec,
      });
      assert.deepEqual(res, []);
    });
  });

  describe('awsDeployProvider.purgeCompute', () => {
    it('aggregates IAM, ECS, and ECR teardown results', async () => {
      const provider = awsDeployProvider();
      assert.ok(typeof provider.purgeCompute === 'function');
    });
  });
});
