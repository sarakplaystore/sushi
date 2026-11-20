import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * The Vercel deployment can never accept a WebSocket upgrade, so a native PTY
 * needs one always-on process somewhere else. These tests keep the three places
 * that process can run — a VPS, Railway and Render — honest: the slim gateway
 * image, both platform manifests, the snippets the UI offers, and the README all
 * have to agree, or a user follows instructions that no longer deploy anything.
 */

console.log("==> Testing the gateway deployment targets (VPS / Railway / Render)...");

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const GATEWAY_IMAGE = "Dockerfile.gateway";
const HEALTH_PATH = "/api/system/capabilities";

// ---- the slim gateway image -------------------------------------------------
assert.ok(existsSync(GATEWAY_IMAGE), `${GATEWAY_IMAGE} exists at the repo root`);
const gatewayDockerfile = read(GATEWAY_IMAGE);
assert.match(gatewayDockerfile, /^ENV GATEWAY_ONLY=true$/m, "the image defaults to gateway-only mode");
assert.match(gatewayDockerfile, /^ENV HOST=0\.0\.0\.0$/m, "binds 0.0.0.0, not localhost (platform requirement)");
assert.match(gatewayDockerfile, /^EXPOSE 3000$/m, "exposes the port the platforms route to");
assert.match(
  gatewayDockerfile,
  /^CMD \["npm", "run", "gateway"\]$/m,
  "runs the gateway script, not the full Next.js server"
);
assert.ok(
  gatewayDockerfile.includes(HEALTH_PATH),
  `the image health-checks the real endpoint (${HEALTH_PATH})`
);
assert.ok(
  gatewayDockerfile.includes("npm ci --omit=dev"),
  "installs production dependencies only — no Next.js toolchain in the gateway"
);
assert.ok(
  !gatewayDockerfile.includes("npm run build"),
  "the gateway image never builds Next.js: it serves no pages"
);
assert.match(gatewayDockerfile, /^USER sushi$/m, "runs as an unprivileged user");
assert.match(gatewayDockerfile, /GUACD_PORT=4822/, "carries the guacd endpoint for live RDP");

// The CMD has to be a real script, and it has to be the gateway one.
const pkg = JSON.parse(read("package.json")) as {
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
assert.equal(
  pkg.scripts.gateway,
  "NODE_ENV=production GATEWAY_ONLY=true tsx server.ts",
  "`npm run gateway` starts server.ts in gateway-only mode"
);

// ---- Railway ----------------------------------------------------------------
// Railway deprecated Config as Code (railway.json / railway.toml) and stops
// reading it on 2026-12-01; new services cannot opt into it at all. Sushi ships
// the Infrastructure-as-Code file instead, so the legacy file must stay absent —
// a service managed by both is rejected by `railway config plan`.
assert.ok(!existsSync("railway.json"), "no deprecated railway.json (Config as Code)");
assert.ok(!existsSync("railway.toml"), "no deprecated railway.toml (Config as Code)");
assert.ok(existsSync(".railway/railway.ts"), ".railway/railway.ts exists");
const railway = read(".railway/railway.ts");
assert.match(railway, /from "railway\/iac"/, "uses the documented railway/iac authoring entrypoint");
assert.match(railway, /export default defineRailway\(/, "exports defineRailway(...)");
assert.match(railway, /return project\(/, "returns a project(...)");
assert.match(railway, /service\("sushi-gateway"/, "declares the sushi-gateway service");
assert.match(railway, /service\("guacd"/, "declares the guacd service next to it");
assert.match(
  railway,
  /image\("guacamole\/guacd:1\.5\.5"\)/,
  "guacd comes from the same pinned image docker-compose uses"
);
assert.ok(
  railway.includes(`RAILWAY_DOCKERFILE_PATH: "${GATEWAY_IMAGE}"`),
  `points Railway at ${GATEWAY_IMAGE} (the root Dockerfile would build the whole app)`
);
assert.ok(
  railway.includes("guacd.env.RAILWAY_PRIVATE_DOMAIN"),
  "GUACD_HOST is a typed cross-service reference, not a guessed hostname"
);
assert.ok(railway.includes(`healthcheck: "${HEALTH_PATH}"`), "health-checks the capabilities endpoint");
assert.match(railway, /start: "npm run gateway"/, "starts with the gateway script");
assert.match(railway, /SUSHI_GATEWAY_TOKEN: preserve\(\)/, "keeps the token on Railway instead of committing it");
assert.match(railway, /ALLOWED_ORIGIN: preserve\(\)/, "keeps the allowed origin on Railway too");
assert.ok(
  !/SUSHI_GATEWAY_TOKEN:\s*["'][^"']+["']/.test(railway),
  "no literal gateway token in the IaC file"
);
// The CLI recipe has to use commands that exist (`railway variable set`, not the
// old `railway variables --set`), and the SDK is installed without touching
// package.json so a Vercel build never sees it.
assert.match(railway, /railway config apply/, "documents `railway config apply`");
assert.match(railway, /railway variable set SUSHI_GATEWAY_TOKEN=/, "documents `railway variable set`");
assert.match(railway, /npm i --no-save railway/, "installs the IaC SDK without adding it to package.json");
assert.ok(
  !/railway variables --set/.test(railway),
  "does not use the non-existent `railway variables --set` form"
);

assert.ok(
  !Object.keys(pkg.dependencies ?? {}).includes("railway") &&
    !Object.keys(pkg.devDependencies ?? {}).includes("railway"),
  "the railway SDK stays out of the app's dependencies"
);

// ---- Render -----------------------------------------------------------------
assert.ok(existsSync("render.yaml"), "render.yaml exists at the repo root");
const render = parseYaml(read("render.yaml")) as {
  services?: Array<Record<string, any>>;
};
assert.ok(Array.isArray(render.services) && render.services.length > 0, "render.yaml declares services");
const renderGateway = render.services!.find((s) => s.name === "sushi-gateway");
assert.ok(renderGateway, "render.yaml declares the sushi-gateway service");
assert.equal(renderGateway!.type, "web", "the gateway is a web service (it must accept inbound wss://)");
assert.equal(renderGateway!.runtime, "docker", "the gateway builds from a Dockerfile");
assert.equal(renderGateway!.dockerfilePath, `./${GATEWAY_IMAGE}`, `render builds ${GATEWAY_IMAGE}`);
assert.equal(renderGateway!.healthCheckPath, HEALTH_PATH, "render health-checks the capabilities endpoint");
assert.ok(typeof renderGateway!.plan === "string" && renderGateway!.plan.length > 0, "picks an explicit plan");

const renderEnv = new Map<string, Record<string, unknown>>(
  (renderGateway!.envVars as Array<Record<string, unknown>>).map((v) => [
    String(v.key),
    v as Record<string, unknown>,
  ])
);
for (const key of ["SUSHI_GATEWAY_TOKEN", "ALLOWED_ORIGIN", "GATEWAY_ONLY"]) {
  assert.ok(renderEnv.has(key), `render.yaml sets ${key}`);
}
assert.equal(renderEnv.get("GATEWAY_ONLY")!.value, "true", "render runs the gateway in gateway-only mode");
assert.equal(
  renderEnv.get("SUSHI_GATEWAY_TOKEN")!.generateValue,
  true,
  "render generates the gateway token instead of shipping one"
);
assert.equal(
  renderEnv.get("ALLOWED_ORIGIN")!.sync,
  false,
  "ALLOWED_ORIGIN is prompted for, because it is the deployer's Vercel origin"
);
assert.ok(
  !render.services!.some((s) => s.image === "guacamole/guacd:1.5.5" || s.name === "guacd"),
  "no unreachable guacd sidecar: Render gives services no private hostname to each other"
);
assert.match(
  read("render.yaml"),
  /IronRDP/,
  "render.yaml explains where RDP goes without guacd (browser IronRDP WASM)"
);

// ---- the in-app gateway panel ----------------------------------------------
const modal = read("src/components/GatewaySetupModal.tsx");
for (const label of ["VPS / Docker", "Railway", "Render"]) {
  assert.ok(modal.includes(`label: "${label}"`), `the gateway panel offers ${label}`);
}
assert.ok(modal.includes(".railway/railway.ts"), "the Railway snippet names the IaC file it deploys from");
assert.ok(modal.includes(GATEWAY_IMAGE), "the panel names the gateway image");
assert.ok(modal.includes("render.yaml"), "the Render snippet names the blueprint it deploys from");
assert.ok(
  modal.includes("railway config apply") && modal.includes("railway variable set"),
  "the Railway snippet uses current CLI commands"
);
assert.ok(
  !modal.includes("railway.json") && !modal.includes("railway variables --set"),
  "the panel does not advertise deprecated Railway config or CLI syntax"
);
assert.ok(modal.includes("/health"), "the keepalive pings the gateway's /health endpoint");
assert.match(modal, /240000/, "the keepalive interval is 4 minutes");
assert.ok(
  modal.includes("Keep this gateway awake"),
  "the panel offers the keep-awake toggle for hosts that suspend idle services"
);
// The status line this whole feature exists for.
assert.ok(
  modal.includes("Serverless Stream Active") && modal.includes("Active on this host"),
  "the runtime matrix still reports serverless-stream vs native-PTY states"
);
// The URL panel is no longer VPS-only, so it must not claim to be.
assert.ok(
  !modal.includes("Remote VPS WebSocket Gateway"),
  "the gateway URL panel is not labelled VPS-only now that Railway/Render are offered"
);

// ---- README -----------------------------------------------------------------
const readme = read("README.md");
for (const needle of [
  "render.yaml",
  ".railway/railway.ts",
  GATEWAY_IMAGE,
  "railway config apply",
  "Deploy to Render",
  "render.com/deploy?repo=https://github.com/sarakplaystore/sushi",
]) {
  assert.ok(readme.includes(needle), `README documents: ${needle}`);
}
// The README may *mention* that railway.json is deprecated — that note is why
// Sushi ships .railway/railway.ts — but it must not tell anyone to create or
// edit one, which is what a stale instruction would do.
assert.ok(
  !/(create|add|edit|ship|ships|see)\s+[`"]?railway\.json/i.test(readme),
  "README gives no instruction to create or edit the deprecated railway.json"
);
assert.match(
  readme,
  /railway\.json[^.]*deprecated/i,
  "README says why railway.json is not used (Config as Code is deprecated)"
);

// The public HTTPS domain is created in the dashboard, so no CLI subcommand is
// claimed for it anywhere a user would read.
for (const [name, text] of [
  ["README", readme],
  ["gateway panel", modal],
  [".railway/railway.ts", railway],
] as Array<[string, string]>) {
  assert.ok(!/railway domain\b/.test(text), `${name} does not claim a \`railway domain\` command`);
  assert.ok(text.includes("Generate Domain"), `${name} routes the public domain through the dashboard`);
}

// Every in-repo anchor the gateway section is referenced by must still resolve.
// GitHub's slugger strips punctuation (including the "." in "3.") and turns each
// run of whitespace into one hyphen — which is why "(+ Optional" leaves "--".
const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s/g, "-");
const headings = [...readme.matchAll(/^#{2,4}\s+(.+)$/gm)].map((m) => slug(m[1]));
for (const anchor of [...readme.matchAll(/\]\(#([a-z0-9-]+)\)/g)].map((m) => m[1])) {
  assert.ok(headings.includes(anchor), `README anchor #${anchor} resolves to a heading`);
}

// ---- .env.example -----------------------------------------------------------
const envExample = read(".env.example");
assert.match(envExample, /^GATEWAY_ONLY=/m, ".env.example documents GATEWAY_ONLY");
assert.match(envExample, /^SUSHI_GATEWAY_TOKEN=/m, ".env.example still documents the gateway token");
assert.match(envExample, /^ALLOWED_ORIGIN=/m, ".env.example still documents ALLOWED_ORIGIN");

// ---- where SUSHI_GATEWAY_TOKEN is set, per target ---------------------------
// The token is the one value every deployer has to carry from a platform
// dashboard into Sushi, and each host keeps it somewhere different. The gateway
// panel links to those places; these assertions keep those links pointing at the
// same hosts the README and the deploy manifests name, so a doc reorganisation
// on Railway's or Render's side shows up here instead of as a dead link in the UI.
const RAILWAY_DASHBOARD = "https://railway.com/new";
const RAILWAY_VARIABLES_DOCS = "https://docs.railway.com/variables";
const RENDER_DASHBOARD = "https://dashboard.render.com";
const RENDER_ENV_DOCS = "https://render.com/docs/configure-environment-variables";
const RENDER_BLUEPRINT =
  "https://render.com/deploy?repo=https://github.com/sarakplaystore/sushi";

assert.ok(
  modal.includes("export const GATEWAY_TOKEN_LINKS"),
  "the gateway panel keeps one exported table of token locations"
);
// Every managed host gets its console *and* its env-var docs, so a user who has
// not deployed yet can still read where the token will end up.
for (const [name, href] of [
  ["Railway dashboard", RAILWAY_DASHBOARD],
  ["Railway variables docs", RAILWAY_VARIABLES_DOCS],
  ["Render dashboard", RENDER_DASHBOARD],
  ["Render environment docs", RENDER_ENV_DOCS],
] as Array<[string, string]>) {
  assert.ok(modal.includes(href), `gateway panel links to the ${name}`);
  assert.ok(readme.includes(href), `README links to the ${name}`);
}
assert.ok(modal.includes(RENDER_BLUEPRINT), "the Render target links to the Blueprint deploy flow");
assert.ok(readme.includes(RENDER_BLUEPRINT), "README links to the Render Blueprint deploy flow");

// Nothing may link off to a host that is not one of the three gateway targets or
// this repository, and no link may be relative (these all open in a new tab).
const tokenSection = modal.slice(modal.indexOf("GATEWAY_TOKEN_LINKS"));
for (const href of [...tokenSection.matchAll(/href: "([^"]+)"/g)].map((m) => m[1])) {
  assert.ok(href.startsWith("https://"), `token link is absolute https: ${href}`);
  assert.match(
    href,
    /^https:\/\/(railway\.com|docs\.railway\.com|render\.com|dashboard\.render\.com|github\.com\/sarakplaystore\/sushi)\b/,
    `token link stays on a known host: ${href}`
  );
}
// Every link in the panel leaves Sushi (a dashboard or the docs), so each one
// has to open in its own tab and carry the rel that stops the opened page from
// driving this one through window.opener.
const anchors = [...modal.matchAll(/<a\s([\s\S]*?)>/g)].map((m) => m[1]);
assert.ok(anchors.length >= 3, `the panel renders outbound links (${anchors.length} <a> elements)`);
for (const attrs of anchors) {
  assert.match(attrs, /href=(?:\{|["'`])/, `anchor has an href: ${attrs.slice(0, 60)}…`);
  assert.match(attrs, /target="_blank"/, `anchor opens in a new tab: ${attrs.slice(0, 60)}…`);
  const rel = /rel="([^"]+)"/.exec(attrs)?.[1] ?? "";
  assert.ok(
    rel.split(/\s+/).includes("noopener") && rel.split(/\s+/).includes("noreferrer"),
    `anchor rel="${rel}" includes noopener noreferrer`
  );
}
assert.ok(
  modal.includes("Copy it from") && modal.includes("ExternalLink"),
  "the token field says where the value comes from, with an outbound-link icon"
);

// Each target names itself in prose ("On Railway that secret lives in …"), so a
// hardcoded two-way ternary here once called the VPS tab "Render". The sentence
// has to be driven by the target list, not by an id comparison.
assert.ok(
  modal.includes("On {activeTarget.short} that secret lives in"),
  "the token sentence takes the platform name from the selected target"
);
assert.ok(
  !/deployTarget === "railway" \?/.test(modal),
  "no hardcoded railway-or-render ternary left in the panel"
);
assert.ok(
  modal.includes('activeTokenLinks[0].href'),
  "the footer link comes from the same table as the token field's links"
);
for (const short of ['short: "a VPS"', 'short: "Railway"', 'short: "Render"']) {
  assert.ok(modal.includes(short), `every target has a prose name (${short})`);
}
// Every target must say where its token lives, including the one with no dashboard.
assert.ok(
  /vps: \{\s*where: "/.test(modal) &&
    /railway: \{\s*where: "/.test(modal) &&
    /render: \{\s*where: "/.test(modal),
  "all three targets document where SUSHI_GATEWAY_TOKEN is kept"
);

// The manifests and .env.example point at the same dashboards they name in the UI.
assert.ok(read("render.yaml").includes(RENDER_DASHBOARD), "render.yaml says where to read the token");
assert.ok(read("render.yaml").includes(RENDER_ENV_DOCS), "render.yaml links the env-var docs");
assert.ok(read(".railway/railway.ts").includes(RAILWAY_DASHBOARD), ".railway/railway.ts links the Railway dashboard");
assert.ok(
  read(".railway/railway.ts").includes(RAILWAY_VARIABLES_DOCS),
  ".railway/railway.ts links the Railway variables docs"
);
for (const href of [RAILWAY_DASHBOARD, RAILWAY_VARIABLES_DOCS, RENDER_DASHBOARD, RENDER_ENV_DOCS]) {
  assert.ok(envExample.includes(href), `.env.example names ${href} next to SUSHI_GATEWAY_TOKEN`);
}

// ---- the runtime matrix must believe an attached gateway --------------------
// The matrix used to read only the *local* capabilities, so on Vercel the "Native
// WebSocket PTY" row said "Serverless Stream Active (Native PTY optional via
// Gateway)" forever — even with a gateway attached whose own probe answered
// `websocketSsh: true` two lines below it. These assertions keep the row driven by
// the gateway's capabilities once one is attached.
assert.ok(
  modal.includes("gatewayCapabilities?: SystemCapabilities | null"),
  "the modal accepts the attached gateway's capabilities"
);
assert.match(
  modal,
  /const attachedCaps =\s*probeStatus\?\.ok && probeStatus\.caps \? probeStatus\.caps : gatewayCapabilities \?\? null;/,
  "a live probe wins over the boot-time read, so Test Gateway Endpoint updates the matrix at once"
);
assert.match(
  modal,
  /attachedCaps\?\.websocketSsh \? \(/,
  "the PTY row is decided by the gateway's capabilities first"
);
assert.ok(
  modal.includes("Active via attached gateway"),
  "an attached, working gateway is reported as active rather than 'optional'"
);
assert.ok(
  modal.includes("Gateway not verified yet") &&
    modal.includes("Gateway reached, but it reports no WebSocket PTY"),
  "the row distinguishes 'not probed' from 'probed and offers no PTY'"
);
assert.ok(
  modal.includes("Attached gateway:"),
  "the matrix names the attached gateway itself, not just the PTY verdict"
);
assert.ok(
  modal.includes("attachedCaps?.rdpGuacd ?? localCapabilities?.rdpGuacd"),
  "the RDP row follows the gateway's guacd (a Render gateway has none, Railway does)"
);

// A sleeping gateway must not be able to stall vault boot or spin forever, so both
// probes go through one bounded helper.
const gatewayLib = read("src/lib/client/gateway.ts");
assert.ok(
  gatewayLib.includes("export async function fetchGatewayCapabilities"),
  "there is one shared gateway probe helper"
);
assert.match(gatewayLib, /new AbortController\(/, "the probe can be aborted");
assert.match(gatewayLib, /GATEWAY_PROBE_TIMEOUT_MS = \d{4,}/, "the probe has a real timeout");
assert.match(gatewayLib, /cache: "no-store"/, "the probe never trusts a cached answer");
assert.ok(gatewayLib.includes("timedOut"), "a timeout is reported as such, not as a generic failure");
assert.ok(
  modal.includes("fetchGatewayCapabilities("),
  "the modal's Test Gateway Endpoint uses the bounded helper"
);
const workspace = read("src/components/SushiWorkspace.tsx");
assert.ok(
  workspace.includes("gatewayCapabilities={remoteCaps}"),
  "the workspace passes the gateway capabilities it already fetched"
);
assert.ok(
  workspace.includes("fetchGatewayCapabilities(gw)"),
  "vault boot uses the same bounded helper, so a cold gateway cannot hang it"
);
assert.ok(
  !/await fetch\(`\$\{httpBase\}\/api\/system\/capabilities`/.test(workspace),
  "no unbounded gateway fetch left in vault boot"
);

console.log("Gateway deployment target tests passed.");
