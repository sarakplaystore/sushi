import type { NextConfig } from "next";

// Identifies the build to the browser, so an open tab notices that a newer
// deployment is live (and can offer a reload) instead of running stale code.
const buildId =
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.GITHUB_SHA ||
  new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_SUSHI_BUILD_ID: buildId,
  },
  serverExternalPackages: ["ssh2", "ws", "@simplewebauthn/server"],
  allowedDevOrigins: ["*.e2b.app", "*.vercel.app"],
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
