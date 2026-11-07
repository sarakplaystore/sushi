import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { importSshClientText } from "../src/lib/client/ssh-import";
import { prepareSshImport } from "../src/lib/client/ssh-import-batch";
import { buildRdpParams } from "../src/lib/server/rdp-params";

const selectedFile = (name: string, content: string) => ({ name, bytes: strToU8(content) });
const privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nZmFrZS10ZXN0LWtleQ==\n-----END OPENSSH PRIVATE KEY-----";

console.log("==> Testing SecureCRT and mRemoteNG XML imports...");

// Based on SecureCRT's Sessions XML export: nested keys and typed values.
const secureXml = `<?xml version="1.0" encoding="UTF-8"?>
<VanDyke version="3.0">
  <key name="Sessions">
    <key name="Default"><string name="Hostname">default.example</string><string name="Protocol Name">SSH2</string></key>
    <key name="Prod &amp; QA"><key name="Web">
      <key name="server &amp; one">
        <string name="Hostname"><![CDATA[server.example]]></string>
        <string name="Protocol Name">SSH2</string><dword name="[SSH2] Port">2222</dword>
        <string name="Username">depl&#111;y</string><string name="Identity Filename V2">C:\\Keys\\id_prod.pub::rawkey</string>
        <string name="Firewall Name">Session:bastion</string><string name="Password V2">SECURECRT_CIPHER_TEST</string>
        <dword name="Enable Agent Forwarding">2</dword><dword name="Use Script File">1</dword>
        <string name="Script Filename">DONT_IMPORT_SCRIPT</string>
        <array name="Port Forward Table V2"><string>127.0.0.1,8080,host,80</string></array>
      </key>
      <key name="direct"><string name="Hostname">direct.example</string><string name="Protocol Name">SSH2</string>
        <dword name="[SSH2] Port">22</dword><string name="Username">ops</string><string name="Firewall Name">None</string>
        <array name="Port Forward Table V3"/>
      </key>
    </key></key>
    <key name="telnet"><string name="Hostname">old.example</string><string name="Protocol Name">Telnet</string></key>
    <key name="rdp"><string name="Hostname">desktop.example</string><string name="Protocol Name">RDP</string></key>
    <key name="unknown"><string name="Hostname">unknown.example</string></key>
    <key name="missing"><dword name="Is Session">1</dword><string name="Protocol Name">SSH2</string></key>
    <key name="bad port"><string name="Hostname">bad.example</string><string name="Protocol Name">SSH2</string><dword name="[SSH2] Port">0x16</dword></key>
  </key>
  <key name="Security"><string name="Hostname">ignore.example</string><string name="Password">OUTSIDE_CIPHER</string></key>
</VanDyke>`;
const secure = importSshClientText(secureXml, "Sessions.xml");
assert.equal(secure.detectedFormat, "securecrt-xml");
assert.deepEqual(secure.hosts.map((host) => host.name), ["server & one", "direct"]);
assert.equal(secure.hosts[0].host, "server.example");
assert.equal(secure.hosts[0].port, 2222); // XML dword is decimal, not INI hexadecimal.
assert.equal(secure.hosts[0].username, "deploy");
assert.equal(secure.hosts[0].group, "Prod & QA / Web");
assert.equal(secure.hosts[0].authMethod, "privateKey");
assert.equal(secure.keyReferences?.[secure.hosts[0].id], "C:\\Keys\\id_prod");
assert.equal(secure.hosts[0].password, undefined);
assert.equal(secure.hosts[1].port, 22);
assert(!secure.hosts[1].notes);
assert.match(secure.warnings.join(" "), /Non-SSH2/);
assert.match(secure.warnings.join(" "), /without a hostname/);
assert.match(secure.warnings.join(" "), /invalid port/);
assert.match(secure.warnings.join(" "), /encrypted/);
assert.match(secure.warnings.join(" "), /proxy or jump host/);
assert.match(secure.warnings.join(" "), /forwards or tunnels/);
assert.match(secure.warnings.join(" "), /agent forwarding/);
assert.match(secure.warnings.join(" "), /scripts/);
for (const secret of ["SECURECRT_CIPHER_TEST", "OUTSIDE_CIPHER", "DONT_IMPORT_SCRIPT"]) {
  assert(!JSON.stringify(secure).includes(secret));
}

// XML files are routed inside archives, and explicitly selected key files can be matched.
const archive = zipSync({
  "iCloud/Settings/Sessions.xml": strToU8(secureXml),
  "iCloud/Keys/id_prod": strToU8(privateKey),
  "iCloud/readme.md": strToU8("unrelated"),
});
const zipped = prepareSshImport([{ name: "export.zip", bytes: archive }]);
assert.equal(zipped.kind, "preview");
if (zipped.kind === "preview") {
  assert.equal(zipped.summary.hosts.length, 2);
  assert.equal(zipped.summary.hosts[0].privateKey, privateKey);
  assert.equal(zipped.summary.hosts[0].sshKeyId, zipped.summary.sshKeys[0].id);
  assert.match(zipped.summary.warnings.join(" "), /proxy or jump host/);
}
const utf16Xml = new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(secureXml, "utf16le")]));
const decoded = prepareSshImport([{ name: "sessions.xml", bytes: utf16Xml }]);
assert.equal(decoded.kind, "preview");
if (decoded.kind === "preview") assert.equal(decoded.summary.hosts[0].username, "deploy");

// Attribute names and inheritance match mRemoteNG's connection XML serializer.
const remoteXml = `<?xml version="1.0" encoding="utf-8"?>
<mrng:Connections xmlns:mrng="http://mremoteng.org" ConfVersion="2.6" FullFileEncryption="False" Protected="VERIFIER_NOT_FILE_CIPHER">
  <mrng:Node Name="Infrastructure &amp; Ops" Type="Container" Username="parent-user" Domain="CORP" Port="2229" Protocol="SSH2"
    PuttySession="proxy-profile" SSHTunnelConnectionName="jump" RDGatewayUsageMethod="Always" Password="PARENT_CIPHER_TEST">
    <mrng:Node Name="Nested" Type="Container" InheritUsername="True" InheritDomain="True" InheritPort="True" InheritProtocol="True"
      InheritPuttySession="True" InheritSSHTunnelConnectionName="True" InheritRDGatewayUsageMethod="True">
      <mrng:Node Name="SSH server" Type="Connection" Hostname="ssh.example" Username="wrong-user" Protocol="Telnet" Port="22"
        InheritUsername="True" InheritPort="True" InheritProtocol="True" InheritPuttySession="True" InheritSSHTunnelConnectionName="True"
        Password="MREMOTE_CIPHER_TEST" Descr="Primary server" OpeningCommand="DONT_RUN_COMMAND" />
    </mrng:Node>
    <mrng:Node Name="Desktop" Type="Connection" Hostname="desktop.example" Username="rdp-user" Domain="ignored" InheritDomain="True"
      Protocol="RDP" Port="3390" InheritRDGatewayUsageMethod="True" Password="RDP_CIPHER_TEST" />
    <mrng:Node Name="Telnet" Type="Connection" Hostname="old.example" Protocol="Telnet" Port="23" />
    <mrng:Node Name="No host" Type="Connection" Protocol="SSH2" Port="22" />
    <mrng:Node Name="Bad port" Type="Connection" Hostname="bad.example" Protocol="RDP" Port="65536" />
  </mrng:Node>
  <mrng:Node Name="Standalone" Type="Connection" Hostname="standalone.example" Protocol="SSH2" Port="22" Username="solo" PuttySession="Default Settings" />
</mrng:Connections>`;
const remote = importSshClientText(remoteXml, "confCons.xml");
assert.equal(remote.detectedFormat, "mremoteng");
assert.deepEqual(remote.hosts.map((host) => host.name), ["SSH server", "Desktop", "Standalone"]);
const [remoteSsh, remoteRdp, standalone] = remote.hosts;
assert.equal(remoteSsh.host, "ssh.example");
assert.equal(remoteSsh.protocol, "ssh");
assert.equal(remoteSsh.port, 2229);
assert.equal(remoteSsh.username, "parent-user");
assert.equal(remoteSsh.group, "Infrastructure & Ops / Nested");
assert.match(remoteSsh.notes!, /Primary server/);
assert.match(remoteSsh.notes!, /proxy-profile/);
assert.match(remoteSsh.notes!, /Proxy\/jump settings were not imported/);
assert.equal(remoteRdp.protocol, "rdp");
assert.equal(remoteRdp.port, 3390);
assert.equal(remoteRdp.username, "rdp-user");
assert.equal(remoteRdp.domain, "CORP");
assert.equal(remoteRdp.ignoreCert, false);
assert.equal(remoteRdp.rdpDrive, false);
const rdpParams = buildRdpParams(remoteRdp);
assert.equal(rdpParams["ignore-cert"], "false");
assert.equal(rdpParams["enable-drive"], "false");
assert.match(remoteRdp.notes!, /Proxy\/jump settings were not imported/);
assert.equal(standalone.group, "mRemoteNG Imported");
assert.match(standalone.notes!, /PuTTY session settings were not imported/);
assert.match(remote.warnings.join(" "), /Non-SSH2\/RDP/);
assert.match(remote.warnings.join(" "), /no hostname/);
assert.match(remote.warnings.join(" "), /invalid port/);
assert.match(remote.warnings.join(" "), /passwords are encrypted/);
assert.match(remote.warnings.join(" "), /commands and additional connection options/);
assert.match(remote.warnings.join(" "), /PuTTY session settings/);
assert.match(remote.warnings.join(" "), /do not ignore TLS certificate errors.*drive disabled/);
for (const value of ["PARENT_CIPHER_TEST", "MREMOTE_CIPHER_TEST", "RDP_CIPHER_TEST", "VERIFIER_NOT_FILE_CIPHER", "DONT_RUN_COMMAND"]) {
  assert(!JSON.stringify(remote).includes(value));
}
assert(remote.hosts.every((host) => host.password === undefined));

// Full-file encryption differs from the ordinary encrypted password attributes.
const encryptedRemote = '<Connections FullFileEncryption="True" ConfVersion="2.6">FULL_FILE_CIPHER_TEST</Connections>';
assert.throws(() => importSshClientText(encryptedRemote, "confCons.xml"), /fully encrypted.*mRemoteNG/);
assert.throws(() => prepareSshImport([selectedFile("confCons.xml", encryptedRemote)]), /fully encrypted/);
// mRemoteNG 2.5 may store a fully encrypted file as opaque base64 rather than XML.
assert.throws(() => prepareSshImport([selectedFile("confCons.xml", "Q2lwaGVy".repeat(30))]), /not plaintext XML.*fully encrypted/);
const mixed = prepareSshImport([selectedFile("encrypted.xml", encryptedRemote), selectedFile("sessions.xml", secureXml)]);
assert.equal(mixed.kind, "preview");
if (mixed.kind === "preview") {
  assert.equal(mixed.summary.hosts.length, 2);
  assert.match(mixed.summary.warnings.join(" "), /encrypted.xml:.*fully encrypted/);
  assert(!JSON.stringify(mixed.summary).includes("FULL_FILE_CIPHER_TEST"));
}

// When a parent is not exported, mRemoteNG's serialized inherited values remain usable.
const inheritedFallback = importSshClientText(`<Connections><Node Type="Connection" Name="fallback" Hostname="fallback.example"
  Protocol="SSH2" Port="2022" Username="serialized" InheritProtocol="True" InheritPort="True" InheritUsername="True" /></Connections>`, "confCons.xml");
assert.equal(inheritedFallback.hosts[0].username, "serialized");
assert.equal(inheritedFallback.hosts[0].port, 2022);
const missingInheritedPort = importSshClientText(`<Connections><Node Type="Container" Name="group" Protocol="SSH2">
  <Node Type="Connection" Name="skip" Hostname="skip.example" Protocol="SSH2" InheritPort="True" />
  <Node Type="Connection" Name="good" Hostname="good.example" Protocol="SSH2" Port="22" />
</Node></Connections>`, "confCons.xml");
assert.deepEqual(missingInheritedPort.hosts.map((host) => host.name), ["good"]);
assert.match(missingInheritedPort.warnings.join(" "), /unavailable inherited port/);
const uncertainRoute = importSshClientText(`<Connections><Node Type="Connection" Name="rdp" Hostname="rdp.example"
  Protocol="RDP" Port="3389" InheritRDGatewayUsageMethod="True" /></Connections>`, "confCons.xml");
assert.match(uncertainRoute.warnings.join(" "), /gateway settings are empty or unavailable/);
assert.match(uncertainRoute.hosts[0].notes!, /review the connection route/);

// Reject dangerous or malformed XML atomically, including if a valid host comes first.
assert.throws(() => importSshClientText('<!DOCTYPE VanDyke SYSTEM "file:///etc/passwd"><VanDyke/>', "bad.xml"), /document types/);
assert.throws(() => importSshClientText('<!DOCTYPE Connections [<!ENTITY x "SECRET">]><Connections>&x;</Connections>', "bad.xml"), /entity definitions/);
assert.throws(() => importSshClientText('<Connections><Node Type="Connection" Name="x" Hostname="x" Protocol="SSH2"/><bad></Connections>', "bad.xml"), /Invalid XML/);
assert.throws(() => importSshClientText('<Connections><Node Type="Connection" Name="x" name="y" /></Connections>', "bad.xml"), /duplicate attributes/);
assert.throws(() => importSshClientText('<Connections><Node Type="Connection" Name="&notDefined;"/></Connections>', "bad.xml"), /Invalid XML/);
assert.throws(() => importSshClientText('<VanDyke><key name="Sessions"><key name="x"><string name="Hostname">x<child/></string></key></key></VanDyke>', "bad.xml"), /nested elements/);
assert.throws(() => importSshClientText('<VanDyke><key name="Other"/></VanDyke>', "bad.xml"), /Sessions section/);
assert.throws(() => importSshClientText('<Connections><other/></Connections>', "bad.xml"), /mRemoteNG connection nodes/);
assert.throws(() => importSshClientText('<unrelated><host>example</host></unrelated>', "bad.xml"), /Unrecognized XML/);
assert.throws(() => importSshClientText('<Connections>' + '<x>'.repeat(129) + '</x>'.repeat(129) + '</Connections>', "deep.xml"), /too complex/);
assert.throws(() => importSshClientText('<Connections>' + '<x/>'.repeat(200_001) + '</Connections>', "many.xml"), /too complex/);
assert.throws(() => importSshClientText('<Connections><Node Type="Connection" Name="' + 'x'.repeat(65_537) + '"/></Connections>', "large.xml"), /field is too large/);
assert.throws(() => importSshClientText('<Connections>' + '<Node Type="Connection" Hostname="x" Protocol="SSH2"/>'.repeat(10_001) + '</Connections>', "many.xml"), /10000 hosts/);
assert.throws(() => importSshClientText('<Connections>' + ' '.repeat(10 * 1024 * 1024) + '</Connections>', "large.xml"), /10 MB/);

console.log("SecureCRT and mRemoteNG XML import tests passed.");
