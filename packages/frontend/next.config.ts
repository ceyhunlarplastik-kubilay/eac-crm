import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@prisma/client", "exceljs", "pg"]
};

export default nextConfig;
