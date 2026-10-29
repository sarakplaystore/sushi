import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["ssh2", "ws"],
  allowedDevOrigins: ["*.e2b.app", "*.vercel.app"],
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
