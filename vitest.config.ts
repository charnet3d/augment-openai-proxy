import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"], // entry point with server startup, hard to unit test
      reporter: ["text", "lcov"],
      linesThreshold: 80,
      branchesThreshold: 80,
      functionsThreshold: 80,
      statementsThreshold: 80,
    },
  },
});
