/** Mocha entry that runs inside the VSCode Extension Host. */
import * as path from "path";
import * as fs from "fs";
import Mocha from "mocha";

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "bdd", color: false, timeout: 90000 });
  const dir = __dirname;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith(".test.js")) mocha.addFile(path.join(dir, f));
  }
  return new Promise<void>((resolve, reject) => {
    try {
      mocha.run((failures) => (failures ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
    } catch (err) {
      reject(err as Error);
    }
  });
}
