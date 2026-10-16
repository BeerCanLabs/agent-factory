import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSemVer, isNewerVersion, extractGitHubRepo, checkAgentUpdate } from './updates.js';

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
});
