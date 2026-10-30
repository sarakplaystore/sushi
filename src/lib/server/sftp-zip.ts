import path from "node:path";
import { once } from "node:events";
import type { Writable } from "node:stream";
import zlib from "node:zlib";
import type { Attributes, SFTPWrapper } from "ssh2";
import type { ConnectionCredentials } from "@/types/connection";
import { formatPermissions, withSftp } from "./ssh-client";

/**
 * Folder download (SFTP → ZIP).
 *
 * Sushi has no shell on Vercel, so "download this folder" cannot be a tar/zip
 * command on the remote host. Instead we walk the tree over the SFTP subsystem
 * and stream a standards-compliant ZIP back to the browser:
 *
 *   collectRemoteTree()  – one SFTP connection, metadata only (fast, lets the
 *                          route reject oversized trees with a clean JSON error
 *                          before any bytes are sent).
 *   writeZipFromTree()   – a second SFTP connection, streams each file straight
 *                          into the ZIP (no temp files, no buffering the archive
 *                          in memory), so it works the same on a VPS and on a
 *                          serverless function.
 *
 * The ZIP writer below is intentionally dependency-free: deflate comes from
 * node:zlib and CRC32 from node:zlib (with a table fallback for older Node).
 */

export interface SftpZipLimits {
  /** Maximum number of files inside the archive. */
  maxFiles: number;
  /** Maximum directory nesting depth below the download root. */
  maxDepth: number;
  /** Maximum total uncompressed bytes. */
  maxTotalBytes: number;
}

export const DEFAULT_SFTP_ZIP_LIMITS: SftpZipLimits = {
  maxFiles: 20000,
  maxDepth: 24,
  // A browser download has to be assembled in memory client-side, and a ZIP
  // cannot exceed 4 GiB without ZIP64 (which this writer does not emit).
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
};

export type SftpZipLimitCode = "too-many-files" | "too-deep" | "too-large";

export class SftpZipLimitError extends Error {
  readonly code: SftpZipLimitCode;
  readonly limit: number;
  readonly context: Record<string, string | number>;

  constructor(
    code: SftpZipLimitCode,
    message: string,
    limit: number,
    context: Record<string, string | number> = {}
  ) {
    super(message);
    this.name = "SftpZipLimitError";
    this.code = code;
    this.limit = limit;
    this.context = context;
  }
}

export interface RemoteTreeEntry {
  /** Path inside the ZIP (POSIX, no leading slash). */
  relPath: string;
  /** Absolute path on the remote host. */
  remotePath: string;
  kind: "file" | "directory";
  size: number;
  /** Milliseconds since epoch. */
  mtime: number;
  mode: number;
}

export interface RemoteTree {
  rootPath: string;
  /** Suggested archive name (without ".zip"). */
  rootName: string;
  entries: RemoteTreeEntry[];
  fileCount: number;
  directoryCount: number;
  totalBytes: number;
  /** Symlinks pointing at directories are skipped so the walk cannot loop. */
  skippedSymlinks: number;
  /** Entries that vanished / were not readable while walking. */
  skippedUnreadable: number;
}

function toMillis(seconds: number | undefined): number {
  const secs = Number(seconds) || 0;
  return secs > 0 ? secs * 1000 : Date.now();
}

function sanitizeRootName(input: string): string {
  const base = path.posix.basename(input.replace(/\/+$/, ""));
  const cleaned = base.replace(/[\\/:*?"<>|\r\n]/g, "_").trim();
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "download";
}

function sftpRealpath(sftp: SFTPWrapper, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.realpath(target, (err, absPath) => {
      if (err) reject(err);
      else resolve(absPath);
    });
  });
}

function sftpStat(sftp: SFTPWrapper, target: string): Promise<Attributes> {
  return new Promise((resolve, reject) => {
    sftp.stat(target, (err, stats) => {
      if (err) reject(err);
      else resolve(stats);
    });
  });
}

function sftpLstat(sftp: SFTPWrapper, target: string): Promise<Attributes> {
  return new Promise((resolve, reject) => {
    sftp.lstat(target, (err, stats) => {
      if (err) reject(err);
      else resolve(stats);
    });
  });
}

function sftpReadDir(
  sftp: SFTPWrapper,
  target: string
): Promise<Array<{ filename: string; attrs: Attributes }>> {
  return new Promise((resolve, reject) => {
    sftp.readdir(target, (err, items) => {
      if (err) reject(err);
      else resolve(items || []);
    });
  });
}

/** A single thing the user selected: a file or a folder. */
interface RemoteTarget {
  /** Absolute path on the remote host. */
  absPath: string;
  /** Name this item gets inside the archive. */
  name: string;
  kind: "file" | "directory";
  size: number;
  mode: number;
  mtime: number;
}

interface WalkState {
  entries: RemoteTreeEntry[];
  fileCount: number;
  directoryCount: number;
  totalBytes: number;
  skippedSymlinks: number;
  skippedUnreadable: number;
  usedNames: Set<string>;
}

/**
 * Keeps archive entry names unique when the selection holds two items with the
 * same basename (possible when paths are posted by hand): `a.txt`, `a (2).txt`.
 */
function uniqueEntryName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; ; i += 1) {
    const candidate = `${base} (${i})${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

/** Deepest folder shared by every selected path (used as the archive root). */
function commonParentDirectory(paths: string[]): string {
  if (paths.length === 1) return path.posix.dirname(paths[0]);
  const parents = paths.map((p) => path.posix.dirname(p).split("/").filter(Boolean));
  const first = parents[0];
  let shared = 0;
  while (
    shared < first.length &&
    parents.every((parts) => parts[shared] === first[shared])
  ) {
    shared += 1;
  }
  return `/${first.slice(0, shared).join("/")}`;
}

/**
 * Walks one folder into `state`, prefixing every entry with `relBase`.
 * `relBase` is empty for a plain "download this folder" (contents at the archive
 * root) and the folder name when the folder is part of a multi-item selection.
 */
async function walkIntoArchive(
  sftp: SFTPWrapper,
  state: WalkState,
  rootPath: string,
  relBase: string,
  limits: SftpZipLimits
): Promise<void> {
  const stack: Array<{ remotePath: string; relPath: string; depth: number }> = [
    { remotePath: rootPath, relPath: relBase, depth: 0 },
  ];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let items: Array<{ filename: string; attrs: Attributes }>;
    try {
      items = await sftpReadDir(sftp, dir.remotePath);
    } catch {
      // Unreadable sub-directory: keep the rest of the selection downloadable.
      state.skippedUnreadable += 1;
      continue;
    }

    for (const item of items) {
      if (item.filename === "." || item.filename === ".." || !item.filename) {
        continue;
      }
      const remotePath = path.posix.join(dir.remotePath, item.filename);
      const relPath = dir.relPath
        ? `${dir.relPath}/${item.filename}`
        : item.filename;
      let attrs = item.attrs;
      let type = formatPermissions(attrs.mode).type;

      if (type === "symlink") {
        // Follow links to regular files, but never into linked directories:
        // `ln -s / target` or cycles would otherwise walk forever.
        const targetStats = await sftpStat(sftp, remotePath).catch(() => null);
        if (!targetStats) {
          state.skippedUnreadable += 1;
          continue;
        }
        const targetType = formatPermissions(targetStats.mode).type;
        if (targetType === "directory") {
          state.skippedSymlinks += 1;
          continue;
        }
        attrs = targetStats;
        type = targetType;
      }

      if (type === "directory") {
        if (dir.depth + 1 > limits.maxDepth) {
          throw new SftpZipLimitError(
            "too-deep",
            `This folder is nested deeper than ${limits.maxDepth} levels at ${remotePath}. Download that sub-folder on its own.`,
            limits.maxDepth,
            { path: remotePath }
          );
        }
        state.directoryCount += 1;
        state.entries.push({
          relPath,
          remotePath,
          kind: "directory",
          size: 0,
          mtime: toMillis(attrs.mtime),
          mode: attrs.mode,
        });
        stack.push({
          remotePath,
          relPath,
          depth: dir.depth + 1,
        });
        continue;
      }

      if (state.fileCount + 1 > limits.maxFiles) {
        throw new SftpZipLimitError(
          "too-many-files",
          `This selection contains more than ${limits.maxFiles} files. Download fewer items or a sub-folder instead.`,
          limits.maxFiles,
          { path: dir.remotePath }
        );
      }
      const size = Number(attrs.size) || 0;
      if (state.totalBytes + size > limits.maxTotalBytes) {
        throw new SftpZipLimitError(
          "too-large",
          `This selection is larger than ${formatMebibytes(limits.maxTotalBytes)}. Download fewer items (large archives should be pulled over SSH/tar on the server).`,
          limits.maxTotalBytes,
          { path: remotePath }
        );
      }
      state.fileCount += 1;
      state.totalBytes += size;
      state.entries.push({
        relPath,
        remotePath,
        kind: "file",
        size,
        mtime: toMillis(attrs.mtime),
        mode: attrs.mode,
      });
    }
  }
}

/** Upper bound on how many paths one archive request may contain. */
export const MAX_ARCHIVE_TARGETS = 500;

/**
 * Walks one or more selected remote paths over one SFTP connection and returns
 * the metadata for a single archive.
 *
 * - One folder → its *contents* go to the archive root (the classic
 *   "download this folder" archive).
 * - One file → the file itself sits at the archive root.
 * - Several files / folders → every item keeps its own name at the archive root,
 *   so `app/` and `single.txt` stay side by side inside one .zip.
 *
 * Throws SftpZipLimitError as soon as a limit would be exceeded.
 */
export async function collectRemoteArchive(
  creds: ConnectionCredentials,
  requestedTargets: string[],
  limits: SftpZipLimits = DEFAULT_SFTP_ZIP_LIMITS,
  options: { requireDirectory?: boolean } = {}
): Promise<RemoteTree> {
  return withSftp(creds, async (sftp) => {
    const targets: RemoteTarget[] = [];
    const seen = new Set<string>();

    for (const raw of requestedTargets) {
      const requested = (raw || "").trim();
      if (!requested) continue;
      if (targets.length >= MAX_ARCHIVE_TARGETS) {
        throw new Error(
          `Too many items selected at once (limit ${MAX_ARCHIVE_TARGETS}).`
        );
      }

      let absPath: string;
      try {
        absPath = await sftpRealpath(sftp, requested);
      } catch {
        absPath = path.posix.resolve("/", requested);
      }
      // `./app` and `/home/me/app` are the same selection — walk it once.
      if (seen.has(absPath)) continue;
      seen.add(absPath);

      let stats = await sftpStat(sftp, absPath).catch(async () =>
        sftpLstat(sftp, absPath)
      );
      let type = formatPermissions(stats.mode).type;
      if (type === "symlink") {
        // A selected symlink is resolved once so a linked file can be archived.
        // Linked folders are still skipped by the walk, so cycles stay impossible.
        const followed = await sftpStat(sftp, absPath).catch(() => null);
        if (followed) {
          stats = followed;
          type = formatPermissions(followed.mode).type;
        }
      }

      if (options.requireDirectory && type !== "directory") {
        throw new Error(
          `${absPath} is a ${type === "symlink" ? "symlink" : "file"}, not a folder — download it directly instead of archiving it.`
        );
      }

      targets.push({
        absPath,
        name: path.posix.basename(absPath) || "download",
        kind: type === "directory" ? "directory" : "file",
        size: Number(stats.size) || 0,
        mode: stats.mode,
        mtime: toMillis(stats.mtime),
      });
    }

    if (targets.length === 0) {
      throw new Error("Nothing was selected to download.");
    }

    const state: WalkState = {
      entries: [],
      fileCount: 0,
      directoryCount: 0,
      totalBytes: 0,
      skippedSymlinks: 0,
      skippedUnreadable: 0,
      usedNames: new Set<string>(),
    };
    const single = targets.length === 1;

    for (const target of targets) {
      const entryName = uniqueEntryName(target.name, state.usedNames);

      if (target.kind === "directory") {
        if (single) {
          await walkIntoArchive(sftp, state, target.absPath, "", limits);
          continue;
        }
        // A folder inside a multi-item selection keeps its own name, and the
        // entry exists even when the folder is empty.
        state.directoryCount += 1;
        state.entries.push({
          relPath: entryName,
          remotePath: target.absPath,
          kind: "directory",
          size: 0,
          mtime: target.mtime,
          mode: target.mode,
        });
        await walkIntoArchive(sftp, state, target.absPath, entryName, limits);
        continue;
      }

      if (state.fileCount + 1 > limits.maxFiles) {
        throw new SftpZipLimitError(
          "too-many-files",
          `This selection contains more than ${limits.maxFiles} files. Download fewer items instead.`,
          limits.maxFiles,
          { path: target.absPath }
        );
      }
      if (state.totalBytes + target.size > limits.maxTotalBytes) {
        throw new SftpZipLimitError(
          "too-large",
          `This selection is larger than ${formatMebibytes(limits.maxTotalBytes)}. Download fewer items (large archives should be pulled over SSH/tar on the server).`,
          limits.maxTotalBytes,
          { path: target.absPath }
        );
      }
      state.fileCount += 1;
      state.totalBytes += target.size;
      state.entries.push({
        relPath: entryName,
        remotePath: target.absPath,
        kind: "file",
        size: target.size,
        mtime: target.mtime,
        mode: target.mode,
      });
    }

    // Directories before their contents reads nicer when unzipping.
    state.entries.sort((a, b) => {
      const depthDiff =
        a.relPath.split("/").length - b.relPath.split("/").length;
      if (depthDiff !== 0) return depthDiff;
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.relPath.localeCompare(b.relPath);
    });

    const rootPath =
      single && targets[0].kind === "directory"
        ? targets[0].absPath
        : commonParentDirectory(targets.map((t) => t.absPath));
    const rootName = single
      ? targets[0].name
      : `${path.posix.basename(rootPath) || "download"}-selection`;

    return {
      rootPath,
      rootName: sanitizeRootName(rootName),
      entries: state.entries,
      fileCount: state.fileCount,
      directoryCount: state.directoryCount,
      totalBytes: state.totalBytes,
      skippedSymlinks: state.skippedSymlinks,
      skippedUnreadable: state.skippedUnreadable,
    };
  });
}

/**
 * Walks a remote folder over one SFTP connection and returns its metadata.
 * Throws SftpZipLimitError as soon as a limit would be exceeded.
 */
export async function collectRemoteTree(
  creds: ConnectionCredentials,
  requestedPath: string,
  limits: SftpZipLimits = DEFAULT_SFTP_ZIP_LIMITS
): Promise<RemoteTree> {
  return collectRemoteArchive(creds, [requestedPath], limits, {
    requireDirectory: true,
  });
}

function formatMebibytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/* ------------------------------------------------------------------ *
 * ZIP writer (store/deflate, no external dependency)
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

type ZlibWithCrc = typeof zlib & {
  crc32?: (data: Buffer | string, value?: number) => number;
};

/** CRC32 of `data`, chained onto `previous` (Node's zlib.crc32 when available). */
export function crc32(data: Buffer, previous = 0): number {
  const native = (zlib as ZlibWithCrc).crc32;
  if (typeof native === "function") {
    return native(data, previous) >>> 0;
  }
  let crc = (previous ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time pair used by ZIP headers (local time, 2-second resolution). */
export function dosDateTime(
  millis: number
): { date: number; time: number } {
  const d = new Date(Number.isFinite(millis) && millis > 0 ? millis : Date.now());
  const year = d.getFullYear();
  if (year < 1980) {
    return { date: (1 << 5) | 1, time: 0 };
  }
  const date =
    ((Math.min(year, 2107) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time =
    (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return { date, time };
}

const LOCAL_HEADER_SIG = 0x04034b50;
const DATA_DESCRIPTOR_SIG = 0x08074b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** Bit 3 (sizes in data descriptor) + bit 11 (UTF-8 names). */
const FLAGS_WITH_DESCRIPTOR = 0x0808;
/** Bit 11 only: directories have known (zero) sizes, so no descriptor. */
const FLAGS_PLAIN = 0x0800;
const MAX_UINT32 = 0xffffffff;

interface CentralRecord {
  name: Buffer;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  mtime: number;
  mode: number;
  isDirectory: boolean;
}

/** Minimal streaming ZIP writer: local headers, deflated data, central directory. */
export type ByteSource = AsyncIterable<Buffer | Uint8Array> & {
  destroy?: (err?: Error) => void;
};

/** Best-effort teardown of a remote read stream (never throws). */
function stopSource(source: ByteSource): void {
  try {
    source.destroy?.();
  } catch {
    // already closed
  }
}

export class ZipStreamWriter {
  private offset = 0;
  private readonly records: CentralRecord[] = [];

  constructor(private readonly write: (chunk: Buffer) => Promise<void>) {}

  private async emit(chunk: Buffer): Promise<void> {
    if (chunk.length === 0) return;
    await this.write(chunk);
    this.offset += chunk.length;
  }

  private localHeader(
    name: Buffer,
    flags: number,
    method: number,
    mtime: number
  ): Buffer {
    const { date, time } = dosDateTime(mtime);
    const header = Buffer.alloc(30 + name.length);
    header.writeUInt32LE(LOCAL_HEADER_SIG, 0);
    header.writeUInt16LE(20, 4); // version needed to extract (2.0)
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(0, 14); // crc32 → data descriptor
    header.writeUInt32LE(0, 18); // compressed size → data descriptor
    header.writeUInt32LE(0, 22); // uncompressed size → data descriptor
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28); // extra field length
    name.copy(header, 30);
    return header;
  }

  /** Adds a directory entry (kept so empty folders survive the round-trip). */
  async addDirectory(name: string, mtime: number, mode = 0o040755): Promise<void> {
    const entryName = Buffer.from(
      (name.endsWith("/") ? name : `${name}/`).replace(/^\/+/, ""),
      "utf8"
    );
    const localOffset = this.offset;
    await this.emit(this.localHeader(entryName, FLAGS_PLAIN, 0, mtime));
    this.records.push({
      name: entryName,
      flags: FLAGS_PLAIN,
      method: 0,
      crc: 0,
      compressedSize: 0,
      uncompressedSize: 0,
      localOffset,
      mtime,
      mode,
      isDirectory: true,
    });
  }

  /**
   * Adds a file by streaming `source` through deflate. `sizeHint` is only used
   * as a sanity check for the 4 GiB ZIP (non-ZIP64) limit; the real sizes come
   * from the bytes that are actually read.
   */
  async addFile(
    name: string,
    source: ByteSource,
    options: { mtime: number; mode?: number; sizeHint?: number }
  ): Promise<void> {
    if ((options.sizeHint ?? 0) > MAX_UINT32) {
      throw new Error("File is larger than 4 GB — ZIP64 is not supported.");
    }
    const entryName = Buffer.from(name.replace(/^\/+/, ""), "utf8");
    const localOffset = this.offset;
    await this.emit(
      this.localHeader(entryName, FLAGS_WITH_DESCRIPTOR, 8, options.mtime)
    );

    const deflate = zlib.createDeflateRaw({ level: 6 });
    let crc = 0;
    let uncompressedSize = 0;
    let compressedSize = 0;

    const consume = (async () => {
      for await (const chunk of deflate) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        compressedSize += buf.length;
        await this.emit(buf);
      }
    })();
    // A consumer failure (client closed the tab, socket error) must not escape as an
    // unhandled rejection: `settled` resolves with the error instead of throwing, so
    // both the read loop and this function can surface it.
    let consumeError: Error | null = null;
    const settled: Promise<Error | null> = consume.then(
      () => null,
      (err: Error) => {
        consumeError = err;
        return err;
      }
    );

    try {
      for await (const chunk of source) {
        if (consumeError) break;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        crc = crc32(buf, crc);
        uncompressedSize += buf.length;
        if (!deflate.write(buf)) {
          // Stop waiting for 'drain' if the consumer already died.
          const failure = await Promise.race([once(deflate, "drain").then(() => null), settled]);
          if (failure) break;
        }
      }
      if (!consumeError) deflate.end();
    } catch (err) {
      deflate.destroy();
      stopSource(source);
      const consumerErr = await settled;
      throw consumerErr ?? err;
    }

    const consumerErr = await settled;
    if (consumerErr) {
      deflate.destroy();
      stopSource(source);
      throw consumerErr;
    }

    if (uncompressedSize > MAX_UINT32 || compressedSize > MAX_UINT32) {
      throw new Error("Archive exceeded the 4 GB limit for ZIP without ZIP64.");
    }

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(DATA_DESCRIPTOR_SIG, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(compressedSize, 8);
    descriptor.writeUInt32LE(uncompressedSize, 12);
    await this.emit(descriptor);

    this.records.push({
      name: entryName,
      flags: FLAGS_WITH_DESCRIPTOR,
      method: 8,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
      mtime: options.mtime,
      mode: options.mode ?? 0o100644,
      isDirectory: false,
    });
  }

  get entryCount(): number {
    return this.records.length;
  }

  /** Writes the central directory + end-of-central-directory record. */
  async finish(): Promise<void> {
    const centralParts: Buffer[] = [];
    let centralSize = 0;

    for (const record of this.records) {
      if (record.localOffset > MAX_UINT32) {
        throw new Error("Archive exceeded the 4 GB limit for ZIP without ZIP64.");
      }
      const { date, time } = dosDateTime(record.mtime);
      const header = Buffer.alloc(46 + record.name.length);
      header.writeUInt32LE(CENTRAL_HEADER_SIG, 0);
      header.writeUInt16LE(0x031e, 4); // version made by: UNIX / 3.0
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(record.flags, 8);
      header.writeUInt16LE(record.method, 10);
      header.writeUInt16LE(time, 12);
      header.writeUInt16LE(date, 14);
      header.writeUInt32LE(record.crc, 16);
      header.writeUInt32LE(record.compressedSize, 20);
      header.writeUInt32LE(record.uncompressedSize, 24);
      header.writeUInt16LE(record.name.length, 28);
      header.writeUInt16LE(0, 30); // extra
      header.writeUInt16LE(0, 32); // comment
      header.writeUInt16LE(0, 34); // disk start
      header.writeUInt16LE(0, 36); // internal attributes
      const externalAttributes =
        (((record.mode & 0xffff) || (record.isDirectory ? 0o040755 : 0o100644)) <<
          16) |
        (record.isDirectory ? 0x10 : 0);
      header.writeUInt32LE(externalAttributes >>> 0, 38);
      header.writeUInt32LE(record.localOffset, 42);
      record.name.copy(header, 46);
      centralParts.push(header);
      centralSize += header.length;
    }

    const centralOffset = this.offset;
    await this.emit(Buffer.concat(centralParts));

    if (centralOffset > MAX_UINT32) {
      throw new Error("Archive exceeded the 4 GB limit for ZIP without ZIP64.");
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4); // this disk
    eocd.writeUInt16LE(0, 6); // disk with central directory
    eocd.writeUInt16LE(Math.min(this.records.length, 0xffff), 8);
    eocd.writeUInt16LE(Math.min(this.records.length, 0xffff), 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralOffset, 16);
    eocd.writeUInt16LE(0, 20); // comment length
    await this.emit(eocd);
  }
}

/**
 * Streams the collected tree as a ZIP into `destination`.
 * Files are read sequentially over a single SFTP connection.
 */
export async function writeZipFromTree(
  creds: ConnectionCredentials,
  tree: RemoteTree,
  destination: Writable
): Promise<void> {
  // A single listener keeps an aborted pipe (client closed the tab) from
  // surfacing as an unhandled "error" event; writes report the failure instead.
  const ignoreError = () => {};
  destination.on("error", ignoreError);

  const writer = new ZipStreamWriter(
    (chunk) =>
      new Promise<void>((resolve, reject) => {
        if (destination.destroyed) {
          reject(new Error("Download cancelled."));
          return;
        }
        destination.write(chunk, (err) => (err ? reject(err) : resolve()));
      })
  );

  await withSftp(creds, async (sftp) => {
    for (const entry of tree.entries) {
      if (destination.destroyed) throw new Error("Download cancelled.");

      if (entry.kind === "directory") {
        await writer.addDirectory(entry.relPath, entry.mtime, entry.mode);
        continue;
      }

      const readStream = sftp.createReadStream(entry.remotePath, {
        autoClose: true,
      });
      // ssh2 surfaces inbound SFTP responses as "error" events on the read stream.
      // Once the session closes, requests that are still in flight (a prefetched
      // read past EOF, for instance) are failed too — without a listener that is an
      // unhandled 'error' event and would take the whole server down.
      const onStreamError = (err: Error) => {
        streamError = err;
      };
      let streamError: Error | null = null;
      readStream.on("error", onStreamError);

      try {
        await writer.addFile(entry.relPath, readStream as unknown as ByteSource, {
          mtime: entry.mtime,
          mode: entry.mode,
          sizeHint: entry.size,
        });
      } catch (err) {
        throw err instanceof Error
          ? new Error(`${entry.relPath}: ${err.message}`)
          : new Error(`Failed to add ${entry.relPath} to the archive.`);
      } finally {
        // Keep the listener attached while destroying (destroy can re-emit) and
        // release the remote file handle as soon as the entry is written.
        try {
          readStream.destroy();
        } catch {
          // already closed
        }
        readStream.removeAllListeners("close");
      }

      if (streamError) {
        throw new Error(`${entry.relPath}: ${(streamError as Error).message}`);
      }
    }
  });

  try {
    await writer.finish();
  } finally {
    destination.removeListener("error", ignoreError);
  }
}
