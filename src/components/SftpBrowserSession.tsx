"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  Folder,
  FileText,
  FileCode2,
  Link2,
  ArrowUp,
  RotateCw,
  Upload,
  FolderPlus,
  FilePlus2,
  Download,
  Pencil,
  Trash2,
  Shield,
  Terminal,
  Eye,
  EyeOff,
  Search,
  ChevronRight,
  Save,
  X,
  Loader2,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import type { HostProfile, SftpEntry } from "@/types/connection";
import { type GatewaySettings, getAuthHeaders } from "@/lib/client/gateway";

interface SftpBrowserSessionProps {
  profile: HostProfile;
  initialPath?: string;
  gatewaySettings: GatewaySettings;
  onOpenCompanionSsh: (cwd?: string) => void;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const idx = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024))
  );
  const val = bytes / Math.pow(1024, idx);
  return `${val >= 10 || idx === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}

function formatDate(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isLikelyCodeOrText(name: string, size: number): boolean {
  if (size > 2 * 1024 * 1024) return false;
  const lower = name.toLowerCase();
  if (
    lower.startsWith(".") ||
    [
      "dockerfile",
      "makefile",
      "caddyfile",
      "readme",
      "license",
      "procfile",
    ].includes(lower)
  ) {
    return true;
  }
  const ext = lower.split(".").pop() || "";
  return [
    "txt",
    "md",
    "json",
    "yaml",
    "yml",
    "toml",
    "ini",
    "cfg",
    "conf",
    "env",
    "sh",
    "bash",
    "zsh",
    "js",
    "mjs",
    "cjs",
    "ts",
    "tsx",
    "jsx",
    "py",
    "go",
    "rs",
    "rb",
    "php",
    "java",
    "c",
    "cpp",
    "h",
    "css",
    "scss",
    "html",
    "xml",
    "svg",
    "sql",
    "log",
    "service",
    "nginx",
    "csv",
  ].includes(ext);
}

export function SftpBrowserSession({
  profile,
  initialPath,
  gatewaySettings,
  onOpenCompanionSsh,
}: SftpBrowserSessionProps) {
  const [cwd, setCwd] = useState<string>(initialPath || profile.initialPath || ".");
  const [pathInput, setPathInput] = useState<string>(
    initialPath || profile.initialPath || "."
  );
  const [editingPath, setEditingPath] = useState(false);
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  const [showHidden, setShowHidden] = useState(true);
  const [filterText, setFilterText] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);

  // Built-in Remote Text/Config Editor state
  const [editorFile, setEditorFile] = useState<{
    path: string;
    name: string;
    content: string;
    originalContent: string;
    octal?: string;
    isNew?: boolean;
  } | null>(null);
  const [savingFile, setSavingFile] = useState(false);

  // Dialog states (mkdir, rename, chmod, delete)
  const [mkdirName, setMkdirName] = useState<string | null>(null);
  const [newFileName, setNewFileName] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<{
    entry: SftpEntry;
    nextName: string;
  } | null>(null);
  const [chmodTarget, setChmodTarget] = useState<{
    entry: SftpEntry;
    octal: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SftpEntry | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const credentialsPayload = {
    host: profile.host,
    port: profile.port,
    username: profile.username,
    authMethod: profile.authMethod,
    password: profile.password,
    privateKey: profile.privateKey,
    passphrase: profile.passphrase,
  };

  const showNotice = (ok: boolean, msg: string) => {
    setToast({ ok, msg });
    setTimeout(() => setToast(null), 3200);
  };

  const loadDirectory = useCallback(
    async (targetPath: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/sftp/list", {
          method: "POST",
          headers: getAuthHeaders(gatewaySettings),
          body: JSON.stringify({
            credentials: credentialsPayload,
            path: targetPath,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || `Failed to list ${targetPath}`);
        }
        setCwd(data.cwd);
        setPathInput(data.cwd);
        setEntries(data.entries || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load directory.");
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      profile.host,
      profile.port,
      profile.username,
      profile.authMethod,
      profile.password,
      profile.privateKey,
      profile.passphrase,
      gatewaySettings,
    ]
  );

  useEffect(() => {
    void loadDirectory(initialPath || profile.initialPath || ".");
  }, [loadDirectory, initialPath, profile.initialPath]);

  const navigateParent = () => {
    if (!cwd || cwd === "/") return;
    const parts = cwd.split("/").filter(Boolean);
    parts.pop();
    const parent = "/" + parts.join("/");
    void loadDirectory(parent);
  };

  const openRemoteFileEditor = async (entry: SftpEntry) => {
    setLoading(true);
    try {
      const res = await fetch("/api/sftp/ops", {
        method: "POST",
        headers: getAuthHeaders(gatewaySettings),
        body: JSON.stringify({
          action: "readText",
          credentials: credentialsPayload,
          path: entry.path,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Unable to read remote file.");
      }
      setEditorFile({
        path: entry.path,
        name: entry.name,
        content: data.content,
        originalContent: data.content,
        octal: data.octal,
      });
    } catch (err) {
      showNotice(false, err instanceof Error ? err.message : "Read failed.");
    } finally {
      setLoading(false);
    }
  };

  const saveEditorFile = async () => {
    if (!editorFile) return;
    setSavingFile(true);
    try {
      const res = await fetch("/api/sftp/ops", {
        method: "POST",
        headers: getAuthHeaders(gatewaySettings),
        body: JSON.stringify({
          action: "writeText",
          credentials: credentialsPayload,
          path: editorFile.path,
          content: editorFile.content,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Unable to save file.");
      }
      setEditorFile((prev) =>
        prev ? { ...prev, originalContent: prev.content, isNew: false } : null
      );
      showNotice(true, `Saved ${editorFile.name} (${data.bytesWritten} B)`);
      void loadDirectory(cwd);
    } catch (err) {
      showNotice(false, err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSavingFile(false);
    }
  };

  const handleDownloadFile = async (entry: SftpEntry) => {
    showNotice(true, `Downloading ${entry.name}...`);
    try {
      const res = await fetch("/api/sftp/download", {
        method: "POST",
        headers: getAuthHeaders(gatewaySettings),
        body: JSON.stringify({
          credentials: credentialsPayload,
          path: entry.path,
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = entry.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      showNotice(false, err instanceof Error ? err.message : "Download failed.");
    }
  };

  const uploadFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("credentials", JSON.stringify(credentialsPayload));
      formData.append("remoteDir", cwd);
      for (const f of files) {
        formData.append("files", f);
      }

      const headers: Record<string, string> = {};
      if (gatewaySettings.gatewayToken) {
        headers["X-Sushi-Token"] = gatewaySettings.gatewayToken;
      }

      const res = await fetch("/api/sftp/upload", {
        method: "POST",
        headers,
        body: formData,
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Upload failed.");
      }
      showNotice(true, `Uploaded ${files.length} file(s) to ${cwd}`);
      void loadDirectory(cwd);
    } catch (err) {
      showNotice(false, err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  };

  const runAction = async (payload: Record<string, unknown>, successMsg: string) => {
    try {
      const res = await fetch("/api/sftp/ops", {
        method: "POST",
        headers: getAuthHeaders(gatewaySettings),
        body: JSON.stringify({
          credentials: credentialsPayload,
          ...payload,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "SFTP operation failed.");
      }
      showNotice(true, successMsg);
      void loadDirectory(cwd);
    } catch (err) {
      showNotice(false, err instanceof Error ? err.message : "Operation failed.");
    }
  };

  const visibleEntries = entries.filter((e) => {
    if (!showHidden && e.name.startsWith(".")) return false;
    if (
      filterText &&
      !e.name.toLowerCase().includes(filterText.trim().toLowerCase())
    ) {
      return false;
    }
    return true;
  });

  const breadcrumbParts = cwd.split("/").filter(Boolean);

  return (
    <div
      className="relative flex h-full w-full flex-col overflow-hidden bg-[#090b10]"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setIsDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        if (e.dataTransfer.files?.length) {
          void uploadFiles(e.dataTransfer.files);
        }
      }}
    >
      {/* Drag-and-Drop Upload Overlay */}
      {isDragging && (
        <div className="pointer-events-none absolute inset-3 z-40 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-sky-400 bg-sky-500/15 backdrop-blur-xs">
          <Upload className="mb-2 h-10 w-10 text-sky-300" />
          <p className="text-sm font-semibold text-white">
            Drop files anywhere to upload to {cwd}
          </p>
        </div>
      )}

      {/* Top Path & Action Bar */}
      <div className="space-y-2 border-b border-white/8 bg-[#0f131b] px-4 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {/* Navigation & Breadcrumbs */}
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <button
              type="button"
              onClick={navigateParent}
              disabled={!cwd || cwd === "/"}
              className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-slate-300 transition hover:bg-white/10 hover:text-white disabled:opacity-35"
              title="Up to parent directory"
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void loadDirectory(cwd)}
              className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-slate-300 transition hover:bg-white/10 hover:text-white"
              title="Refresh directory"
            >
              <RotateCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>

            {editingPath ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setEditingPath(false);
                  void loadDirectory(pathInput.trim() || "/");
                }}
                className="flex flex-1 items-center"
              >
                <input
                  type="text"
                  value={pathInput}
                  onChange={(e) => setPathInput(e.target.value)}
                  onBlur={() => setEditingPath(false)}
                  autoFocus
                  className="font-mono-code w-full rounded-lg border border-sky-500/50 bg-[#090b10] px-3 py-1 text-xs text-white outline-none"
                />
              </form>
            ) : (
              <div
                onClick={() => setEditingPath(true)}
                className="font-mono-code flex min-w-0 flex-1 cursor-text items-center gap-1 overflow-x-auto rounded-lg border border-white/8 bg-[#090b10] px-2.5 py-1 text-xs text-slate-200 hover:border-white/18"
                title="Click to type remote path directly"
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void loadDirectory("/");
                  }}
                  className="rounded px-1 text-sky-400 hover:bg-white/8"
                >
                  /
                </button>
                {breadcrumbParts.map((part, idx) => {
                  const target = "/" + breadcrumbParts.slice(0, idx + 1).join("/");
                  return (
                    <React.Fragment key={target}>
                      <ChevronRight className="h-3 w-3 shrink-0 text-slate-600" />
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void loadDirectory(target);
                        }}
                        className="truncate rounded px-1 hover:bg-white/8 hover:text-white"
                      >
                        {part}
                      </button>
                    </React.Fragment>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right Toolbar */}
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={(e) => {
                if (e.target.files?.length) {
                  void uploadFiles(e.target.files);
                  e.target.value = "";
                }
              }}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex items-center gap-1.5 rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-sky-400 disabled:opacity-50"
            >
              {uploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              Upload
            </button>

            <button
              type="button"
              onClick={() => setMkdirName("")}
              className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-slate-200 transition hover:bg-white/10"
            >
              <FolderPlus className="h-3.5 w-3.5 text-sky-400" />
              <span className="hidden sm:inline">New Folder</span>
            </button>

            <button
              type="button"
              onClick={() => setNewFileName("")}
              className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-slate-200 transition hover:bg-white/10"
            >
              <FilePlus2 className="h-3.5 w-3.5 text-emerald-400" />
              <span className="hidden sm:inline">New File</span>
            </button>

            <button
              type="button"
              onClick={() => onOpenCompanionSsh(cwd)}
              className="flex items-center gap-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-medium text-emerald-300 transition hover:bg-emerald-500/20"
              title="Open SSH terminal in this folder"
            >
              <Terminal className="h-3.5 w-3.5" />
              <span className="hidden md:inline">SSH Here</span>
            </button>
          </div>
        </div>

        {/* Filter & Hidden Toggle */}
        <div className="flex items-center justify-between gap-3">
          <div className="relative flex-1 max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-500" />
            <input
              type="text"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder="Filter current directory..."
              className="w-full rounded-lg border border-white/8 bg-[#090b10] py-1 pl-8 pr-3 text-xs text-white placeholder-slate-500 outline-none focus:border-white/20"
            />
          </div>

          <div className="flex items-center gap-3 text-xs text-slate-400">
            {toast && (
              <span
                className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] ${
                  toast.ok
                    ? "bg-emerald-500/15 text-emerald-300"
                    : "bg-rose-500/15 text-rose-300"
                }`}
              >
                {toast.ok ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : (
                  <AlertCircle className="h-3 w-3" />
                )}
                {toast.msg}
              </span>
            )}
            <span className="font-mono-code hidden sm:inline">
              {visibleEntries.length} items
            </span>
            <button
              type="button"
              onClick={() => setShowHidden((v) => !v)}
              className="flex items-center gap-1 rounded-md px-2 py-0.5 text-xs text-slate-300 hover:bg-white/5"
            >
              {showHidden ? (
                <Eye className="h-3.5 w-3.5 text-sky-400" />
              ) : (
                <EyeOff className="h-3.5 w-3.5 text-slate-500" />
              )}
              Dotfiles
            </button>
          </div>
        </div>
      </div>

      {/* Inline Quick Prompts (New Folder / New File) */}
      {mkdirName !== null && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = mkdirName.trim();
            if (trimmed) {
              const target = cwd === "/" ? `/${trimmed}` : `${cwd}/${trimmed}`;
              setMkdirName(null);
              void runAction({ action: "mkdir", path: target }, `Created ${trimmed}`);
            }
          }}
          className="flex items-center gap-2 border-b border-white/8 bg-[#141925] px-4 py-2"
        >
          <FolderPlus className="h-4 w-4 text-sky-400" />
          <input
            type="text"
            value={mkdirName}
            onChange={(e) => setMkdirName(e.target.value)}
            placeholder="New folder name..."
            autoFocus
            className="font-mono-code flex-1 rounded-lg border border-white/15 bg-[#090b10] px-3 py-1 text-xs text-white outline-none"
          />
          <button
            type="submit"
            className="rounded-lg bg-sky-500 px-3 py-1 text-xs font-semibold text-slate-950"
          >
            Create
          </button>
          <button
            type="button"
            onClick={() => setMkdirName(null)}
            className="text-xs text-slate-400 hover:text-white"
          >
            Cancel
          </button>
        </form>
      )}

      {newFileName !== null && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = newFileName.trim();
            if (trimmed) {
              const target = cwd === "/" ? `/${trimmed}` : `${cwd}/${trimmed}`;
              setNewFileName(null);
              setEditorFile({
                path: target,
                name: trimmed,
                content: "",
                originalContent: "",
                isNew: true,
              });
            }
          }}
          className="flex items-center gap-2 border-b border-white/8 bg-[#141925] px-4 py-2"
        >
          <FilePlus2 className="h-4 w-4 text-emerald-400" />
          <input
            type="text"
            value={newFileName}
            onChange={(e) => setNewFileName(e.target.value)}
            placeholder="New remote filename (e.g. docker-compose.yml)..."
            autoFocus
            className="font-mono-code flex-1 rounded-lg border border-white/15 bg-[#090b10] px-3 py-1 text-xs text-white outline-none"
          />
          <button
            type="submit"
            className="rounded-lg bg-emerald-500 px-3 py-1 text-xs font-semibold text-slate-950"
          >
            Open in Editor
          </button>
          <button
            type="button"
            onClick={() => setNewFileName(null)}
            className="text-xs text-slate-400 hover:text-white"
          >
            Cancel
          </button>
        </form>
      )}

      {/* Error State */}
      {error && (
        <div className="m-4 flex items-center justify-between rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-200">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={() => void loadDirectory(cwd)}
            className="rounded-lg bg-rose-500/20 px-3 py-1 font-medium text-rose-100 hover:bg-rose-500/30"
          >
            Retry
          </button>
        </div>
      )}

      {/* File Table */}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-left text-xs">
          <thead className="sticky top-0 z-10 border-b border-white/8 bg-[#0e121a] text-[11px] font-medium uppercase tracking-wider text-slate-400">
            <tr>
              <th className="py-2.5 pl-4 pr-3">Name</th>
              <th className="hidden px-3 py-2.5 text-right sm:table-cell">Size</th>
              <th className="hidden px-3 py-2.5 md:table-cell">Permissions</th>
              <th className="hidden px-3 py-2.5 lg:table-cell">Modified</th>
              <th className="py-2.5 pl-3 pr-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.04]">
            {cwd !== "/" && (
              <tr
                onClick={navigateParent}
                className="cursor-pointer transition hover:bg-white/[0.03]"
              >
                <td className="py-2 pl-4 pr-3 font-medium text-slate-300" colSpan={5}>
                  <div className="flex items-center gap-2.5">
                    <Folder className="h-4 w-4 text-sky-400/75" />
                    <span className="font-mono-code">..</span>
                  </div>
                </td>
              </tr>
            )}

            {loading && entries.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-16 text-center text-slate-400">
                  <Loader2 className="mx-auto mb-2 h-6 w-6 animate-spin text-sky-400" />
                  Connecting to {profile.host}:{profile.port} via SFTP...
                </td>
              </tr>
            ) : visibleEntries.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-16 text-center text-slate-500">
                  Directory is empty. Drag &amp; drop files here to upload.
                </td>
              </tr>
            ) : (
              visibleEntries.map((entry) => {
                const isDir = entry.type === "directory";
                const isLink = entry.type === "symlink";
                const editable =
                  !isDir && isLikelyCodeOrText(entry.name, entry.size);

                return (
                  <tr
                    key={entry.path}
                    onDoubleClick={() => {
                      if (isDir) {
                        void loadDirectory(entry.path);
                      } else if (editable) {
                        void openRemoteFileEditor(entry);
                      }
                    }}
                    className="group transition hover:bg-white/[0.035]"
                  >
                    <td className="py-2 pl-4 pr-3">
                      <button
                        type="button"
                        onClick={() => {
                          if (isDir) {
                            void loadDirectory(entry.path);
                          } else if (editable) {
                            void openRemoteFileEditor(entry);
                          }
                        }}
                        className="flex max-w-full items-center gap-2.5 text-left"
                      >
                        {isDir ? (
                          <Folder className="h-4 w-4 shrink-0 fill-sky-400/20 text-sky-400" />
                        ) : isLink ? (
                          <Link2 className="h-4 w-4 shrink-0 text-purple-400" />
                        ) : editable ? (
                          <FileCode2 className="h-4 w-4 shrink-0 text-emerald-400" />
                        ) : (
                          <FileText className="h-4 w-4 shrink-0 text-slate-400" />
                        )}
                        <span
                          className={`font-mono-code truncate ${
                            isDir
                              ? "font-medium text-white group-hover:text-sky-300"
                              : "text-slate-200"
                          }`}
                        >
                          {entry.name}
                        </span>
                      </button>
                    </td>

                    <td className="font-mono-code hidden px-3 py-2 text-right text-slate-400 sm:table-cell">
                      {isDir ? "—" : formatBytes(entry.size)}
                    </td>

                    <td className="font-mono-code hidden px-3 py-2 text-slate-400 md:table-cell">
                      <span>{entry.permissions}</span>{" "}
                      <span className="text-[11px] text-slate-500">
                        ({entry.octal})
                      </span>
                    </td>

                    <td className="tabular-nums hidden px-3 py-2 text-slate-400 lg:table-cell">
                      {formatDate(entry.mtime)}
                    </td>

                    <td className="py-2 pl-3 pr-4 text-right">
                      <div className="inline-flex items-center justify-end gap-1 opacity-80 transition group-hover:opacity-100">
                        {!isDir && (
                          <>
                            <button
                              type="button"
                              onClick={() => void openRemoteFileEditor(entry)}
                              className="rounded-md p-1 text-slate-400 hover:bg-white/8 hover:text-emerald-300"
                              title="Edit file over SFTP"
                            >
                              <FileCode2 className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDownloadFile(entry)}
                              className="rounded-md p-1 text-slate-400 hover:bg-white/8 hover:text-sky-300"
                              title="Download file"
                            >
                              <Download className="h-3.5 w-3.5" />
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          onClick={() =>
                            setRenameTarget({ entry, nextName: entry.name })
                          }
                          className="rounded-md p-1 text-slate-400 hover:bg-white/8 hover:text-white"
                          title="Rename"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setChmodTarget({
                              entry,
                              octal: entry.octal.replace(/^0/, ""),
                            })
                          }
                          className="rounded-md p-1 text-slate-400 hover:bg-white/8 hover:text-amber-300"
                          title="Permissions (chmod)"
                        >
                          <Shield className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(entry)}
                          className="rounded-md p-1 text-slate-400 hover:bg-rose-500/15 hover:text-rose-400"
                          title="Delete"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Rename Modal */}
      {renameTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const next = renameTarget.nextName.trim();
              if (!next || next === renameTarget.entry.name) {
                setRenameTarget(null);
                return;
              }
              const dir =
                cwd === "/" ? `/${next}` : `${cwd}/${next}`;
              const oldPath = renameTarget.entry.path;
              setRenameTarget(null);
              void runAction(
                { action: "rename", oldPath, newPath: dir },
                `Renamed to ${next}`
              );
            }}
            className="w-full max-w-md space-y-4 rounded-2xl border border-white/10 bg-[#121722] p-5 shadow-2xl"
          >
            <h3 className="text-sm font-semibold text-white">Rename Item</h3>
            <input
              type="text"
              value={renameTarget.nextName}
              onChange={(e) =>
                setRenameTarget({ ...renameTarget, nextName: e.target.value })
              }
              autoFocus
              className="font-mono-code w-full rounded-xl border border-white/12 bg-[#090b10] px-3.5 py-2 text-xs text-white outline-none"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRenameTarget(null)}
                className="rounded-xl px-3.5 py-1.5 text-xs text-slate-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-xl bg-sky-500 px-4 py-1.5 text-xs font-semibold text-slate-950"
              >
                Rename
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Chmod Modal with interactive matrix */}
      {chmodTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md space-y-4 rounded-2xl border border-white/10 bg-[#121722] p-5 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">
                Permissions (chmod) — {chmodTarget.entry.name}
              </h3>
              <span className="font-mono-code rounded-md bg-white/8 px-2 py-0.5 text-xs text-amber-300">
                0{chmodTarget.octal}
              </span>
            </div>

            {(() => {
              const parsed = parseInt(chmodTarget.octal || "644", 8) || 0;
              const toggleBit = (bit: number) => {
                const next = parsed ^ bit;
                setChmodTarget({
                  ...chmodTarget,
                  octal: (next & 0o777).toString(8).padStart(3, "0"),
                });
              };
              const roles = [
                { label: "Owner", r: 0o400, w: 0o200, x: 0o100 },
                { label: "Group", r: 0o040, w: 0o020, x: 0o010 },
                { label: "Public", r: 0o004, w: 0o002, x: 0o001 },
              ];
              return (
                <div className="grid grid-cols-3 gap-2.5 rounded-xl border border-white/8 bg-[#0b0e14] p-3 text-xs">
                  {roles.map((role) => (
                    <div key={role.label} className="space-y-1.5">
                      <div className="font-semibold text-slate-300">{role.label}</div>
                      {(
                        [
                          ["Read (4)", role.r],
                          ["Write (2)", role.w],
                          ["Exec (1)", role.x],
                        ] as const
                      ).map(([lbl, bit]) => (
                        <label
                          key={lbl}
                          className="flex cursor-pointer items-center gap-2 text-slate-400"
                        >
                          <input
                            type="checkbox"
                            checked={Boolean(parsed & bit)}
                            onChange={() => toggleBit(bit)}
                            className="accent-amber-400"
                          />
                          {lbl}
                        </label>
                      ))}
                    </div>
                  ))}
                </div>
              );
            })()}

            <div>
              <label className="mb-1 block text-xs text-slate-400">Octal Mode</label>
              <input
                type="text"
                maxLength={4}
                value={chmodTarget.octal}
                onChange={(e) =>
                  setChmodTarget({
                    ...chmodTarget,
                    octal: e.target.value.replace(/[^0-7]/g, ""),
                  })
                }
                className="font-mono-code w-full rounded-xl border border-white/12 bg-[#090b10] px-3.5 py-2 text-xs text-white outline-none"
              />
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setChmodTarget(null)}
                className="rounded-xl px-3.5 py-1.5 text-xs text-slate-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = chmodTarget;
                  setChmodTarget(null);
                  void runAction(
                    {
                      action: "chmod",
                      path: target.entry.path,
                      mode: target.octal,
                    },
                    `Updated permissions on ${target.entry.name} to 0${target.octal}`
                  );
                }}
                className="rounded-xl bg-amber-400 px-4 py-1.5 text-xs font-semibold text-slate-950"
              >
                Apply chmod
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md space-y-4 rounded-2xl border border-rose-500/25 bg-[#121722] p-5 shadow-2xl">
            <h3 className="text-sm font-semibold text-white">
              Delete {deleteTarget.type === "directory" ? "Folder" : "File"}?
            </h3>
            <p className="text-xs leading-relaxed text-slate-300">
              Permanently remove{" "}
              <code className="font-mono-code rounded bg-white/8 px-1.5 py-0.5 text-rose-300">
                {deleteTarget.path}
              </code>
              {deleteTarget.type === "directory"
                ? " and all nested contents"
                : ""}{" "}
              from <strong>{profile.host}</strong>?
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="rounded-xl px-3.5 py-1.5 text-xs text-slate-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = deleteTarget;
                  setDeleteTarget(null);
                  void runAction(
                    { action: "delete", path: target.path },
                    `Deleted ${target.name}`
                  );
                }}
                className="rounded-xl bg-rose-500 px-4 py-1.5 text-xs font-semibold text-white hover:bg-rose-600"
              >
                Delete Permanently
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Remote File Code Editor Drawer */}
      {editorFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3 sm:p-6">
          <div className="flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-white/12 bg-[#0d1118] shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/8 bg-[#121722] px-4 py-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <FileCode2 className="h-4 w-4 shrink-0 text-emerald-400" />
                <span className="font-mono-code truncate text-xs font-medium text-white">
                  {editorFile.path}
                </span>
                {editorFile.content !== editorFile.originalContent && (
                  <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-medium text-amber-300">
                    Unsaved changes
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void saveEditorFile()}
                  disabled={savingFile}
                  className="flex items-center gap-1.5 rounded-xl bg-emerald-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
                >
                  {savingFile ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  Save over SFTP (⌘S)
                </button>
                <button
                  type="button"
                  onClick={() => setEditorFile(null)}
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <textarea
              value={editorFile.content}
              onChange={(e) =>
                setEditorFile({ ...editorFile, content: e.target.value })
              }
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
                  e.preventDefault();
                  void saveEditorFile();
                }
              }}
              spellCheck={false}
              className="font-mono-code min-h-0 flex-1 resize-none bg-[#090b10] p-4 text-xs leading-relaxed text-slate-100 outline-none"
              placeholder="Write remote file content..."
            />
          </div>
        </div>
      )}
    </div>
  );
}
