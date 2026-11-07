import { SaxesParser, type SaxesTagPlain } from "saxes";

/** Only connection metadata is returned; encrypted credentials and scripts are never copied. */
export interface XmlImportRow {
  name?: string;
  host?: string;
  port?: string;
  username?: string;
  protocol?: string;
  keyReference?: string;
  group?: string;
  notes?: string;
  domain?: string;
  ignoreCert?: boolean;
  rdpDrive?: boolean;
  route?: boolean;
  forwards?: boolean;
  agent?: boolean;
}

export interface XmlImportData {
  format: "securecrt-xml" | "mremoteng";
  rows: XmlImportRow[];
  warnings: string[];
}

// In addition to the import-file size and host limits, keep XML parsing work
// and relevant field sizes bounded. DTDs and external entities are forbidden.
const MAX_XML_CHARS = 10 * 1024 * 1024;
const MAX_XML_DEPTH = 128;
const MAX_XML_ELEMENTS = 200_000;
const MAX_XML_FIELD_CHARS = 65_536;
const MAX_XML_ROWS = 10_000;

const SECURECRT_FIELDS = new Set([
  "hostname", "protocol name", "username", "[ssh2] port", "identity filename v2", "identity filename",
  "firewall name", "enable agent forwarding", "is session", "use login script", "use script file",
]);
const MREMOTE_FIELDS = [
  "username", "domain", "protocol", "port", "descr", "puttysession", "sshtunnelconnectionname",
  "rdgatewayusagemethod", "openingcommand", "sshoptions", "preextapp", "postextapp", "extapp", "startprogram",
] as const;
type MRemoteField = typeof MREMOTE_FIELDS[number];

type SecureKey = {
  depth: number;
  name: string;
  fields: Record<string, string>;
  passwordPresent: boolean;
  forwards: boolean;
};
type SecureValue = { depth: number; key: SecureKey; name: string; text: string; secret: boolean };
type SecureArray = { depth: number; key: SecureKey };
type MRemoteNode = {
  depth: number;
  type: string;
  groups: string[];
  effective: Partial<Record<MRemoteField, string>>;
};

function localName(name: string): string {
  return name.slice(name.lastIndexOf(":") + 1).toLowerCase();
}

function attributes(tag: SaxesTagPlain): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(tag.attributes)) {
    // Attributes with conflicting case are ambiguous even though XML itself is case-sensitive.
    const normalized = name.toLowerCase();
    if (normalized in result) throw new Error("Invalid XML: duplicate attributes with conflicting case.");
    result[normalized] = value;
  }
  return result;
}

function bounded(value: string | undefined): string | undefined {
  if (value !== undefined && value.length > MAX_XML_FIELD_CHARS) {
    throw new Error("An XML connection field is too large to import.");
  }
  return value;
}

function enabled(value: string | undefined): boolean {
  return /^(?:true|yes|1)$/i.test(value?.trim() || "");
}

function configured(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase() || "";
  return Boolean(v && !["0", "false", "none", "never"].includes(v));
}

/** Strict, non-validating streaming XML parsing shared by the browser and Node tests. */
export function parseClientXml(text: string): XmlImportData {
  if (text.length > MAX_XML_CHARS) throw new Error("XML import files are limited to 10 MB.");
  const parser = new SaxesParser({ xmlns: false });
  const tags: string[] = [];
  const rows: XmlImportRow[] = [];
  const warningSet = new Set<string>();
  const secureKeys: SecureKey[] = [];
  const remoteNodes: MRemoteNode[] = [];
  let format: XmlImportData["format"] | undefined;
  let elementCount = 0;
  let sessionsDepth = 0;
  let foundSessions = false;
  let foundRemoteNode = false;
  let secureValue: SecureValue | undefined;
  let secureArray: SecureArray | undefined;

  const warn = (message: string) => { warningSet.add(message); };
  const add = (row: XmlImportRow) => {
    if (rows.length >= MAX_XML_ROWS) throw new Error(`Import is limited to ${MAX_XML_ROWS} hosts per file.`);
    rows.push(row);
  };

  // saxes never fetches DTDs or resolves custom entities. Explicitly reject a
  // DTD as well, and do not surface parser messages containing input text.
  parser.on("doctype", () => { throw new Error("XML document types and entity definitions are not supported. Export without a DTD."); });
  parser.on("error", () => { throw new Error("Invalid XML file. Export a well-formed XML file from the original client."); });

  parser.on("opentag", (tag) => {
    if (++elementCount > MAX_XML_ELEMENTS || tags.length >= MAX_XML_DEPTH) {
      throw new Error("XML file is too complex to import at once. Split it into smaller exports.");
    }
    const element = localName(tag.name);
    const parent = tags[tags.length - 1];
    tags.push(element);
    const depth = tags.length;
    const attrs = attributes(tag);

    if (depth === 1) {
      if (element === "vandyke") format = "securecrt-xml";
      else if (element === "connections") {
        format = "mremoteng";
        if (enabled(attrs.fullfileencryption)) {
          throw new Error("This mRemoteNG connection file is fully encrypted. Open it in mRemoteNG and export unencrypted connection settings first.");
        }
      } else throw new Error("Unrecognized XML export. Use SecureCRT Sessions XML or a plaintext mRemoteNG connections file.");
      return;
    }

    if (format === "securecrt-xml") {
      if (secureValue && depth > secureValue.depth) {
        throw new Error("Invalid SecureCRT XML: a session value contains nested elements.");
      }
      if (depth === 2 && element === "key" && (attrs.name || "").toLowerCase() === "sessions") {
        if (foundSessions) throw new Error("Invalid SecureCRT XML: more than one Sessions section.");
        foundSessions = true;
        sessionsDepth = depth;
        return;
      }
      if (!sessionsDepth || depth <= sessionsDepth) return;
      const current = secureKeys[secureKeys.length - 1];
      if (element === "key" && ((depth === sessionsDepth + 1 && parent === "key") ||
        (current && current.depth === depth - 1))) {
        secureKeys.push({ depth, name: bounded(attrs.name)?.trim() || "", fields: Object.create(null), passwordPresent: false, forwards: false });
        return;
      }
      if (!current) return;
      if (secureArray && depth > secureArray.depth && Object.values(attrs).some((value) => value.trim())) secureArray.key.forwards = true;
      if (current.depth !== depth - 1) return;
      const name = (bounded(attrs.name) || "").toLowerCase();
      if (element === "array" && /^(?:port|reverse|remote|local) forward.*table/.test(name)) {
        secureArray = { depth, key: current };
      } else if ((element === "string" || element === "dword") && (SECURECRT_FIELDS.has(name) || /^password(?: v2)?$/.test(name))) {
        secureValue = { depth, key: current, name, text: "", secret: /^password(?: v2)?$/.test(name) };
      }
      return;
    }

    if (format === "mremoteng" && element === "node") {
      const parentNode = remoteNodes[remoteNodes.length - 1];
      if (!((depth === 2 && parent === "connections") || (parentNode && parentNode.depth === depth - 1))) return;
      if (parentNode && parentNode.type !== "container") return;
      foundRemoteNode = true;
      const type = (bounded(attrs.type) || "").trim().toLowerCase();
      const name = bounded(attrs.name)?.trim() || "";
      const effective: MRemoteNode["effective"] = {};
      for (const field of MREMOTE_FIELDS) {
        // mRemoteNG writes the effective value even for inherited properties. If
        // the parent isn't in this export, that serialized value is our fallback.
        const flag = field === "descr" ? "inheritdescription" : `inherit${field}`;
        const inherited = enabled(attrs[flag]);
        const inheritedValue = inherited ? parentNode?.effective[field] : undefined;
        effective[field] = bounded(inheritedValue !== undefined ? inheritedValue : attrs[field]);
        if (inherited && inheritedValue === undefined && !attrs[field]) {
          warn("Some mRemoteNG inherited settings depend on values outside this export. Review the affected connections.");
        }
      }
      const groups = parentNode?.groups || [];
      const node: MRemoteNode = { depth, type, groups: type === "container" && name ? [...groups, name] : groups, effective };
      remoteNodes.push(node);
      if (type === "container") return;
      if (type !== "connection") {
        warn("Some unrecognized mRemoteNG node types were skipped.");
        return;
      }
      const protocol = effective.protocol?.trim().toLowerCase();
      if (protocol !== "ssh2" && protocol !== "rdp") {
        warn("Non-SSH2/RDP mRemoteNG connections or connections without a known protocol were skipped.");
        return;
      }
      if (enabled(attrs.inheritport) && !effective.port?.trim()) {
        warn("Some mRemoteNG connections with an unavailable inherited port were skipped.");
        return;
      }
      const putty = effective.puttysession?.trim();
      let notes = effective.descr?.trim() || "";
      if (protocol === "ssh2") {
        warn("mRemoteNG PuTTY session settings, including keys and proxies, are not imported. Review SSH routes and authentication.");
        notes = [notes, putty && putty !== "Default Settings" ? `mRemoteNG PuTTY session: ${putty}` : undefined,
          "PuTTY session settings were not imported; review the connection route and authentication."].filter(Boolean).join("\n");
      }
      if ([effective.openingcommand, effective.sshoptions, effective.preextapp, effective.postextapp, effective.extapp, effective.startprogram].some(configured)) {
        warn("mRemoteNG commands and additional connection options were not imported or executed.");
      }
      const route = configured(effective.sshtunnelconnectionname) || (protocol === "rdp" && configured(effective.rdgatewayusagemethod));
      const uncertainRoute = (enabled(attrs.inheritsshtunnelconnectionname) && !effective.sshtunnelconnectionname?.trim()) ||
        (protocol === "rdp" && enabled(attrs.inheritrdgatewayusagemethod) && !effective.rdgatewayusagemethod?.trim());
      if (uncertainRoute) {
        warn("Some inherited mRemoteNG tunnel or gateway settings are empty or unavailable. Review the connection route before connecting.");
        notes = [notes, "Inherited tunnel or gateway settings may be unavailable; review the connection route."].filter(Boolean).join("\n");
      }
      if (protocol === "rdp") {
        warn("Imported mRemoteNG RDP connections do not ignore TLS certificate errors and start with Sushi's file-transfer drive disabled. Review these settings before connecting.");
      }
      add({ name, host: bounded(attrs.hostname), username: effective.username, domain: effective.domain,
        protocol, port: effective.port, group: groups.join(" / ") || "mRemoteNG Imported", notes, route,
        // Do not silently ignore certificates or enable file sharing when the source
        // application's security and drive-redirection settings are not migrated.
        ignoreCert: protocol === "rdp" ? false : undefined, rdpDrive: protocol === "rdp" ? false : undefined });
    }
  });

  const textValue = (value: string) => {
    if (secureArray && tags.length > secureArray.depth && value.trim()) secureArray.key.forwards = true;
    if (!secureValue || tags.length !== secureValue.depth) return;
    if (secureValue.secret) {
      if (value.trim()) secureValue.key.passwordPresent = true;
      return;
    }
    if (secureValue.text.length + value.length > MAX_XML_FIELD_CHARS) throw new Error("An XML connection field is too large to import.");
    secureValue.text += value;
  };
  parser.on("text", textValue);
  parser.on("cdata", textValue);

  parser.on("closetag", () => {
    const depth = tags.length;
    if (secureValue && secureValue.depth === depth) {
      if (!secureValue.secret) secureValue.key.fields[secureValue.name] = secureValue.text.trim();
      secureValue = undefined;
    }
    if (secureArray && secureArray.depth === depth) secureArray = undefined;
    const current = secureKeys[secureKeys.length - 1];
    if (current && current.depth === depth) {
      const fields = current.fields;
      const isDefaultTemplate = secureKeys.length === 1 && current.name.toLowerCase() === "default";
      if (!isDefaultTemplate && fields.hostname) {
        if ((fields["protocol name"] || "").toLowerCase() !== "ssh2") {
          warn("Non-SSH2 SecureCRT sessions or sessions without a known protocol were skipped.");
        } else {
          const key = (fields["identity filename v2"] || fields["identity filename"] || "").split("::")[0].replace(/\.pub$/i, "");
          add({ name: current.name, host: fields.hostname, username: fields.username, protocol: "ssh2",
            // SecureCRT XML dword values are decimal, unlike its hexadecimal INI values.
            port: fields["[ssh2] port"], keyReference: key,
            group: secureKeys.slice(0, -1).map((entry) => entry.name).filter(Boolean).join(" / ") || "SecureCRT Imported",
            route: configured(fields["firewall name"]), forwards: current.forwards,
            // Value 2 inherits the global agent setting, which isn't migrated either.
            agent: configured(fields["enable agent forwarding"]) });
          if (current.passwordPresent) warn("SecureCRT stored passwords are encrypted and were not imported. Enter them in Sushi.");
          if (configured(fields["use login script"]) || configured(fields["use script file"])) {
            warn("SecureCRT login scripts were not imported or executed.");
          }
        }
      } else if (!isDefaultTemplate && fields["is session"] === "1" && !fields.hostname) {
        warn("Some SecureCRT sessions without a hostname were skipped.");
      }
      secureKeys.pop();
    }
    const remote = remoteNodes[remoteNodes.length - 1];
    if (remote && remote.depth === depth) remoteNodes.pop();
    if (sessionsDepth === depth && tags[depth - 1] === "key") sessionsDepth = 0;
    tags.pop();
  });

  parser.write(text).close();
  if (format === "securecrt-xml") {
    if (!foundSessions) throw new Error("This SecureCRT XML export does not contain a Sessions section.");
    warn("SecureCRT settings such as scripts, host-key trust, and global options are not migrated. Review connections and verify fingerprints.");
  } else if (format === "mremoteng") {
    if (!foundRemoteNode) throw new Error("This XML does not contain mRemoteNG connection nodes.");
    warn("mRemoteNG passwords are encrypted and were not imported. Enter missing credentials in Sushi.");
    warn("mRemoteNG display, redirect, and other client settings are not migrated. Review imported connections.");
  } else throw new Error("Unrecognized XML export.");
  return { format, rows, warnings: [...warningSet] };
}
