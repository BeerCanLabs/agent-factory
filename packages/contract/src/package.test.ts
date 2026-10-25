import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import zlib from 'node:zlib';
import {
  extractSkillPackage,
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

function makeTarBlock(name: string, size = 0, mode = 0o644, typeflag = '0', prefix = ''): Buffer {
  const block = Buffer.alloc(512, 0);
  block.write(name, 0, 100, 'utf8');
  block.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
  block.write('0000000\0', 108, 8, 'ascii');
  block.write('0000000\0', 116, 8, 'ascii');
  block.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  block.write('00000000000\0', 136, 12, 'ascii');
  block.fill(32, 148, 156); // 8 spaces
  block[156] = typeflag.charCodeAt(0);
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  if (prefix) {
    block.write(prefix, 345, 155, 'utf8');
  }
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += block[i];
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return block;
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

  it('safely extracts a valid package with extractSkillPackage (A19)', async () => {
    const { dir, cleanup } = createSkillDir();
    const targetDir = mkdtempSync(join(tmpdir(), 'skill-extract-'));
    try {
      const buffer = await packSkillDirectory(dir);
      const res = extractSkillPackage(buffer, targetDir);
      assert.ok(res.ok);
      assert.equal(res.manifest.id, 'test-skill');
      assert.ok(readFileSync(join(targetDir, 'skill.yaml'), 'utf8').includes('id: test-skill'));
      assert.ok(readFileSync(join(targetDir, 'skill.py'), 'utf8').includes('def tools():'));
      assert.ok(readFileSync(join(targetDir, 'tests', 'test_skill.py'), 'utf8').includes('class TestSkill'));
    } finally {
      cleanup();
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it('refuses multi-member gzip stream and trailing data (A19)', async () => {
    const { dir, cleanup } = createSkillDir();
    try {
      const buffer = await packSkillDirectory(dir);

      // Trailing garbage
      const trailingGz = Buffer.concat([buffer, Buffer.from('extra trailing bytes')]);
      const trailingRes = validateSkillPackage(trailingGz);
      assert.ok(!trailingRes.ok);
      if (!trailingRes.ok) {
        assert.ok(trailingRes.issues.some((i) => i.includes('no concatenated streams or trailing data')));
      }

      // Multi-member gzip
      const secondMember = zlib.gzipSync(Buffer.from('second gzip member'));
      const multiGz = Buffer.concat([buffer, secondMember]);
      const multiRes = validateSkillPackage(multiGz);
      assert.ok(!multiRes.ok);
      if (!multiRes.ok) {
        assert.ok(multiRes.issues.some((i) => i.includes('no concatenated streams or trailing data')));
      }
    } finally {
      cleanup();
    }
  });

  it('refuses decompression bombs exceeding 20 MiB (A1, A19)', () => {
    // Generate 21 MiB of zeroes compressed with gzip (very small compressed size ~21 KB)
    const zeroes = Buffer.alloc(21 * 1024 * 1024, 0);
    const bombGz = zlib.gzipSync(zeroes);
    assert.ok(bombGz.length < 50000, 'bomb is small compressed');

    const result = validateSkillPackage(bombGz);
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.ok(result.issues.some((i) => i.includes('exceeds 20 MiB limit')));
    }
  });

  it('refuses tar header checksum mismatch (A19)', async () => {
    const { dir, cleanup } = createSkillDir();
    try {
      const buffer = await packSkillDirectory(dir);
      const tar = zlib.gunzipSync(buffer);

      // Tamper with first block's magic without recalculating checksum
      tar[257] = 'x'.charCodeAt(0);
      const tamperedGz = zlib.gzipSync(tar);

      const result = validateSkillPackage(tamperedGz);
      assert.ok(!result.ok);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('tar header checksum verification failed')));
      }
    } finally {
      cleanup();
    }
  });

  it('refuses malformed octal numbers in tar fields (A19)', () => {
    const block = Buffer.alloc(512, 0);
    block.write('skill.yaml', 0, 100, 'utf8');
    block.write('0009999\0', 100, 8, 'ascii'); // invalid octal 9
    block.write('0000000\0', 108, 8, 'ascii');
    block.write('0000000\0', 116, 8, 'ascii');
    block.write('00000000000\0', 124, 12, 'ascii');
    block.write('00000000000\0', 136, 12, 'ascii');
    block.fill(32, 148, 156);
    block[156] = 48;
    block.write('ustar\0', 257, 6, 'ascii');
    block.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += block[i];
    block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');

    const gz = zlib.gzipSync(Buffer.concat([block, Buffer.alloc(1024, 0)]));
    const result = validateSkillPackage(gz);
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.ok(result.issues.some((i) => i.includes('malformed octal')));
    }
  });

  it('refuses setuid, setgid, and sticky bits (A19)', () => {
    const setuidBlock = makeTarBlock('skill.yaml', 0, 0o4755);
    const gz = zlib.gzipSync(Buffer.concat([setuidBlock, Buffer.alloc(1024, 0)]));
    const result = validateSkillPackage(gz);
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.ok(result.issues.some((i) => i.includes('forbidden setuid/setgid/sticky bits')));
    }
  });

  it('refuses non-regular file types like symlinks and hardlinks (A19)', () => {
    const symlinkBlock = makeTarBlock('link.py', 0, 0o777, '2'); // '2' = symlink
    const gz = zlib.gzipSync(Buffer.concat([symlinkBlock, Buffer.alloc(1024, 0)]));
    const result = validateSkillPackage(gz);
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.ok(result.issues.some((i) => i.includes('only regular files and directories are accepted')));
    }
  });

  it('refuses control characters in entry paths (A19)', () => {
    const ctrlBlock = makeTarBlock('test\x07bell.py', 0, 0o644, '0');
    const gz = zlib.gzipSync(Buffer.concat([ctrlBlock, Buffer.alloc(1024, 0)]));
    const result = validateSkillPackage(gz);
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.ok(result.issues.some((i) => i.includes('control character in path')));
    }
  });

  it('packs and validates paths > 100 characters via ustar prefix (A1, A19)', async () => {
    const { dir, cleanup } = createSkillDir();
    try {
      const deepDir = join(dir, 'a'.repeat(50), 'b'.repeat(50));
      mkdirSync(deepDir, { recursive: true });
      writeFileSync(join(deepDir, 'deep_tool.py'), 'def deep(): pass\n');

      const buffer = await packSkillDirectory(dir);
      const result = validateSkillPackage(buffer);
      assert.ok(result.ok, result.ok ? '' : result.issues.join(', '));
      if (result.ok) {
        assert.ok(result.files.some((f) => f.path.includes('deep_tool.py')));
      }
    } finally {
      cleanup();
    }
  });

  it('refuses paths exceeding 255 character limit (A1)', () => {
    const longName = 'a'.repeat(256);
    const longBlock = makeTarBlock(longName.slice(0, 100), 0, 0o644, '0', longName.slice(100));
    const gz = zlib.gzipSync(Buffer.concat([longBlock, Buffer.alloc(1024, 0)]));
    const result = validateSkillPackage(gz);
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.ok(result.issues.some((i) => i.includes('exceeds 255 character limit')));
    }
  });

  it('refuses banned binary extensions (.so, .dylib, .dll, .exe, .bin, .whl, etc.) (A19)', () => {
    for (const ext of ['.so', '.dylib', '.dll', '.exe', '.bin', '.wasm', '.whl', '.class', '.jar']) {
      const block = makeTarBlock(`lib${ext}`, 10, 0o644, '0');
      const content = Buffer.alloc(512, 0);
      const gz = zlib.gzipSync(Buffer.concat([block, content, Buffer.alloc(1024, 0)]));
      const res = validateSkillPackage(gz);
      assert.ok(!res.ok, `expected refusal for ${ext}`);
      if (!res.ok) {
        assert.ok(res.issues.some((i) => i.includes('compiled binary')));
      }
    }
  });

  it('refuses forbidden names .git and __pycache__ (A19)', () => {
    for (const forbidden of ['.git', '__pycache__']) {
      const block = makeTarBlock(`${forbidden}/file.py`, 0, 0o644, '0');
      const gz = zlib.gzipSync(Buffer.concat([block, Buffer.alloc(1024, 0)]));
      const res = validateSkillPackage(gz);
      assert.ok(!res.ok, `expected refusal for ${forbidden}`);
      if (!res.ok) {
        assert.ok(res.issues.some((i) => i.includes('contains .git or __pycache__')));
      }
    }
  });

  it('refuses skill.yaml exceeding 64 KiB (A19)', () => {
    const bigYaml = Buffer.alloc(65 * 1024, 'a');
    const block = makeTarBlock('skill.yaml', bigYaml.length, 0o644, '0');
    const content = Buffer.concat([bigYaml, Buffer.alloc(512 - (bigYaml.length % 512), 0)]);
    const gz = zlib.gzipSync(Buffer.concat([block, content, Buffer.alloc(1024, 0)]));
    const res = validateSkillPackage(gz);
    assert.ok(!res.ok);
    if (!res.ok) {
      assert.ok(res.issues.some((i) => i.includes('exceeds 64 KiB limit')));
    }
  });

  it('refuses package missing tests outside vendor/ (A1, A2)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-pkg-no-tests-'));
    try {
      writeFileSync(
        join(dir, 'skill.yaml'),
        `spec: 1\nid: no-tests\nversion: 1.0.0\nlanguage: python\nentry: skill.py\n`
      );
      writeFileSync(join(dir, 'skill.py'), 'def run(): pass\n');
      mkdirSync(join(dir, 'vendor', 'tests'), { recursive: true });
      writeFileSync(join(dir, 'vendor', 'tests', 'test_vendor.py'), 'def test(): pass\n');

      const gz = await packSkillDirectory(dir);
      const res = validateSkillPackage(gz);
      assert.ok(!res.ok);
      if (!res.ok) {
        assert.ok(res.issues.some((i) => i.includes('must contain tests outside vendor/')));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses spec missing or not 1 in skill.yaml (A1)', async () => {
    const { dir, cleanup } = createSkillDir();
    try {
      writeFileSync(
        join(dir, 'skill.yaml'),
        `spec: 2\nid: test-skill\nversion: 1.0.0\nlanguage: python\nentry: skill.py\n`
      );
      const gz = await packSkillDirectory(dir);
      const res = validateSkillPackage(gz);
      assert.ok(!res.ok);
      if (!res.ok) {
        assert.ok(res.issues.some((i) => i.includes('declare spec: 1')));
      }
    } finally {
      cleanup();
    }
  });
});
