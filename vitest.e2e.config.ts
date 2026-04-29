import { defineConfig } from "vitest/config";

// Dedicated config for end-to-end tests that hit the real Augment API.
// Run with `npm run test:e2e`. Requires either AUGMENT_API_KEY/_URL in .env
// or a session file written by `auggie login`; the suite self-skips otherwise.
export default defineConfig({
  test: {
    globals: true,
    include: ["src/__tests__/e2e.test.ts"],
  },
});
