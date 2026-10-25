import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import {
  validateSkillPackage,
  extractSkillPackage,
  packSkillDirectory,
  MAX_PACKAGE_SIZE,
  MAX_EXPANDED_SIZE,
  MAX_FILE_SIZE,
  MAX_FILES,
  MAX_PATH_LENGTH,
  MAX_SKILL_YAML_SIZE,
} from './package.js';

function createTarHeader(opts: {
  name: string;
  size?: number;
  mode?: number;
  typeflag?: string;
  magic?: string;
  prefix?: string;
  checksum?: number;
}): Buffer {
  const block = Buffer.alloc(512, 0);
  const name = opts.name ?? 'test.py';
  const size = opts.size ?? 0;
  const mode = opts.mode ?? 0o644;
  const typeflag = opts.typeflag ?? '0';
  const magic = opts.magic !== undefined ? opts.magic : 'ustar\0';
  const prefix = opts.prefix ?? '';

  block.write(name, 0, 100, 'utf8');
  block.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
  block.write('0000000\0', 108, 8, 'ascii');
  block.write('0000000\0', 116, 8, 'ascii');
  block.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  block.write('00000000000\0', 136, 12, 'ascii');
  block.write(typeflag, 156, 1, 'ascii');
  if (magic) {
    block.write(magic, 257, 6, 'ascii');
    block.write('00', 263, 2, 'ascii');
  }
  if (prefix) {
    block.write(prefix, 345, 155, 'utf8');
  }

  if (opts.checksum !== undefined) {
    block.write(opts.checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  } else {
    let sum = 0;
    for (let i = 0; i < 512; i++) {
      sum += i >= 148 && i < 156 ? 0x20 : block[i];
    }
    block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  }

  return block;
}

function makeTarball(entries: Array<{ header: Buffer; content?: Buffer }>, trailingZeroBlocks = 2): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    blocks.push(entry.header);
    if (entry.content && entry.content.length > 0) {
      blocks.push(entry.content);
      const remainder = entry.content.length % 512;
      if (remainder > 0) {
        blocks.push(Buffer.alloc(512 - remainder, 0));
      }
    }
  }
  for (let i = 0; i < trailingZeroBlocks; i++) {
    blocks.push(Buffer.alloc(512, 0));
  }
  return Buffer.concat(blocks);
}

const VALID_SKILL_YAML = `spec: 1
id: test-skill
name: Test Skill
version: 1.0.0
language: python
description: A valid test skill package
entry: entry.py
`;

const VALID_TEST_PY = `def test_something():
    assert True
`;

const VALID_ENTRY_PY = `def tools():
    return []
`;

function makeValidPackage(): Buffer {
  const yamlBuf = Buffer.from(VALID_SKILL_YAML, 'utf8');
  const entryBuf = Buffer.from(VALID_ENTRY_PY, 'utf8');
  const testBuf = Buffer.from(VALID_TEST_PY, 'utf8');

  const tar = makeTarball([
    { header: createTarHeader({ name: 'skill.yaml', size: yamlBuf.length }), content: yamlBuf },
    { header: createTarHeader({ name: 'entry.py', size: entryBuf.length }), content: entryBuf },
    { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
  ]);
  return zlib.gzipSync(tar);
}

describe('Skill Package Specification & Validator (A1, A19, A22)', () => {
  it('accepts a valid conforming skill package', async () => {
    const gz = makeValidPackage();
    const result = await validateSkillPackage(gz);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.manifest.id, 'test-skill');
      assert.equal(result.manifest.version, '1.0.0');
      assert.equal(result.files.length, 3);
    }
  });

  describe('Gzip Decompression & Single-Stream Enforcement (A19)', () => {
    it('refuses non-gzip data with bad magic', async () => {
      const bad = Buffer.from('this is not gzip data at all!!');
      const result = await validateSkillPackage(bad);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('bad magic')));
      }
    });

    it('refuses compressed package exceeding 5 MiB limit', async () => {
      const huge = Buffer.alloc(MAX_PACKAGE_SIZE + 10, 0);
      huge[0] = 0x1f;
      huge[1] = 0x8b;
      huge[2] = 0x08;
      const result = await validateSkillPackage(huge);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('exceeds maximum of 5242880 bytes')));
      }
    });

    it('refuses decompression bombs exceeding 20 MiB limit', async () => {
      // 25 MiB of zeros compresses to ~25 KiB
      const bombData = Buffer.alloc(25 * 1024 * 1024, 0);
      const tar = makeTarball([
        { header: createTarHeader({ name: 'skill.yaml', size: Buffer.byteLength(VALID_SKILL_YAML) }), content: Buffer.from(VALID_SKILL_YAML) },
        { header: createTarHeader({ name: 'test_entry.py', size: Buffer.byteLength(VALID_TEST_PY) }), content: Buffer.from(VALID_TEST_PY) },
        { header: createTarHeader({ name: 'huge.bin', size: bombData.length }), content: bombData },
      ]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('package expanded size exceeds')));
      }
    });

    it('refuses concatenated multi-member gzip streams (A19)', async () => {
      const validGz = makeValidPackage();
      const secondGz = zlib.gzipSync(Buffer.from('hello second stream'));
      const concatenated = Buffer.concat([validGz, secondGz]);

      const result = await validateSkillPackage(concatenated);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('trailing data or multiple gzip members')));
      }
    });

    it('refuses trailing junk bytes after gzip trailer (A19)', async () => {
      const validGz = makeValidPackage();
      const withTrailingJunk = Buffer.concat([validGz, Buffer.from('extra junk bytes')]);

      const result = await validateSkillPackage(withTrailingJunk);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('trailing data or multiple gzip members')));
      }
    });

    it('refuses invalid CRC32 in gzip trailer (A19)', async () => {
      const gz = makeValidPackage();
      // Corrupt CRC32 at gz.length - 8
      gz[gz.length - 8] ^= 0xff;
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('CRC32 mismatch')));
      }
    });

    it('refuses invalid ISIZE in gzip trailer (A19)', async () => {
      const gz = makeValidPackage();
      // Corrupt ISIZE at gz.length - 4
      gz[gz.length - 4] ^= 0xff;
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('ISIZE mismatch')));
      }
    });
  });

  describe('Tar Parser Hardening & Python Extractor Agreement (A19)', () => {
    it('verifies tar header checksum and refuses tampered headers', async () => {
      const yamlBuf = Buffer.from(VALID_SKILL_YAML);
      const testBuf = Buffer.from(VALID_TEST_PY);
      const header = createTarHeader({ name: 'skill.yaml', size: yamlBuf.length, checksum: 0o12345 }); // bad checksum
      const tar = makeTarball([
        { header, content: yamlBuf },
        { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
      ]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('invalid tar header checksum')));
      }
    });

    it('refuses non-octal characters in header octal fields', async () => {
      const yamlBuf = Buffer.from(VALID_SKILL_YAML);
      const testBuf = Buffer.from(VALID_TEST_PY);
      const header = createTarHeader({ name: 'skill.yaml', size: yamlBuf.length });
      // Inject non-octal '8' into size field (offset 124..136)
      header[124] = 0x38; // '8'
      // Recompute checksum so only octal parsing fails
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156 ? 0x20 : header[i]);
      header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');

      const tar = makeTarball([
        { header, content: yamlBuf },
        { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
      ]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('malformed octal')));
      }
    });

    it('refuses non-zero prefix field without POSIX ustar magic (Python agreement)', async () => {
      const yamlBuf = Buffer.from(VALID_SKILL_YAML);
      const testBuf = Buffer.from(VALID_TEST_PY);
      const header = createTarHeader({
        name: 'skill.yaml',
        size: yamlBuf.length,
        prefix: 'some/prefix',
        magic: '', // non-ustar
      });
      const tar = makeTarball([
        { header, content: yamlBuf },
        { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
      ]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('without POSIX ustar magic')));
      }
    });

    it('refuses entries appearing after the zero-block end-of-archive marker', async () => {
      const yamlBuf = Buffer.from(VALID_SKILL_YAML);
      const testBuf = Buffer.from(VALID_TEST_PY);
      const blocks: Buffer[] = [
        createTarHeader({ name: 'skill.yaml', size: yamlBuf.length }),
        yamlBuf,
        Buffer.alloc(512 - (yamlBuf.length % 512), 0),
        createTarHeader({ name: 'test_entry.py', size: testBuf.length }),
        testBuf,
        Buffer.alloc(512 - (testBuf.length % 512), 0),
        Buffer.alloc(512, 0), // End-of-archive zero block 1
        Buffer.alloc(512, 0), // End-of-archive zero block 2
        // Rogue entry AFTER end-of-archive marker
        createTarHeader({ name: 'rogue.py', size: 5 }),
        Buffer.from('rogue'),
        Buffer.alloc(507, 0),
      ];
      const tar = Buffer.concat(blocks);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('contains non-zero data after end-of-archive marker')));
      }
    });

    it('refuses regular file entry whose name ends in a slash', async () => {
      const yamlBuf = Buffer.from(VALID_SKILL_YAML);
      const testBuf = Buffer.from(VALID_TEST_PY);
      const header = createTarHeader({ name: 'foo.py/', size: 0, typeflag: '0' });
      const tar = makeTarball([
        { header: createTarHeader({ name: 'skill.yaml', size: yamlBuf.length }), content: yamlBuf },
        { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
        { header },
      ]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('regular file entry name ends in slash')));
      }
    });

    it('refuses path that is both a regular file and a directory parent', async () => {
      const yamlBuf = Buffer.from(VALID_SKILL_YAML);
      const testBuf = Buffer.from(VALID_TEST_PY);
      const fileA = Buffer.from('print(1)');
      const fileB = Buffer.from('print(2)');
      const tar = makeTarball([
        { header: createTarHeader({ name: 'skill.yaml', size: yamlBuf.length }), content: yamlBuf },
        { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
        { header: createTarHeader({ name: 'pkg', size: fileA.length, typeflag: '0' }), content: fileA },
        { header: createTarHeader({ name: 'pkg/sub.py', size: fileB.length, typeflag: '0' }), content: fileB },
      ]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('both a regular file and a directory parent')));
      }
    });

    it('refuses symlinks, hardlinks, fifos, and device entries', async () => {
      const yamlBuf = Buffer.from(VALID_SKILL_YAML);
      const testBuf = Buffer.from(VALID_TEST_PY);
      for (const [typeflag, desc] of [['1', 'hardlink'], ['2', 'symlink'], ['3', 'chr'], ['4', 'blk'], ['6', 'fifo']]) {
        const header = createTarHeader({ name: 'bad_entry', typeflag });
        const tar = makeTarball([
          { header: createTarHeader({ name: 'skill.yaml', size: yamlBuf.length }), content: yamlBuf },
          { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
          { header },
        ]);
        const gz = zlib.gzipSync(tar);
        const result = await validateSkillPackage(gz);
        assert.equal(result.ok, false, `should refuse ${desc} (${typeflag})`);
        if (!result.ok) {
          assert.ok(result.issues.some((i) => i.includes('only regular files and directories allowed')));
        }
      }
    });

    it('refuses setuid, setgid, and sticky bits', async () => {
      const yamlBuf = Buffer.from(VALID_SKILL_YAML);
      const testBuf = Buffer.from(VALID_TEST_PY);
      for (const [mode, desc] of [[0o4755, 'setuid'], [0o2755, 'setgid'], [0o1755, 'sticky']]) {
        const header = createTarHeader({ name: 'script.py', mode, size: 0 });
        const tar = makeTarball([
          { header: createTarHeader({ name: 'skill.yaml', size: yamlBuf.length }), content: yamlBuf },
          { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
          { header },
        ]);
        const gz = zlib.gzipSync(tar);
        const result = await validateSkillPackage(gz);
        assert.equal(result.ok, false, `should refuse ${desc}`);
        if (!result.ok) {
          assert.ok(result.issues.some((i) => i.includes('forbidden')));
        }
      }
    });

    it('refuses paths with illegal control characters', async () => {
      const yamlBuf = Buffer.from(VALID_SKILL_YAML);
      const testBuf = Buffer.from(VALID_TEST_PY);
      const header = createTarHeader({ name: 'bad\x01name.py', size: 0 });
      const tar = makeTarball([
        { header: createTarHeader({ name: 'skill.yaml', size: yamlBuf.length }), content: yamlBuf },
        { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
        { header },
      ]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('illegal control characters')));
      }
    });

    it('refuses paths exceeding 255 bytes', async () => {
      const yamlBuf = Buffer.from(VALID_SKILL_YAML);
      const testBuf = Buffer.from(VALID_TEST_PY);
      const header = createTarHeader({
        prefix: 'a'.repeat(155),
        name: 'b'.repeat(101), // total 257 chars > 255
        size: 0,
      });
      const tar = makeTarball([
        { header: createTarHeader({ name: 'skill.yaml', size: yamlBuf.length }), content: yamlBuf },
        { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
        { header },
      ]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('exceeds limit of 255')));
      }
    });

    it('accepts ustar prefix split for valid paths between 101 and 255 characters', async () => {
      const yamlBuf = Buffer.from(VALID_SKILL_YAML);
      const testBuf = Buffer.from(VALID_TEST_PY);
      const header = createTarHeader({
        prefix: 'nested/' + 'dir/'.repeat(20), // prefix <= 155
        name: 'some_long_filename.py', // name <= 100
        size: 0,
      });
      const tar = makeTarball([
        { header: createTarHeader({ name: 'skill.yaml', size: yamlBuf.length }), content: yamlBuf },
        { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
        { header },
      ]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, true);
    });

    it('refuses duplicate file entries and case-colliding entries', async () => {
      const yamlBuf = Buffer.from(VALID_SKILL_YAML);
      const testBuf = Buffer.from(VALID_TEST_PY);
      const tar = makeTarball([
        { header: createTarHeader({ name: 'skill.yaml', size: yamlBuf.length }), content: yamlBuf },
        { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
        { header: createTarHeader({ name: 'module.py', size: 0 }) },
        { header: createTarHeader({ name: 'MODULE.py', size: 0 }) },
      ]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('case-colliding')));
      }
    });

    it('refuses directory traversal, leading slashes, and backslashes', async () => {
      const yamlBuf = Buffer.from(VALID_SKILL_YAML);
      const testBuf = Buffer.from(VALID_TEST_PY);
      for (const badPath of ['../escape.py', '/root.py', 'foo\\bar.py']) {
        const header = createTarHeader({ name: badPath, size: 0 });
        const tar = makeTarball([
          { header: createTarHeader({ name: 'skill.yaml', size: yamlBuf.length }), content: yamlBuf },
          { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
          { header },
        ]);
        const gz = zlib.gzipSync(tar);
        const result = await validateSkillPackage(gz);
        assert.equal(result.ok, false, `should refuse ${badPath}`);
      }
    });
  });

  describe('Banned Files, Extensions & Binary Headers', () => {
    it('refuses banned extensions (.pyc, .so, .dylib, .dll, .exe)', async () => {
      const yamlBuf = Buffer.from(VALID_SKILL_YAML);
      const testBuf = Buffer.from(VALID_TEST_PY);
      for (const ext of ['.pyc', '.so', '.dylib', '.dll', '.exe']) {
        const header = createTarHeader({ name: `bad${ext}`, size: 0 });
        const tar = makeTarball([
          { header: createTarHeader({ name: 'skill.yaml', size: yamlBuf.length }), content: yamlBuf },
          { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
          { header },
        ]);
        const gz = zlib.gzipSync(tar);
        const result = await validateSkillPackage(gz);
        assert.equal(result.ok, false, `should refuse ${ext}`);
        if (!result.ok) {
          assert.ok(result.issues.some((i) => i.includes('banned file extension')));
        }
      }
    });

    it('refuses banned directory segments (.git, __pycache__, node_modules, .venv, .DS_Store)', async () => {
      const yamlBuf = Buffer.from(VALID_SKILL_YAML);
      const testBuf = Buffer.from(VALID_TEST_PY);
      for (const seg of ['.git', '__pycache__', 'node_modules', '.venv', '.DS_Store']) {
        const header = createTarHeader({ name: `${seg}/file.txt`, size: 0 });
        const tar = makeTarball([
          { header: createTarHeader({ name: 'skill.yaml', size: yamlBuf.length }), content: yamlBuf },
          { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
          { header },
        ]);
        const gz = zlib.gzipSync(tar);
        const result = await validateSkillPackage(gz);
        assert.equal(result.ok, false, `should refuse ${seg}`);
        if (!result.ok) {
          assert.ok(result.issues.some((i) => i.includes('banned path segment')));
        }
      }
    });

    it('refuses ELF, Mach-O and PE/MZ binary headers regardless of filename', async () => {
      const yamlBuf = Buffer.from(VALID_SKILL_YAML);
      const testBuf = Buffer.from(VALID_TEST_PY);

      const elfContent = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x01, 0x02]);
      const machoContent = Buffer.from([0xfe, 0xed, 0xfa, 0xce, 0x00, 0x00]);
      const peContent = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);

      for (const [content, name] of [[elfContent, 'elf'], [machoContent, 'macho'], [peContent, 'pe']]) {
        const header = createTarHeader({ name: 'innocent.txt', size: content.length });
        const tar = makeTarball([
          { header: createTarHeader({ name: 'skill.yaml', size: yamlBuf.length }), content: yamlBuf },
          { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
          { header, content },
        ]);
        const gz = zlib.gzipSync(tar);
        const result = await validateSkillPackage(gz);
        assert.equal(result.ok, false, `should refuse ${name} binary`);
        if (!result.ok) {
          assert.ok(result.issues.some((i) => i.includes('compiled binary file')));
        }
      }
    });
  });

  describe('Manifest & Test Coverage Rules (A1, A2, A22, H11)', () => {
    it('refuses package without skill.yaml at root', async () => {
      const testBuf = Buffer.from(VALID_TEST_PY);
      const tar = makeTarball([
        { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
      ]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('package must contain a skill.yaml at root')));
      }
    });

    it('refuses skill.yaml missing spec: 1', async () => {
      const yaml = `id: test-skill\nname: Test\nversion: 1.0.0\nentry: entry.py\n`;
      const testBuf = Buffer.from(VALID_TEST_PY);
      const tar = makeTarball([
        { header: createTarHeader({ name: 'skill.yaml', size: Buffer.byteLength(yaml) }), content: Buffer.from(yaml) },
        { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
      ]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('declare spec: 1')));
      }
    });

    it('refuses skill.yaml declaring visibility or owner (A22, H11)', async () => {
      const yamlVis = `${VALID_SKILL_YAML}visibility: public\n`;
      const testBuf = Buffer.from(VALID_TEST_PY);
      const tar = makeTarball([
        { header: createTarHeader({ name: 'skill.yaml', size: Buffer.byteLength(yamlVis) }), content: Buffer.from(yamlVis) },
        { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
      ]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('drop visibility field')));
      }
    });

    it('refuses package with no tests outside vendor/', async () => {
      const yamlBuf = Buffer.from(VALID_SKILL_YAML);
      const vendorTestBuf = Buffer.from(VALID_TEST_PY);
      // Tests only in vendor/ should be refused
      const tar = makeTarball([
        { header: createTarHeader({ name: 'skill.yaml', size: yamlBuf.length }), content: yamlBuf },
        { header: createTarHeader({ name: 'vendor/pkg/test_pkg.py', size: vendorTestBuf.length }), content: vendorTestBuf },
      ]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('package must contain tests outside vendor/')));
      }
    });

    it('accepts package with vendor/ when tests exist outside vendor/', async () => {
      const yamlBuf = Buffer.from(VALID_SKILL_YAML);
      const testBuf = Buffer.from(VALID_TEST_PY);
      const vendorBuf = Buffer.from('VALUE = 1\n');
      const tar = makeTarball([
        { header: createTarHeader({ name: 'skill.yaml', size: yamlBuf.length }), content: yamlBuf },
        { header: createTarHeader({ name: 'test_skill.py', size: testBuf.length }), content: testBuf },
        { header: createTarHeader({ name: 'vendor/helper.py', size: vendorBuf.length }), content: vendorBuf },
      ]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, true);
    });
  });

  describe('packSkillDirectory and extractSkillPackage (A6, A19)', () => {
    it('packs a directory and extracts it safely with matching contents', async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'skill-pack-'));
      const srcDir = join(tmp, 'src');
      const destDir = join(tmp, 'dest');
      mkdirSync(srcDir, { recursive: true });

      writeFileSync(join(srcDir, 'skill.yaml'), VALID_SKILL_YAML);
      writeFileSync(join(srcDir, 'entry.py'), VALID_ENTRY_PY);
      writeFileSync(join(srcDir, 'test_entry.py'), VALID_TEST_PY);

      const gz = await packSkillDirectory(srcDir);
      assert.ok(gz.length > 0);

      const extracted = extractSkillPackage(gz, destDir);
      assert.equal(extracted.ok, true);
      assert.equal(extracted.manifest.id, 'test-skill');

      const extractedYaml = readFileSync(join(destDir, 'skill.yaml'), 'utf8');
      assert.equal(extractedYaml, VALID_SKILL_YAML);

      rmSync(tmp, { recursive: true, force: true });
    });
  });
});
