import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSemVer,
  isNewerVersion,
  extractGitHubRepo,
  checkAgentUpdate,
  clearCartridgeReleaseMetadata,
  migrateConfigurationReleaseMetadata,
} from './updates.js';
import type { AgentRecord } from '@beercanlabs/factory-registrar';

describe('updates: SemVer parsing & comparison', () => {
  it('parses semver strings with or without leading v', () => {
    assert.deepEqual(parseSemVer('v1.2.3'), { major: 1, minor: 2, patch: 3 });
    assert.deepEqual(parseSemVer('1.2.3'), { major: 1, minor: 2, patch: 3 });
    assert.deepEqual(parseSemVer('v0.1.0'), { major: 0, minor: 1, patch: 0 });
    assert.equal(parseSemVer('invalid'), null);
    assert.equal(parseSemVer(''), null);
  });

  it('correctly compares newer vs current versions', () => {
    assert.equal(isNewerVersion('v1.2.0', '1.0.0'), true);
    assert.equal(isNewerVersion('v1.0.1', '1.0.0'), true);
    assert.equal(isNewerVersion('v2.0.0', '1.9.9'), true);
    assert.equal(isNewerVersion('v1.0.0', '1.0.0'), false);
    assert.equal(isNewerVersion('v1.0.0', '1.0.1'), false);
    assert.equal(isNewerVersion('v0.9.0', '1.0.0'), false);
  });

  it('handles unversioned baseline defaulting to 0.1.0', () => {
    assert.equal(isNewerVersion('v1.0.0', undefined), true);
    assert.equal(isNewerVersion('v0.1.1', undefined), true);
    assert.equal(isNewerVersion('v0.1.0', undefined), false);
  });
});

describe('updates: extractGitHubRepo', () => {
  it('extracts owner and repo from various formats', () => {
    assert.deepEqual(extractGitHubRepo('https://github.com/BeerCanLabs/SM-donna.git'), { owner: 'BeerCanLabs', repo: 'SM-donna' });
    assert.deepEqual(extractGitHubRepo('https://github.com/BeerCanLabs/SM-castle'), { owner: 'BeerCanLabs', repo: 'SM-castle' });
    assert.deepEqual(extractGitHubRepo('git@github.com:BeerCanLabs/SM-finley.git'), { owner: 'BeerCanLabs', repo: 'SM-finley' });
    assert.deepEqual(extractGitHubRepo('BeerCanLabs/SM-template'), { owner: 'BeerCanLabs', repo: 'SM-template' });
    assert.equal(extractGitHubRepo('https://gitlab.com/other/repo'), null);
  });
});

describe('updates: checkAgentUpdate', () => {
  it('detects available update from mock fetch', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: 'v1.2.0',
        target_commitish: 'abcdef1234567890abcdef1234567890abcdef12',
        body: 'Release notes for 1.2.0',
        published_at: '2026-10-16T12:00:00Z',
      }),
    }) as unknown as typeof fetch;

    const res = await checkAgentUpdate(
      { id: 'donna', repo: 'https://github.com/BeerCanLabs/SM-donna.git', installedVersion: '1.0.0' },
      undefined,
      mockFetch
    );

    assert.equal(res.updateAvailable, true);
    assert.equal(res.offeredVersion, '1.2.0');
    assert.equal(res.offeredCommit, 'abcdef1234567890abcdef1234567890abcdef12');
    assert.equal(res.releaseNotes, 'Release notes for 1.2.0');
  });

  it('reports no update when already on latest version', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: 'v1.2.0',
        target_commitish: 'abcdef1234567890abcdef1234567890abcdef12',
        body: 'Release notes for 1.2.0',
        published_at: '2026-10-16T12:00:00Z',
      }),
    }) as unknown as typeof fetch;

    const res = await checkAgentUpdate(
      { id: 'donna', repo: 'https://github.com/BeerCanLabs/SM-donna.git', installedVersion: '1.2.0' },
      undefined,
      mockFetch
    );

    assert.equal(res.updateAvailable, false);
    assert.equal(res.offeredVersion, '1.2.0');
  });

  it('does not fetch or offer releases for a configuration agent with a stale cartridge repo', async () => {
    let calls = 0;
    const mockFetch = async (url: string) => {
      calls += 1;
      throw new Error(`configuration agents must not fetch releases: ${url}`);
    };

    const res = await checkAgentUpdate(
      {
        id: 'finley',
        createdFrom: 'configuration',
        repo: 'https://github.com/BeerCanLabs/SM-finley.git',
        installedVersion: '1.1.0',
      },
      'token-should-not-be-sent',
      mockFetch as unknown as typeof fetch,
    );

    assert.equal(calls, 0);
    assert.equal(res.updateAvailable, false);
    assert.equal(res.offeredVersion, undefined);
    assert.equal(res.offeredCommit, undefined);
    assert.equal(res.releaseNotes, undefined);
    assert.equal(res.publishedAt, undefined);
    assert.equal(JSON.stringify(res).includes('SM-finley'), false);
    assert.equal(JSON.stringify(res).includes('releases/latest'), false);
  });
});

function releaseAgent(overrides: Partial<AgentRecord> & Pick<AgentRecord, 'id'>): AgentRecord {
  return {
    name: overrides.id,
    role: 'Agent',
    state: 'SLEEPING',
    provider: 'cloud',
    artifact: 'image',
    requires: [],
    ungated: [],
    gated: [],
    triggers: [],
    dir: '/tmp',
    ...overrides,
  };
}

describe('updates: configuration release metadata', () => {
  it('clears leftover SM-finley release fields and leaves the runtime pin alone', () => {
    const finley = releaseAgent({
      id: 'finley',
      createdFrom: 'configuration',
      repo: 'https://github.com/BeerCanLabs/agent-factory',
      commit: 'a'.repeat(40),
      deployedRuntime: { repo: 'https://github.com/BeerCanLabs/agent-factory', commit: 'a'.repeat(40), image: 'runtime@sha256:abc' },
      installedVersion: '1.1.0',
      offeredVersion: '1.1.0',
      offeredCommit: 'main',
      updateAvailable: false,
      releaseNotes: 'See BeerCanLabs/SM-finley/compare/v1.0.1...v1.1.0 and SM-finley#16',
      publishedAt: '2026-10-17T02:01:00.000Z',
      lastCheckedAt: '2026-10-20T04:51:00.000Z',
      stagedVersion: '1.1.0',
      stagedCommit: 'main',
      pendingDrain: true,
    });

    assert.deepEqual(clearCartridgeReleaseMetadata(finley), [
      'installedVersion',
      'updateAvailable',
      'offeredVersion',
      'offeredCommit',
      'releaseNotes',
      'publishedAt',
      'lastCheckedAt',
      'stagedVersion',
      'stagedCommit',
      'pendingDrain',
    ]);
    assert.equal(finley.installedVersion, undefined);
    assert.equal(finley.releaseNotes, undefined);
    assert.equal(finley.updateAvailable, undefined);
    assert.equal(finley.repo, 'https://github.com/BeerCanLabs/agent-factory');
    assert.equal(finley.commit, 'a'.repeat(40));
    assert.equal(finley.deployedRuntime?.image, 'runtime@sha256:abc');
    assert.deepEqual(clearCartridgeReleaseMetadata(finley), []);
  });

  it('persists a cleanup only for configuration agents that still carry cartridge release fields', () => {
    const finley = releaseAgent({
      id: 'finley',
      createdFrom: 'configuration',
      repo: 'git@github.com:BeerCanLabs/SM-finley.git',
      installedVersion: '1.1.0',
      releaseNotes: 'SM-finley 1.1.0',
    });
    const donna = releaseAgent({
      id: 'donna',
      repo: 'https://github.com/BeerCanLabs/SM-donna.git',
      installedVersion: '1.0.0',
      offeredVersion: '1.2.0',
      updateAvailable: true,
      releaseNotes: 'SM-donna notes',
    });
    const clean = releaseAgent({ id: 'nova', createdFrom: 'configuration', repo: 'https://github.com/BeerCanLabs/agent-factory' });
    const helper = releaseAgent({
      id: 'finley-helper',
      createdFrom: 'configuration',
      installedVersion: '9.9.9',
      ephemeral: { subagent: 'helper', parentRunId: 'run-1' },
    });
    const saved: string[] = [];

    const cleaned = migrateConfigurationReleaseMetadata([finley, donna, clean, helper], (agent) => saved.push(agent.id));

    assert.deepEqual(cleaned, ['finley']);
    assert.deepEqual(saved, ['finley']);
    assert.equal(finley.installedVersion, undefined);
    assert.equal(finley.releaseNotes, undefined);
    assert.equal(finley.repo, 'git@github.com:BeerCanLabs/SM-finley.git');
    assert.equal(donna.releaseNotes, 'SM-donna notes');
    assert.equal(donna.updateAvailable, true);
    assert.equal(helper.installedVersion, '9.9.9');
    assert.deepEqual(migrateConfigurationReleaseMetadata([finley, donna, clean, helper], () => saved.push('again')), []);
  });
});
