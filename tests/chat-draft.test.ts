import { beforeEach, describe, expect, it, vi } from "vitest";

let chat: typeof import("../src/chat-draft");
let setIdentity: typeof import("../src/api").setJobIdentity;

beforeEach(async () => {
  vi.resetModules();
  chat = await import("../src/chat-draft");
  ({ setJobIdentity: setIdentity } = await import("../src/api"));
  setIdentity("synthetic-account-a");
});

describe("memory-only chat drafts across views and account lifetimes", () => {
  it("shares a stable snapshot across navigation and same-account refreshes", () => {
    const firstView = chat.chatDraftSession();
    const selection = ["synthetic-medication"];
    firstView.update({ question: "合成草稿", selected: selection });
    selection.push("external-mutation");
    setIdentity("synthetic-account-a");
    const returnedView = chat.chatDraftSession();
    expect(returnedView.read()).toMatchObject({
      question: "合成草稿",
      selected: ["synthetic-medication"],
    });
    expect(returnedView.read()).toBe(returnedView.read());
    expect(returnedView.read()).toBe(firstView.read());
  });

  it("locks all views during a send and publishes completion to the returned view", () => {
    const oldView = chat.chatDraftSession();
    oldView.update({
      question: " 合成問題 ",
      selected: ["synthetic-medication"],
    });
    expect(oldView.startSubmission()).toBe(true);
    const returnedView = chat.chatDraftSession();
    const changed = vi.fn();
    const stop = returnedView.subscribe(changed);
    expect(returnedView.startSubmission()).toBe(false);
    returnedView.update({ question: "must-not-replace-in-flight-question" });
    oldView.progress("合成工作處理中");
    expect(returnedView.read()).toMatchObject({
      question: " 合成問題 ",
      busy: "合成工作處理中",
    });
    oldView.completeQuestion(" 合成問題 ");
    expect(returnedView.read()).toMatchObject({
      question: "",
      selected: ["synthetic-medication"],
      busy: "",
      sent: true,
      completed: 1,
    });
    expect(changed).toHaveBeenCalledTimes(2);
    stop();
    returnedView.update({ question: "下一個合成問題" });
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("retains a failed question and selection for retry after leaving the view", () => {
    const oldView = chat.chatDraftSession();
    oldView.update({
      question: "合成重試問題",
      selected: ["synthetic-medication"],
    });
    oldView.startSubmission();
    const returnedView = chat.chatDraftSession();
    oldView.fail("合成錯誤");
    expect(returnedView.read()).toMatchObject({
      question: "合成重試問題",
      selected: ["synthetic-medication"],
      busy: "",
      error: "合成錯誤",
      sent: false,
    });
    expect(returnedView.startSubmission()).toBe(true);
    expect(returnedView.read().error).toBe("");
  });

  it.each(["synthetic-account-b", null])(
    "clears account state on identity %s and ignores old async callbacks",
    (nextIdentity) => {
      const oldView = chat.chatDraftSession();
      oldView.update({ question: "帳號甲合成問題", selected: ["private-a"] });
      oldView.startSubmission();
      setIdentity(nextIdentity);
      expect(oldView.read()).toMatchObject({
        question: "",
        selected: [],
        busy: "",
      });
      setIdentity("synthetic-account-a");
      const newView = chat.chatDraftSession();
      newView.update({ question: "重新登入的合成問題", selected: ["new-a"] });
      newView.startSubmission();
      const current = newView.read();
      oldView.update({ question: "不得帶回舊問題", selected: ["private-a"] });
      oldView.progress("不得更新新帳號的狀態");
      oldView.completeQuestion("帳號甲合成問題");
      oldView.fail("不得顯示舊帳號錯誤");
      expect(oldView.startSubmission()).toBe(false);
      expect(newView.read()).toBe(current);
      expect(oldView.read()).toMatchObject({
        question: "",
        selected: [],
        busy: "",
      });
    },
  );
});
