import type { HostProfile } from "@/types/connection";

export function generateRdpFileContent(profile: HostProfile): string {
  const port = profile.port || 3389;
  const fullAddress = port === 3389 ? profile.host : `${profile.host}:${port}`;
  const width = profile.rdpWidth || 1600;
  const height = profile.rdpHeight || 900;

  const lines = [
    `full address:s:${fullAddress}`,
    `username:s:${profile.username || "Administrator"}`,
    profile.domain ? `domain:s:${profile.domain}` : "",
    "screen mode id:i:1",
    "use multimon:i:0",
    `desktopwidth:i:${width}`,
    `desktopheight:i:${height}`,
    "session bpp:i:32",
    "compression:i:1",
    "keyboardhook:i:2",
    "audiocapturemode:i:0",
    "videoplaybackmode:i:1",
    "connection type:i:7",
    "networkautodetect:i:1",
    "bandwidthautodetect:i:1",
    "displayconnectionbar:i:1",
    "enableworkspacereconnect:i:0",
    "disable wallpaper:i:0",
    "allow font smoothing:i:1",
    "allow desktop composition:i:1",
    "redirectclipboard:i:1",
    "redirectprinters:i:0",
    "redirectsmartcards:i:0",
    "audiomode:i:0",
    `authentication level:i:${profile.ignoreCert !== false ? 0 : 2}`,
    "prompt for credentials:i:1",
    "negotiate security layer:i:1",
    `enablecredsspsupport:i:${profile.rdpSecurity === "rdp" ? 0 : 1}`,
  ].filter(Boolean);

  return lines.join("\r\n") + "\r\n";
}

export function downloadRdpFile(profile: HostProfile): void {
  const content = generateRdpFileContent(profile);
  const blob = new Blob([content], { type: "application/x-rdp;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safeName = (profile.name || profile.host || "remote-desktop")
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-");
  a.href = url;
  a.download = `${safeName}.rdp`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
