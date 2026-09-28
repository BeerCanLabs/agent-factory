import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FULL_SHA } from './runtime.js';

const execFileAsync = promisify(execFile);

/** Resolves a repository's default-branch HEAD to a full commit SHA, once, at registration (L3 pinning). */
export type CommitResolver = (repo: string) => Promise<string>;

/**
 * Only plain https git URLs without embedded credentials: the URL is stored on the agent record and shown in
 * the console, so a token in it would leak (S1), and a leading '-' could be read by git as an option.
 */
export function checkRepoUrl(repo: unknown): string | undefined {
  if (typeof repo !== 'string' || !/^https:\/\/[^\s@/]+\/[^\s@]+$/.test(repo)) return undefined;
  return repo;
}

export const gitLsRemoteResolver: CommitResolver = async (repo) => {
  const { stdout } = await execFileAsync('git', ['ls-remote', '--', repo, 'HEAD'], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_TERMINAL_PROMPT: '0' },
  });
  const sha = stdout.split(/\s+/)[0];
  if (!sha || !FULL_SHA.test(sha)) throw new Error(`git ls-remote returned no HEAD for ${repo}`);
  return sha;
};
