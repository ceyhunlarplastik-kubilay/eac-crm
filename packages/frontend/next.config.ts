import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@eac-crm/call-analytics"],
  serverExternalPackages: ["@prisma/client", "exceljs", "pg"]
};

export default nextConfig;
