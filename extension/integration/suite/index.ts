/** Mocha entry that runs inside the VSCode Extension Host. */

import * as fs from "node:fs";
import * as path from "node:path";
import Mocha from "mocha";
import * as vscode from "vscode";

/**
 * Destructive commands (`tithon.restartKernel`, `tithon.restartDaemon`) open a
 * MODAL dialog no in-host test can answer, so the harness turns the gate off —
 * the suites still drive the real command, only the dialog is skipped.
 * `TITHON_CONFIRM_DESTRUCTIVE=1` leaves it at its shipped default for the one
 * suite whose subject IS the gate.
 */
async function applyConfirmationPolicy(): Promise<void> {
  if (process.env.TITHON_CONFIRM_DESTRUCTIVE === "1") return;
  await vscode.workspace
    .getConfiguration("tithon")
    .update("confirmDestructiveActions", false, vscode.ConfigurationTarget.Global);
}

export async function run(): Promise<void> {
  await applyConfirmationPolicy();
  const mocha = new Mocha({ ui: "bdd", color: false, timeout: 90000 });
  const dir = __dirname;
  // TITHON_SUITE selects a single suite by EXACT filename stem (e.g. "restore",
  // "reconnect"); unset runs every *.test.js. Exact match avoids substring
  // collisions (e.g. "reconnect" must not also pull in "reconnectstates").
  const only = process.env.TITHON_SUITE;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".test.js")) continue;
    if (only && f !== `${only}.test.js`) continue;
    mocha.addFile(path.join(dir, f));
  }
  return new Promise<void>((resolve, reject) => {
    try {
      mocha.run((failures) =>
        failures ? reject(new Error(`${failures} test(s) failed`)) : resolve(),
      );
    } catch (err) {
      reject(err as Error);
    }
  });
}
