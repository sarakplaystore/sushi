import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_GATEWAY_ALLOWED_ORIGIN } from "../src/lib/gateway-defaults.mjs";

console.log("==> Railway template: safe symbolic defaults and setup instructions");

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const variables = JSON.parse(read(".railway/gateway-template-variables.json")) as Record<string, {
  value: unknown;
  description: unknown;
}>;
const expectedValues: Record<string, string> = {
  RAILWAY_DOCKERFILE_PATH: "Dockerfile.gateway",
  GATEWAY_ONLY: "true",
  NODE_ENV: "production",
  HOST: "0.0.0.0",
  PORT: "3000",
  GUACD_HOST: "${{guacd.RAILWAY_PRIVATE_DOMAIN}}",
  GUACD_PORT: "4822",
  ALLOWED_ORIGIN: DEFAULT_GATEWAY_ALLOWED_ORIGIN,
  SUSHI_GATEWAY_TOKEN: '${{secret(48, "abcdef0123456789")}}',
  SUSHI_GATEWAY_TOKEN_REQUIRE_HEX_48: "true",
};
assert.deepEqual(Object.keys(variables).sort(), Object.keys(expectedValues).sort(),
  "the template editor import contains exactly the gateway settings, not full-app env defaults");
for (const [key, value] of Object.entries(expectedValues)) {
  assert.deepEqual(Object.keys(variables[key]).sort(), ["description", "value"], `${key} is a Raw Editor variable object`);
  assert.equal(variables[key].value, value, `${key} uses the intended template default`);
  assert.equal(typeof variables[key].description, "string");
  assert.ok((variables[key].description as string).length > 20, `${key} explains its purpose`);
  assert(!key.startsWith("NEXT_PUBLIC_"), "no template setting exposes secrets to a frontend bundle");
}
assert.match(String(variables.SUSHI_GATEWAY_TOKEN.value), /^\$\{\{secret\(48, "abcdef0123456789"\)\}\}$/,
  "only Railway's symbolic 192-bit hex generator is committed, never a fixed secret");
assert.doesNotMatch(read(".railway/railway.ts"), /SUSHI_GATEWAY_TOKEN_REQUIRE_HEX_48/,
  "the template-only guard is not applied to existing IaC-managed services");

const guide = read(".railway/TEMPLATE.md");
for (const text of [
  "recipe, not an existing Railway template",
  "Do not paste the template variables into a live service",
  "https://railway.com/workspace/templates",
  "New Template",
  "guacamole/guacd:1.5.5",
  "/opt/guacamole/sbin/guacd -b :: -L info -f",
  "Dockerfile.gateway",
  "Variables → Raw Editor →",
  "gateway-template-variables.json",
  expectedValues.SUSHI_GATEWAY_TOKEN,
  "SUSHI_GATEWAY_TOKEN_REQUIRE_HEX_48=true",
  "/api/system/capabilities",
  "Create Template",
  "Generate Domain",
  "not blank or the literal expression",
  "the two values",
  "Redeploy or restart",
  "real SSH",
]) {
  assert.ok(guide.includes(text), `the template setup guide explains ${text}`);
}
assert.match(guide, /do not enable public\s+networking on `guacd`/i, "guacd is kept off the public internet");
assert.match(guide, /checks\s+format only, not randomness/i, "the startup guard is not oversold");
assert.match(guide, /does not validate the token or WebSocket/i, "the HTTP probe is not oversold");
assert.match(guide, /cannot send its\s+generated secret automatically/i, "separate-frontend pairing is described honestly");
assert.match(guide, /cannot be read back/i, "sealed token recovery is explained");
assert.ok(read("README.md").includes(".railway/TEMPLATE.md"), "the README links the template guide");
assert.ok(read("README.md").includes(".railway/gateway-template-variables.json"), "the README links the JSON");
console.log("Railway template configuration tests passed (no live Railway deployment was performed).");
