import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url));

/** Runs the real entry point with its own HOME, as the installer does. */
async function factory(home: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', MAIN, ...args], { env: { PATH: process.env.PATH ?? '', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), FACTORY_CLI_STORE: 'file', ...env }, encoding: 'utf8' }, (error, out, err) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, out, err });
    });
  });
}

describe('§6.17 CL10 factory config, which the ops repository\'s installer uses', () => {
  it('CL10 sets and shows the address, sign-in method, theme and manager', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cli-main-'));
    assert.match((await factory(home, ['config', 'get'])).out, /address  \(not set\)/);
    for (const [k, v] of [['address', 'agent-factory.example.com'], ['auth', 'cloudflare-access'], ['theme', 'light'], ['manager', 'chief']]) {
      const r = await factory(home, ['config', 'set', k, v]);
      assert.equal(r.code, 0, `${k}: ${r.err}`);
    }
    const got = (await factory(home, ['config', 'get'])).out;
    assert.match(got, /address  https:\/\/agent-factory\.example\.com\n/);
    assert.match(got, /auth     cloudflare-access/);
    assert.match(got, /theme    light/);
    assert.match(got, /manager  chief/);
    assert.deepEqual(JSON.parse(await readFile(join(home, '.config', 'factory-cli', 'config.json'), 'utf8')), { instance: 'https://agent-factory.example.com', auth: 'cloudflare-access', theme: 'light', manager: 'chief' });
  });

  it('CL10 refuses values that are not usable and changes nothing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cli-main-'));
    for (const args of [['address', 'http://remote.example.com'], ['address', 'https://u:p@x.example.com'], ['auth', 'saml'], ['theme', 'neon'], ['manager', '../x'], ['colour', 'red']]) {
      const r = await factory(home, ['config', 'set', ...args]);
      assert.equal(r.code, 1, args.join(' '));
      assert.ok(r.err.length > 0);
    }
    assert.match((await factory(home, ['config', 'get'])).out, /address  \(not set\)/);
  });

  it('CL10 moving to a different address signs out of the old one and forgets how it signed in', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cli-main-'));
    await factory(home, ['config', 'set', 'address', 'old.example.com']);
    await factory(home, ['config', 'set', 'auth', 'cloudflare-access']);
    const creds = join(home, '.config', 'factory-cli', 'credentials.json');
    await mkdir(join(home, '.config', 'factory-cli'), { recursive: true });
    await writeFile(creds, JSON.stringify({ 'https://old.example.com': 'saved-token', 'https://keep.example.com': 'other' }));
    const cf = join(home, '.cloudflared');
    await mkdir(cf);
    await writeFile(join(cf, 'old.example.com-abc123-token'), 'x');

    await factory(home, ['config', 'set', 'address', 'new.example.com']);
    assert.deepEqual(JSON.parse(await readFile(creds, 'utf8')), { 'https://keep.example.com': 'other' }, 'only the old address\'s sign-in goes');
    assert.match((await factory(home, ['config', 'get'])).out, /auth     auto/);
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(cf), [], 'cloudflared\'s copy goes too');

    // Setting the same address again changes nothing.
    await factory(home, ['config', 'set', 'auth', 'oidc']);
    await factory(home, ['config', 'set', 'address', 'new.example.com']);
    assert.match((await factory(home, ['config', 'get'])).out, /auth     oidc/);
  });

  it('CL10 --version and an unknown command', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cli-main-'));
    assert.match((await factory(home, ['--version'])).out, /^\d+\.\d+\.\d+\n$/);
    const bad = await factory(home, ['frobnicate']);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /unknown command "frobnicate"/);
  });
});


/** A factory that answers the few routes the commands use, and remembers what it was asked. */
async function fakeServer(roles: string[]) {
  const seen: Array<{ method: string; path: string; token?: string; body: string }> = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ method: req.method ?? '', path: req.url ?? '', token: req.headers['cf-access-token'] as string | undefined, body });
    const json = (status: number, v: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v));
    if (req.headers['cf-access-token'] !== 'assertion-1') return json(401, {});
    if (req.url === '/api/v1/whoami') return json(200, { actor: 'access:dale@example.com', roles });
    if (req.url === '/api/v1/agents') return json(200, [{ id: 'donna', state: 'SLEEPING' }, { id: 'rosie', state: 'WORKING' }]);
    if (req.url === '/api/v1/spend') return json(200, { totalUsd: 12.5, apiKey: 'sk-live-1' });
    if (req.url === '/api/v1/registry/agents/donna/budget' && req.method === 'PUT') return json(200, { ok: true });
    if (req.url === '/api/v1/approvals/12' && req.method === 'POST') return json(200, { ok: true });
    if (req.url === '/api/v1/skills') return json(200, Array.from({ length: 3000 }, (_, i) => ({ id: `skill-${i}`, description: 'x'.repeat(150) })));
    json(404, { error: 'not_found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('§6.17 CL11 commands as subcommands, for scripts', () => {
  const env = (url: string) => ({ FACTORY_URL: url, FACTORY_CLI_ACCESS_TOKEN: 'assertion-1' });

  it('CL11 a read prints a table, or the raw answer with --json, and exits 0', async () => {
    const srv = await fakeServer(['viewer']);
    try {
      const home = await mkdtemp(join(tmpdir(), 'cli-cmd-'));
      const table = await factory(home, ['agents'], env(srv.url));
      assert.equal(table.code, 0, table.err);
      assert.match(table.out, /ID\s+STATE\ndonna\s+SLEEPING\nrosie\s+WORKING/);
      const json = await factory(home, ['spend', '--json'], env(srv.url));
      assert.deepEqual(JSON.parse(json.out), { totalUsd: 12.5, apiKey: '[hidden]' });
      assert.ok(srv.seen.filter((s) => s.path === '/api/v1/agents').every((s) => s.token === 'assertion-1'));
    } finally {
      await srv.close();
    }
  });

  it('CL4 a change from a script is refused without --yes and sends nothing; with --yes it runs', async () => {
    const srv = await fakeServer(['admin']);
    try {
      const home = await mkdtemp(join(tmpdir(), 'cli-cmd-'));
      const refused = await factory(home, ['budget', 'donna', '5', 'daily'], env(srv.url));
      assert.equal(refused.code, 1);
      assert.match(refused.err, /add --yes to run it from a script/);
      assert.ok(!srv.seen.some((s) => s.method === 'PUT'));
      const done = await factory(home, ['budget', 'donna', '5', 'daily', '--yes'], env(srv.url));
      assert.equal(done.code, 0, done.err);
      assert.match(done.out, /^Done: set an agent's spend limit/);
      assert.deepEqual(JSON.parse(srv.seen.find((s) => s.method === 'PUT')!.body), { spendLimitUsd: 5, period: 'daily' });
    } finally {
      await srv.close();
    }
  });

  it('CL3 a person without the role is told so and nothing is sent; not being signed in is an error, not a hang', async () => {
    const srv = await fakeServer(['viewer']);
    try {
      const home = await mkdtemp(join(tmpdir(), 'cli-cmd-'));
      const denied = await factory(home, ['budget', 'donna', '5', 'daily', '--yes'], env(srv.url));
      assert.equal(denied.code, 1);
      assert.match(denied.err, /Your roles do not allow \/budget/);
      assert.ok(!srv.seen.some((s) => s.method === 'PUT'));
      const anon = await factory(home, ['agents'], { FACTORY_URL: srv.url });
      assert.equal(anon.code, 1);
      assert.match(anon.err, /not signed in/);
      const usage = await factory(home, ['budget', 'donna'], env(srv.url));
      assert.equal(usage.code, 1);
      assert.match(usage.err, /usage: \/budget/);
    } finally {
      await srv.close();
    }
  });

  it('CL11 --help lists the commands', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cli-cmd-'));
    const help = await factory(home, ['--help']);
    assert.match(help.out, /factory spend --json/);
    assert.match(help.out, /\/budget <agent> <amount> daily\|monthly/);
  });

  it('CL4 an argument that contains quotes and --yes is one argument: it cannot answer the question for the person', async () => {
    const srv = await fakeServer(['admin']);
    try {
      const home = await mkdtemp(join(tmpdir(), 'cli-cmd-'));
      for (const note of ['x" --yes "y', 'ok --yes', 'a"b c']) {
        const r = await factory(home, ['approve', '12', note], env(srv.url));
        assert.equal(r.code, 1, `${note}: ${r.out}${r.err}`);
        assert.match(r.err, /add --yes to run it from a script/, note);
      }
      assert.ok(!srv.seen.some((s) => s.method === 'POST'), 'nothing was approved');
      // The person's own --yes still works, and notes arrive whole.
      const ok = await factory(home, ['approve', '12', 'x" and more', '--yes'], env(srv.url));
      assert.equal(ok.code, 0, ok.err);
      assert.deepEqual(JSON.parse(srv.seen.find((s) => s.method === 'POST')!.body), { decision: 'approve', notes: 'x" and more' });
    } finally {
      await srv.close();
    }
  });

  it('CL11 a large --json answer through a real, slow shell pipe arrives whole and valid, and the CLI exits 0', async () => {
    const srv = await fakeServer(['viewer']);
    try {
      const home = await mkdtemp(join(tmpdir(), 'cli-cmd-'));
      // A shell pipe, as `factory skills --json | jq` is: the reader is slow, and the pipe holds only 64 KiB.
      const script = `set -o pipefail; "${process.execPath}" --import tsx "${MAIN}" skills --json | (sleep 1; cat)`;
      const child = spawn('bash', ['-c', script], { env: { PATH: process.env.PATH ?? '', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), ...env(srv.url) }, stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      child.stdout.on('data', (c: Buffer) => chunks.push(c));
      const code = await new Promise<number>((r) => child.on('close', (c) => r(c ?? 1)));
      const text = Buffer.concat(chunks).toString('utf8');
      assert.equal(code, 0, 'the CLI\'s own exit status (pipefail)');
      assert.ok(text.length > 200_000, `only ${text.length} bytes arrived`);
      assert.equal((JSON.parse(text) as unknown[]).length, 3000);
    } finally {
      await srv.close();
    }
  });

  it('CL11 a reader that closes early (| head) is not an error and prints no stack trace', async () => {
    const srv = await fakeServer(['viewer']);
    try {
      const home = await mkdtemp(join(tmpdir(), 'cli-cmd-'));
      const errFile = join(home, 'stderr.txt');
      const script = `"${process.execPath}" --import tsx "${MAIN}" skills --json 2>"${errFile}" | head -c 10 >/dev/null; cat "${errFile}"`;
      const child = spawn('bash', ['-c', script], { env: { PATH: process.env.PATH ?? '', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), ...env(srv.url) }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (c: Buffer) => (out += c));
      await new Promise<number>((r) => child.on('close', (c) => r(c ?? 1)));
      assert.doesNotMatch(out, /EPIPE|\n\s+at |Error/, `the CLI crashed when its reader went away: ${out.slice(0, 300)}`);
    } finally {
      await srv.close();
    }
  });

  it('factory skill pack and register (A6)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cli-skill-'));
    const fixtureDir = fileURLToPath(new URL('../../../examples/skills/e2e-ping', import.meta.url));
    const outFile = join(home, 'e2e-ping-1.0.0.tar.gz');
    const res = await factory(home, ['skill', 'pack', fixtureDir, '--out', outFile]);
    assert.equal(res.code, 0, res.err);
    assert.match(res.out, /Packed e2e-ping@1\.0\.0/);
    const { existsSync } = await import('node:fs');
    assert.ok(existsSync(outFile));

    const bad = await factory(home, ['skill', 'pack']);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /usage: factory skill pack <dir>/);
  });
});
