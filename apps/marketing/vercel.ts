import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  installCommand: "npm install -g vite-plus && vp install --filter '@bibcode/marketing'",
  buildCommand: "vp run --filter @bibcode/marketing build",
  outputDirectory: "dist",
};
