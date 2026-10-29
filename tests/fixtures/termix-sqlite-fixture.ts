/**
 * Builds a realistic Termix SQLite database for importer tests, sealing secrets
 * exactly like Termix does (`Termix-SSH/Termix`):
 *  - FieldCrypto: AES-256-GCM, 16-byte IV, HKDF-SHA256(DEK, salt, `${recordId}:${fieldName}`)
 *  - UserKeyManager v3 DEK wrap: HKDF(ENCRYPTION_KEY, "", `termix:dek-wrap:v3:${userId}`), AAD = userId
 *  - Termix 2.x password DEK wrap: PBKDF2-SHA256(password, salt, iterations)
 *  - DatabaseFileEncryption v2: `[UInt32BE metaLength][meta JSON][AES-256-GCM(DATABASE_KEY)]`
 */
import crypto from "node:crypto";
import initSqlJs from "sql.js";
import { generateEd25519KeyPair } from "../../src/lib/server/ssh-key-utils";

export function termixEncryptField(
  plaintext: string,
  dek: Buffer,
  recordId: string,
  fieldName: string
): string {
  const salt = crypto.randomBytes(32);
  const fieldKey = Buffer.from(
    crypto.hkdfSync("sha256", dek, salt, `${recordId}:${fieldName}`, 32)
  );
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", fieldKey, iv);
  let data = cipher.update(plaintext, "utf8", "hex");
  data += cipher.final("hex");
  return JSON.stringify({
    data,
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    salt: salt.toString("hex"),
    recordId,
  });
}

export function termixWrapDekV3(
  userId: string,
  dek: Buffer,
  encryptionKey: Buffer
): string {
  const wrapKey = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      encryptionKey,
      Buffer.alloc(0),
      `termix:dek-wrap:v3:${userId}`,
      32
    )
  );
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", wrapKey, iv);
  cipher.setAAD(Buffer.from(userId, "utf8"));
  const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
  return JSON.stringify({
    v: 3,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    createdAt: new Date().toISOString(),
  });
}

export function termixWrapDekWithPassword(
  dek: Buffer,
  password: string
): { wrap: string; salt: string } {
  const salt = crypto.randomBytes(32);
  const iterations = 100000;
  const kek = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", kek, iv);
  const data = Buffer.concat([cipher.update(dek), cipher.final()]);
  const createdAt = new Date().toISOString();
  return {
    wrap: JSON.stringify({
      data: data.toString("hex"),
      iv: iv.toString("hex"),
      tag: cipher.getAuthTag().toString("hex"),
      algorithm: "aes-256-gcm",
      createdAt,
    }),
    salt: JSON.stringify({
      salt: salt.toString("hex"),
      iterations,
      algorithm: "pbkdf2-sha256",
      createdAt,
    }),
  };
}

function sealDatabase(
  sqliteBytes: Buffer,
  databaseKey: Buffer
): { meta: Record<string, unknown>; encrypted: Buffer } {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", databaseKey, iv);
  const encrypted = Buffer.concat([cipher.update(sqliteBytes), cipher.final()]);
  return {
    meta: {
      iv: iv.toString("hex"),
      tag: cipher.getAuthTag().toString("hex"),
      version: "v2",
      fingerprint: "termix-v2-systemcrypto",
      algorithm: "aes-256-gcm",
      keySource: "SystemCrypto",
      dataSize: encrypted.length,
    },
    encrypted,
  };
}

/** Termix's current single-file `db.sqlite.encrypted` layout. */
export function termixEncryptDatabaseFile(
  sqliteBytes: Buffer,
  databaseKey: Buffer
): Buffer {
  const { meta, encrypted } = sealDatabase(sqliteBytes, databaseKey);
  const metaBuf = Buffer.from(JSON.stringify(meta, null, 2), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(metaBuf.length, 0);
  return Buffer.concat([len, metaBuf, encrypted]);
}

/** Termix's legacy two-file layout (`db.sqlite.encrypted` + `db.sqlite.encrypted.meta`). */
export function termixEncryptDatabaseTwoFile(
  sqliteBytes: Buffer,
  databaseKey: Buffer
): { encrypted: Buffer; metaJson: string } {
  const { meta, encrypted } = sealDatabase(sqliteBytes, databaseKey);
  return { encrypted, metaJson: JSON.stringify(meta, null, 2) };
}

export interface TermixFixture {
  sqlite: Buffer;
  encryptedFile: Buffer;
  databaseKeyHex: string;
  encryptionKeyHex: string;
  envFile: string;
  bobPassword: string;
  clusterKey: { privateKey: string; publicKey: string; fingerprint: string };
  buildKey: { privateKey: string; publicKey: string; fingerprint: string };
}

const SCHEMA = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  registered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE ssh_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  folder TEXT,
  tags TEXT,
  pin INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER,
  auth_type TEXT NOT NULL,
  username TEXT,
  password TEXT,
  key TEXT,
  private_key TEXT,
  public_key TEXT,
  key_password TEXT,
  key_type TEXT,
  detected_key_type TEXT,
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE ssh_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  connection_type TEXT NOT NULL DEFAULT 'ssh',
  name TEXT,
  ip TEXT NOT NULL,
  port INTEGER NOT NULL,
  username TEXT NOT NULL,
  folder TEXT,
  parent_host_id INTEGER,
  tags TEXT,
  pin INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER,
  auth_type TEXT NOT NULL,
  password TEXT,
  key TEXT,
  key_password TEXT,
  key_type TEXT,
  sudo_password TEXT,
  credential_id INTEGER,
  override_credential_username INTEGER,
  jump_hosts TEXT,
  notes TEXT,
  enable_ssh INTEGER NOT NULL DEFAULT 1,
  ssh_port INTEGER DEFAULT 22,
  use_socks5 INTEGER,
  socks5_host TEXT,
  socks5_port INTEGER,
  enable_rdp INTEGER NOT NULL DEFAULT 0,
  rdp_port INTEGER DEFAULT 3389,
  rdp_user TEXT,
  rdp_password TEXT,
  rdp_domain TEXT,
  rdp_security TEXT,
  rdp_ignore_cert INTEGER DEFAULT 0,
  rdp_credential_id INTEGER,
  rdp_auth_type TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE host_protocol_auth (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  protocol TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'direct',
  credential_id INTEGER,
  username TEXT,
  password TEXT,
  fields TEXT,
  secret_fields TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE snippets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  description TEXT,
  folder TEXT,
  "order" INTEGER NOT NULL DEFAULT 0,
  is_note INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  username TEXT NOT NULL,
  action TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

export async function buildTermixFixture(
  options: { sshTestPort?: number } = {}
): Promise<TermixFixture> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(SCHEMA);

  const databaseKey = crypto.randomBytes(32);
  const encryptionKey = crypto.randomBytes(32);
  const adminId = "u-admin-7f3a";
  const bobId = "u-bob-19c2";
  const bobPassword = "bob-termix-pass!";
  const adminDek = crypto.randomBytes(32);
  const bobDek = crypto.randomBytes(32);

  const cluster = generateEd25519KeyPair("termix-cluster");
  const build = generateEd25519KeyPair("termix-build");

  db.run("INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, ?)", [
    adminId,
    "admin",
    "$2b$10$hash",
    1,
  ]);
  db.run("INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, ?)", [
    bobId,
    "bob",
    "$2b$10$hash",
    0,
  ]);

  // Admin: Termix v3 DEK (system ENCRYPTION_KEY wrap). Bob: Termix 2.x password wrap.
  db.run("INSERT INTO settings (key, value) VALUES (?, ?)", [
    `user_dek_v3_${adminId}`,
    termixWrapDekV3(adminId, adminDek, encryptionKey),
  ]);
  const bobWrap = termixWrapDekWithPassword(bobDek, bobPassword);
  db.run("INSERT INTO settings (key, value) VALUES (?, ?)", [
    `user_encrypted_dek_${bobId}`,
    bobWrap.wrap,
  ]);
  db.run("INSERT INTO settings (key, value) VALUES (?, ?)", [
    `user_kek_salt_${bobId}`,
    bobWrap.salt,
  ]);

  // ssh_credentials (ids 1, 2)
  db.run(
    "INSERT INTO ssh_credentials (id, user_id, name, auth_type, username, private_key, key_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      1,
      adminId,
      "Prod Cluster Key",
      "key",
      "deploy",
      termixEncryptField(cluster.privateKey, adminDek, "1", "privateKey"),
      "ssh-ed25519",
    ]
  );
  db.run(
    "INSERT INTO ssh_credentials (id, user_id, name, auth_type, username, password) VALUES (?, ?, ?, ?, ?, ?)",
    [
      2,
      adminId,
      "Windows Admin",
      "password",
      "Administrator",
      termixEncryptField("WinCred!42", adminDek, "2", "password"),
    ]
  );

  // ssh_data
  // 1: password SSH host (pinned, nested folder, tags)
  db.run(
    "INSERT INTO ssh_data (id, user_id, connection_type, name, ip, port, username, folder, tags, pin, auth_type, password, notes) VALUES (?, ?, 'ssh', ?, ?, ?, ?, ?, ?, ?, 'password', ?, ?)",
    [
      1,
      adminId,
      "web-01",
      "10.0.0.11",
      22,
      "ubuntu",
      "Production/Web",
      "web,prod",
      1,
      termixEncryptField("Sup3rSecret!", adminDek, "1", "password"),
      "Primary nginx node",
    ]
  );
  // 2: credential-backed key host behind a jump host
  db.run(
    "INSERT INTO ssh_data (id, user_id, connection_type, name, ip, port, username, folder, auth_type, credential_id, override_credential_username, jump_hosts) VALUES (?, ?, 'ssh', ?, ?, ?, ?, ?, 'credential', ?, 0, ?)",
    [2, adminId, "db-01", "10.0.1.20", 22, "ignored", "Production/DB", 1, JSON.stringify([{ hostId: 1 }])]
  );
  // 3: inline key host with passphrase-less key + stored key password, custom port
  db.run(
    "INSERT INTO ssh_data (id, user_id, connection_type, name, ip, port, username, auth_type, key, key_password, key_type) VALUES (?, ?, 'ssh', ?, ?, ?, ?, 'key', ?, ?, 'auto')",
    [
      3,
      adminId,
      "build-box",
      "build.internal",
      2222,
      "ci",
      termixEncryptField(build.privateKey, adminDek, "3", "key"),
      termixEncryptField("kp-123", adminDek, "3", "keyPassword"),
    ]
  );
  // 4: Termix 3.x RDP host with host_protocol_auth -> credential 2
  db.run(
    "INSERT INTO ssh_data (id, user_id, connection_type, name, ip, port, username, folder, auth_type, enable_ssh) VALUES (?, ?, 'rdp', ?, ?, ?, '', ?, 'password', 0)",
    [4, adminId, "win-bastion", "10.0.0.50", 3389, "Windows"]
  );
  db.run(
    "INSERT INTO host_protocol_auth (host_id, user_id, protocol, auth_type, credential_id, fields) VALUES (?, ?, 'rdp', 'credential', ?, ?)",
    [4, adminId, 2, JSON.stringify({ domain: "CORP", security: "nla", ignoreCert: "true" })]
  );
  // 5: Termix 2.8 multi-protocol host: SSH + legacy RDP columns
  db.run(
    "INSERT INTO ssh_data (id, user_id, connection_type, name, ip, port, username, auth_type, password, enable_rdp, rdp_port, rdp_user, rdp_password, rdp_domain, rdp_security, use_socks5, socks5_host, socks5_port) VALUES (?, ?, 'ssh', ?, ?, ?, ?, 'password', ?, 1, 3390, ?, ?, ?, 'tls', 1, ?, ?)",
    [
      5,
      adminId,
      "dual-stack",
      "192.168.50.5",
      22,
      "admin",
      termixEncryptField("ssh-dual-pass", adminDek, "5", "password"),
      "rdpuser",
      termixEncryptField("rdp-dual-pass", adminDek, "5", "rdpPassword"),
      "LAB",
      "proxy.lan",
      1080,
    ]
  );
  // 6: VNC-only host (unsupported in Sushi)
  db.run(
    "INSERT INTO ssh_data (id, user_id, connection_type, name, ip, port, username, auth_type, enable_ssh) VALUES (?, ?, 'vnc', ?, ?, ?, '', 'password', 0)",
    [6, adminId, "kiosk-vnc", "10.0.0.99", 5900]
  );
  // 7: Bob's Termix 2.x host (password-wrapped DEK)
  db.run(
    "INSERT INTO ssh_data (id, user_id, connection_type, name, ip, port, username, auth_type, password) VALUES (?, ?, 'ssh', ?, ?, ?, ?, 'password', ?)",
    [7, bobId, "bob-pi", "192.168.1.42", 22, "pi", termixEncryptField("raspberry", bobDek, "7", "password")]
  );

  // 8: credential-backed host that overrides the credential's username and
  //    points at the E2E SSH server, proving an imported host really connects.
  if (options.sshTestPort) {
    db.run(
      "INSERT INTO ssh_data (id, user_id, connection_type, name, ip, port, username, folder, auth_type, credential_id, override_credential_username) VALUES (?, ?, 'ssh', ?, ?, ?, ?, ?, 'credential', ?, 1)",
      [8, adminId, "sushi-e2e", "127.0.0.1", options.sshTestPort, "tester", "E2E", 1]
    );
  }

  // snippets
  db.run(
    "INSERT INTO snippets (user_id, name, content, description, folder, is_note) VALUES (?, ?, ?, ?, ?, 0)",
    [adminId, "Disk usage", "df -h", "Show disk usage", "Ops"]
  );
  db.run(
    "INSERT INTO snippets (user_id, name, content, folder, is_note) VALUES (?, ?, ?, ?, 1)",
    [adminId, "Runbook note", "Remember to rotate keys", "Notes"]
  );
  db.run("INSERT INTO snippets (user_id, name, content, is_note) VALUES (?, ?, ?, 0)", [
    bobId,
    "Pi temp",
    "vcgencmd measure_temp",
  ]);
  db.run("INSERT INTO audit_logs (user_id, username, action) VALUES (?, ?, ?)", [
    adminId,
    "admin",
    "login",
  ]);

  const sqlite = Buffer.from(db.export());
  db.close();

  const databaseKeyHex = databaseKey.toString("hex");
  const encryptionKeyHex = encryptionKey.toString("hex");
  return {
    sqlite,
    encryptedFile: termixEncryptDatabaseFile(sqlite, databaseKey),
    databaseKeyHex,
    encryptionKeyHex,
    envFile: [
      "# Termix Auto-generated Configuration",
      "",
      "# Security Keys (Auto-generated)",
      `JWT_SECRET=${crypto.randomBytes(32).toString("hex")}`,
      `DATABASE_KEY=${databaseKeyHex}`,
      `ENCRYPTION_KEY=${encryptionKeyHex}`,
      `INTERNAL_AUTH_TOKEN=${crypto.randomBytes(32).toString("hex")}`,
      "",
    ].join("\n"),
    bobPassword,
    clusterKey: {
      privateKey: cluster.privateKey,
      publicKey: cluster.publicKey,
      fingerprint: cluster.record.fingerprint,
    },
    buildKey: {
      privateKey: build.privateKey,
      publicKey: build.publicKey,
      fingerprint: build.record.fingerprint,
    },
  };
}
