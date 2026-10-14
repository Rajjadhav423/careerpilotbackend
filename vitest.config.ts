import { defineConfig } from "vitest/config";

export default defineConfig({
  // No CSS here: an inline (empty) PostCSS config stops Vite searching parent folders for one
  css: { postcss: {} },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // PDF tests start Chromium; database tests share one test database
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    setupFiles: ["test/setup.ts"],
  },
});
