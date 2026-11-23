/**
 * Builds the environment block a bug report needs, so the reporter only has to
 * describe what happened. Pure: the command in extension.ts gathers the inputs.
 */

/** Bounds the log so the prefilled issue still fits in a GitHub new-issue URL. */
export const LOG_MAX_LINES = 80;
export const LOG_MAX_CHARS = 6000;

export interface ReportInputs {
  extensionVersion: string;
  vscodeVersion: string;
  appHost: string;
  remoteName: string | undefined;
  hostPlatform: string;
  daemonHome: string;
  /** The daemon's `status` reply, or undefined when it did not answer. */
  daemon: Record<string, unknown> | undefined;
  daemonError?: string;
  /** Raw tail of daemon.log, or undefined when it could not be read. */
  log: string | undefined;
}

const REMOTES: Record<string, string> = {
  "ssh-remote": "Remote-SSH",
  tunnel: "VS Code Tunnel",
  wsl: "WSL",
  "dev-container": "Dev Container",
  "attached-container": "Container",
  codespaces: "Codespaces",
};

export function connectionLabel(remoteName: string | undefined): string {
  if (!remoteName) return "Local";
  return REMOTES[remoteName] ?? remoteName;
}

/** The last lines of `text`, trimmed from the front to fit both bounds. */
export function tailLog(text: string, maxLines = LOG_MAX_LINES, maxChars = LOG_MAX_CHARS): string {
  let lines = text.replace(/\s+$/, "").split("\n").slice(-maxLines);
  while (lines.length > 1 && lines.join("\n").length > maxChars) lines = lines.slice(1);
  const out = lines.join("\n");
  return out.length > maxChars ? out.slice(-maxChars) : out;
}

export function buildReportData(inputs: ReportInputs): string {
  const d = inputs.daemon;
  const daemonLine = d
    ? `tithon ${d.daemon_version ?? "unknown (daemon predates version reporting)"}, ` +
      `Python ${d.daemon_python ?? "unknown"}, ${d.daemon_platform ?? inputs.hostPlatform}`
    : `not reachable${inputs.daemonError ? ` (${inputs.daemonError})` : ""}`;
  const sessions = Array.isArray(d?.sessions) ? d.sessions.length : 0;
  const lines = [
    "### Environment",
    "",
    `- Extension: ${inputs.extensionVersion}`,
    `- VS Code: ${inputs.vscodeVersion} (${inputs.appHost})`,
    `- Connection: ${connectionLabel(inputs.remoteName)}`,
    `- Host: ${inputs.hostPlatform}`,
    `- Daemon: ${daemonLine}`,
    `- Loaded sessions: ${sessions}`,
    "",
    `### Daemon log (last lines of ${inputs.daemonHome}/daemon.log)`,
    "",
  ];
  if (inputs.log === undefined) lines.push("Not readable.");
  else lines.push("```text", tailLog(inputs.log), "```");
  return lines.join("\n");
}
