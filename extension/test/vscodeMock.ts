/**
 * A stand-in for the `vscode` module under vitest (aliased in vitest.config.ts).
 *
 * It exists for one thing the real-VSCode suites structurally cannot reach: the
 * Extension Host test runner REFUSES to show modal dialogs, so v65 can only
 * prove that a declined confirmation destroys nothing. Whether the dialog Tithon
 * would have shown is actually modal, carries the right detail line, and maps
 * the right button to "yes" is asserted here instead.
 *
 * Only the surface `src/notify.ts` touches is implemented. Keep it that way — a
 * general-purpose VSCode fake is a maintenance sink, not a test.
 */
export interface ModalCall {
  message: string;
  options: { modal?: boolean; detail?: string };
  items: string[];
}

export const state = {
  /** Value `getConfiguration("tithon").get("confirmDestructiveActions", …)` returns. */
  confirmSetting: undefined as boolean | undefined,
  /** What the user "clicks"; undefined = dismissed. */
  answer: undefined as string | undefined,
  /** Make the dialog reject, the way the test host's DialogService does. */
  rejectDialog: false,
  modalCalls: [] as ModalCall[],
  infoMessages: [] as string[],
  warningMessages: [] as string[],
  configSection: undefined as string | undefined,
};

export function resetVscodeMock(): void {
  state.confirmSetting = undefined;
  state.answer = undefined;
  state.rejectDialog = false;
  state.modalCalls = [];
  state.infoMessages = [];
  state.warningMessages = [];
  state.configSection = undefined;
}

export const window = {
  showInformationMessage(message: string): Promise<undefined> {
    state.infoMessages.push(message);
    return Promise.resolve(undefined);
  },
  /** Both roles of the real API: a notification with no options object, or —
   *  when an options object is passed — a dialog. */
  showWarningMessage(message: string, ...rest: unknown[]): Promise<string | undefined> {
    if (rest.length > 0 && typeof rest[0] === "object" && rest[0] !== null) {
      state.modalCalls.push({
        message,
        options: rest[0] as ModalCall["options"],
        items: rest.slice(1) as string[],
      });
      if (state.rejectDialog) {
        return Promise.reject(new Error("DialogService: refused to show dialog in tests"));
      }
      return Promise.resolve(state.answer);
    }
    state.warningMessages.push(message);
    return Promise.resolve(undefined);
  },
};

export const workspace = {
  getConfiguration(section?: string) {
    state.configSection = section;
    return {
      get<T>(_key: string, defaultValue: T): T {
        return (state.confirmSetting as T | undefined) ?? defaultValue;
      },
    };
  },
};
