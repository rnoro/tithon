/**
 * Per-notebook options the daemon needs even while no client is attached.
 *
 * The daemon publishes the shared output file when a run finishes, which can
 * happen after the window closed, so every attach carries these and the daemon
 * persists the last value it received for that session.
 */

import * as vscode from "vscode";

export function sessionOptions(session: string): Record<string, unknown> {
  if (session === "default") return {};
  try {
    const scope = vscode.Uri.parse(session, true);
    const saveWidgetState = vscode.workspace
      .getConfiguration("tithon", scope)
      .get<boolean>("saveWidgetState", true);
    return { save_widget_state: saveWidgetState !== false };
  } catch {
    return {};
  }
}
