import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "../backend/src"),
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.mts"],
    testTimeout: 60000,
  },
});
