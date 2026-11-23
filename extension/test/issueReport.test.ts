import { describe, expect, it } from "vitest";
import {
  buildReportData,
  connectionLabel,
  LOG_MAX_CHARS,
  type ReportInputs,
  tailLog,
} from "../src/issueReport";

const BASE: ReportInputs = {
  extensionVersion: "0.3.2",
  vscodeVersion: "1.99.0",
  appHost: "desktop",
  remoteName: "tunnel",
  hostPlatform: "linux 6.8.0 x64",
  daemonHome: "/home/u/.tithon",
  daemon: {
    daemon_version: "0.3.2",
    daemon_python: "3.12.4",
    daemon_platform: "Linux 6.8.0 x86_64",
    sessions: [{}, {}],
  },
  log: "line 1\nline 2\n",
};

describe("issue report data", () => {
  it("names every version and the connection without asking the reporter", () => {
    const body = buildReportData(BASE);
    expect(body).toContain("- Extension: 0.3.2");
    expect(body).toContain("- VS Code: 1.99.0 (desktop)");
    expect(body).toContain("- Connection: VS Code Tunnel");
    expect(body).toContain("- Daemon: tithon 0.3.2, Python 3.12.4, Linux 6.8.0 x86_64");
    expect(body).toContain("- Loaded sessions: 2");
    expect(body).toContain("```text\nline 1\nline 2\n```");
  });

  it("still reports when the daemon is down and the log is missing", () => {
    const body = buildReportData({
      ...BASE,
      daemon: undefined,
      daemonError: "ENOENT",
      log: undefined,
    });
    expect(body).toContain("- Daemon: not reachable (ENOENT)");
    expect(body).toContain("Not readable.");
  });

  it("labels an older daemon that has no version field", () => {
    const body = buildReportData({ ...BASE, daemon: { sessions: [] } });
    expect(body).toContain("tithon unknown (daemon predates version reporting)");
  });

  it("maps VS Code remote names and keeps unknown ones verbatim", () => {
    expect(connectionLabel(undefined)).toBe("Local");
    expect(connectionLabel("ssh-remote")).toBe("Remote-SSH");
    expect(connectionLabel("wsl")).toBe("WSL");
    expect(connectionLabel("something-new")).toBe("something-new");
  });

  it("keeps only the newest log lines within the size bound", () => {
    const log = Array.from({ length: 500 }, (_, i) => `entry ${i} ${"x".repeat(100)}`).join("\n");
    const tail = tailLog(log);
    expect(tail.length).toBeLessThanOrEqual(LOG_MAX_CHARS);
    expect(tail.endsWith(`entry 499 ${"x".repeat(100)}`)).toBe(true);
    expect(tail).not.toContain("entry 0 ");
  });
});
