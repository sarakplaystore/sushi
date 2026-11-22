/**
 * A share link may name a gateway, but must never carry credentials. Keep the
 * canonical address identical in the browser and in scoped account tickets.
 */
export function normalizeShareGateway(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (value.length > 2048 || /\s/.test(value)) throw new Error("Invalid gateway address in the share link.");

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw new Error("Invalid gateway address in the share link.");
  }
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname ||
      url.username || url.password || url.search || url.hash) {
    throw new Error("The share gateway must be an HTTP(S) address without credentials, a query or a fragment.");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function isShareId(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,64}$/.test(value);
}
