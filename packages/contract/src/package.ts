/**
 * Skill package specification, validator, and safe extraction (A1, A19).
 *
 * Implements strict single-pass decompression bounds, ustar header checksums,
 * strict octal parsing, path normalization, hierarchy conflict guards,
 * typeflag guards, setuid guards, and Python `tarfile` agreement.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { validateSkillManifest, type SkillManifest } from './skill.js';

export const MAX_PACKAGE_SIZE = 5 * 1024 * 1024; // 5 MiB compressed (A1, A19)
export const MAX_EXPANDED_SIZE = 20 * 1024 * 1024; // 20 MiB uncompressed (A1, A19)
export const MAX_FILES = 500; // 500 files total (A1, A19)
export const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MiB per file (A1, A19)
export const MAX_PATH_LENGTH = 255; // 255 bytes max path (POSIX ustar prefix + name) (A19)
export const MAX_SKILL_YAML_SIZE = 64 * 1024; // 64 KiB max for skill.yaml (A19)

const BANNED_EXTENSIONS = new Set([
  '.pyc',
  '.pyo',
  '.pyd',
  '.so',
  '.dylib',
  '.dll',
  '.exe',
]);

const BANNED_SEGMENTS = new Set([
  '.git',
  '__pycache__',
  'node_modules',
  '.venv',
  'venv',
  '.DS_Store',
]);

export type ValidatedSkillPackage =
  | {
      ok: true;
      manifest: SkillManifest;
      sha256: string;
      files: string[];
      totalExpandedBytes: number;
    }
  | {
      ok: false;
      issues: string[];
    };

/**
 * Strict fixed-width octal parser for tar header fields (A19).
 * Rejects NaN, non-octal characters, and truncated fields.
 */
export function parseOctal(buf: Buffer, offset: number, length: number, fieldName: string, issues: string[]): number | null {
  const field = buf.subarray(offset, offset + length);
  let str = '';
  for (let i = 0; i < field.length; i++) {
    const b = field[i];
    if (b === 0 || b === 0x20) {
      if (str.length > 0) break; // trailing NUL or space after digits
      continue; // leading spaces/NULs
    }
    if (b >= 0x30 && b <= 0x37) {
      str += String.fromCharCode(b);
    } else {
      issues.push(`malformed octal in tar header ${fieldName} at offset ${offset} (A19)`);
      return null;
    }
  }
  if (str.length === 0) return 0;
  const val = parseInt(str, 8);
  if (Number.isNaN(val)) {
    issues.push(`invalid octal in tar header ${fieldName} at offset ${offset} (A19)`);
    return null;
  }
  return val;
}

/**
 * Validates tar header checksum against unsigned and signed sums (A19).
 */
export function verifyTarHeaderChecksum(block: Buffer, offset: number, issues: string[]): boolean {
  const recordedChecksum = parseOctal(block, 148, 8, 'chksum', issues);
  if (recordedChecksum === null) return false;

  let unsignedSum = 0;
  let signedSum = 0;

  for (let i = 0; i < 512; i++) {
    const val = (i >= 148 && i < 156) ? 0x20 : block[i];
    unsignedSum += val;
    signedSum += (val > 127 ? val - 256 : val);
  }

  if (recordedChecksum !== unsignedSum && recordedChecksum !== signedSum) {
    issues.push(`invalid tar header checksum at offset ${offset} (recorded ${recordedChecksum}, calculated ${unsignedSum}) (A19)`);
    return false;
  }
  return true;
}

/**
 * Single-pass gzip decompressor enforcing single-stream execution and output size limits (A19).
 */
export function gunzipSingleStream(gz: Buffer, issues: string[]): Buffer | null {
  if (gz.length < 18) {
    issues.push('gzip archive too short to contain a valid gzip header and trailer (A19)');
    return null;
  }

  // Verify gzip magic
  if (gz[0] !== 0x1f || gz[1] !== 0x8b) {
    issues.push('package is not a valid gzip file (bad magic) (A19)');
    return null;
  }

  // Compression method must be deflate (8)
  if (gz[2] !== 0x08) {
    issues.push(`unsupported gzip compression method: ${gz[2]} (expected 8) (A19)`);
    return null;
  }

  const flags = gz[3];
  let pos = 10; // skip magic (2), method (1), flags (1), mtime (4), xfl (1), os (1)

  // FEXTRA
  if (flags & 0x04) {
    if (pos + 2 > gz.length) {
      issues.push('truncated gzip header in FEXTRA (A19)');
      return null;
    }
    const xlen = gz.readUInt16LE(pos);
    pos += 2 + xlen;
  }

  // FNAME
  if (flags & 0x08) {
    while (pos < gz.length && gz[pos] !== 0) pos++;
    pos++; // skip null
  }

  // FCOMMENT
  if (flags & 0x10) {
    while (pos < gz.length && gz[pos] !== 0) pos++;
    pos++; // skip null
  }

  // FHCRC
  if (flags & 0x02) {
    pos += 2;
  }

  if (pos >= gz.length - 8) {
    issues.push('truncated gzip header before deflate stream (A19)');
    return null;
  }

  // InflateRawSync with bounded maxOutputLength
  let res: { buffer: Buffer | ArrayBuffer; engine?: { bytesWritten?: number } };
  try {
    const rawRes = zlib.inflateRawSync(gz.subarray(pos), {
      maxOutputLength: MAX_EXPANDED_SIZE + 1,
      info: true,
    } as any);
    res = rawRes as unknown as { buffer: Buffer | ArrayBuffer; engine?: { bytesWritten?: number } };
  } catch (err: any) {
    if (err?.code === 'ERR_BUFFER_TOO_LARGE' || err?.message?.includes('maxOutputLength')) {
      issues.push(`package expanded size exceeds ${MAX_EXPANDED_SIZE} bytes (A19)`);
      return null;
    }
    issues.push(`failed to decompress gzip stream: ${err?.message || String(err)} (A19)`);
    return null;
  }

  const outBuf = Buffer.isBuffer(res.buffer) ? res.buffer : Buffer.from(res.buffer);

  if (outBuf.length > MAX_EXPANDED_SIZE) {
    issues.push(`package expanded size exceeds ${MAX_EXPANDED_SIZE} bytes (A19)`);
    return null;
  }

  // Consumed deflate bytes check
  const deflateConsumed = res.engine?.bytesWritten;
  if (typeof deflateConsumed !== 'number' || deflateConsumed <= 0) {
    issues.push('could not determine consumed deflate stream length (A19)');
    return null;
  }

  // Verify single-stream: pos + deflateConsumed + 8 (trailer) must exactly equal gz.length
  if (pos + deflateConsumed + 8 !== gz.length) {
    issues.push('package contains trailing data or multiple gzip members; only single-stream gzip is permitted (A19)');
    return null;
  }

  // Verify trailer CRC32 and ISIZE
  const trailerCrc = gz.readUInt32LE(gz.length - 8);
  const trailerIsize = gz.readUInt32LE(gz.length - 4);

  const actualCrc = zlib.crc32(outBuf);
  if (trailerCrc !== actualCrc) {
    issues.push(`gzip CRC32 mismatch (expected ${trailerCrc}, calculated ${actualCrc}) (A19)`);
    return null;
  }

  const actualIsize = (outBuf.length >>> 0) & 0xffffffff;
  if (trailerIsize !== actualIsize) {
    issues.push(`gzip ISIZE mismatch (expected ${trailerIsize}, calculated ${actualIsize}) (A19)`);
    return null;
  }

  return outBuf;
}

/**
 * Validates a skill package buffer according to A1, A19, and A22.
 */
export async function validateSkillPackage(buffer: Buffer): Promise<ValidatedSkillPackage> {
  const issues: string[] = [];

  if (buffer.length > MAX_PACKAGE_SIZE) {
    issues.push(`package size (${buffer.length} bytes) exceeds maximum of ${MAX_PACKAGE_SIZE} bytes (A19)`);
    return { ok: false, issues };
  }

  const sha256 = createHash('sha256').update(buffer).digest('hex');

  const tar = gunzipSingleStream(buffer, issues);
  if (!tar) {
    return { ok: false, issues };
  }

  const files: string[] = [];
  const allFiles = new Set<string>();
  const allDirs = new Set<string>();
  const parentDirs = new Set<string>();
  const seenPathsLower = new Map<string, string>();
  let totalExpandedBytes = 0;
  let skillYamlContent: string | null = null;
  let hasTests = false;

  let offset = 0;
  let seenEndMarker = false;

  while (offset < tar.length) {
    if (offset + 512 > tar.length) {
      issues.push('archive ends with truncated tar header block (A19)');
      break;
    }

    const block = tar.subarray(offset, offset + 512);

    let isZeroBlock = true;
    for (let i = 0; i < 512; i++) {
      if (block[i] !== 0) {
        isZeroBlock = false;
        break;
      }
    }

    if (isZeroBlock) {
      seenEndMarker = true;
      offset += 512;
      continue;
    }

    if (seenEndMarker) {
      issues.push('archive contains non-zero data after end-of-archive marker (A19)');
      break;
    }

    if (!verifyTarHeaderChecksum(block, offset, issues)) {
      offset += 512;
      continue;
    }

    let nameEnd = block.indexOf(0, 0);
    if (nameEnd === -1 || nameEnd > 100) nameEnd = 100;
    const namePart = block.subarray(0, nameEnd).toString('utf8');

    // Prefix field at offset 345 (up to 155 bytes)
    const prefixBytes = block.subarray(345, 500);
    let hasPrefix = false;
    for (let i = 0; i < prefixBytes.length; i++) {
      if (prefixBytes[i] !== 0) {
        hasPrefix = true;
        break;
      }
    }

    const magic = block.subarray(257, 263).toString('ascii');
    const isUstar = magic.startsWith('ustar');

    if (hasPrefix && !isUstar) {
      issues.push(`header has non-empty prefix field without POSIX ustar magic (A19): "${namePart}"`);
    }

    let prefixPart = '';
    if (isUstar && hasPrefix) {
      let prefixEnd = block.indexOf(0, 345);
      if (prefixEnd === -1 || prefixEnd > 500) prefixEnd = 500;
      prefixPart = block.subarray(345, prefixEnd).toString('utf8');
    }

    const rawPath = prefixPart ? `${prefixPart}/${namePart}` : namePart;

    if (!rawPath || rawPath.trim() === '') {
      issues.push(`empty entry path at header offset ${offset} (A19)`);
      offset += 512;
      continue;
    }

    if (/[\x00-\x1f\x7f]/.test(rawPath)) {
      issues.push(`file path contains illegal control characters (A19): "${rawPath}"`);
    }

    if (Buffer.byteLength(rawPath, 'utf8') > MAX_PATH_LENGTH) {
      issues.push(`path length (${Buffer.byteLength(rawPath, 'utf8')} bytes) exceeds limit of ${MAX_PATH_LENGTH} (A19): "${rawPath}"`);
    }

    if (rawPath.startsWith('/') || rawPath.startsWith('\\')) {
      issues.push(`path must not be absolute (A19): "${rawPath}"`);
    }

    if (rawPath.includes('\\')) {
      issues.push(`path must not contain backslashes (A19): "${rawPath}"`);
    }

    const segments = rawPath.split('/');
    if (segments.some((s) => s === '..')) {
      issues.push(`directory traversal not allowed in path (A19): "${rawPath}"`);
    }

    const mode = parseOctal(block, 100, 8, 'mode', issues) ?? 0;
    if (mode & 0o4000) issues.push(`setuid bit forbidden (A19): "${rawPath}"`);
    if (mode & 0o2000) issues.push(`setgid bit forbidden (A19): "${rawPath}"`);
    if (mode & 0o1000) issues.push(`sticky bit forbidden (A19): "${rawPath}"`);

    const size = parseOctal(block, 124, 12, 'size', issues) ?? 0;
    const typeflag = String.fromCharCode(block[156]);

    const isRegular = typeflag === '0' || typeflag === '\0';
    const isDir = typeflag === '5';

    if (!isRegular && !isDir) {
      issues.push(`entry type '${typeflag}' not permitted (only regular files and directories allowed) (A19): "${rawPath}"`);
    }

    if (isRegular && (namePart.endsWith('/') || rawPath.endsWith('/'))) {
      issues.push(`regular file entry name ends in slash (A19): "${rawPath}"`);
    }

    const cleanPath = rawPath.replace(/\/+$/, '');
    if (!cleanPath) {
      offset += 512;
      continue;
    }

    const lower = cleanPath.toLowerCase();
    if (seenPathsLower.has(lower) && seenPathsLower.get(lower) !== cleanPath) {
      issues.push(`case-colliding paths in package (A19): "${seenPathsLower.get(lower)}" vs "${cleanPath}"`);
    } else {
      seenPathsLower.set(lower, cleanPath);
    }

    if (isDir) {
      allDirs.add(cleanPath);
    } else if (isRegular) {
      if (allFiles.has(cleanPath)) {
        issues.push(`duplicate file entry in package (A19): "${cleanPath}"`);
      }
      allFiles.add(cleanPath);
      files.push(cleanPath);

      // Record all parent directories
      const parts = cleanPath.split('/');
      for (let p = 1; p < parts.length; p++) {
        parentDirs.add(parts.slice(0, p).join('/'));
      }
    }

    // Banned files/segments check
    for (const seg of segments.filter(Boolean)) {
      if (BANNED_SEGMENTS.has(seg)) {
        issues.push(`banned path segment "${seg}" in entry (A19): "${cleanPath}"`);
      }
    }

    const ext = cleanPath.substring(cleanPath.lastIndexOf('.')).toLowerCase();
    if (BANNED_EXTENSIONS.has(ext)) {
      issues.push(`banned file extension "${ext}" in entry (A19): "${cleanPath}"`);
    }

    if (isRegular) {
      if (size > MAX_FILE_SIZE) {
        issues.push(`file size (${size} bytes) exceeds limit of ${MAX_FILE_SIZE} (A19): "${cleanPath}"`);
      }
      totalExpandedBytes += size;
      if (totalExpandedBytes > MAX_EXPANDED_SIZE) {
        issues.push(`total expanded package size exceeds limit of ${MAX_EXPANDED_SIZE} bytes (A19)`);
      }

      if (files.length > MAX_FILES) {
        issues.push(`file count exceeds maximum of ${MAX_FILES} (A19)`);
      }

      const contentBlocks = Math.ceil(size / 512);
      const contentStart = offset + 512;
      const contentEnd = contentStart + size;

      if (contentStart + contentBlocks * 512 > tar.length) {
        issues.push(`truncated file content for "${cleanPath}" (A19)`);
        break;
      }

      const content = tar.subarray(contentStart, contentEnd);

      // Check binary header magic
      if (content.length >= 4) {
        // ELF
        if (content[0] === 0x7f && content[1] === 0x45 && content[2] === 0x4c && content[3] === 0x46) {
          issues.push(`compiled binary file (ELF) forbidden (A19): "${cleanPath}"`);
        }
        // Mach-O
        if (
          (content[0] === 0xfe && content[1] === 0xed && content[2] === 0xfa && (content[3] === 0xce || content[3] === 0xcf)) ||
          ((content[0] === 0xce || content[0] === 0xcf) && content[1] === 0xfa && content[2] === 0xed && content[3] === 0xfe)
        ) {
          issues.push(`compiled binary file (Mach-O) forbidden (A19): "${cleanPath}"`);
        }
      }
      // PE / MZ
      if (content.length >= 2 && content[0] === 0x4d && content[1] === 0x5a) {
        issues.push(`compiled binary file (PE/EXE) forbidden (A19): "${cleanPath}"`);
      }

      // Check null bytes in source/text files
      const textExts = ['.py', '.yaml', '.yml', '.json', '.txt', '.md'];
      if (textExts.includes(ext) && content.includes(0)) {
        issues.push(`unexpected null bytes in source file (A19): "${cleanPath}"`);
      }

      if (cleanPath === 'skill.yaml') {
        if (size > MAX_SKILL_YAML_SIZE) {
          issues.push(`skill.yaml size (${size} bytes) exceeds limit of ${MAX_SKILL_YAML_SIZE} (A19)`);
        } else {
          skillYamlContent = content.toString('utf8');
        }
      }

      // Check test files outside vendor/
      if (!cleanPath.startsWith('vendor/')) {
        const basename = cleanPath.split('/').pop() || '';
        if (
          cleanPath.startsWith('tests/') ||
          cleanPath.includes('/tests/') ||
          basename.startsWith('test_') ||
          basename.endsWith('_test.py')
        ) {
          hasTests = true;
        }
      }
    }

    const contentBlocks = Math.ceil(size / 512);
    offset += 512 + contentBlocks * 512;
  }

  // Hierarchy conflict guard: a path cannot be both a regular file and a directory parent
  for (const file of allFiles) {
    if (allDirs.has(file)) {
      issues.push(`path is declared as both a regular file and a directory (A19): "${file}"`);
    }
    if (parentDirs.has(file)) {
      issues.push(`entry is both a regular file and a directory parent (A19): "${file}"`);
    }
  }

  if (!skillYamlContent) {
    issues.push('package must contain a skill.yaml at root (A1, A19)');
    return { ok: false, issues };
  }

  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(skillYamlContent);
  } catch (err: any) {
    issues.push(`skill.yaml is not valid YAML: ${err?.message || String(err)}`);
    return { ok: false, issues };
  }

  if (!parsedYaml || typeof parsedYaml !== 'object' || Array.isArray(parsedYaml)) {
    issues.push('skill.yaml must be an object');
    return { ok: false, issues };
  }

  const rawManifest = parsedYaml as Record<string, unknown>;

  if (rawManifest.spec !== 1) {
    issues.push(`skill package skill.yaml must declare spec: 1 (got ${JSON.stringify(rawManifest.spec)}) (A22)`);
  }

  if ('visibility' in rawManifest) {
    issues.push('skill packages drop visibility field from skill.yaml (A22, H11)');
  }

  if ('owner' in rawManifest) {
    issues.push('skill packages drop owner field from skill.yaml (A22, H11)');
  }

  const { spec: _spec, ...manifestBody } = rawManifest;
  const manifestChecked = validateSkillManifest(manifestBody);
  if (!manifestChecked.ok) {
    for (const issue of manifestChecked.issues) {
      issues.push(`manifest.${issue.path}: ${issue.message}`);
    }
  }

  if (!hasTests) {
    issues.push('package must contain tests outside vendor/ (A1, A2)');
  }

  if (issues.length > 0 || !manifestChecked.ok) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    manifest: manifestChecked.manifest,
    sha256,
    files,
    totalExpandedBytes,
  };
}

/**
 * Safely extracts a verified skill package to target directory (A19).
 * Enforces all A19 security constraints on extraction.
 */
export function extractSkillPackage(gz: Buffer, targetDir: string): ValidatedSkillPackage {
  const issues: string[] = [];
  const tar = gunzipSingleStream(gz, issues);
  if (!tar) {
    throw new Error(`cannot extract invalid skill package: ${issues.join('; ')}`);
  }

  const resolvedTarget = resolve(targetDir);
  mkdirSync(resolvedTarget, { recursive: true });

  let offset = 0;
  let seenEndMarker = false;

  while (offset < tar.length) {
    if (offset + 512 > tar.length) break;
    const block = tar.subarray(offset, offset + 512);

    let isZeroBlock = true;
    for (let i = 0; i < 512; i++) {
      if (block[i] !== 0) {
        isZeroBlock = false;
        break;
      }
    }
    if (isZeroBlock) {
      seenEndMarker = true;
      offset += 512;
      continue;
    }
    if (seenEndMarker) break;

    let nameEnd = block.indexOf(0, 0);
    if (nameEnd === -1 || nameEnd > 100) nameEnd = 100;
    const namePart = block.subarray(0, nameEnd).toString('utf8');

    let prefixPart = '';
    const magic = block.subarray(257, 263).toString('ascii');
    if (magic.startsWith('ustar')) {
      let prefixEnd = block.indexOf(0, 345);
      if (prefixEnd === -1 || prefixEnd > 500) prefixEnd = 500;
      if (prefixEnd > 345) {
        prefixPart = block.subarray(345, prefixEnd).toString('utf8');
      }
    }

    const rawPath = prefixPart ? `${prefixPart}/${namePart}` : namePart;
    const cleanPath = rawPath.replace(/\/+$/, '');
    if (!cleanPath) {
      offset += 512;
      continue;
    }

    const size = parseOctal(block, 124, 12, 'size', issues) ?? 0;
    const typeflag = String.fromCharCode(block[156]);
    const isRegular = typeflag === '0' || typeflag === '\0';
    const isDir = typeflag === '5';

    const destPath = resolve(resolvedTarget, cleanPath);
    if (!destPath.startsWith(resolvedTarget + '/') && destPath !== resolvedTarget) {
      throw new Error(`package entry "${cleanPath}" escapes target directory (A19)`);
    }

    if (isDir) {
      mkdirSync(destPath, { recursive: true });
    } else if (isRegular) {
      mkdirSync(dirname(destPath), { recursive: true });
      const content = tar.subarray(offset + 512, offset + 512 + size);
      writeFileSync(destPath, content, { mode: 0o644 });
    }

    const contentBlocks = Math.ceil(size / 512);
    offset += 512 + contentBlocks * 512;
  }

  try {
    const manifestContent = readFileSync(join(resolvedTarget, 'skill.yaml'), 'utf8');
    const parsed = parseYaml(manifestContent) as Record<string, unknown>;
    const { spec: _spec, ...manifestBody } = parsed;
    const checked = validateSkillManifest(manifestBody);
    if (!checked.ok) {
      throw new Error(`invalid skill manifest in extracted package: ${checked.issues.map((i) => i.message).join('; ')}`);
    }
    const sha256 = createHash('sha256').update(gz).digest('hex');
    return {
      ok: true,
      manifest: checked.manifest,
      sha256,
      files: [],
      totalExpandedBytes: 0,
    };
  } catch (err: any) {
    throw new Error(`cannot extract skill package: ${err?.message || String(err)}`);
  }
}

/**
 * Builds a conforming .tar.gz buffer from a directory (A6).
 */
export async function packSkillDirectory(dir: string): Promise<Buffer> {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`directory not found: ${dir}`);
  }

  const tarBlocks: Buffer[] = [];

  function writeHeader(name: string, size: number, isDir: boolean, mode = isDir ? 0o755 : 0o644): void {
    const block = Buffer.alloc(512, 0);

    // In POSIX ustar format, name can be split at a slash such that:
    // prefix is at most 155 bytes, name is at most 100 bytes (A19).
    let namePart = name;
    let prefixPart = '';
    const byteLen = Buffer.byteLength(name, 'utf8');
    if (byteLen > 100) {
      if (byteLen > MAX_PATH_LENGTH) {
        throw new Error(`path exceeds 255 byte tar ustar limit: ${name}`);
      }
      let split = -1;
      for (let i = Math.min(name.length - 1, 155); i >= 0; i--) {
        if (
          name[i] === '/' &&
          Buffer.byteLength(name.substring(0, i), 'utf8') <= 155 &&
          Buffer.byteLength(name.substring(i + 1), 'utf8') <= 100
        ) {
          split = i;
          break;
        }
      }
      if (split === -1) {
        throw new Error(`path cannot be split into ustar prefix (<=155) and name (<=100): ${name}`);
      }
      prefixPart = name.substring(0, split);
      namePart = name.substring(split + 1);
    }

    block.write(namePart, 0, 100, 'utf8');
    block.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii'); // mode
    block.write('0000000\0', 108, 8, 'ascii'); // uid
    block.write('0000000\0', 116, 8, 'ascii'); // gid
    block.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii'); // size
    block.write('00000000000\0', 136, 12, 'ascii'); // mtime (deterministic: 0)
    block.write(isDir ? '5' : '0', 156, 1, 'ascii'); // typeflag
    block.write('ustar\0', 257, 6, 'ascii'); // magic
    block.write('00', 263, 2, 'ascii'); // version
    if (prefixPart) {
      block.write(prefixPart, 345, 155, 'utf8'); // prefix
    }

    // Compute checksum treating chksum field as 8 spaces (0x20)
    let sum = 0;
    for (let i = 0; i < 512; i++) {
      sum += (i >= 148 && i < 156) ? 0x20 : block[i];
    }
    block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');

    tarBlocks.push(block);
  }

  function addDir(currentPath: string): void {
    const entries = readdirSync(currentPath, { withFileTypes: true });
    // Sort deterministically (byte-wise)
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (BANNED_SEGMENTS.has(entry.name)) continue;

      const fullPath = join(currentPath, entry.name);
      const relPath = fullPath.substring(dir.length).replace(/^[/\\]+/, '').replace(/\\/g, '/');

      if (entry.isDirectory()) {
        writeHeader(`${relPath}/`, 0, true);
        addDir(fullPath);
      } else if (entry.isFile()) {
        const content = readFileSync(fullPath);
        writeHeader(relPath, content.length, false);

        // Add content padded to 512-byte block
        tarBlocks.push(content);
        const remainder = content.length % 512;
        if (remainder > 0) {
          tarBlocks.push(Buffer.alloc(512 - remainder, 0));
        }
      }
    }
  }

  addDir(dir);

  // Two 512-byte zero blocks at end of tar archive
  tarBlocks.push(Buffer.alloc(1024, 0));

  const tarBuffer = Buffer.concat(tarBlocks);
  const gz = zlib.gzipSync(tarBuffer);

  const checked = await validateSkillPackage(gz);
  if (!checked.ok) {
    throw new Error(`cannot pack skill: ${checked.issues.join('; ')}`);
  }

  return gz;
}
