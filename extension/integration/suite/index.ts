/** Mocha entry that runs inside the VSCode Extension Host. */
import * as path from "path";
import * as fs from "fs";
import Mocha from "mocha";

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "bdd", color: false, timeout: 90000 });
  const dir = __dirname;
  // TITHON_SUITE selects a single suite by filename substring (e.g. "restore",
  // "live"); unset runs every *.test.js in the directory.
  const only = process.env.TITHON_SUITE;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".test.js")) continue;
    if (only && !f.includes(only)) continue;
    mocha.addFile(path.join(dir, f));
  }
  return new Promise<void>((resolve, reject) => {
    try {
      mocha.run((failures) => (failures ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
    } catch (err) {
      reject(err as Error);
    }
  });
}
