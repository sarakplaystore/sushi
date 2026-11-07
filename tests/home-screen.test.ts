import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import manifest from "../src/app/manifest";

const webApp = manifest();
assert.equal(webApp.short_name, "Sushi");
assert.equal(webApp.start_url, "/");
assert.equal(webApp.display, "standalone");

function assertPng(path: string, size: number) {
  const png = readFileSync(resolve(process.cwd(), "public", path));
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR");
  assert.equal(png.readUInt32BE(16), size, `${path} width`);
  assert.equal(png.readUInt32BE(20), size, `${path} height`);
  assert.equal(png[25], 2, `${path} must be an opaque RGB PNG`);
}

assertPng("apple-touch-icon.png", 180);
for (const size of [192, 512]) {
  const path = `/icon-${size}.png`;
  assert.ok(
    webApp.icons?.some((icon) => icon.src === path && icon.sizes === `${size}x${size}`),
    `manifest must include ${path}`
  );
  assertPng(path.slice(1), size);
}

// iOS needs a touch-icon link even when a web manifest exists.
const layout = readFileSync(resolve(process.cwd(), "src/app/layout.tsx"), "utf8");
assert.match(layout, /apple:\s*\[\s*\{\s*url:\s*["']\/apple-touch-icon\.png["']/);
assert.match(layout, /["']apple-mobile-web-app-capable["']:\s*["']yes["']/);
assert.match(layout, /viewportFit:\s*["']cover["']/);
assert.ok(!/maximumScale|userScalable/.test(layout), "do not disable browser zoom");
console.log("Home-screen manifest and icon tests passed.");
