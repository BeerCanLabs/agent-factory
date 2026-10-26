import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  validateSkillPackage,
  extractSkillPackage,
  MAX_PACKAGE_SIZE,
  MAX_EXPANDED_SIZE,
  MAX_FILE_SIZE,
  MAX_FILES,
  MAX_PATH_LENGTH,
  MAX_SKILL_YAML_SIZE,
  MAX_ISSUES,
} from './package.js';

function createTarHeader(opts: {
  name: string;
  size?: number;
  mode?: number;
  typeflag?: string;
  magic?: string;
  prefix?: string;
  checksum?: number;
  rawSize?: Buffer;
  rawUid?: Buffer;
  devmajor?: string;
  devminor?: string;
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
  if (opts.rawUid) {
    opts.rawUid.copy(block, 108, 0, Math.min(8, opts.rawUid.length));
  } else {
    block.write('0000000\0', 108, 8, 'ascii');
  }
  block.write('0000000\0', 116, 8, 'ascii');
  if (opts.rawSize) {
    opts.rawSize.copy(block, 124, 0, Math.min(12, opts.rawSize.length));
  } else {
    block.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  }
  block.write('00000000000\0', 136, 12, 'ascii');
  block.write(typeflag, 156, 1, 'ascii');
  if (magic) {
    block.write(magic, 257, 6, 'ascii');
    block.write('00', 263, 2, 'ascii');
  }
  if (opts.devmajor) {
    block.write(opts.devmajor, 329, 8, 'latin1');
  }
  if (opts.devminor) {
    block.write(opts.devminor, 337, 8, 'latin1');
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

describe('Skill Package Specification & Validator (A1, A19, A22, H7)', () => {
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
      const result = await validateSkillPackage(Buffer.from('not a gzip file at all!'));
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('bad magic')));
      }
    });

    it('refuses compressed package exceeding 5 MiB limit', async () => {
      const over5Mb = Buffer.alloc(MAX_PACKAGE_SIZE + 100, 0);
      over5Mb[0] = 0x1f;
      over5Mb[1] = 0x8b;
      over5Mb[2] = 0x08;
      const result = await validateSkillPackage(over5Mb);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('exceeds maximum of 5242880 bytes')));
      }
    });

    it('refuses decompression bombs exceeding 20 MiB limit (asserting inflate cap)', async () => {
      // Create a compressed stream representing >20 MiB of zeros (compressed size is tiny)
      const bigZeroBuf = Buffer.alloc(25 * 1024 * 1024, 0);
      const gzBomb = zlib.gzipSync(bigZeroBuf);
      assert.ok(gzBomb.length < MAX_PACKAGE_SIZE);

      const result = await validateSkillPackage(gzBomb);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('package expanded size exceeds decompression limit of 20971520 bytes')));
      }
    });

    it('refuses concatenated multi-member gzip streams (A19)', async () => {
      const gz1 = makeValidPackage();
      const gz2 = makeValidPackage();
      const multi = Buffer.concat([gz1, gz2]);
      const result = await validateSkillPackage(multi);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('trailing data or multiple gzip members')));
      }
    });

    it('refuses trailing junk bytes after gzip trailer (A19)', async () => {
      const gz = makeValidPackage();
      const withTrailingJunk = Buffer.concat([gz, Buffer.from('junkbytes')]);
      const result = await validateSkillPackage(withTrailingJunk);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('trailing data or multiple gzip members')));
      }
    });

    it('refuses invalid CRC32 in gzip trailer (A19)', async () => {
      const gz = makeValidPackage();
      const tampered = Buffer.from(gz);
      tampered.writeUInt32LE(0xdeadbeef, tampered.length - 8);
      const result = await validateSkillPackage(tampered);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('gzip CRC32 mismatch')));
      }
    });

    it('refuses invalid ISIZE in gzip trailer (A19)', async () => {
      const gz = makeValidPackage();
      const tampered = Buffer.from(gz);
      tampered.writeUInt32LE(0x12345678, tampered.length - 4);
      const result = await validateSkillPackage(tampered);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('gzip ISIZE mismatch')));
      }
    });
  });

  describe('Tar Parser Hardening, Path Normalization & Python Agreement (N1-N5, B1-B3, A19)', () => {
    it('verifies tar header checksum and refuses tampered headers', async () => {
      const entryBuf = Buffer.from(VALID_ENTRY_PY);
      const header = createTarHeader({ name: 'entry.py', size: entryBuf.length });
      header[100] = 0x39; // tamper mode without updating checksum
      const tar = makeTarball([{ header, content: entryBuf }]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('invalid tar header checksum')));
      }
    });

    it('accepts signed tar header checksum with non-ASCII bytes (signed != unsigned sum)', async () => {
      const yamlBuf = Buffer.from(VALID_SKILL_YAML);
      const testBuf = Buffer.from(VALID_TEST_PY);
      // Header with byte 0x85 in name
      const header = createTarHeader({ name: 'file_\x85.py', size: 0 });
      let signedSum = 0;
      let unsignedSum = 0;
      for (let i = 0; i < 512; i++) {
        const val = (i >= 148 && i < 156) ? 0x20 : header[i];
        unsignedSum += val;
        signedSum += (val > 127 ? val - 256 : val);
      }
      assert.notEqual(signedSum, unsignedSum, 'signed and unsigned sums must differ');
      header.write(signedSum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
      const tar = makeTarball([
        { header: createTarHeader({ name: 'skill.yaml', size: yamlBuf.length }), content: yamlBuf },
        { header },
        { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
      ]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, true);
    });

    it('refuses N1: . entry with typeflag 0 and size 512 pretending to be data', async () => {
      const dotHeader = createTarHeader({ name: '.', typeflag: '0', size: 512 });
      const tar = makeTarball([{ header: dotHeader, content: Buffer.alloc(512, 0) }]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('root directory entry must have directory typeflag') || i.includes('root directory entry has non-zero size')));
      }
    });

    it('refuses N2: high-bit byte in numeric field (000000\\xb1\\0)', async () => {
      const rawUid = Buffer.alloc(8, 0);
      rawUid.write('000000\xb1\0', 0, 'latin1');
      const header = createTarHeader({ name: 'entry.py', rawUid });
      const tar = makeTarball([{ header }]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('malformed octal in tar header uid')));
      }
    });

    it('refuses N3: non-ustar header with devmajor 9999999\\0', async () => {
      const header = createTarHeader({ name: 'entry.py', magic: '', devmajor: '9999999\0' });
      const tar = makeTarball([{ header }]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('malformed octal in tar header devmajor')));
      }
    });

    it('refuses N4: file a and directory entry a/b/', async () => {
      const yamlBuf = Buffer.from(VALID_SKILL_YAML);
      const testBuf = Buffer.from(VALID_TEST_PY);
      const fileA = Buffer.from('print(1)');
      const tar = makeTarball([
        { header: createTarHeader({ name: 'skill.yaml', size: yamlBuf.length }), content: yamlBuf },
        { header: createTarHeader({ name: 'a', size: fileA.length }), content: fileA },
        { header: createTarHeader({ name: 'a/b/', typeflag: '5', size: 0 }) },
        { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
      ]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('both a regular file and a directory parent (A19): "a"')));
      }
    });

    it('refuses N5: case collision across parent path components (A/x.py and a/y.py)', async () => {
      const yamlBuf = Buffer.from(VALID_SKILL_YAML);
      const testBuf = Buffer.from(VALID_TEST_PY);
      const f1 = Buffer.from('print(1)');
      const f2 = Buffer.from('print(2)');
      const tar = makeTarball([
        { header: createTarHeader({ name: 'skill.yaml', size: yamlBuf.length }), content: yamlBuf },
        { header: createTarHeader({ name: 'A/x.py', size: f1.length }), content: f1 },
        { header: createTarHeader({ name: 'a/y.py', size: f2.length }), content: f2 },
        { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
      ]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('case-colliding paths in package (A19): "A" vs "a"')));
      }
    });

    it('refuses B3: NUL before digits (\\0 followed by 00000002000)', async () => {
      const rawSize = Buffer.alloc(12, 0);
      rawSize.write('\x000000002000', 0, 'ascii');
      const header = createTarHeader({ name: 'entry.py', rawSize });
      const tar = makeTarball([{ header }]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('non-padding byte')));
      }
    });

    it('refuses B3: space followed by non-padding digit (0000000010 7)', async () => {
      const rawSize = Buffer.from('0000000010 7', 'ascii');
      const header = createTarHeader({ name: 'entry.py', rawSize });
      const tar = makeTarball([{ header }]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('malformed octal in tar header size')));
      }
    });

    it('refuses B3: base-256 binary encoding (0x80 high bit)', async () => {
      const rawSize = Buffer.alloc(12, 0);
      rawSize[0] = 0x80;
      rawSize[11] = 0x20;
      const header = createTarHeader({ name: 'entry.py', rawSize });
      const tar = makeTarball([{ header }]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('base-256 binary encoding not permitted')));
      }
    });

    it('refuses B2: directory entry with non-zero size', async () => {
      const yamlBuf = Buffer.from(VALID_SKILL_YAML);
      const testBuf = Buffer.from(VALID_TEST_PY);
      const dirHeader = createTarHeader({ name: 'mydir/', typeflag: '5', size: 1024 });
      const tar = makeTarball([
        { header: createTarHeader({ name: 'skill.yaml', size: yamlBuf.length }), content: yamlBuf },
        { header: dirHeader },
        { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
      ]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('directory entry has non-zero size')));
      }
    });

    it('refuses B1: duplicate manifest using ./skill.yaml and skill.yaml', async () => {
      const yamlBufA = Buffer.from(VALID_SKILL_YAML);
      const yamlBufB = Buffer.from(`${VALID_SKILL_YAML}\n# comment`);
      const testBuf = Buffer.from(VALID_TEST_PY);
      const tar = makeTarball([
        { header: createTarHeader({ name: 'skill.yaml', size: yamlBufA.length }), content: yamlBufA },
        { header: createTarHeader({ name: './skill.yaml', size: yamlBufB.length }), content: yamlBufB },
        { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
      ]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('duplicate file entry in package (A19): "skill.yaml"')));
      }
    });

    it('refuses B1: duplicate file entry with // and . components (a//b.py vs a/b.py)', async () => {
      const yamlBuf = Buffer.from(VALID_SKILL_YAML);
      const testBuf = Buffer.from(VALID_TEST_PY);
      const fileBuf = Buffer.from('print(1)');
      const tar = makeTarball([
        { header: createTarHeader({ name: 'skill.yaml', size: yamlBuf.length }), content: yamlBuf },
        { header: createTarHeader({ name: 'a/b.py', size: fileBuf.length }), content: fileBuf },
        { header: createTarHeader({ name: 'a//./b.py', size: fileBuf.length }), content: fileBuf },
        { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
      ]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('duplicate file entry in package (A19): "a/b.py"')));
      }
    });

    it('accepts B1: single ./skill.yaml normalized as root manifest', async () => {
      const yamlBuf = Buffer.from(VALID_SKILL_YAML);
      const testBuf = Buffer.from(VALID_TEST_PY);
      const tar = makeTarball([
        { header: createTarHeader({ name: './skill.yaml', size: yamlBuf.length }), content: yamlBuf },
        { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
      ]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, true);
    });

    it('refuses pax and GNU headers (x, g, L, K, S)', async () => {
      for (const flag of ['x', 'g', 'L', 'K', 'S']) {
        const header = createTarHeader({ name: 'test.py', typeflag: flag });
        const tar = makeTarball([{ header }]);
        const gz = zlib.gzipSync(tar);
        const result = await validateSkillPackage(gz);
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.ok(result.issues.some((i) => i.includes(`entry type '${flag}' not permitted`)));
        }
      }
    });

    it('refuses symlinks, hardlinks, fifos, and device entries', async () => {
      for (const flag of ['1', '2', '3', '4', '6']) {
        const header = createTarHeader({ name: 'test.py', typeflag: flag });
        const tar = makeTarball([{ header }]);
        const gz = zlib.gzipSync(tar);
        const result = await validateSkillPackage(gz);
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.ok(result.issues.some((i) => i.includes(`entry type '${flag}' not permitted`)));
        }
      }
    });

    it('refuses non-zero prefix field without POSIX ustar magic', async () => {
      const header = createTarHeader({ name: 'file.py', prefix: 'somedir', magic: 'notust' });
      const tar = makeTarball([{ header }]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('non-empty prefix field without POSIX ustar magic')));
      }
    });

    it('refuses entries appearing after zero-block end-of-archive marker', async () => {
      const header1 = createTarHeader({ name: 'a.py' });
      const header2 = createTarHeader({ name: 'b.py' });
      const blocks = [header1, Buffer.alloc(512, 0), header2, Buffer.alloc(512, 0)];
      const tar = Buffer.concat(blocks);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('after end-of-archive marker')));
      }
    });

    it('refuses regular file entry whose name ends in a slash', async () => {
      const header = createTarHeader({ name: 'myfile.py/', typeflag: '0' });
      const tar = makeTarball([{ header }]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('regular file entry name ends in slash')));
      }
    });

    it('refuses path that is both a regular file and a directory parent', async () => {
      const fileBuf = Buffer.from('print(1)');
      const tar = makeTarball([
        { header: createTarHeader({ name: 'sub', size: fileBuf.length }), content: fileBuf },
        { header: createTarHeader({ name: 'sub/inner.py', size: fileBuf.length }), content: fileBuf },
      ]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('both a regular file and a directory parent')));
      }
    });

    it('refuses setuid, setgid, and sticky bits', async () => {
      for (const mode of [0o4755, 0o2755, 0o1755]) {
        const header = createTarHeader({ name: 'test.py', mode });
        const tar = makeTarball([{ header }]);
        const gz = zlib.gzipSync(tar);
        const result = await validateSkillPackage(gz);
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.ok(result.issues.some((i) => i.includes('bit forbidden')));
        }
      }
    });

    it('refuses paths exceeding 255 bytes', async () => {
      const prefix = 'd'.repeat(155);
      const name = 'a'.repeat(100);
      assert.equal(prefix.length + 1 + name.length, 256);
      const header = createTarHeader({ name, prefix });
      const tar = makeTarball([{ header }]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes(`exceeds limit of ${MAX_PATH_LENGTH}`)));
      }
    });

    it('accepts ustar prefix split for valid path exactly 255 characters', async () => {
      const prefix = 'd'.repeat(154);
      const name = 'f'.repeat(100);
      assert.equal(prefix.length + 1 + name.length, 255);
      const yamlBuf = Buffer.from(VALID_SKILL_YAML);
      const testBuf = Buffer.from(VALID_TEST_PY);
      const longHeader = createTarHeader({ name, prefix, size: 0 });
      const tar = makeTarball([
        { header: createTarHeader({ name: 'skill.yaml', size: yamlBuf.length }), content: yamlBuf },
        { header: longHeader },
        { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
      ]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, true);
    });

    it('refuses directory traversal, leading slashes, and backslashes with specific error messages', async () => {
      const yamlBuf = Buffer.from(VALID_SKILL_YAML);
      const testBuf = Buffer.from(VALID_TEST_PY);

      // Traversal
      let tar = makeTarball([
        { header: createTarHeader({ name: 'skill.yaml', size: yamlBuf.length }), content: yamlBuf },
        { header: createTarHeader({ name: '../etc/passwd' }) },
        { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
      ]);
      let res = await validateSkillPackage(zlib.gzipSync(tar));
      assert.equal(res.ok, false);
      if (!res.ok) assert.ok(res.issues.some((i) => i.includes('directory traversal not allowed in path')));

      // Absolute
      tar = makeTarball([
        { header: createTarHeader({ name: 'skill.yaml', size: yamlBuf.length }), content: yamlBuf },
        { header: createTarHeader({ name: '/root/file' }) },
        { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
      ]);
      res = await validateSkillPackage(zlib.gzipSync(tar));
      assert.equal(res.ok, false);
      if (!res.ok) assert.ok(res.issues.some((i) => i.includes('path must not be absolute')));

      // Backslash
      tar = makeTarball([
        { header: createTarHeader({ name: 'skill.yaml', size: yamlBuf.length }), content: yamlBuf },
        { header: createTarHeader({ name: 'win\\path' }) },
        { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
      ]);
      res = await validateSkillPackage(zlib.gzipSync(tar));
      assert.equal(res.ok, false);
      if (!res.ok) assert.ok(res.issues.some((i) => i.includes('path must not contain backslashes')));
    });
  });

  describe('Banned Files, Extensions & Binary Headers', () => {
    it('refuses banned extensions (.pyc, .so, .dylib, .dll, .exe, .pyo, .pyd)', async () => {
      for (const ext of ['.pyc', '.so', '.dylib', '.dll', '.exe', '.pyo', '.pyd']) {
        const header = createTarHeader({ name: `bad${ext}` });
        const tar = makeTarball([{ header }]);
        const gz = zlib.gzipSync(tar);
        const result = await validateSkillPackage(gz);
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.ok(result.issues.some((i) => i.includes(`banned file extension "${ext}"`)));
        }
      }
    });

    it('refuses N1: . entry with directory typeflag 5 and size 512 containing smuggled header', async () => {
      const forgedHeader = createTarHeader({ name: 'x/.git/hooks/pre-commit', size: 100 });
      const dotHeader = createTarHeader({ name: '.', typeflag: '5', size: 512 });
      const tar = makeTarball([
        { header: dotHeader, content: forgedHeader },
      ]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('root directory entry has non-zero size')));
      }
    });

    it('refuses banned directory segments case-insensitively (.git, .GIT, __pycache__)', async () => {
      for (const seg of ['.git', '.GIT', '__pycache__', '__PYCACHE__']) {
        const header = createTarHeader({ name: `${seg}/file.py` });
        const tar = makeTarball([{ header }]);
        const gz = zlib.gzipSync(tar);
        const result = await validateSkillPackage(gz);
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.ok(result.issues.some((i) => i.includes(`banned path segment "${seg}"`)));
        }
      }
    });

    it('refuses ELF, Mach-O and PE/MZ binary headers regardless of filename', async () => {
      const elfMagic = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x01]);
      const machoMagic = Buffer.from([0xfe, 0xed, 0xfa, 0xce]);
      const peMagic = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);

      for (const bin of [elfMagic, machoMagic, peMagic]) {
        const header = createTarHeader({ name: 'innocent.py', size: bin.length });
        const tar = makeTarball([{ header, content: bin }]);
        const gz = zlib.gzipSync(tar);
        const result = await validateSkillPackage(gz);
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.ok(result.issues.some((i) => i.includes('compiled binary file')));
        }
      }
    });
  });

  describe('Manifest & Test Coverage Rules (A1, A2, A22, H7)', () => {
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

    it('refuses skill.yaml missing spec: 1 or declaring spec: 2', async () => {
      for (const spec of [undefined, 2]) {
        const yaml = spec === undefined ? `id: test-skill\nname: Test\nversion: 1.0.0\nentry: entry.py\nlanguage: python\n` : `spec: ${spec}\nid: test-skill\nname: Test\nversion: 1.0.0\nentry: entry.py\nlanguage: python\n`;
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
      }
    });

    it('refuses skill.yaml declaring visibility or owner (A22, H7)', async () => {
      for (const field of ['visibility: public\n', 'owner: alice\n']) {
        const yaml = `${VALID_SKILL_YAML}${field}`;
        const testBuf = Buffer.from(VALID_TEST_PY);
        const tar = makeTarball([
          { header: createTarHeader({ name: 'skill.yaml', size: Buffer.byteLength(yaml) }), content: Buffer.from(yaml) },
          { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
        ]);
        const gz = zlib.gzipSync(tar);
        const result = await validateSkillPackage(gz);
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.ok(result.issues.some((i) => i.includes('drop visibility field') || i.includes('drop owner field')));
        }
      }
    });

    it('refuses skill.yaml exceeding 64 KiB', async () => {
      const bigYaml = `${VALID_SKILL_YAML}\n# ` + 'x'.repeat(MAX_SKILL_YAML_SIZE + 10);
      const testBuf = Buffer.from(VALID_TEST_PY);
      const tar = makeTarball([
        { header: createTarHeader({ name: 'skill.yaml', size: Buffer.byteLength(bigYaml) }), content: Buffer.from(bigYaml) },
        { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
      ]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes(`skill.yaml size (${Buffer.byteLength(bigYaml)} bytes) exceeds limit of ${MAX_SKILL_YAML_SIZE}`)));
      }
    });

    it('refuses skill.yaml that is non-mapping or invalid YAML', async () => {
      const yaml = `[1, 2, 3]`;
      const testBuf = Buffer.from(VALID_TEST_PY);
      const tar = makeTarball([
        { header: createTarHeader({ name: 'skill.yaml', size: Buffer.byteLength(yaml) }), content: Buffer.from(yaml) },
        { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
      ]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes('skill.yaml must be an object')));
      }
    });

    it('refuses package with no tests outside vendor/', async () => {
      const yamlBuf = Buffer.from(VALID_SKILL_YAML);
      const entryBuf = Buffer.from(VALID_ENTRY_PY);
      const testInVendor = Buffer.from(VALID_TEST_PY);

      const tar = makeTarball([
        { header: createTarHeader({ name: 'skill.yaml', size: yamlBuf.length }), content: yamlBuf },
        { header: createTarHeader({ name: 'entry.py', size: entryBuf.length }), content: entryBuf },
        { header: createTarHeader({ name: 'vendor/tests/test_foo.py', size: testInVendor.length }), content: testInVendor },
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
      const entryBuf = Buffer.from(VALID_ENTRY_PY);
      const testBuf = Buffer.from(VALID_TEST_PY);
      const vendorBuf = Buffer.from('# vendor library');

      const tar = makeTarball([
        { header: createTarHeader({ name: 'skill.yaml', size: yamlBuf.length }), content: yamlBuf },
        { header: createTarHeader({ name: 'entry.py', size: entryBuf.length }), content: entryBuf },
        { header: createTarHeader({ name: 'test_entry.py', size: testBuf.length }), content: testBuf },
        { header: createTarHeader({ name: 'vendor/lib.py', size: vendorBuf.length }), content: vendorBuf },
      ]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.files.length, 4);
      }
    });
  });

  describe('Bounded Work & Resource Limits (H-1, A19)', () => {
    it('caps issue strings at MAX_ISSUES (50)', async () => {
      const entries = [];
      for (let i = 0; i < 70; i++) {
        entries.push({ header: createTarHeader({ name: `bad_${i}.py`, mode: 0o4755 }) });
      }
      const tar = makeTarball(entries);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.issues.length, MAX_ISSUES);
      }
    });

    it('refuses package exceeding MAX_FILES limit (500)', async () => {
      const yamlBuf = Buffer.from(VALID_SKILL_YAML);
      const entries = [
        { header: createTarHeader({ name: 'skill.yaml', size: yamlBuf.length }), content: yamlBuf },
        { header: createTarHeader({ name: 'test_entry.py', size: Buffer.byteLength(VALID_TEST_PY) }), content: Buffer.from(VALID_TEST_PY) },
      ];
      for (let i = 0; i < 505; i++) {
        entries.push({ header: createTarHeader({ name: `f_${i}.py`, size: 0 }) });
      }
      const tar = makeTarball(entries);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes(`file count exceeds maximum of ${MAX_FILES}`)));
      }
    });

    it('refuses file exceeding MAX_FILE_SIZE limit (2 MiB)', async () => {
      const header = createTarHeader({ name: 'large.py', size: MAX_FILE_SIZE + 10 });
      const tar = makeTarball([{ header }]);
      const gz = zlib.gzipSync(tar);
      const result = await validateSkillPackage(gz);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((i) => i.includes(`exceeds limit of ${MAX_FILE_SIZE}`)));
      }
    });
  });

  describe('extractSkillPackage safe extraction (A19)', () => {
    it('extracts valid skill package files to target directory', async () => {
      const { mkdtempSync, rmSync, existsSync, readFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');

      const tmp = mkdtempSync(join(tmpdir(), 'skill-extract-test-'));
      try {
        const manifestYaml = Buffer.from(VALID_SKILL_YAML, 'utf8');
        const codePy = Buffer.from('def hello():\n    return "world"\n', 'utf8');
        const testPy = Buffer.from('import unittest\nclass T(unittest.TestCase):\n    def test_ok(self):\n        pass\n', 'utf8');

        const tar = makeTarball([
          { header: createTarHeader({ name: 'skill.yaml', size: manifestYaml.length }), content: manifestYaml },
          { header: createTarHeader({ name: 'src/', typeflag: '5' }) },
          { header: createTarHeader({ name: 'src/main.py', size: codePy.length }), content: codePy },
          { header: createTarHeader({ name: 'test_main.py', size: testPy.length }), content: testPy },
        ]);
        const gz = zlib.gzipSync(tar);

        const outDir = join(tmp, 'extracted');
        const res = await extractSkillPackage(gz, outDir);
        assert.equal(res.ok, true);
        if (res.ok) {
          assert.equal(existsSync(join(outDir, 'skill.yaml')), true);
          assert.equal(existsSync(join(outDir, 'src', 'main.py')), true);
          assert.equal(existsSync(join(outDir, 'test_main.py')), true);
          assert.equal(readFileSync(join(outDir, 'src', 'main.py'), 'utf8'), 'def hello():\n    return "world"\n');
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('refuses extraction on invalid package without creating files', async () => {
      const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');

      const tmp = mkdtempSync(join(tmpdir(), 'skill-extract-test-'));
      try {
        const outDir = join(tmp, 'extracted');
        const invalidGz = Buffer.from('not-a-valid-gzip-buffer');
        const res = await extractSkillPackage(invalidGz, outDir);
        assert.equal(res.ok, false);
        assert.equal(existsSync(join(outDir, 'skill.yaml')), false);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
