import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // `vscode` is injected by the Extension Host and has no npm package to
  // resolve, so any src module importing it is unreachable from a unit test.
  // The alias makes exactly one such module testable — `src/notify.ts`, whose
  // modal dialog the real-VSCode host refuses to show (see test/vscodeMock.ts).
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL("./test/vscodeMock.ts", import.meta.url)),
    },
  },
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
