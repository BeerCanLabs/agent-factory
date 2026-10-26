/**
 * Skill package specification and validator (A1, A19, A22, H7).
 *
 * Implements single-pass decompression bounds, ustar header checksums,
 * strict octal parsing aligned with Python `tarfile`, path normalization,
 * hierarchy conflict guards, typeflag guards, setuid guards, and bounded work.
 */
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
export const MAX_ISSUES = 50; // Bounded issues output (A19)

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

function pushIssue(issues: string[], msg: string): void {
  if (issues.length < MAX_ISSUES) {
    issues.push(msg);
  }
}

/**
 * Strict numeric field parser for tar header fields aligned with Python `tarfile` (A19).
 *
 * Python's `tarfile.nti` stops at the first NUL terminator and strips spaces.
 * This parser stops at the first NUL, rejects any non-zero bytes after the terminator,
 * rejects non-octal characters, rejects base-256 binary encoding, and enforces safe bounds.
 */
function parseNumericField(
  buf: Buffer,
  offset: number,
  length: number,
  fieldName: string,
  issues: string[]
): number | null {
  const field = buf.subarray(offset, offset + length);
  if (field.length === 0) return 0;

  // Refuse base-256 binary encoding (A19)
  if ((field[0] & 0x80) !== 0) {
    pushIssue(issues, `base-256 binary encoding not permitted in tar header ${fieldName} at offset ${offset} (A19)`);
    return null;
  }

  // Find first NUL terminator
  const nulIdx = field.indexOf(0);
  const beforeNul = nulIdx !== -1 ? field.subarray(0, nulIdx) : field;

  // After the first NUL, all remaining bytes in the fixed-width field must be padding (NUL or space)
  if (nulIdx !== -1) {
    for (let i = nulIdx + 1; i < field.length; i++) {
      if (field[i] !== 0 && field[i] !== 0x20) {
        pushIssue(
          issues,
          `malformed tar header ${fieldName} at offset ${offset}: non-padding byte after NUL terminator (A19)`
        );
        return null;
      }
    }
  }

  const rawStr = beforeNul.toString('ascii');
  const trimmed = rawStr.trim();
  if (trimmed === '') {
    return 0;
  }

  // Stricter than Python: only octal digits 0-7 allowed (no embedded spaces or trailing non-octal chars)
  if (!/^[0-7]+$/.test(trimmed)) {
    pushIssue(issues, `malformed octal in tar header ${fieldName} at offset ${offset}: "${rawStr}" (A19)`);
    return null;
  }

  const val = parseInt(trimmed, 8);
  if (!Number.isSafeInteger(val) || val < 0) {
    pushIssue(issues, `invalid numeric value in tar header ${fieldName} at offset ${offset} (A19)`);
    return null;
  }

  return val;
}

/**
 * Validates tar header checksum against unsigned and signed sums (A19).
 */
function verifyTarHeaderChecksum(block: Buffer, offset: number, issues: string[]): boolean {
  const recordedChecksum = parseNumericField(block, 148, 8, 'chksum', issues);
  if (recordedChecksum === null) return false;

  let unsignedSum = 0;
  let signedSum = 0;

  for (let i = 0; i < 512; i++) {
    const val = (i >= 148 && i < 156) ? 0x20 : block[i];
    unsignedSum += val;
    signedSum += (val > 127 ? val - 256 : val);
  }

  if (recordedChecksum !== unsignedSum && recordedChecksum !== signedSum) {
    pushIssue(
      issues,
      `invalid tar header checksum at offset ${offset} (recorded ${recordedChecksum}, calculated ${unsignedSum}) (A19)`
    );
    return false;
  }
  return true;
}

/**
 * Normalizes a tar path component by resolving '.', collapsing '//',
 * stripping leading './' and checking for illegal characters (B1, A19).
 */
function normalizeTarPath(rawPath: string, issues: string[]): {
  normalized: string;
  isExplicitDir: boolean;
  isValid: boolean;
} {
  if (!rawPath || rawPath.trim() === '') {
    pushIssue(issues, 'empty entry path in tar header (A19)');
    return { normalized: '', isExplicitDir: false, isValid: false };
  }

  if (/[\x00-\x1f\x7f]/.test(rawPath)) {
    pushIssue(issues, `file path contains illegal control characters (A19): "${rawPath}"`);
    return { normalized: '', isExplicitDir: false, isValid: false };
  }

  if (Buffer.byteLength(rawPath, 'utf8') > MAX_PATH_LENGTH) {
    pushIssue(
      issues,
      `path length (${Buffer.byteLength(rawPath, 'utf8')} bytes) exceeds limit of ${MAX_PATH_LENGTH} (A19): "${rawPath}"`
    );
    return { normalized: '', isExplicitDir: false, isValid: false };
  }

  if (rawPath.startsWith('/') || rawPath.startsWith('\\')) {
    pushIssue(issues, `path must not be absolute (A19): "${rawPath}"`);
    return { normalized: '', isExplicitDir: false, isValid: false };
  }

  if (rawPath.includes('\\')) {
    pushIssue(issues, `path must not contain backslashes (A19): "${rawPath}"`);
    return { normalized: '', isExplicitDir: false, isValid: false };
  }

  const isExplicitDir = rawPath.endsWith('/');
  const rawParts = rawPath.split('/');
  const cleanParts: string[] = [];

  for (const part of rawParts) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      pushIssue(issues, `directory traversal not allowed in path (A19): "${rawPath}"`);
      return { normalized: '', isExplicitDir: false, isValid: false };
    }
    cleanParts.push(part);
  }

  const normalized = cleanParts.join('/');
  if (!normalized) {
    // Root directory reference like '.' or './'
    return { normalized: '', isExplicitDir: true, isValid: true };
  }

  return { normalized, isExplicitDir, isValid: true };
}

/**
 * Single-pass gzip decompressor enforcing single-stream execution and output size limits (A19).
 */
function gunzipSingleStream(gz: Buffer, issues: string[]): Buffer | null {
  if (gz.length < 18) {
    pushIssue(issues, 'gzip archive too short to contain a valid gzip header and trailer (A19)');
    return null;
  }

  // Verify gzip magic
  if (gz[0] !== 0x1f || gz[1] !== 0x8b) {
    pushIssue(issues, 'package is not a valid gzip file (bad magic) (A19)');
    return null;
  }

  // Compression method must be deflate (8)
  if (gz[2] !== 0x08) {
    pushIssue(issues, `unsupported gzip compression method: ${gz[2]} (expected 8) (A19)`);
    return null;
  }

  const flags = gz[3];
  let pos = 10; // skip magic (2), method (1), flags (1), mtime (4), xfl (1), os (1)

  // FEXTRA
  if (flags & 0x04) {
    if (pos + 2 > gz.length) {
      pushIssue(issues, 'truncated gzip header in FEXTRA (A19)');
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
    pushIssue(issues, 'truncated gzip header before deflate stream (A19)');
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
      pushIssue(issues, `package expanded size exceeds ${MAX_EXPANDED_SIZE} bytes (A19)`);
      return null;
    }
    pushIssue(issues, `failed to decompress gzip stream: ${err?.message || String(err)} (A19)`);
    return null;
  }

  const outBuf = Buffer.isBuffer(res.buffer) ? res.buffer : Buffer.from(res.buffer);

  if (outBuf.length > MAX_EXPANDED_SIZE) {
    pushIssue(issues, `package expanded size exceeds ${MAX_EXPANDED_SIZE} bytes (A19)`);
    return null;
  }

  // Consumed deflate bytes check
  const deflateConsumed = res.engine?.bytesWritten;
  if (typeof deflateConsumed !== 'number' || deflateConsumed <= 0) {
    pushIssue(issues, 'could not determine consumed deflate stream length (A19)');
    return null;
  }

  // Verify single-stream: pos + deflateConsumed + 8 (trailer) must exactly equal gz.length
  if (pos + deflateConsumed + 8 !== gz.length) {
    pushIssue(issues, 'package contains trailing data or multiple gzip members; only single-stream gzip is permitted (A19)');
    return null;
  }

  // Verify trailer CRC32 and ISIZE
  const trailerCrc = gz.readUInt32LE(gz.length - 8);
  const trailerIsize = gz.readUInt32LE(gz.length - 4);

  const actualCrc = zlib.crc32(outBuf);
  if (trailerCrc !== actualCrc) {
    pushIssue(issues, `gzip CRC32 mismatch (expected ${trailerCrc}, calculated ${actualCrc}) (A19)`);
    return null;
  }

  const actualIsize = (outBuf.length >>> 0) & 0xffffffff;
  if (trailerIsize !== actualIsize) {
    pushIssue(issues, `gzip ISIZE mismatch (expected ${trailerIsize}, calculated ${actualIsize}) (A19)`);
    return null;
  }

  return outBuf;
}

/**
 * Validates a skill package buffer according to A1, A19, A22, and H7.
 */
export async function validateSkillPackage(buffer: Buffer): Promise<ValidatedSkillPackage> {
  const issues: string[] = [];

  if (buffer.length > MAX_PACKAGE_SIZE) {
    pushIssue(issues, `package size (${buffer.length} bytes) exceeds maximum of ${MAX_PACKAGE_SIZE} bytes (A19)`);
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
    if (issues.length >= MAX_ISSUES) {
      break;
    }

    if (offset + 512 > tar.length) {
      pushIssue(issues, 'archive ends with truncated tar header block (A19)');
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
      pushIssue(issues, 'archive contains non-zero data after end-of-archive marker (A19)');
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
      pushIssue(issues, `header has non-empty prefix field without POSIX ustar magic (A19): "${namePart}"`);
    }

    let prefixPart = '';
    if (isUstar && hasPrefix) {
      let prefixEnd = block.indexOf(0, 345);
      if (prefixEnd === -1 || prefixEnd > 500) prefixEnd = 500;
      prefixPart = block.subarray(345, prefixEnd).toString('utf8');
    }

    const rawPath = prefixPart ? `${prefixPart}/${namePart}` : namePart;

    // Validate and parse all header numeric fields (mode, uid, gid, size, mtime, devmajor, devminor) (B3)
    const mode = parseNumericField(block, 100, 8, 'mode', issues);
    parseNumericField(block, 108, 8, 'uid', issues);
    parseNumericField(block, 116, 8, 'gid', issues);
    const size = parseNumericField(block, 124, 12, 'size', issues);
    parseNumericField(block, 136, 12, 'mtime', issues);
    if (isUstar) {
      parseNumericField(block, 329, 8, 'devmajor', issues);
      parseNumericField(block, 337, 8, 'devminor', issues);
    }

    const typeflag = String.fromCharCode(block[156]);
    const isRegular = typeflag === '0' || typeflag === '\0';
    const isTypeDir = typeflag === '5';

    // Normalize path (B1)
    const { normalized, isExplicitDir, isValid } = normalizeTarPath(rawPath, issues);
    if (!isValid) {
      offset += 512;
      continue;
    }

    // Root directory reference (.)
    if (normalized === '') {
      offset += 512;
      continue;
    }

    const isDir = isTypeDir || isExplicitDir;

    // Reject non-regular and non-directory entries (pax, gnu, symlink, hardlink, dev, fifo) (B6)
    if (!isRegular && !isDir) {
      pushIssue(issues, `entry type '${typeflag}' not permitted (only regular files and directories allowed) (A19): "${normalized}"`);
      offset += 512;
      continue;
    }

    // Enforce size === 0 for directory entries (B2)
    if (isDir) {
      if (size !== null && size !== 0) {
        pushIssue(issues, `directory entry has non-zero size (${size}) (A19): "${normalized}"`);
      }
    }

    // Enforce setuid, setgid, sticky bit guards (A19)
    if (mode !== null) {
      if (mode & 0o4000) pushIssue(issues, `setuid bit forbidden (A19): "${normalized}"`);
      if (mode & 0o2000) pushIssue(issues, `setgid bit forbidden (A19): "${normalized}"`);
      if (mode & 0o1000) pushIssue(issues, `sticky bit forbidden (A19): "${normalized}"`);
    }

    // Regular file ending in slash
    if (isRegular && (namePart.endsWith('/') || rawPath.endsWith('/'))) {
      pushIssue(issues, `regular file entry name ends in slash (A19): "${normalized}"`);
    }

    // Check case collisions on normalized canonical path (B1)
    const lower = normalized.toLowerCase().normalize('NFC');
    if (seenPathsLower.has(lower) && seenPathsLower.get(lower) !== normalized) {
      pushIssue(issues, `case-colliding paths in package (A19): "${seenPathsLower.get(lower)}" vs "${normalized}"`);
    } else {
      seenPathsLower.set(lower, normalized);
    }

    if (isDir) {
      allDirs.add(normalized);
      if (allDirs.size > MAX_FILES) {
        pushIssue(issues, `directory count exceeds maximum of ${MAX_FILES} (A19)`);
        break;
      }
    } else if (isRegular) {
      if (allFiles.has(normalized)) {
        pushIssue(issues, `duplicate file entry in package (A19): "${normalized}"`);
      }
      allFiles.add(normalized);
      files.push(normalized);

      // Record all parent directories
      const parts = normalized.split('/');
      for (let p = 1; p < parts.length; p++) {
        parentDirs.add(parts.slice(0, p).join('/'));
      }
    }

    // Banned segments and extensions
    const segments = normalized.split('/');
    for (const seg of segments) {
      if (BANNED_SEGMENTS.has(seg)) {
        pushIssue(issues, `banned path segment "${seg}" in entry (A19): "${normalized}"`);
      }
    }

    const dotIdx = normalized.lastIndexOf('.');
    const ext = dotIdx !== -1 ? normalized.substring(dotIdx).toLowerCase() : '';
    if (BANNED_EXTENSIONS.has(ext)) {
      pushIssue(issues, `banned file extension "${ext}" in entry (A19): "${normalized}"`);
    }

    if (isRegular) {
      const fileSize = size ?? 0;
      if (fileSize > MAX_FILE_SIZE) {
        pushIssue(issues, `file size (${fileSize} bytes) exceeds limit of ${MAX_FILE_SIZE} (A19): "${normalized}"`);
      }
      totalExpandedBytes += fileSize;
      if (totalExpandedBytes > MAX_EXPANDED_SIZE) {
        pushIssue(issues, `total expanded package size exceeds limit of ${MAX_EXPANDED_SIZE} bytes (A19)`);
      }

      if (files.length > MAX_FILES) {
        pushIssue(issues, `file count exceeds maximum of ${MAX_FILES} (A19)`);
        break;
      }

      const contentBlocks = Math.ceil(fileSize / 512);
      const contentStart = offset + 512;
      const contentEnd = contentStart + fileSize;

      if (contentStart + contentBlocks * 512 > tar.length) {
        pushIssue(issues, `truncated file content for "${normalized}" (A19)`);
        break;
      }

      const content = tar.subarray(contentStart, contentEnd);

      // Binary header magic checks
      if (content.length >= 4) {
        if (content[0] === 0x7f && content[1] === 0x45 && content[2] === 0x4c && content[3] === 0x46) {
          pushIssue(issues, `compiled binary file (ELF) forbidden (A19): "${normalized}"`);
        }
        if (
          (content[0] === 0xfe && content[1] === 0xed && content[2] === 0xfa && (content[3] === 0xce || content[3] === 0xcf)) ||
          ((content[0] === 0xce || content[0] === 0xcf) && content[1] === 0xfa && content[2] === 0xed && content[3] === 0xfe)
        ) {
          pushIssue(issues, `compiled binary file (Mach-O) forbidden (A19): "${normalized}"`);
        }
      }
      if (content.length >= 2 && content[0] === 0x4d && content[1] === 0x5a) {
        pushIssue(issues, `compiled binary file (PE/EXE) forbidden (A19): "${normalized}"`);
      }

      // Check unexpected null bytes in source/text files
      const textExts = ['.py', '.yaml', '.yml', '.json', '.txt', '.md'];
      if (textExts.includes(ext) && content.includes(0)) {
        pushIssue(issues, `unexpected null bytes in source file (A19): "${normalized}"`);
      }

      if (normalized === 'skill.yaml') {
        if (fileSize > MAX_SKILL_YAML_SIZE) {
          pushIssue(issues, `skill.yaml size (${fileSize} bytes) exceeds limit of ${MAX_SKILL_YAML_SIZE} (A19)`);
        } else {
          skillYamlContent = content.toString('utf8');
        }
      }

      // Check tests outside vendor/
      if (!normalized.startsWith('vendor/')) {
        const basename = normalized.split('/').pop() || '';
        if (
          normalized.startsWith('tests/') ||
          normalized.includes('/tests/') ||
          basename.startsWith('test_') ||
          basename.endsWith('_test.py')
        ) {
          hasTests = true;
        }
      }
    }

    // Only regular files advance the walk with content blocks; directories never have content blocks (B2)
    const contentBlocks = isRegular ? Math.ceil((size ?? 0) / 512) : 0;
    offset += 512 + contentBlocks * 512;
  }

  // Hierarchy conflict guard: a path cannot be both a regular file and a directory parent
  for (const file of allFiles) {
    if (allDirs.has(file)) {
      pushIssue(issues, `path is declared as both a regular file and a directory (A19): "${file}"`);
    }
    if (parentDirs.has(file)) {
      pushIssue(issues, `entry is both a regular file and a directory parent (A19): "${file}"`);
    }
  }

  if (!skillYamlContent) {
    pushIssue(issues, 'package must contain a skill.yaml at root (A1, A19)');
    return { ok: false, issues };
  }

  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(skillYamlContent);
  } catch (err: any) {
    pushIssue(issues, `skill.yaml is not valid YAML: ${err?.message || String(err)}`);
    return { ok: false, issues };
  }

  if (!parsedYaml || typeof parsedYaml !== 'object' || Array.isArray(parsedYaml)) {
    pushIssue(issues, 'skill.yaml must be an object');
    return { ok: false, issues };
  }

  const rawManifest = parsedYaml as Record<string, unknown>;

  if (rawManifest.spec !== 1) {
    pushIssue(issues, `skill package skill.yaml must declare spec: 1 (got ${JSON.stringify(rawManifest.spec)}) (A22)`);
  }

  if ('visibility' in rawManifest) {
    pushIssue(issues, 'skill packages drop visibility field from skill.yaml (A22, H7)');
  }

  if ('owner' in rawManifest) {
    pushIssue(issues, 'skill packages drop owner field from skill.yaml (A22, H7)');
  }

  const { spec: _spec, ...manifestBody } = rawManifest;
  const manifestChecked = validateSkillManifest(manifestBody);
  if (!manifestChecked.ok) {
    for (const issue of manifestChecked.issues) {
      pushIssue(issues, `manifest.${issue.path}: ${issue.message}`);
    }
  }

  if (!hasTests) {
    pushIssue(issues, 'package must contain tests outside vendor/ (A1, A2)');
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
