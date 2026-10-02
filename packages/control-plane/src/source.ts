import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/**
 * Reads a skill's source for registration (DESIGN_AUTHORITY.md §6.14 SK1): resolves a branch or tag to the full commit it
 * points at now, and reads one file at a pinned commit. The caller pins the result; nothing here is cached or run.
 */
export interface SkillSource {
  /** The full SHA a branch or tag points at, or undefined when the repository has no such branch or tag. */
  resolveRef(repo: string, ref: string): Promise<string | undefined>;
  /** A file's text at `commit`, or undefined when the commit has no such file. Throws `SourceError` when it cannot read. */
  readFile(repo: string, commit: string, file: string): Promise<string | undefined>;
}

/** Why a source could not be read: the repository is unreachable to the factory, or it has no such commit. */
export class SourceError extends Error {
  constructor(
    readonly kind: 'unreachable' | 'no_commit' | 'ambiguous' | 'too_large',
    message: string,
  ) {
    super(message);
    this.name = 'SourceError';
  }
}

/** A branch or tag name as a caller may type it: no options, no `..`, no control characters, no ref-log syntax. */
export function checkRefName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const ref = raw.trim().replace(/^refs\/(heads|tags)\//, '');
  if (!ref || ref.length > 200 || ref.startsWith('-') || ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.')) return undefined;
  if (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.includes('..') || ref.includes('//') || ref.endsWith('.lock') || ref.includes('@{')) return undefined;
  return ref;
}

const MAX_SOURCE_FILE_BYTES = 256 * 1024;

export type GitSkillSourceOptions = {
  /** The factory's read-only source token (FACTORY_AGENT_SOURCE_TOKEN). Read on each call; absent: anonymous. */
  token?: () => string | undefined;
  /**
   * Hosts the token is sent to (FACTORY_AGENT_SOURCE_TOKEN_HOSTS, comma-separated; default `github.com`). A registration
   * names any https repository, so the token goes only to the hosts it was issued for, never to the one a caller typed.
   */
  tokenHosts?: string[];
};

/**
 * The git configuration (by environment) that sends the source token to `repo`: only over https, only to a host the
 * token is for, and scoped to that origin. Anything else gets nothing, and git reads the repository anonymously.
 */
export function gitTokenEnv(repo: string, token: string | undefined, hosts: string[]): Record<string, string> {
  if (!token) return {};
  let url: URL;
  try {
    url = new URL(repo);
  } catch {
    return {};
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.includes(url.hostname.toLowerCase())) return {};
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${url.origin}/.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')}`,
  };
}

/**
 * `git` with only the factory's own configuration: no system or user config, no credential helper, no prompt. The token,
 * when the repository's host may receive it, is an `http.<origin>/.extraHeader` passed by environment (never on argv).
 */
export function gitSkillSource(opts: GitSkillSourceOptions = {}): SkillSource {
  const token = opts.token ?? (() => process.env.FACTORY_AGENT_SOURCE_TOKEN || undefined);
  const hosts = (opts.tokenHosts ?? (process.env.FACTORY_AGENT_SOURCE_TOKEN_HOSTS ?? 'github.com').split(','))
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  const run = async (args: string[], repo: string, home: string, maxBuffer = 4 * 1024 * 1024) => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
    };
    Object.assign(env, gitTokenEnv(repo, token(), hosts));
    return execFileAsync('git', args, { encoding: 'utf8', timeout: 30_000, maxBuffer, env });
  };

  const withTemp = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
    const dir = await mkdtemp(join(tmpdir(), 'factory-skill-source-'));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  const reachable = (repo: string, home: string) =>
    run(['ls-remote', '--', repo, 'HEAD'], repo, home).then(
      () => true,
      () => false,
    );

  return {
    async resolveRef(repo, ref) {
      const name = checkRefName(ref);
      if (!name) return undefined;
      return withTemp(async (home) => {
        let stdout: string;
        try {
          ({ stdout } = await run(['ls-remote', '--', repo, `refs/heads/${name}`, `refs/tags/${name}`, `refs/tags/${name}^{}`], repo, home));
        } catch {
          throw new SourceError('unreachable', `cannot read ${repo}`);
        }
        const refs = new Map<string, string>();
        for (const line of stdout.split('\n')) {
          const [sha, r] = line.trim().split(/\s+/);
          if (sha && r && FULL_SHA.test(sha)) refs.set(r, sha);
        }
        const branch = refs.get(`refs/heads/${name}`);
        // An annotated tag points at a tag object; its peeled entry (`^{}`) is the commit.
        const tag = refs.get(`refs/tags/${name}^{}`) ?? refs.get(`refs/tags/${name}`);
        if (branch && tag && branch !== tag) {
          throw new SourceError('ambiguous', `"${name}" is both a branch and a tag at different commits; give the full commit SHA`);
        }
        return branch ?? tag;
      });
    },

    async readFile(repo, commit, file) {
      if (!FULL_SHA.test(commit)) throw new SourceError('no_commit', 'a file is read only at a full commit SHA');
      return withTemp(async (home) => {
        const git = join(home, 'repo.git');
        await run(['init', '-q', '--bare', git], repo, home);
        try {
          await run(['--git-dir', git, 'fetch', '-q', '--depth=1', '--no-tags', '--', repo, commit], repo, home);
        } catch {
          if (await reachable(repo, home)) throw new SourceError('no_commit', `${repo} has no commit ${commit} (is it pushed?)`);
          throw new SourceError('unreachable', `cannot read ${repo}`);
        }
        const object = `${commit}:${file}`;
        try {
          const { stdout: type } = await run(['--git-dir', git, 'cat-file', '-t', object], repo, home);
          if (type.trim() !== 'blob') return undefined;
        } catch {
          return undefined;
        }
        const { stdout: size } = await run(['--git-dir', git, 'cat-file', '-s', object], repo, home);
        if (Number(size.trim()) > MAX_SOURCE_FILE_BYTES) throw new SourceError('too_large', `${file} is larger than ${MAX_SOURCE_FILE_BYTES} bytes`);
        const { stdout } = await run(['--git-dir', git, 'cat-file', 'blob', object], repo, home, MAX_SOURCE_FILE_BYTES * 2);
        return stdout;
      });
    },
  };
}
