import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import zlib from 'node:zlib';
import { parse as parseYaml } from 'yaml';
import {
  type SkillManifest,
  validateSkillManifest,
} from './skill.js';

export const MAX_COMPRESSED_SIZE = 5 * 1024 * 1024; // 5 MiB (A1)
export const MAX_EXPANDED_SIZE = 20 * 1024 * 1024;   // 20 MiB (A1)
export const MAX_FILES = 500;                       // 500 files (A1)
export const MAX_FILE_SIZE = 2 * 1024 * 1024;       // 2 MiB per file (A1)
export const MAX_PATH_LENGTH = 255;                 // 255 chars (A1)
export const MAX_MANIFEST_SIZE = 64 * 1024;         // 64 KiB (A19)

export const COMPILED_EXTENSIONS = new Set([
  '.pyc',
  '.pyo',
  '.so',
  '.pyd',
  '.dll',
  '.dylib',
  '.exe',
  '.bin',
  '.wasm',
  '.class',
  '.jar',
  '.whl',
]);

export type PackageFileInfo = {
  path: string;
  size: number;
  isDirectory: boolean;
};

export type ValidatedSkillPackage = {
  ok: true;
  sha256: string;
  manifest: SkillManifest;
  rawManifest: Record<string, unknown>;
  files: PackageFileInfo[];
};

export type FailedSkillPackage = {
  ok: false;
  issues: string[];
};

export type SkillPackageValidation = ValidatedSkillPackage | FailedSkillPackage;

/**
 * Checks whether a buffer represents a single gzip stream with no trailing bytes (A19).
 * Uses a single-pass inflateRaw with maxOutputLength bound to prevent decompression bombs.
 * Returns the uncompressed buffer if valid, or null if invalid.
 */
function gunzipSingleStream(gz: Buffer, issues: string[]): Buffer | null {
  if (gz.length < 18) {
    issues.push('package: buffer too small to be a gzip archive (minimum 18 bytes)');
    return null;
  }
  // Gzip magic 0x1f, 0x8b, and Deflate compression method (0x08)
  if (gz[0] !== 0x1f || gz[1] !== 0x8b || gz[2] !== 0x08) {
    issues.push('package: not a gzip stream (invalid magic or compression method)');
    return null;
  }

  // Parse gzip header to locate start of deflate block
  let pos = 10;
  const flg = gz[3];
  if (flg & 4) {
    // FEXTRA
    if (pos + 2 > gz.length) { issues.push('package: malformed gzip FEXTRA header'); return null; }
    const xlen = gz.readUInt16LE(pos);
    pos += 2 + xlen;
  }
  if (flg & 8) {
    // FNAME
    while (pos < gz.length && gz[pos] !== 0) pos++;
    pos++;
  }
  if (flg & 16) {
    // FCOMMENT
    while (pos < gz.length && gz[pos] !== 0) pos++;
    pos++;
  }
  if (flg & 2) {
    // FHCRC
    pos += 2;
  }
  if (pos >= gz.length) {
    issues.push('package: malformed gzip header');
    return null;
  }

  try {
    // Single stream inflate with exact maxOutputLength limit of 20 MiB bound (A1, A19)
    const res = zlib.inflateRawSync(gz.subarray(pos), {
      info: true,
      maxOutputLength: MAX_EXPANDED_SIZE + 1,
    }) as unknown as { buffer: Buffer | ArrayBuffer; engine?: { bytesWritten?: number } };

    const outBuf = Buffer.isBuffer(res.buffer) ? res.buffer : Buffer.from(res.buffer);

    if (outBuf.length > MAX_EXPANDED_SIZE) {
      issues.push(`package: expanded size ${outBuf.length} exceeds 20 MiB limit (A1)`);
      return null;
    }

    const deflateConsumed = res.engine?.bytesWritten ?? (gz.length - pos - 8);
    const expectedTotal = pos + deflateConsumed + 8;
    if (expectedTotal !== gz.length) {
      if (expectedTotal < gz.length) {
        issues.push('package: must be a single gzip stream with no concatenated streams or trailing data (A19)');
      } else {
        issues.push('package: truncated gzip archive (missing or truncated trailer) (A19)');
      }
      return null;
    }

    // Verify gzip trailer: 4 bytes CRC-32 (LE), 4 bytes ISIZE (LE)
    const trailerCrc = gz.readUInt32LE(pos + deflateConsumed);
    const computedCrc = zlib.crc32(outBuf);
    if (trailerCrc !== computedCrc) {
      issues.push(`package: gzip CRC32 mismatch (computed ${computedCrc.toString(16)}, trailer ${trailerCrc.toString(16)})`);
      return null;
    }

    const trailerIsize = gz.readUInt32LE(pos + deflateConsumed + 4);
    const expectedIsize = outBuf.length >>> 0;
    if (trailerIsize !== expectedIsize) {
      issues.push(`package: gzip ISIZE mismatch (decompressed ${expectedIsize}, trailer ${trailerIsize})`);
      return null;
    }

    return outBuf;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('larger than') || (err as { code?: string })?.code === 'ERR_BUFFER_TOO_LARGE') {
      issues.push('package: expanded size exceeds 20 MiB limit (A1)');
    } else {
      issues.push(`package: decompression failed (${msg})`);
    }
    return null;
  }
}

/**
 * Parses a fixed-width octal field strictly from a tar block (A19).
 */
function parseOctal(buf: Buffer, start: number, length: number, fieldName: string, issues: string[]): number | null {
  const slice = buf.subarray(start, start + length);
  let str = slice.toString('ascii').replace(/[\0 ]+$/, '').trim();
  if (str === '') return 0;
  if (!/^[0-7]+$/.test(str)) {
    issues.push(`package: malformed octal in tar field "${fieldName}" (A19)`);
    return null;
  }
  const val = parseInt(str, 8);
  if (Number.isNaN(val) || val < 0) {
    issues.push(`package: malformed octal in tar field "${fieldName}" (A19)`);
    return null;
  }
  return val;
}

/**
 * Computes and verifies the header checksum of a 512-byte tar header block (A19).
 */
function verifyTarHeaderChecksum(block: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    if (i >= 148 && i < 156) {
      sum += 32; // treat chksum field as 8 ASCII spaces
    } else {
      sum += block[i];
    }
  }

  const chkSlice = block.subarray(148, 156).toString('ascii').replace(/[\0 ]+$/, '').trim();
  if (!/^[0-7]+$/.test(chkSlice)) return false;
  const recorded = parseInt(chkSlice, 8);
  return sum === recorded;
}

/**
 * Validates a gzip tarball in memory without extracting to disk (A1, A19).
 */
export function validateSkillPackage(gz: Buffer): SkillPackageValidation {
  const issues: string[] = [];

  if (gz.length > MAX_COMPRESSED_SIZE) {
    issues.push(`package: compressed size ${gz.length} exceeds 5 MiB limit (A1)`);
    return { ok: false, issues };
  }

  const tar = gunzipSingleStream(gz, issues);
  if (!tar) {
    return { ok: false, issues };
  }

  if (tar.length > MAX_EXPANDED_SIZE) {
    issues.push(`package: expanded size ${tar.length} exceeds 20 MiB limit (A1)`);
    return { ok: false, issues };
  }

  const sha256 = createHash('sha256').update(gz).digest('hex');

  // Parse tar blocks (512 bytes each)
  const files: PackageFileInfo[] = [];
  const seenPaths = new Set<string>();
  const seenCaseFolded = new Set<string>();
  let skillYamlContent: string | null = null;
  let hasPython = false;
  let hasTests = false;

  let offset = 0;
  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512);

    // Check for two consecutive 512-byte zero blocks indicating end of archive
    let isZeroBlock = true;
    for (let i = 0; i < 512; i++) {
      if (block[i] !== 0) {
        isZeroBlock = false;
        break;
      }
    }
    if (isZeroBlock) {
      offset += 512;
      continue;
    }

    // Header checksum verification (A19)
    if (!verifyTarHeaderChecksum(block)) {
      issues.push(`package: tar header checksum verification failed at offset ${offset} (A19)`);
      return { ok: false, issues };
    }

    // Name (bytes 0..99)
    let nameEnd = block.indexOf(0, 0);
    if (nameEnd === -1 || nameEnd > 100) nameEnd = 100;
    const namePart = block.subarray(0, nameEnd).toString('utf8');

    // Prefix (bytes 345..499) for ustar
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
    const cleanPath = rawPath.replace(/\/+$/, ''); // strip trailing slash

    if (!cleanPath) {
      offset += 512;
      continue;
    }

    // Mode (bytes 100..107, octal)
    const mode = parseOctal(block, 100, 8, 'mode', issues);
    if (mode === null) {
      return { ok: false, issues };
    }

    // Size (bytes 124..135, octal)
    const size = parseOctal(block, 124, 12, 'size', issues);
    if (size === null) {
      return { ok: false, issues };
    }

    // Typeflag (byte 156)
    const typeflag = String.fromCharCode(block[156]);

    // Check for pax or GNU long-name headers (refused per A19)
    if (typeflag === 'x' || typeflag === 'g') {
      issues.push(`package: pax extended headers are refused (${cleanPath}) (A19)`);
    }
    if (typeflag === 'L' || typeflag === 'K') {
      issues.push(`package: GNU long-name headers are refused (${cleanPath}) (A19)`);
    }

    // Only allow regular files ('0' or '\0') and directories ('5') (A19)
    const isRegular = typeflag === '0' || typeflag === '\0';
    const isDir = typeflag === '5';
    if (!isRegular && !isDir) {
      issues.push(`package: entry "${cleanPath}" has forbidden type "${typeflag}"; only regular files and directories are accepted (A19)`);
    }

    // Setuid / setgid / sticky bits refused (A19)
    if ((mode & 0o7000) !== 0) {
      issues.push(`package: entry "${cleanPath}" has forbidden setuid/setgid/sticky bits set (${(mode & 0o7000).toString(8)}) (A19)`);
    }

    // Path constraints (A1, A19)
    if (cleanPath.length > MAX_PATH_LENGTH) {
      issues.push(`package: path "${cleanPath}" exceeds 255 character limit (A1)`);
    }
    if (cleanPath.startsWith('/') || /^[a-zA-Z]:/.test(cleanPath)) {
      issues.push(`package: absolute path "${cleanPath}" is refused (A19)`);
    }
    if (cleanPath.includes('\\')) {
      issues.push(`package: backslash in path "${cleanPath}" is refused (A19)`);
    }
    const segments = cleanPath.split('/');
    if (segments.includes('..') || segments.includes('.')) {
      issues.push(`package: relative traversal segment in "${cleanPath}" is refused (A19)`);
    }
    for (let i = 0; i < cleanPath.length; i++) {
      const code = cleanPath.charCodeAt(i);
      if (code < 32 || code === 127) {
        issues.push(`package: control character in path "${cleanPath}" is refused (A19)`);
        break;
      }
    }

    // Check forbidden names .git and __pycache__ (A19)
    if (segments.some((s) => s === '.git' || s === '__pycache__')) {
      issues.push(`package: forbidden entry "${cleanPath}" contains .git or __pycache__ (A19)`);
    }

    // Duplicate and case-collision checks (A19)
    if (seenPaths.has(cleanPath)) {
      issues.push(`package: duplicate entry "${cleanPath}" (A19)`);
    }
    seenPaths.add(cleanPath);

    const folded = cleanPath.toLowerCase();
    if (seenCaseFolded.has(folded)) {
      issues.push(`package: case-colliding entry "${cleanPath}" (A19)`);
    }
    seenCaseFolded.add(folded);

    // Verify content length does not exceed archive
    const contentBlocks = Math.ceil(size / 512);
    if (offset + 512 + contentBlocks * 512 > tar.length) {
      issues.push(`package: truncated content for file "${cleanPath}" (A19)`);
      return { ok: false, issues };
    }

    // File size and compiled binary checks
    if (isRegular) {
      if (size > MAX_FILE_SIZE) {
        issues.push(`package: file "${cleanPath}" size ${size} exceeds 2 MiB limit (A1)`);
      }

      const lower = cleanPath.toLowerCase();
      for (const ext of COMPILED_EXTENSIONS) {
        if (lower.endsWith(ext)) {
          issues.push(`package: compiled binary "${cleanPath}" is refused (A19)`);
          break;
        }
      }

      // Read skill.yaml if at root
      if (cleanPath === 'skill.yaml') {
        if (size > MAX_MANIFEST_SIZE) {
          issues.push(`package: skill.yaml size ${size} exceeds 64 KiB limit (A19)`);
        } else {
          const contentStart = offset + 512;
          const contentEnd = contentStart + size;
          skillYamlContent = tar.subarray(contentStart, contentEnd).toString('utf8');
        }
      }

      // Check python code and test detection
      const isVendor = segments[0] === 'vendor';
      if (!isVendor) {
        if (cleanPath.endsWith('.py')) {
          hasPython = true;
        }
        if (
          segments.includes('tests') ||
          segments.includes('test') ||
          segments[segments.length - 1].startsWith('test_') ||
          segments[segments.length - 1].endsWith('_test.py')
        ) {
          hasTests = true;
        }
      }
    } else if (isDir && size !== 0) {
      issues.push(`package: directory "${cleanPath}" has non-zero size ${size} (A19)`);
    }

    files.push({
      path: cleanPath,
      size: isRegular ? size : 0,
      isDirectory: isDir,
    });

    // Advance offset: 512 byte header + padded content blocks
    offset += 512 + contentBlocks * 512;
  }

  if (files.length > MAX_FILES) {
    issues.push(`package: file count ${files.length} exceeds 500 file limit (A1)`);
  }

  if (!skillYamlContent) {
    issues.push('package: missing skill.yaml at package root (A1)');
  }

  if (!hasPython) {
    issues.push('package: package must contain Python code (.py) outside vendor/ (A1, A2)');
  }

  if (!hasTests) {
    issues.push('package: package must contain tests outside vendor/ (A1, A2)');
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  // Parse skill.yaml and validate schema
  let rawManifest: Record<string, unknown>;
  try {
    rawManifest = parseYaml(skillYamlContent!) as Record<string, unknown>;
  } catch (err) {
    issues.push(`manifest: skill.yaml does not parse (${err instanceof Error ? err.message : String(err)})`);
    return { ok: false, issues };
  }

  if (typeof rawManifest !== 'object' || rawManifest === null || Array.isArray(rawManifest)) {
    issues.push('manifest: skill.yaml must be a mapping');
    return { ok: false, issues };
  }

  if (rawManifest.spec !== 1) {
    issues.push('manifest.spec: skill packages must declare spec: 1 (A1)');
    return { ok: false, issues };
  }

  const manifestResult = validateSkillManifest(rawManifest);
  if (!manifestResult.ok) {
    for (const item of manifestResult.issues) {
      issues.push(`manifest.${item.path}: ${item.message}`);
    }
    return { ok: false, issues };
  }

  return {
    ok: true,
    sha256,
    manifest: manifestResult.manifest,
    rawManifest,
    files,
  };
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
    block.write('00000000000\0', 136, 12, 'ascii'); // mtime (0 for reproducibility)

    // Checksum placeholder: 8 ASCII spaces
    block.fill(32, 148, 156);

    // Typeflag
    block[156] = isDir ? 53 : 48; // '5' or '0'

    // Magic and version
    block.write('ustar\0', 257, 6, 'ascii');
    block.write('00', 263, 2, 'ascii');

    if (prefixPart) {
      block.write(prefixPart, 345, 155, 'utf8');
    }

    // Calculate checksum
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += block[i];
    const chkStr = sum.toString(8).padStart(6, '0') + '\0 ';
    block.write(chkStr, 148, 8, 'ascii');

    tarBlocks.push(block);
  }

  function addDir(currentDir: string): void {
    const entries = readdirSync(currentDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === '__pycache__' || entry.name.endsWith('.pyc')) {
        continue;
      }
      const fullPath = join(currentDir, entry.name);
      const relPath = relative(dir, fullPath).replace(/\\/g, '/');

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
  return zlib.gzipSync(tarBuffer);
}

/**
 * Safely extracts a verified skill package to target directory (A19).
 * Enforces all A19 security constraints on extraction.
 */
export function extractSkillPackage(gz: Buffer, targetDir: string): ValidatedSkillPackage {
  const validation = validateSkillPackage(gz);
  if (!validation.ok) {
    throw new Error(`cannot extract invalid skill package: ${validation.issues.join('; ')}`);
  }

  const issues: string[] = [];
  const tar = gunzipSingleStream(gz, issues);
  if (!tar) {
    throw new Error(`failed to decompress skill package: ${issues.join('; ')}`);
  }

  const resolvedTarget = resolve(targetDir);
  mkdirSync(resolvedTarget, { recursive: true });

  let offset = 0;
  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512);

    let isZeroBlock = true;
    for (let i = 0; i < 512; i++) {
      if (block[i] !== 0) {
        isZeroBlock = false;
        break;
      }
    }
    if (isZeroBlock) {
      offset += 512;
      continue;
    }

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

  return validation;
}
