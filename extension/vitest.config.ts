import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // jsdom is opted into per-file via the `// @vitest-environment jsdom`
    // docblock (only the widget render test needs a DOM).
    environmentMatchGlobs: [],
    setupFiles: ["./test/setup.ts"],
    reporters: ["default"],
    testTimeout: 60000,
  },
});
