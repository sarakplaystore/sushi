import assert from "node:assert/strict";
import { strToU8, zipSync, Zip, ZipDeflate } from "fflate";
import { importSshClientText } from "../src/lib/client/ssh-import";
import { decodeImportText, expandImportFiles } from "../src/lib/client/ssh-import-files";
import { prepareSshImport } from "../src/lib/client/ssh-import-batch";
import { decryptVaultEnvelope, encryptVaultData, type VaultPlaintext } from "../src/lib/client/crypto-vault";
import { importFromTermixContent } from "../src/lib/client/termix-porter";

const file = (name: string, content: string) => ({ name, bytes: strToU8(content) });
const privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nZmFrZS10ZXN0LWtleQ==\n-----END OPENSSH PRIVATE KEY-----";

async function main() {
  console.log("==> Testing SSH client imports and portable backups...");
  const csv = [
    "Groups,Label,Tags,Hostname/IP,Protocol,Port,Username,Password,SSH_KEY",
    'Production,"Web, one","prod,eu",192.0.2.1,ssh,2222,deploy," p,\"\"q\"\" ",',
    'Production,Key Host,,192.0.2.2,ssh,22,ubuntu,,"' + privateKey + '"',
    'Other,FTP,,192.0.2.3,ftp,21,user,secret,',
    'Other,Bad port,,192.0.2.4,ssh,99999,user,secret,',
  ].join("\r\n");
  const csvResult = importSshClientText(csv, "hosts.csv");
  assert.equal(csvResult.detectedFormat, "ssh-csv");
  assert.equal(csvResult.hosts.length, 2);
  assert.equal(csvResult.hosts[0].name, "Web, one");
  assert.equal(csvResult.hosts[0].port, 2222);
  assert.equal(csvResult.hosts[0].password, ' p,"q" ');
  assert.deepEqual(csvResult.hosts[0].tags, ["prod", "eu"]);
  assert.equal(csvResult.sshKeys.length, 1);
  assert.equal(csvResult.hosts[1].sshKeyId, csvResult.sshKeys[0].id);
  assert.match(csvResult.warnings.join(" "), /protocol/);
  assert.match(csvResult.warnings.join(" "), /invalid port/);
  assert(!csvResult.warnings.join(" ").includes("secret"));
  assert.equal(importSshClientText("name,host,password\na,example.org, trailing  ", "hosts.csv").hosts[0].password, " trailing  ");
  const headerless = importSshClientText("Router,192.0.2.5,admin\nRaspberry,192.0.2.6,pi", "hosts.csv");
  assert.equal(headerless.hosts[1].username, "pi");
  assert.throws(() => importSshClientText('name,host\na,"not closed', "hosts.csv"), /quoted field/);
  assert.throws(() => importSshClientText("foo,bar,baz,qux\na,b,c,d", "hosts.csv"), /hostname\/address column/);

  const sshConfig = `# Global defaults are first-value-wins, just like OpenSSH
Host * !no-default
  User global
  Port 2022
Host first second
  HostName %h.example.test
  User overridden
  IdentityFile ~/.ssh/id_ed25519
Host no-default
  HostName no-default.example.test
  User special
Host direct
  ProxyJump bastion
Host unresolved
  HostName %n.example.test
Include other-config
Match user test
  HostName should-not-be-used
`;
  const ssh = importSshClientText(sshConfig, "config");
  assert.equal(ssh.detectedFormat, "ssh-config");
  assert.deepEqual(ssh.hosts.map((h) => h.name), ["first", "second", "no-default", "direct"]);
  assert.equal(ssh.hosts[0].host, "first.example.test");
  assert.equal(ssh.hosts[0].username, "global");
  assert.equal(ssh.hosts[0].port, 2022);
  assert.equal(ssh.hosts[0].authMethod, "privateKey");
  assert.equal(ssh.hosts[0].privateKey, undefined);
  assert.equal(ssh.hosts[2].username, "special");
  assert.equal(ssh.hosts[3].host, "direct");
  assert.match(ssh.warnings.join(" "), /jump host/);
  assert.match(ssh.warnings.join(" "), /Match/);
  assert.match(ssh.warnings.join(" "), /Include/);
  assert.match(ssh.warnings.join(" "), /requires expansion/);

  const reg = `Windows Registry Editor Version 5.00
[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\Prod%20%E2%98%83]
"HostName"="alice@host.example"
"PortNumber"=dword:000008ae
"Protocol"="ssh"
"PublicKeyFile"="C:\\\\Keys\\\\prod.ppk"
"ProxyMethod"=dword:00000006
[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\Telnet]
"HostName"="legacy.example"
"Protocol"="telnet"
`;
  const utf16Reg = new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(reg, "utf16le")]));
  const putty = prepareSshImport([{ name: "putty.reg", bytes: utf16Reg }]);
  assert.equal(putty.kind, "preview");
  if (putty.kind === "preview") {
    assert.equal(putty.summary.detectedFormat, "putty-reg");
    assert.equal(putty.summary.hosts.length, 1);
    assert.equal(putty.summary.hosts[0].name, "Prod ☃");
    assert.equal(putty.summary.hosts[0].username, "alice");
    assert.equal(putty.summary.hosts[0].host, "host.example");
    assert.equal(putty.summary.hosts[0].port, 2222);
    assert.match(putty.summary.hosts[0].notes!, /prod\.ppk/);
    assert.equal(putty.summary.hosts[0].privateKey, undefined);
    assert.match(putty.summary.warnings.join(" "), /proxy or jump host/);
  }
  assert.equal(decodeImportText(new Uint8Array(Buffer.from(reg, "utf16le"))), reg);
  assert.equal(decodeImportText(new Uint8Array([0x43, 0x61, 0x66, 0xe9])), "Café");

  const moba = `[Bookmarks_1]
SubRep=Production\\DB
SSH=#149#0%db.example%2200%deploy%%-1%-1%%jump.example%22%jump%0%0%0%/keys/id.ppk
Telnet=#98#1%telnet.example%23%u
`;
  const mobaResult = importSshClientText(moba, "sessions.mxtsessions");
  assert.equal(mobaResult.detectedFormat, "mobaxterm");
  assert.equal(mobaResult.hosts.length, 1);
  assert.equal(mobaResult.hosts[0].group, "Production\\DB");
  assert.equal(mobaResult.hosts[0].host, "db.example");
  assert.equal(mobaResult.hosts[0].authMethod, "privateKey");
  assert.match(mobaResult.warnings.join(" "), /Non-SSH/);
  assert.match(mobaResult.warnings.join(" "), /proxy or jump host/);

  const winScp = `[Sessions\\Team/Production%20SFTP]
HostName=files.example
UserName=backup
PortNumber=2202
FSProtocol=2
Password=THIS_IS_ENCRYPTED
RemoteDirectory=%2Fbackups
[Sessions\\Legacy FTP]
HostName=ftp.example
FSProtocol=5
`;
  const winscpResult = importSshClientText(winScp, "WinSCP.ini");
  assert.equal(winscpResult.hosts.length, 1);
  assert.equal(winscpResult.hosts[0].name, "Production SFTP");
  assert.equal(winscpResult.hosts[0].protocol, "sftp");
  assert.equal(winscpResult.hosts[0].initialPath, "/backups");
  assert.equal(winscpResult.hosts[0].password, undefined);
  assert(!JSON.stringify(winscpResult).includes("THIS_IS_ENCRYPTED"));
  assert.match(winscpResult.warnings.join(" "), /passwords/);
  assert.equal(importSshClientText(winScp.replace("FSProtocol=2", "FSProtocol=0"), "WinSCP.ini").hosts[0].protocol, "ssh");
  assert.equal(importSshClientText(winScp.replace("FSProtocol=2", "FSProtocol=1"), "WinSCP.ini").hosts[0].protocol, "sftp");

  const tabby = `groups:
  - id: prod
    name: Production
profileDefaults:
  ssh:
    port: 2022
profiles:
  - type: ssh
    name: Server
    group: prod
    options:
      host: tabby.example
      user: ubuntu
      auth: publicKey
      privateKeys: ["file:///home/me/.ssh/id_rsa"]
      jumpHost: proxy
  - type: local
    name: Shell
    options: { host: should-not-import }
vault: encrypted-values
`;
  const tabbyResult = importSshClientText(tabby, "config.yaml");
  assert.equal(tabbyResult.detectedFormat, "tabby");
  assert.equal(tabbyResult.hosts.length, 1);
  assert.equal(tabbyResult.hosts[0].port, 2022);
  assert.equal(tabbyResult.hosts[0].group, "Production");
  assert.equal(tabbyResult.hosts[0].authMethod, "privateKey");
  assert.equal(tabbyResult.hosts[0].privateKey, undefined);
  assert.match(tabbyResult.warnings.join(" "), /vault/);
  assert.throws(() => importSshClientText("encrypted: true\nvault: secret", "config.yaml"), /encrypted/);
  assert.throws(() => importSshClientText("profiles: [\n", "config.yaml"), /Invalid YAML/);

  const xshell = `[CONNECTION]
Host=xshell.example
Port=2222
Protocol=SSH
[CONNECTION:AUTHENTICATION]
UserName=tester
Password=NOT_PLAINTEXT
`;
  const xshellResult = importSshClientText(xshell, "Prod.xsh");
  assert.equal(xshellResult.detectedFormat, "xshell");
  assert.equal(xshellResult.hosts[0].username, "tester");
  assert.equal(xshellResult.hosts[0].password, undefined);
  assert(!JSON.stringify(xshellResult).includes("NOT_PLAINTEXT"));
  assert.throws(() => importSshClientText(xshell.replace("Protocol=SSH", "Protocol=TELNET"), "Prod.xsh"), /No supported hosts/);

  const generic = importSshClientText(JSON.stringify({ hosts: [
    { name: "JSON", hostname: "192.0.2.9", protocol: "sftp", user: "root", password: "!", privateKey, jumpHostId: "bastion", tunnels: ["forward"] },
    { name: "No Username", host: "host.example", protocol: "ssh" },
    { name: "Telnet", host: "telnet.example", protocol: "telnet" },
  ] }), "hosts.json");
  assert.equal(generic.detectedFormat, "ssh-json");
  assert.equal(generic.hosts.length, 2);
  assert.equal(generic.hosts[0].protocol, "sftp");
  assert.equal(generic.hosts[0].sshKeyId, generic.sshKeys[0].id);
  assert.equal(generic.hosts[1].username, "");
  assert.match(generic.warnings.join(" "), /no username/);
  assert.match(generic.warnings.join(" "), /jump host/);
  assert.match(generic.warnings.join(" "), /forwards or tunnels/);
  assert.throws(() => importSshClientText(JSON.stringify({ encrypted: true, hosts: [] }), "backup.json"), /encrypted/);
  const sealedGeneric = importSshClientText(JSON.stringify({ hosts: [
    { name: "Marked", host: "marked.example", password: "CIPHER_PASSWORD", passwordEncrypted: true },
    { name: "Prefix", host: "prefix.example", password: "enc:NOT_PLAINTEXT", privateKey: "encrypted:NOT_A_KEY", passphrase: "vault://key-passphrase" },
    { name: "Clear", host: "clear.example", password: "my enc:password" },
  ] }), "hosts.json");
  assert.equal(sealedGeneric.hosts[0].password, undefined);
  assert.equal(sealedGeneric.hosts[1].password, undefined);
  assert.equal(sealedGeneric.hosts[1].privateKey, undefined);
  assert.equal(sealedGeneric.hosts[1].passphrase, undefined);
  assert.equal(sealedGeneric.hosts[1].authMethod, "privateKey");
  assert.equal(sealedGeneric.hosts[2].password, "my enc:password");
  assert.match(sealedGeneric.warnings.join(" "), /encrypted/);
  assert(!JSON.stringify(sealedGeneric).includes("CIPHER_PASSWORD"));
  assert(!JSON.stringify(sealedGeneric).includes("NOT_PLAINTEXT"));
  assert(!JSON.stringify(sealedGeneric).includes("NOT_A_KEY"));
  const sealedCsv = importSshClientText("name,host,password,passwordEncrypted\na,a.example,cipher,yes", "hosts.csv");
  assert.equal(sealedCsv.hosts[0].password, undefined);
  assert.match(sealedCsv.warnings.join(" "), /encrypted/);

  const sealedTermix = JSON.stringify({ userData: {
    sshCredentials: [{ id: 1, name: "sealed", authType: "password", password: "CIPHERTEXT" }],
    sshHosts: [{ name: "termix", ip: "termix.example", credentialId: 1, password: "ALSO_CIPHER" }],
  }, metadata: { encrypted: true } });
  const termix = importFromTermixContent(sealedTermix);
  assert.equal(termix.hosts[0].password, undefined);
  assert(!JSON.stringify(termix).includes("ALSO_CIPHER"));
  assert.equal(importSshClientText(sealedTermix, "termix.json").detectedFormat, "termix-user-data-v2");
  const sealedTermixHosts = importSshClientText(JSON.stringify({
    metadata: { encrypted: true }, credentials: [{ id: 1, password: "CIPHER_CREDENTIAL" }],
    hosts: [{ name: "sealed-host", ip: "host.example", credentialId: 1, password: "CIPHER_HOST" }],
  }), "termix-hosts.json");
  assert.equal(sealedTermixHosts.hosts[0].password, undefined);
  assert(!JSON.stringify(sealedTermixHosts).includes("CIPHER_"));
  const markedTermix = importSshClientText(JSON.stringify({ credentials: [{ id: 1, password: "enc:SEALED" }],
    hosts: [{ name: "marked", ip: "host.example", credentialId: 1 }] }), "termix-hosts.json");
  assert.equal(markedTermix.hosts[0].password, undefined);
  assert.match(markedTermix.warnings.join(" "), /encrypted/);
  assert(!JSON.stringify(markedTermix).includes("SEALED"));
  const routedTermix = importSshClientText(JSON.stringify({ credentials: [], hosts: [
    { name: "routed", ip: "route.example", connectionType: "ssh", jumpHosts: ["bastion"], forwardedPorts: ["8080"] },
    { name: "unsupported", ip: "ftp.example", connectionType: "ftp" },
  ] }), "termix-hosts.json");
  assert.equal(routedTermix.hosts.length, 1);
  assert.match(routedTermix.warnings.join(" "), /jump host/);
  assert.match(routedTermix.warnings.join(" "), /forwards or tunnels/);
  assert.match(routedTermix.warnings.join(" "), /protocol is not/);
  assert.match(routedTermix.hosts[0].notes!, /Proxy\/jump settings were not imported/);

  const zip = zipSync({
    "data/hosts.csv": strToU8("Label,Host,Username,Password\nServer,example.org,alice,plaintext"),
    "data/config": strToU8("Host web\n  HostName web.example\n  User webuser\n  IdentityFile ~/.ssh/private.pem\n"),
    "keys/private.pem": strToU8(privateKey),
    "../../unsafe.csv": strToU8("Name,Host\nunsafe,evil.example"),
  });
  const archive = prepareSshImport([{ name: "icloud-drive.zip", bytes: zip }]);
  assert.equal(archive.kind, "preview");
  if (archive.kind === "preview") {
    assert.equal(archive.summary.hosts.length, 2);
    assert.equal(archive.summary.detectedFormat, "multiple-files");
    assert.match(archive.summary.warnings.join(" "), /ignored 1/);
    assert.equal(archive.summary.hosts[0].password, "plaintext");
    assert.equal(archive.summary.sshKeys.length, 1);
    assert.equal(archive.summary.hosts[1].sshKeyId, archive.summary.sshKeys[0].id);
    assert.equal(archive.summary.hosts[1].privateKey, privateKey);
    assert(!archive.summary.warnings.join(" ").includes("cannot be read from the export"));
  }
  const directoryZip = zipSync({ "folder/": new Uint8Array(), "folder/hosts.csv": strToU8("name,host\na,host.example") });
  const directoryImport = prepareSshImport([{ name: "folder.zip", bytes: directoryZip }]);
  assert.equal(directoryImport.kind, "preview");
  if (directoryImport.kind === "preview") assert.equal(directoryImport.summary.hosts.length, 1);
  const streamedChunks: Uint8Array[] = [];
  const streamedZip = new Zip((error, chunk) => { if (error) throw error; streamedChunks.push(chunk); });
  const streamedFile = new ZipDeflate("hosts.csv");
  streamedZip.add(streamedFile); streamedFile.push(strToU8("name,host\na,host.example"), true); streamedZip.end();
  const streamedImport = prepareSshImport([{ name: "stream.zip", bytes: Buffer.concat(streamedChunks) }]);
  assert.equal(streamedImport.kind, "preview");
  if (streamedImport.kind === "preview") assert.equal(streamedImport.summary.hosts.length, 1);

  const extensionlessKeyZip = zipSync({
    "config": strToU8("Host custom\n  HostName custom.example\n  IdentityFile ~/.ssh/my-deploy-key\n"),
    "keys/my-deploy-key": strToU8(privateKey),
  });
  const extensionlessKeyImport = prepareSshImport([{ name: "keys.zip", bytes: extensionlessKeyZip }]);
  assert.equal(extensionlessKeyImport.kind, "preview");
  if (extensionlessKeyImport.kind === "preview") {
    assert.equal(extensionlessKeyImport.summary.sshKeys.length, 1);
    assert.equal(extensionlessKeyImport.summary.hosts[0].sshKeyId, extensionlessKeyImport.summary.sshKeys[0].id);
  }
  const ambiguous = prepareSshImport([
    file("config", "Host x\n  HostName x.example\n  IdentityFile ~/.ssh/id.pem\n"),
    file("first/id.pem", privateKey),
    file("second/id.pem", privateKey.replace("ZmFrZS10ZXN0LWtleQ==", "b3RoZXIta2V5")),
  ]);
  assert.equal(ambiguous.kind, "preview");
  if (ambiguous.kind === "preview") {
    assert.equal(ambiguous.summary.sshKeys.length, 2);
    assert.equal(ambiguous.summary.hosts[0].sshKeyId, undefined);
    assert.match(ambiguous.summary.warnings.join(" "), /cannot be read from the export/);
  }
  const keyOnly = prepareSshImport([file("id_ed25519", privateKey)]);
  assert.equal(keyOnly.kind, "preview");
  if (keyOnly.kind === "preview") {
    assert.equal(keyOnly.summary.detectedFormat, "ssh-keys");
    assert.equal(keyOnly.summary.sshKeys.length, 1);
    assert.equal(keyOnly.summary.hosts.length, 0);
  }
  assert.throws(() => expandImportFiles([{ name: "bad.zip", bytes: strToU8("not a zip") }]), /valid ZIP/);
  const encryptedZip = zipSync({ "host.csv": strToU8("name,host\na,host.example") });
  const encryptedView = new DataView(encryptedZip.buffer, encryptedZip.byteOffset);
  for (let i = 0; i < encryptedZip.length - 46; i++) {
    if (encryptedView.getUint32(i, true) === 0x02014b50) {
      encryptedView.setUint16(i + 8, encryptedView.getUint16(i + 8, true) | 1, true);
      break;
    }
  }
  assert.throws(() => expandImportFiles([{ name: "encrypted.zip", bytes: encryptedZip }]), /Password-protected/);
  const damagedZip = zipSync({ "host.csv": [strToU8("name,host\na,host.example"), { level: 0 }] });
  const damagedView = new DataView(damagedZip.buffer, damagedZip.byteOffset);
  const dataOffset = 30 + damagedView.getUint16(26, true) + damagedView.getUint16(28, true);
  damagedZip[dataOffset] ^= 1;
  assert.throws(() => expandImportFiles([{ name: "damaged.zip", bytes: damagedZip }]), /damaged|integrity/);
  // A central-directory entry without a matching local file must not yield a partial import.
  const incompleteZip = zipSync({ "host.csv": strToU8("name,host\na,host.example") });
  const incompleteView = new DataView(incompleteZip.buffer, incompleteZip.byteOffset);
  const end = incompleteZip.length - 22;
  const centralOffset = incompleteView.getUint32(end + 16, true);
  const central = incompleteZip.slice(centralOffset, end);
  central[46] = "x".charCodeAt(0); // a second, distinct central path
  const incomplete = new Uint8Array(incompleteZip.length + central.length);
  incomplete.set(incompleteZip.subarray(0, end)); incomplete.set(central, end);
  incomplete.set(incompleteZip.subarray(end), end + central.length);
  const incompleteEnd = end + central.length;
  const incompleteResultView = new DataView(incomplete.buffer);
  incompleteResultView.setUint16(incompleteEnd + 8, 2, true);
  incompleteResultView.setUint16(incompleteEnd + 10, 2, true);
  incompleteResultView.setUint32(incompleteEnd + 12, central.length * 2, true);
  assert.throws(() => expandImportFiles([{ name: "incomplete.zip", bytes: incomplete }]), /damaged|incomplete/);
  const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`${i}.csv`, strToU8("x")]));
  assert.throws(() => expandImportFiles([{ name: "many.zip", bytes: zipSync(many) }]), /200 entries/);
  const oversizedHeader = zipSync({ "host.csv": strToU8("x") });
  // ZIP local-header uncompressed size, used before any decompression.
  new DataView(oversizedHeader.buffer, oversizedHeader.byteOffset).setUint32(22, 51 * 1024 * 1024, true);
  assert.throws(() => expandImportFiles([{ name: "large.zip", bytes: oversizedHeader }]), /50 MB/);
  assert.throws(() => prepareSshImport([{ name: "opaque.backup", bytes: strToU8("opaque proprietary backup") }]), /Unrecognized/);

  const sqliteBytes = strToU8("SQLite format 3\0rest");
  const preparedDb = prepareSshImport([
    { name: "db.sqlite", bytes: sqliteBytes },
    file("db.sqlite.encrypted.meta", JSON.stringify({ iv: "x", tag: "x", version: 1 })),
    file("termix.env", "DATABASE_KEY=example"),
  ]);
  assert.equal(preparedDb.kind, "termix-sqlite");
  if (preparedDb.kind === "termix-sqlite") {
    assert.equal(preparedDb.envText, "DATABASE_KEY=example");
    assert.match(preparedDb.metaJson!, /tag/);
  }
  assert.throws(() => prepareSshImport([{ name: "Manifest.db", bytes: sqliteBytes }]), /Apple device backup/);
  assert.throws(() => prepareSshImport([{ name: "db.sqlite", bytes: sqliteBytes }, file("hosts.csv", "name,host\na,example.org")]), /separately/);

  // A device-bound vault cannot move to a different device. A separately
  // passphrase-encrypted export can, without changing either device's vault key.
  const storage = () => {
    const map = new Map<string, string>();
    return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); }, removeItem: (key: string) => { map.delete(key); } };
  };
  const plain: VaultPlaintext = { version: 1, hosts: csvResult.hosts, sshKeys: csvResult.sshKeys,
    snippets: [{ id: "s", title: "uptime", command: "uptime", category: "General" }], enforceKeyWhitelist: true };
  (globalThis as Record<string, unknown>).localStorage = storage();
  const deviceBound = await encryptVaultData(plain);
  const portable = await encryptVaultData(plain, "backup passphrase");
  assert.equal(portable.mode, "passphrase");
  (globalThis as Record<string, unknown>).localStorage = storage();
  await assert.rejects(() => decryptVaultEnvelope(deviceBound), /device vault/);
  await assert.rejects(() => decryptVaultEnvelope(portable, "wrong passphrase"), /Incorrect master passphrase/);
  assert.deepEqual(await decryptVaultEnvelope(portable, "backup passphrase"), JSON.parse(JSON.stringify(plain)));
  const vaultZip = zipSync({ "backup.enc.json": strToU8(JSON.stringify(portable)) });
  const preparedVault = prepareSshImport([{ name: "icloud.zip", bytes: vaultZip }]);
  assert.equal(preparedVault.kind, "vault");
  if (preparedVault.kind === "vault") assert.deepEqual(await decryptVaultEnvelope(preparedVault.envelope, "backup passphrase"), JSON.parse(JSON.stringify(plain)));
  assert.throws(() => prepareSshImport([file("bad.json", JSON.stringify({ version: 1, mode: "passphrase", iv: "x", ciphertext: "x" }))]), /incomplete/);

  const secureCrt = `S:"Protocol Name"=SSH2
S:"Hostname"=crt.example
S:"Username"=deploy
D:"[SSH2] Port"=000008ae
S:"Identity Filename V2"=C:\\Keys\\id_prod.pub::rawkey
S:"Password V2"=02:abcdef
S:"Firewall Name"=Session:bastion
`;
  const crt = importSshClientText(secureCrt, "Config/Sessions/Team/Prod.ini");
  assert.equal(crt.detectedFormat, "securecrt");
  assert.equal(crt.hosts[0].host, "crt.example");
  assert.equal(crt.hosts[0].port, 2222);
  assert.equal(crt.hosts[0].group, "Team");
  assert.equal(crt.hosts[0].password, undefined);
  assert.equal(crt.keyReferences?.[crt.hosts[0].id], "C:\\Keys\\id_prod");
  assert.match(crt.warnings.join(" "), /encrypted/);
  assert.match(crt.warnings.join(" "), /proxy/);
  assert.throws(() => importSshClientText(secureCrt.replace('S:"Protocol Name"=SSH2', 'S:"Protocol Name"=SSH1'), "old.ini"), /No supported hosts/);

  const borg = importSshClientText(JSON.stringify({ version: 7, exported_at: "2026-11-01T00:00:00Z", groups: [{ name: "Lab", color: 123 }],
    hosts: [{ label: "Pi", hostname: "pi.local", port: 2222, username: "pi", group: "Lab", keyLabel: "my-key", jumpHostIdList: "1,2", portForwardings: "9000:localhost:80", agentForwarding: true }], settings: {} }), "sshborg.json");
  assert.equal(borg.detectedFormat, "sshborg");
  assert.equal(borg.hosts[0].group, "Lab");
  assert.equal(borg.hosts[0].authMethod, "privateKey");
  assert.match(borg.hosts[0].notes!, /SSHBorg key label: my-key/);
  assert.match(borg.warnings.join(" "), /omit passwords/);
  assert.match(borg.warnings.join(" "), /proxy/);
  assert.match(borg.warnings.join(" "), /forwards/);
  assert.match(borg.warnings.join(" "), /agent forwarding/);

  const sevenBackup = { formatVersion: 1, appVersion: "0.1", exportedAt: "2026-11-01T00:00:00Z", settings: { paletteID: "7term" }, importedPalettes: [], hosts: [
    { name: "Pi", hostname: "pi.local", port: 22, username: "pi", tags: ["lab"], authMethod: "keyFile", identityFile: "~/.ssh/id_pi", kind: "ssh" },
    { name: "Serial", hostname: "/dev/cu.usbserial", kind: "serial" },
  ] };
  const seven = importSshClientText(JSON.stringify(sevenBackup), "7term-backup.json");
  assert.equal(seven.detectedFormat, "seven-term");
  assert.equal(seven.hosts.length, 1);
  assert.deepEqual(seven.hosts[0].tags, ["lab"]);
  assert.equal(seven.keyReferences?.[seven.hosts[0].id], "~/.ssh/id_pi");
  assert.match(seven.warnings.join(" "), /omit Keychain/);
  assert.match(seven.warnings.join(" "), /Non-SSH/);
  assert.throws(() => importSshClientText(JSON.stringify({ ...sevenBackup, formatVersion: 99 }), "7term.json"), /Unsupported 7 Term/);

  const glob = importSshClientText("Host *.example !excluded.example\n User alice\nHost app.example excluded.example\n Port 2222\n", "config");
  assert.equal(glob.hosts.find((host) => host.name === "app.example")?.username, "alice");
  assert.equal(glob.hosts.find((host) => host.name === "excluded.example")?.username, "");
  const complex = Array.from({ length: 1200 }, (_, i) => `Host host-${i}\n User alice\n`).join("");
  assert.throws(() => importSshClientText(complex, "config"), /too complex/);

  const termixKeyPath = { hosts: [{ name: "prod", ip: "prod.example", username: "alice", credentialId: 4 }],
    credentials: [{ id: 4, authType: "key", privateKey: "/home/alice/.ssh/id_prod" }] };
  const termixWithSelectedKey = prepareSshImport([file("termix.json", JSON.stringify(termixKeyPath)), file("id_prod", privateKey)]);
  assert.equal(termixWithSelectedKey.kind, "preview");
  if (termixWithSelectedKey.kind === "preview") {
    assert.equal(termixWithSelectedKey.summary.hosts[0].sshKeyId, termixWithSelectedKey.summary.sshKeys[0].id);
    assert.equal(termixWithSelectedKey.summary.hosts[0].privateKey, privateKey);
  }
  const secondKey = privateKey.replace("ZmFrZS10ZXN0LWtleQ==", "YW5vdGhlcg==");
  const override = importFromTermixContent(JSON.stringify({ credentials: [{ id: 1, name: "library", authType: "key", key: privateKey }],
    hosts: [{ name: "override", ip: "override.example", credentialId: 1, key: secondKey }] }));
  assert.equal(override.sshKeys.find((key) => key.id === override.hosts[0].sshKeyId)?.privateKey, secondKey);
  const blocked = importFromTermixContent(JSON.stringify({ credentials: [{ id: 1, authType: "key", password: "library", key: privateKey }],
    hosts: [{ ip: "sealed.example", credentialId: 1, password: "cipher", passwordEncrypted: true, key: "encrypted:cipher" }] }));
  assert.equal(blocked.hosts[0].password, undefined);
  assert.equal(blocked.hosts[0].privateKey, undefined);
  assert.equal(blocked.hosts[0].sshKeyId, undefined);
  const invalid = importFromTermixContent(JSON.stringify({ hosts: [{ name: "bad", ip: "host", port: "22junk" }, { name: "good", ip: "good.example", port: 2222 }] }));
  assert.equal(invalid.hosts.length, 1);
  assert.match(invalid.warnings.join(" "), /invalid port/);
  assert.throws(() => prepareSshImport([file(".env", "DATABASE_KEY=a"), file("termix.env", "DATABASE_KEY=b")]), /only one Termix/);

  console.log("SSH client import and portable backup tests passed.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
