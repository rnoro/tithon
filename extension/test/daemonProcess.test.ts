import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { ensureDaemon } from "../src/daemonProcess";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("checks daemon readiness with a complete WebSocket handshake", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tithon-probe-"));
  dirs.push(dir);
  const socket = join(dir, "daemon.sock");
  const server = createServer();
  const wss = new WebSocketServer({ server });
  let connections = 0;
  wss.on("connection", () => connections++);
  await new Promise<void>((resolve) => server.listen(socket, resolve));

  try {
    await ensureDaemon(socket);
    expect(connections).toBe(1);
  } finally {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
