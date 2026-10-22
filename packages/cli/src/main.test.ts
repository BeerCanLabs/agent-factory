import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url));

/** Runs the real entry point with its own HOME, as the installer does. */
async function factory(home: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', MAIN, ...args], { env: { PATH: process.env.PATH ?? '', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), ...env }, encoding: 'utf8' }, (error, out, err) => {
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
