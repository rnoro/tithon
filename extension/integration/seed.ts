/**
 * Seed a real daemon with the fixture notebook's executions (run from plain
 * node, before the VSCode integration test). Submits each code cell's verbatim
 * source via the verified SessionClient so daemon cell_hash == the extension's
 * computeCellHash(cellSource), and waits until every execution is terminal.
 */
import { readFileSync } from "fs";
import { parse, cellSource } from "../src/serializer";
import { SessionClient } from "../src/sessionClient";
import { computeCellHash } from "../src/cellAttach";

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error("usage: seed.js <fixture.py>");
  const text = readFileSync(file, "utf8");
  const cells = parse(text).cells;

  const client = new SessionClient();
  await client.attach(0);

  let line = 0;
  const ids: string[] = [];
  for (const cell of cells) {
    const span = (cell.hasMarker ? 1 : 0) + cell.body.length;
    if (cell.kind === "code") {
      const src = cellSource(cell);
      const id = await client.execute(src, {
        uri: `file://${file}`,
        range: { start: line, end: line + span - 1 },
        cell_hash: computeCellHash(src),
      });
      ids.push(id);
    }
    line += span;
  }

  await new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const byId = new Map(client.executions().map((e) => [e.execId, e]));
      const done = ids.every(
        (i) => byId.has(i) && ["done", "error", "orphaned"].includes(byId.get(i)!.status),
      );
      if (done) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - t0 > 40000) {
        clearInterval(iv);
        reject(new Error("seed timed out waiting for executions"));
      }
    }, 50);
  });

  client.close();
  // eslint-disable-next-line no-console
  console.log(`seeded ${ids.length} executions: ${ids.join(",")}`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
