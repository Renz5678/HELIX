import { defineConfig } from "vitest/config";
export default defineConfig({
  base: process.env.HELIX_BASE_PATH || "/",
  css: {postcss:{plugins:[]}},
  test: { include: ["tests/**/*.test.ts"] },
});
