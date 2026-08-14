import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The console is a single full-height screen; the dev indicator sits on top of the
  // service list. Compile and runtime errors are still surfaced without it.
  devIndicators: false,
};

export default nextConfig;
