import crypto from "node:crypto";
import path from "node:path";
import { Client, type ConnectConfig, type SFTPWrapper, type Attributes } from "ssh2";
import type {
  ConnectionCredentials,
  SftpEntry,
  SshTestResult,
} from "@/types/connection";
import { validateTargetHost } from "./security";

export interface ConnectedSshSession {
  client: Client;
  fingerprint?: string;
  serverBanner?: string;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function formatPermissions(mode: number): {
  symbolic: string;
  octal: string;
  type: "file" | "directory" | "symlink";
} {
  const fileTypeMask = mode & 0o170000;
  let typeChar = "-";
  let type: "file" | "directory" | "symlink" = "file";

  if (fileTypeMask === 0o040000) {
    typeChar = "d";
    type = "directory";
  } else if (fileTypeMask === 0o120000) {
    typeChar = "l";
    type = "symlink";
  }

  const chars = [
    mode & 0o400 ? "r" : "-",
    mode & 0o200 ? "w" : "-",
    mode & 0o100 ? (mode & 0o4000 ? "s" : "x") : mode & 0o4000 ? "S" : "-",
    mode & 0o040 ? "r" : "-",
    mode & 0o020 ? "w" : "-",
    mode & 0o010 ? (mode & 0o2000 ? "s" : "x") : mode & 0o2000 ? "S" : "-",
    mode & 0o004 ? "r" : "-",
    mode & 0o002 ? "w" : "-",
    mode & 0o001 ? (mode & 0o1000 ? "t" : "x") : mode & 0o1000 ? "T" : "-",
  ];

  const octal = "0" + (mode & 0o7777).toString(8).padStart(3, "0");
  return {
    symbolic: typeChar + chars.join(""),
    octal,
    type,
  };
}

export async function connectSsh(
  creds: ConnectionCredentials,
  timeoutMs = 15000
): Promise<ConnectedSshSession> {
  const port = Number(creds.port || 22);
  await validateTargetHost(creds.host, port);

  if (!creds.username?.trim()) {
    throw new Error("SSH username is required.");
  }

  return new Promise<ConnectedSshSession>((resolve, reject) => {
    const client = new Client();
    let settled = false;
    let fingerprint: string | undefined;
    let serverBanner: string | undefined;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        client.destroy();
        reject(new Error(`SSH connection timed out after ${Math.round(timeoutMs / 1000)}s.`));
      }
    }, timeoutMs);

    client.on("banner", (message) => {
      serverBanner = message.trim();
    });

    client.on("greeting", (greeting) => {
      if (!serverBanner) {
        serverBanner = greeting.trim();
      }
    });

    client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
      if (creds.password !== undefined && prompts.length > 0) {
        finish(prompts.map(() => creds.password || ""));
      } else {
        finish([]);
      }
    });

    client.on("ready", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ client, fingerprint, serverBanner });
    });

    client.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      reject(new Error(err.message || "SSH connection failed."));
    });

    const config: ConnectConfig = {
      host: creds.host.trim(),
      port,
      username: creds.username.trim(),
      readyTimeout: timeoutMs,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      tryKeyboard: true,
      hostVerifier: (key: Buffer | string) => {
        try {
          const buf = Buffer.isBuffer(key) ? key : Buffer.from(key, "hex");
          const hash = crypto
            .createHash("sha256")
            .update(buf)
            .digest("base64")
            .replace(/=+$/, "");
          fingerprint = `SHA256:${hash}`;
        } catch {
          // ignore hash parse issues
        }
        return true;
      },
    };

    if (creds.authMethod === "privateKey" || (creds.privateKey && creds.privateKey.trim())) {
      if (!creds.privateKey?.trim()) {
        clearTimeout(timer);
        settled = true;
        reject(new Error("Private key is required when using key authentication."));
        return;
      }
      config.privateKey = creds.privateKey.trim();
      if (creds.passphrase) {
        config.passphrase = creds.passphrase;
      }
    } else {
      config.password = creds.password ?? "";
    }

    try {
      client.connect(config);
    } catch (err) {
      clearTimeout(timer);
      settled = true;
      reject(err instanceof Error ? err : new Error("Failed to initiate SSH connection."));
    }
  });
}

function execSimple(client: Client, cmd: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve) => {
    let output = "";
    const timer = setTimeout(() => {
      resolve(output.trim());
    }, timeoutMs);

    client.exec(cmd, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        resolve("");
        return;
      }
      stream.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      stream.stderr.on("data", () => {
        // ignore stderr during probe
      });
      stream.on("close", () => {
        clearTimeout(timer);
        resolve(output.trim());
      });
    });
  });
}

export async function testSshConnection(
  creds: ConnectionCredentials
): Promise<SshTestResult> {
  const started = Date.now();
  let session: ConnectedSshSession | null = null;
  try {
    session = await connectSsh(creds, 12000);
    const latencyMs = Date.now() - started;

    const probeScript = [
      'printf "HOST=%s\\n" "$(hostname 2>/dev/null || uname -n 2>/dev/null)"',
      'printf "KERNEL=%s\\n" "$(uname -sr 2>/dev/null)"',
      'printf "OS=%s\\n" "$( ( . /etc/os-release 2>/dev/null && printf "%s" "$PRETTY_NAME" ) || uname -s 2>/dev/null )"',
      'printf "UPTIME=%s\\n" "$(uptime -p 2>/dev/null || uptime 2>/dev/null | sed "s/^ *//")"',
    ].join("; ");

    const raw = await execSimple(session.client, probeScript, 6000);
    const map: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const idx = line.indexOf("=");
      if (idx > 0) {
        map[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }

    return {
      ok: true,
      latencyMs,
      fingerprint: session.fingerprint,
      serverBanner: session.serverBanner,
      systemInfo: {
        hostname: map.HOST || undefined,
        kernel: map.KERNEL || undefined,
        os: map.OS || undefined,
        uptime: map.UPTIME || undefined,
      },
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : "SSH connection test failed.",
    };
  } finally {
    session?.client.end();
  }
}

export async function withSftp<T>(
  creds: ConnectionCredentials,
  handler: (sftp: SFTPWrapper, session: ConnectedSshSession) => Promise<T>
): Promise<T> {
  const session = await connectSsh(creds, 15000);
  try {
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      session.client.sftp((err, sftpStream) => {
        if (err) {
          reject(new Error(err.message || "Failed to open SFTP subsystem."));
          return;
        }
        resolve(sftpStream);
      });
    });
    return await handler(sftp, session);
  } finally {
    session.client.end();
  }
}

function sftpRealpath(sftp: SFTPWrapper, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.realpath(target, (err, absPath) => {
      if (err) reject(err);
      else resolve(absPath);
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

function sftpStat(sftp: SFTPWrapper, target: string): Promise<Attributes> {
  return new Promise((resolve, reject) => {
    sftp.stat(target, (err, stats) => {
      if (err) reject(err);
      else resolve(stats);
    });
  });
}

export async function sftpListDirectory(
  creds: ConnectionCredentials,
  requestedPath?: string
): Promise<{ cwd: string; entries: SftpEntry[]; fingerprint?: string }> {
  return withSftp(creds, async (sftp, session) => {
    const rawTarget =
      !requestedPath || requestedPath === "~" || requestedPath === "."
        ? "."
        : requestedPath;
    let resolvedPath = rawTarget;
    try {
      resolvedPath = await sftpRealpath(sftp, rawTarget);
    } catch {
      if (rawTarget === ".") {
        resolvedPath = "/";
      }
    }

    const list = await new Promise<
      Array<{ filename: string; longname: string; attrs: Attributes }>
    >((resolve, reject) => {
      sftp.readdir(resolvedPath, (err, items) => {
        if (err) reject(new Error(err.message || `Cannot read directory ${resolvedPath}`));
        else resolve(items || []);
      });
    });

    const entries: SftpEntry[] = list
      .filter((item) => item.filename !== "." && item.filename !== "..")
      .map((item) => {
        const perm = formatPermissions(item.attrs.mode);
        const fullPath = path.posix.join(resolvedPath, item.filename);
        return {
          name: item.filename,
          path: fullPath,
          type: perm.type,
          size: item.attrs.size ?? 0,
          mode: item.attrs.mode,
          permissions: perm.symbolic,
          octal: perm.octal,
          mtime: (item.attrs.mtime ?? 0) * 1000,
          atime: (item.attrs.atime ?? 0) * 1000,
          uid: item.attrs.uid ?? 0,
          gid: item.attrs.gid ?? 0,
        };
      })
      .sort((a, b) => {
        if (a.type === "directory" && b.type !== "directory") return -1;
        if (a.type !== "directory" && b.type === "directory") return 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });

    return {
      cwd: resolvedPath,
      entries,
      fingerprint: session.fingerprint,
    };
  });
}

export async function sftpReadBuffer(
  creds: ConnectionCredentials,
  remotePath: string,
  maxBytes = 50 * 1024 * 1024
): Promise<{ buffer: Buffer; stats: Attributes }> {
  return withSftp(creds, async (sftp) => {
    const stats = await sftpStat(sftp, remotePath);
    const perm = formatPermissions(stats.mode);
    if (perm.type === "directory") {
      throw new Error("Cannot read a directory as a file.");
    }
    if (stats.size > maxBytes) {
      throw new Error(
        `File size (${(stats.size / (1024 * 1024)).toFixed(1)} MB) exceeds limit (${(
          maxBytes /
          (1024 * 1024)
        ).toFixed(0)} MB).`
      );
    }

    const buffer = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      const rs = sftp.createReadStream(remotePath);
      rs.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          rs.destroy(new Error("File exceeded maximum allowed download size."));
          return;
        }
        chunks.push(chunk);
      });
      rs.on("error", (err: Error) => reject(err));
      rs.on("end", () => resolve(Buffer.concat(chunks)));
    });

    return { buffer, stats };
  });
}

export async function sftpWriteBuffer(
  creds: ConnectionCredentials,
  remotePath: string,
  content: Buffer,
  mode?: number
): Promise<{ bytesWritten: number }> {
  return withSftp(creds, async (sftp) => {
    await new Promise<void>((resolve, reject) => {
      const ws = sftp.createWriteStream(remotePath, mode ? { mode } : undefined);
      ws.on("error", (err: Error) => reject(err));
      ws.on("close", () => resolve());
      ws.end(content);
    });
    return { bytesWritten: content.length };
  });
}

export async function sftpMakeDir(
  creds: ConnectionCredentials,
  remotePath: string
): Promise<void> {
  return withSftp(creds, async (sftp) => {
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(remotePath, (err) => {
        if (err) reject(new Error(err.message || "Failed to create directory."));
        else resolve();
      });
    });
  });
}

export async function sftpRenameItem(
  creds: ConnectionCredentials,
  oldPath: string,
  newPath: string
): Promise<void> {
  return withSftp(creds, async (sftp) => {
    await new Promise<void>((resolve, reject) => {
      sftp.rename(oldPath, newPath, (err) => {
        if (err) reject(new Error(err.message || "Failed to rename item."));
        else resolve();
      });
    });
  });
}

export async function sftpChmodItem(
  creds: ConnectionCredentials,
  remotePath: string,
  octalOrMode: string | number
): Promise<void> {
  const numericMode =
    typeof octalOrMode === "number"
      ? octalOrMode
      : parseInt(octalOrMode.replace(/^0o?/i, ""), 8);

  if (Number.isNaN(numericMode) || numericMode < 0 || numericMode > 0o7777) {
    throw new Error("Invalid octal permissions value.");
  }

  return withSftp(creds, async (sftp) => {
    await new Promise<void>((resolve, reject) => {
      sftp.chmod(remotePath, numericMode, (err) => {
        if (err) reject(new Error(err.message || "Failed to update permissions."));
        else resolve();
      });
    });
  });
}

async function deleteRecursiveInternal(sftp: SFTPWrapper, targetPath: string): Promise<void> {
  const stats = await sftpLstat(sftp, targetPath);
  const perm = formatPermissions(stats.mode);

  if (perm.type === "directory") {
    const children = await new Promise<
      Array<{ filename: string; attrs: Attributes }>
    >((resolve, reject) => {
      sftp.readdir(targetPath, (err, items) => {
        if (err) reject(err);
        else resolve(items || []);
      });
    });

    for (const child of children) {
      if (child.filename === "." || child.filename === "..") continue;
      await deleteRecursiveInternal(
        sftp,
        path.posix.join(targetPath, child.filename)
      );
    }

    await new Promise<void>((resolve, reject) => {
      sftp.rmdir(targetPath, (err) => {
        if (err) reject(new Error(err.message || `Failed to remove directory ${targetPath}`));
        else resolve();
      });
    });
  } else {
    await new Promise<void>((resolve, reject) => {
      sftp.unlink(targetPath, (err) => {
        if (err) reject(new Error(err.message || `Failed to remove file ${targetPath}`));
        else resolve();
      });
    });
  }
}

export async function sftpDeleteItem(
  creds: ConnectionCredentials,
  remotePath: string
): Promise<void> {
  if (!remotePath || remotePath === "/") {
    throw new Error("Refusing to delete root directory '/'.");
  }
  return withSftp(creds, async (sftp) => {
    await deleteRecursiveInternal(sftp, remotePath);
  });
}
