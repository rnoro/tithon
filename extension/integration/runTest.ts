/**
 * Launch a real VSCode Extension Host (via @vscode/test-electron) and run the
 * restore integration suite inside it. Driven by verify/v8.sh, which starts a
 * daemon, seeds executions, and passes TITHON_HOME / TITHON_FIXTURE in the env.
 */
import * as path from "path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  // out-int/integration/runTest.js -> ../../ is the extension root.
  const extensionDevelopmentPath = path.resolve(__dirname, "../../");
  const extensionTestsPath = path.resolve(__dirname, "./suite/index");

  const workspace = process.env.TITHON_WORKSPACE;
  if (!workspace) throw new Error("TITHON_WORKSPACE not set");

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      workspace,
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-updates",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-workspace-trust",
      // keep other installed extensions out; our dev extension still loads.
      "--disable-extensions",
    ],
    extensionTestsEnv: {
      TITHON_HOME: process.env.TITHON_HOME ?? "",
      TITHON_FIXTURE: process.env.TITHON_FIXTURE ?? "",
      TITHON_SUITE: process.env.TITHON_SUITE ?? "",
    },
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("integration runner failed:", err);
  process.exit(1);
});
