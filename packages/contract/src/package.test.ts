import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import zlib from 'node:zlib';
import {
  packSkillDirectory,
  validateSkillPackage,
} from './package.js';

function createSkillDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'skill-pkg-test-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });

  writeFileSync(
    join(dir, 'skill.yaml'),
    `spec: 1
id: test-skill
version: 1.0.0
name: Test Skill
description: A test skill for package validation
language: python
entry: skill.py
requires:
  routes: []
actions: []
`
  );

  writeFileSync(
    join(dir, 'skill.py'),
    `def tools():
    return [{"name": "echo", "description": "echoes", "parameters": {}, "handler": lambda args, ctx: "ok"}]
`
  );

  mkdirSync(join(dir, 'tests'));
  writeFileSync(
    join(dir, 'tests', 'test_skill.py'),
    `import unittest
class TestSkill(unittest.TestCase):
    def test_echo(self):
        self.assertTrue(True)
`
  );

  return { dir, cleanup };
}

describe('skill package validation & packing (A1, A19)', () => {
  it('packs a conforming skill directory and validates it successfully', async () => {
    const { dir, cleanup } = createSkillDir();
    try {
      const buffer = await packSkillDirectory(dir);
      assert.ok(Buffer.isBuffer(buffer));
      assert.ok(buffer.length > 0);

      const result = validateSkillPackage(buffer);
      assert.ok(result.ok, result.ok ? '' : result.issues.join(', '));
      if (result.ok) {
        assert.equal(result.manifest.id, 'test-skill');
        assert.equal(result.manifest.version, '1.0.0');
        assert.equal(result.manifest.spec, 1);
        assert.equal(result.manifest.language, 'python');
        assert.equal(result.manifest.visibility, undefined);
        assert.equal(result.manifest.owner, undefined);
        assert.ok(typeof result.sha256 === 'string' && result.sha256.length === 64);
        assert.ok(result.files.length >= 3);
      }
    } finally {
      cleanup();
    }
  });

  it('refuses a package missing skill.yaml at root', () => {
    // Tar containing only a dummy python file
    const block = Buffer.alloc(512, 0);
    block.write('skill.py', 0, 100, 'utf8');
    block.write('0000644\0', 100, 8, 'ascii');
    block.write('0000000\0', 124, 12, 'ascii');
    block[156] = 48; // '0'
    block.write('ustar\0', 257, 6, 'ascii');

    // Checksum
    let sum = 0;
    block.fill(32, 148, 156);
    for (let i = 0; i < 512; i++) sum += block[i];
    block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');

    const tar = Buffer.concat([block, Buffer.alloc(1024, 0)]);
    const gz = zlib.gzipSync(tar);

    const result = validateSkillPackage(gz);
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.ok(result.issues.some((i) => i.includes('missing skill.yaml at package root')));
    }
  });

  it('refuses compiled binaries (.pyc, .so, etc.) and forbidden names (.git, __pycache__)', async () => {
    const { dir, cleanup } = createSkillDir();
    try {
      // Add forbidden compiled binary
      writeFileSync(join(dir, 'extra.pyc'), 'binary bytecode');
      const buffer = await packSkillDirectory(dir);

      // We explicitly bypass packSkillDirectory skip list by creating a tar directly
      const rawTar = zlib.gunzipSync(buffer);
      // Create a tar header for extra.pyc
      const badBlock = Buffer.alloc(512, 0);
      badBlock.write('extra.pyc', 0, 100, 'utf8');
      badBlock.write('0000644\0', 100, 8, 'ascii');
      badBlock.write('00000000020\0', 124, 12, 'ascii');
      badBlock[156] = 48; // '0'
      badBlock.write('ustar\0', 257, 6, 'ascii');
      let sum = 0;
      badBlock.fill(32, 148, 156);
      for (let i = 0; i < 512; i++) sum += badBlock[i];
      badBlock.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');

      const content = Buffer.alloc(512, 0);
      content.write('bytecode data', 0, 'utf8');

      const corruptedTar = Buffer.concat([rawTar.subarray(0, rawTar.length - 1024), badBlock, content, Buffer.alloc(1024, 0)]);
      const corruptedGz = zlib.gzipSync(corruptedTar);

      const result = validateSkillPackage(corruptedGz);
      assert.ok(!result.ok);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('compiled binary "extra.pyc" is refused')));
      }
    } finally {
      cleanup();
    }
  });

  it('refuses path traversal (..), absolute paths, and backslashes (A19)', () => {
    function makeTarWithEntry(path: string): Buffer {
      const block = Buffer.alloc(512, 0);
      block.write(path, 0, 100, 'utf8');
      block.write('0000644\0', 100, 8, 'ascii');
      block.write('0000000\0', 124, 12, 'ascii');
      block[156] = 48; // '0'
      block.write('ustar\0', 257, 6, 'ascii');
      let sum = 0;
      block.fill(32, 148, 156);
      for (let i = 0; i < 512; i++) sum += block[i];
      block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
      return zlib.gzipSync(Buffer.concat([block, Buffer.alloc(1024, 0)]));
    }

    const dotdot = validateSkillPackage(makeTarWithEntry('../escape.py'));
    assert.ok(!dotdot.ok);
    if (!dotdot.ok) assert.ok(dotdot.issues.some((i) => i.includes('relative traversal')));

    const abs = validateSkillPackage(makeTarWithEntry('/etc/passwd'));
    assert.ok(!abs.ok);
    if (!abs.ok) assert.ok(abs.issues.some((i) => i.includes('absolute path')));

    const bslash = validateSkillPackage(makeTarWithEntry('foo\\bar.py'));
    assert.ok(!bslash.ok);
    if (!bslash.ok) assert.ok(bslash.issues.some((i) => i.includes('backslash')));
  });

  it('refuses pax and GNU long-name headers (A19)', () => {
    function makeTarWithType(typeflag: string): Buffer {
      const block = Buffer.alloc(512, 0);
      block.write('some-entry', 0, 100, 'utf8');
      block.write('0000644\0', 100, 8, 'ascii');
      block.write('0000000\0', 124, 12, 'ascii');
      block[156] = typeflag.charCodeAt(0);
      block.write('ustar\0', 257, 6, 'ascii');
      let sum = 0;
      block.fill(32, 148, 156);
      for (let i = 0; i < 512; i++) sum += block[i];
      block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
      return zlib.gzipSync(Buffer.concat([block, Buffer.alloc(1024, 0)]));
    }

    const pax = validateSkillPackage(makeTarWithType('x'));
    assert.ok(!pax.ok);
    if (!pax.ok) assert.ok(pax.issues.some((i) => i.includes('pax extended headers are refused')));

    const gnu = validateSkillPackage(makeTarWithType('L'));
    assert.ok(!gnu.ok);
    if (!gnu.ok) assert.ok(gnu.issues.some((i) => i.includes('GNU long-name headers are refused')));
  });

  it('refuses duplicate and case-colliding filenames (A19)', () => {
    function makeTarWithEntries(p1: string, p2: string): Buffer {
      const b1 = Buffer.alloc(512, 0);
      b1.write(p1, 0, 100, 'utf8');
      b1.write('0000644\0', 100, 8, 'ascii');
      b1.write('0000000\0', 124, 12, 'ascii');
      b1[156] = 48;
      b1.write('ustar\0', 257, 6, 'ascii');
      let s1 = 0;
      b1.fill(32, 148, 156);
      for (let i = 0; i < 512; i++) s1 += b1[i];
      b1.write(s1.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');

      const b2 = Buffer.alloc(512, 0);
      b2.write(p2, 0, 100, 'utf8');
      b2.write('0000644\0', 100, 8, 'ascii');
      b2.write('0000000\0', 124, 12, 'ascii');
      b2[156] = 48;
      b2.write('ustar\0', 257, 6, 'ascii');
      let s2 = 0;
      b2.fill(32, 148, 156);
      for (let i = 0; i < 512; i++) s2 += b2[i];
      b2.write(s2.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');

      return zlib.gzipSync(Buffer.concat([b1, b2, Buffer.alloc(1024, 0)]));
    }

    const dup = validateSkillPackage(makeTarWithEntries('file.py', 'file.py'));
    assert.ok(!dup.ok);
    if (!dup.ok) assert.ok(dup.issues.some((i) => i.includes('duplicate entry')));

    const caseColl = validateSkillPackage(makeTarWithEntries('File.py', 'file.py'));
    assert.ok(!caseColl.ok);
    if (!caseColl.ok) assert.ok(caseColl.issues.some((i) => i.includes('case-colliding entry')));
  });
});
