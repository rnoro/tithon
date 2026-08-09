/**
 * Launch a real VSCode Extension Host (via @vscode/test-electron) and run an
 * integration suite inside it. Driven by the vN.sh scripts, which start a
 * daemon, seed executions, and pass TITHON_HOME / TITHON_FIXTURE / TITHON_SUITE
 * (and, for the LSP suite, TITHON_LSP_EXT_DIR) in the env.
 *
 * The VSCode build under test is selectable via TITHON_VSCODE_VERSION
 * ("stable" — the default — / "insiders" / an explicit "1.9x.y"). The Cell View
 * reuses the .py's own file:// URI as its notebook URI (ADR-041), so the
 * single-representation guards lean on VSCode/Pylance/ty internals and EVERY
 * VSCode release is a regression risk. `make notebook-insiders` re-runs the
 * notebook/LSP guard suites against the insiders build as an early warning, so a
 * breaking change is caught before it reaches users on stable.
 */
import * as path from "path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  // When this harness runs inside a VSCode server/tunnel, the inherited env has
  // ELECTRON_RUN_AS_NODE=1 — which makes the desktop Electron we spawn run as
  // plain Node, treating the workspace folder as a script ("Cannot find module
  // …/work"). Strip it so the test host boots as a real Electron app.
  delete process.env.ELECTRON_RUN_AS_NODE;

  // out-int/integration/runTest.js -> ../../ is the extension root.
  const extensionDevelopmentPath = path.resolve(__dirname, "../../");
  const extensionTestsPath = path.resolve(__dirname, "./suite/index");

  const workspace = process.env.TITHON_WORKSPACE;
  if (!workspace) throw new Error("TITHON_WORKSPACE not set");

  // A FRESH per-run user-data-dir (under the per-suite TITHON_HOME) — otherwise
  // sequential suites share VSCode's default profile and it restores the PREVIOUS
  // suite's editors (whose fixture files were already deleted), corrupting
  // activeNotebookEditor and making batch runs fail though each passes alone.
  const home = process.env.TITHON_HOME;
  const userDataDir = home ? path.join(home, "vscode-user") : undefined;

  // Most suites run hermetically with --disable-extensions (only our dev
  // extension loads). The LSP suite (v32) instead needs real notebook-aware
  // Python language servers (ruff/ty) live, so it passes TITHON_LSP_EXT_DIR — a
  // curated extensions dir — and we drop --disable-extensions for that run.
  const lspExtDir = process.env.TITHON_LSP_EXT_DIR;
  const extArgs = lspExtDir
    ? [`--extensions-dir=${lspExtDir}`]
    : ["--disable-extensions"];

  // Default "stable" matches @vscode/test-electron's own default (latest stable),
  // so the existing bundles are unchanged; the insiders bundle overrides it.
  const version = process.env.TITHON_VSCODE_VERSION || "stable";
  if (version !== "stable") {
    // eslint-disable-next-line no-console
    console.log(`[tithon] integration host: VSCode ${version}`);
  }

  await runTests({
    version,
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
      ...extArgs,
      ...(userDataDir ? [`--user-data-dir=${userDataDir}`] : []),
    ],
    extensionTestsEnv: {
      TITHON_HOME: process.env.TITHON_HOME ?? "",
      TITHON_FIXTURE: process.env.TITHON_FIXTURE ?? "",
      TITHON_HELPER: process.env.TITHON_HELPER ?? "",
      TITHON_SUITE: process.env.TITHON_SUITE ?? "",
    },
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("integration runner failed:", err);
  process.exit(1);
});
