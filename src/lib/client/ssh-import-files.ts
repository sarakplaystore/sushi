import { Unzip, UnzipInflate, strFromU8 } from "fflate";

export interface SelectedImportFile {
  name: string;
  bytes: Uint8Array;
}

// Limits apply before reading files and while inflating, including ZIPs that lie
// about their sizes. No archive entry is ever written to disk or executed.
export const MAX_IMPORT_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_IMPORT_FILES = 100;
const MAX_ARCHIVE_OUTPUT = 50 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 200;

export function decodeImportText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  // Windows .reg/.xsh files are often UTF-16 without a BOM.
  const sample = bytes.subarray(0, Math.min(bytes.length, 512));
  let evenZeros = 0, oddZeros = 0;
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0) { if (i % 2) oddZeros++; else evenZeros++; }
  if (oddZeros > sample.length / 6) return new TextDecoder("utf-16le").decode(bytes);
  if (evenZeros > sample.length / 6) return new TextDecoder("utf-16be").decode(bytes);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return new TextDecoder("windows-1252").decode(bytes); }
}

export function isZipFile(file: SelectedImportFile): boolean {
  return (file.bytes[0] === 0x50 && file.bytes[1] === 0x4b &&
    ((file.bytes[2] === 3 && file.bytes[3] === 4) || (file.bytes[2] === 5 && file.bytes[3] === 6))) || /\.zip$/i.test(file.name);
}

function looksLikeImportEntry(name: string): boolean {
  const base = name.split(/[\\/]/).pop() || "";
  return /\.(json|csv|reg|ini|mxtsessions|moba|xsh|yaml|yml|cfg|conf|txt|sqlite3?|db|encrypted|meta|pem|key|ppk|priv|privkey|openssh)$/i.test(base) ||
    /^(?:\.env|termix\.env)$/i.test(base) ||
    // OpenSSH configs and private keys can have arbitrary extensionless names.
    Boolean(base && !base.includes("."));
}

interface ZipEntryInfo { crc: number; originalSize: number }
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
function updateCrc(crc: number, bytes: Uint8Array): number {
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return crc >>> 0;
}

/** Check the central directory before inflating: reject encrypted/invalid ZIPs. */
function zipDirectory(bytes: Uint8Array): Map<string, ZipEntryInfo> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let pos = bytes.length - 22; pos >= Math.max(0, bytes.length - 65557); pos--) {
    if (view.getUint32(pos, true) === 0x06054b50 && pos + 22 + view.getUint16(pos + 20, true) === bytes.length) { end = pos; break; }
  }
  if (end < 0) throw new Error("Could not read the ZIP archive. It may be encrypted or damaged; unzip it first.");
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) ||
    view.getUint16(end + 8, true) !== count || count === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
    throw new Error("Multi-volume and ZIP64 archives are not supported. Unzip the files first.");
  }
  if (count > MAX_ARCHIVE_ENTRIES) throw new Error(`ZIP archives are limited to ${MAX_ARCHIVE_ENTRIES} entries.`);
  if (directoryOffset + directorySize > end) throw new Error("The ZIP archive is damaged or incomplete.");
  const entries = new Map<string, ZipEntryInfo>();
  let pos = directoryOffset;
  for (let index = 0; index < count; index++) {
    if (pos + 46 > end || view.getUint32(pos, true) !== 0x02014b50) throw new Error("The ZIP archive is damaged or incomplete.");
    const flags = view.getUint16(pos + 8, true);
    const nameLength = view.getUint16(pos + 28, true), extraLength = view.getUint16(pos + 30, true), commentLength = view.getUint16(pos + 32, true);
    const next = pos + 46 + nameLength + extraLength + commentLength;
    if (next > end || next > directoryOffset + directorySize) throw new Error("The ZIP archive is damaged or incomplete.");
    if (flags & 1 || flags & 0x40) throw new Error("Password-protected ZIP archives cannot be opened. Unzip the files first.");
    const name = strFromU8(bytes.subarray(pos + 46, pos + 46 + nameLength), !(flags & 0x800)).replace(/\\/g, "/");
    if (entries.has(name)) throw new Error("ZIP archive contains duplicate file paths. Unzip and select the files separately.");
    entries.set(name, { crc: view.getUint32(pos + 16, true), originalSize: view.getUint32(pos + 24, true) });
    pos = next;
  }
  return entries;
}

export function expandImportFiles(files: SelectedImportFile[]): { files: SelectedImportFile[]; warnings: string[] } {
  if (files.length > MAX_IMPORT_FILES) throw new Error(`Select at most ${MAX_IMPORT_FILES} files at once.`);
  if (files.reduce((total, file) => total + file.bytes.length, 0) > MAX_IMPORT_FILE_BYTES) throw new Error("Selected files exceed the 50 MB total import limit.");
  const expanded: SelectedImportFile[] = [];
  const warnings: string[] = [];
  let totalOutput = 0;
  for (const input of files) {
    if (input.bytes.length > MAX_IMPORT_FILE_BYTES) throw new Error(`"${input.name}" exceeds the 50 MB import limit.`);
    if (!isZipFile(input)) {
      totalOutput += input.bytes.length;
      if (totalOutput > MAX_ARCHIVE_OUTPUT) throw new Error("Imported files exceed the 50 MB total output limit.");
      expanded.push(input);
      continue;
    }
    if (!(input.bytes[0] === 0x50 && input.bytes[1] === 0x4b)) throw new Error(`"${input.name}" is not a valid ZIP archive.`);
    const directory = zipDirectory(input.bytes);
    const seen = new Set<string>();
    const unfinished = new Set<string>();
    let entries = 0, ignored = 0;
    const unzip = new Unzip((entry) => {
      if (++entries > MAX_ARCHIVE_ENTRIES) throw new Error(`ZIP archives are limited to ${MAX_ARCHIVE_ENTRIES} entries.`);
      const name = entry.name.replace(/\\/g, "/");
      const info = directory.get(name);
      if (!info || seen.has(name)) throw new Error("The ZIP archive is damaged or has mismatched file names.");
      seen.add(name);
      if (name.endsWith("/") || name.startsWith("__MACOSX/") || name.split("/").includes("..") || name.startsWith("/") || !looksLikeImportEntry(name)) {
        if (!name.endsWith("/")) ignored++;
        return;
      }
      if (info.originalSize > MAX_ARCHIVE_OUTPUT || (entry.originalSize !== undefined && entry.originalSize > MAX_ARCHIVE_OUTPUT)) throw new Error("The ZIP archive expands beyond the 50 MB limit.");
      if (entry.compression !== 0 && entry.compression !== 8) throw new Error("The ZIP uses an unsupported compression or encryption method. Unzip it first.");
      const chunks: Uint8Array[] = [];
      let size = 0, crc = 0xffffffff;
      unfinished.add(name);
      entry.ondata = (err, chunk, final) => {
        if (err) throw new Error("Could not read the ZIP archive. It may be encrypted or damaged; unzip it first.");
        size += chunk.length;
        crc = updateCrc(crc, chunk);
        totalOutput += chunk.length;
        if (size > MAX_IMPORT_FILE_BYTES || totalOutput > MAX_ARCHIVE_OUTPUT) throw new Error("The ZIP archive expands beyond the 50 MB limit.");
        chunks.push(chunk);
        if (final) {
          if (size !== info.originalSize || ((crc ^ 0xffffffff) >>> 0) !== info.crc) throw new Error("The ZIP archive is damaged or failed its integrity check.");
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
          unfinished.delete(name);
          expanded.push({ name: `${input.name}/${name}`, bytes });
        }
      };
      entry.start();
    });
    unzip.register(UnzipInflate);
    try {
      // Bound each inflate step too, even for streams without size metadata.
      for (let offset = 0; offset < input.bytes.length; offset += 8192) {
        unzip.push(input.bytes.subarray(offset, Math.min(offset + 8192, input.bytes.length)), offset + 8192 >= input.bytes.length);
      }
    } catch (err) {
      if (err instanceof Error && /limit|unsupported|encrypted|damaged/i.test(err.message)) throw err;
      throw new Error("Could not read the ZIP archive. It may be encrypted or damaged; unzip it first.");
    }
    if (seen.size !== directory.size || unfinished.size) throw new Error("The ZIP archive is damaged or incomplete.");
    if (ignored) warnings.push(`${input.name}: ignored ${ignored} unsupported archive entr${ignored === 1 ? "y" : "ies"}.`);
  }
  if (expanded.length > MAX_IMPORT_FILES) throw new Error(`Import contains more than ${MAX_IMPORT_FILES} supported files.`);
  return { files: expanded, warnings };
}
