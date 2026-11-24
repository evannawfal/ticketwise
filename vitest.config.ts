import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "services/*/test/**/*.test.ts", "evals/test/**/*.test.ts"],
    testTimeout: 20000,
  },
});
