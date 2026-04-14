import type { NextConfig } from "next";
// Vercel Workflow replaced with lightweight async runner
// import { withWorkflow } from "workflow/next";
const withWorkflow = <T>(config: T): T => config;

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "avatars.githubusercontent.com",
      },
      {
        protocol: "https",
        hostname: "vercel.com",
      },
      {
        protocol: "https",
        hostname: "*.vercel.com",
      },
    ],
  },
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
};

export default withWorkflow(nextConfig);
