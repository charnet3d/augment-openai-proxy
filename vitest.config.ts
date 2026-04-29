import { defineConfig, configDefaults } from "vitest/config";

// E2E tests hit the real Augment API and require credentials; they are
// excluded from the default `npm test` run and executed via `npm run test:e2e`
// (see package.json), which points vitest at vitest.e2e.config.ts.
export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "src/__tests__/e2e.test.ts"],
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
