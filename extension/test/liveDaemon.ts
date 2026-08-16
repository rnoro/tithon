/**
 * The gate for the two vitest suites that drive a REAL daemon
 * (`restore.test.ts` = v7, `richDaemon.test.ts` = v27).
 *
 * Both used to decide "is a daemon live?" with `existsSync(defaultSocketPath())`,
 * and `defaultSocketPath()` falls back to `~/.tithon/daemon.sock` when
 * `TITHON_HOME` is unset. So a plain `npm test` — or any full vitest run — would
 * silently attach to whatever daemon happened to own the user's default socket:
 * a different workspace's daemon, a leftover from manual debugging, a daemon
 * built from another revision. These suites submit cells to the `default`
 * session and assume its journal starts empty, so a stray daemon both pollutes
 * them (v7/v27 fail for reasons unrelated to the change under test — seen
 * 2026-06-30, while all 28 electron tests passed) and is polluted BY them.
 *
 * The fix is to make "live" mean *deliberately provisioned for this suite*
 * rather than *a socket exists somewhere*:
 *
 *   1. `TITHON_TEST_DAEMON=1` must be set — only `scripts/v7.sh` and
 *      `scripts/v27.sh` set it, and only after they have started their own
 *      daemon. An ambient daemon can never opt itself in.
 *   2. `TITHON_HOME` must be set, so the socket is the isolated one those
 *      scripts created under `/tmp/tithon-*` (lib.sh `setup_env`).
 *   3. `TITHON_HOME` must NOT be the user's default `~/.tithon`, which is the
 *      shared home these suites must never write into.
 *
 * This does not weaken v7/v27: they still run against a real daemon and a real
 * kernel, and both scripts already FAIL if their suite reports itself skipped.
 * What it removes is the third state — running against the *wrong* daemon.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface LiveDaemon {
  /** Socket to drive. Only meaningful when `live`. */
  sock: string;
  /** True when a daemon was provisioned for this suite by a verify script. */
  live: boolean;
  /** Why the suite is not running — printed so a skip is never silent. */
  reason: string;
}

export function liveDaemon(): LiveDaemon {
  const home = process.env.TITHON_HOME;
  const sock = home ? join(home, "daemon.sock") : "";
  const no = (reason: string): LiveDaemon => ({ sock, live: false, reason });

  if (process.env.TITHON_TEST_DAEMON !== "1") {
    return no(
      "TITHON_TEST_DAEMON is not 1 — this suite only runs against a daemon a verify " +
        "script provisioned for it (scripts/v7.sh, scripts/v27.sh). Run those, not `npm test`.",
    );
  }
  if (!home) {
    return no(
      "TITHON_TEST_DAEMON=1 but TITHON_HOME is unset — refusing to fall back to the " +
        "shared ~/.tithon socket, which is what made these suites pollutable.",
    );
  }
  if (resolve(home) === resolve(join(homedir(), ".tithon"))) {
    return no(
      `TITHON_HOME is the user's default home (${home}); these suites assume a fresh ` +
        "journal on the `default` session, so they must run in an isolated home.",
    );
  }
  if (!existsSync(sock)) {
    return no(`no daemon socket at ${sock} — the verify script's daemon did not come up.`);
  }
  return { sock, live: true, reason: "" };
}

/** Resolve the gate and announce a skip, so it is never silent. */
export function requireLiveDaemon(suite: string): LiveDaemon {
  const d = liveDaemon();
  if (!d.live) console.warn(`[${suite}] not run against a real daemon: ${d.reason}`);
  return d;
}
