import { beforeEach, describe, expect, it } from "vitest";
import { confirmDestructive, notifyInfo, notifyWarn } from "../src/notify";
import { resetVscodeMock, state } from "./vscodeMock";

const ASK = {
  message: "Restart the kernel for train.py?",
  detail: "The Python process is replaced.",
  confirmLabel: "Restart",
};

describe("destructive-action confirmation", () => {
  beforeEach(resetVscodeMock);

  it("asks with a MODAL dialog that spells out what is lost", async () => {
    state.answer = ASK.confirmLabel;
    await confirmDestructive(ASK);

    expect(state.modalCalls).toHaveLength(1);
    const call = state.modalCalls[0];
    // `modal: true` is the whole point — a non-modal warning is a corner toast
    // the user can miss, and the kernel would already be gone by the time they
    // read it.
    expect(call.options.modal).toBe(true);
    expect(call.options.detail).toBe(ASK.detail);
    expect(call.message).toBe(ASK.message);
    // One affirmative button only; Cancel is VSCode's own and must NOT be listed
    // as an item, or dismissing becomes ambiguous with choosing.
    expect(call.items).toEqual([ASK.confirmLabel]);
    expect(state.configSection).toBe("tithon");
  });

  it("proceeds only on the affirmative button", async () => {
    state.answer = ASK.confirmLabel;
    expect(await confirmDestructive(ASK)).toBe(true);
  });

  it.each([
    [
      "dismissed (Escape / Cancel)",
      () => {
        state.answer = undefined;
      },
    ],
    [
      "some other button",
      () => {
        state.answer = "Later";
      },
    ],
    [
      "a host that refuses to show the dialog",
      () => {
        state.rejectDialog = true;
      },
    ],
  ])("fails safe when the answer is %s", async (_label, arrange) => {
    arrange();
    expect(await confirmDestructive(ASK)).toBe(false);
  });

  it("defaults to asking when the setting is unset", async () => {
    state.confirmSetting = undefined;
    state.answer = undefined;
    expect(await confirmDestructive(ASK)).toBe(false);
    expect(state.modalCalls).toHaveLength(1);
  });

  it("skips the dialog entirely when the user opts out", async () => {
    state.confirmSetting = false;
    expect(await confirmDestructive(ASK)).toBe(true);
    expect(state.modalCalls).toHaveLength(0);
  });
});

describe("action feedback", () => {
  beforeEach(resetVscodeMock);

  it("reports through notifications, not the status bar", () => {
    notifyInfo("Tithon: kernel restarted (train.py)");
    notifyWarn("Tithon: no running kernel to interrupt");
    expect(state.infoMessages).toEqual(["Tithon: kernel restarted (train.py)"]);
    expect(state.warningMessages).toEqual(["Tithon: no running kernel to interrupt"]);
    // Plain notifications, never dialogs — only destructive actions interrupt.
    expect(state.modalCalls).toHaveLength(0);
  });
});
