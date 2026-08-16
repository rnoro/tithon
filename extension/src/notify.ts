/**
 * User-facing feedback for Tithon's button/palette actions.
 *
 * Two rules live here, in one place, so every command reports alike:
 *
 *  - An action the user asked for reports through a NOTIFICATION, not
 *    `setStatusBarMessage`. A status-bar flash is dismissed on a timer in a
 *    corner the user is not looking at, so "did the restart happen?" had no
 *    answer a few seconds later; a notification persists until dismissed and is
 *    replayable from the bell. The exception is high-frequency, low-stakes
 *    feedback (cell submission fires on every run) — that stays in the status
 *    bar, because one toast per executed cell is noise, not information.
 *
 *  - An action that DESTROYS running state (restart / terminate) asks first,
 *    modally. Losing a multi-hour training namespace to a mis-clicked toolbar
 *    button is unrecoverable, and Tithon's whole premise is that the namespace
 *    outlives the client.
 */
import * as vscode from "vscode";

/** Report the outcome of a user-invoked action. */
export function notifyInfo(message: string): void {
  void vscode.window.showInformationMessage(message);
}

/** Report an action that could not do anything (no kernel, nothing to restore). */
export function notifyWarn(message: string): void {
  void vscode.window.showWarningMessage(message);
}

/**
 * Ask, modally and centred, before destroying running kernel state. Returns
 * true only on an explicit confirm — a dismissed dialog (Escape / Cancel)
 * returns false, so callers can `if (!(await confirmDestructive(...))) return;`.
 *
 * `tithon.confirmDestructiveActions: false` opts out and returns true without
 * prompting. That switch is the ONE seam the real-VSCode suites use to keep
 * driving `tithon.restartKernel` / `tithon.restartDaemon` unattended; the gate
 * itself is covered by a suite that leaves it at its default.
 */
export async function confirmDestructive(opts: {
  /** The question, e.g. "Restart the kernel for train.py?" */
  message: string;
  /** What is lost — shown as the dialog's smaller second line. */
  detail: string;
  /** Affirmative button label, e.g. "Restart". */
  confirmLabel: string;
}): Promise<boolean> {
  const enabled = vscode.workspace
    .getConfiguration("tithon")
    .get<boolean>("confirmDestructiveActions", true);
  if (!enabled) return true;
  // Fail SAFE, never open: anything other than a click on the affirmative button
  // — Escape, Cancel, or a host that declines to show the dialog at all (the
  // Extension Host test runner rejects every modal with "refused to show dialog
  // in tests") — must leave the kernel alone. Letting the rejection escape would
  // turn an unshowable dialog into a failed command with a raw error toast.
  let answer: string | undefined;
  try {
    answer = await vscode.window.showWarningMessage(
      opts.message,
      { modal: true, detail: opts.detail },
      opts.confirmLabel,
    );
  } catch {
    return false;
  }
  return answer === opts.confirmLabel;
}
