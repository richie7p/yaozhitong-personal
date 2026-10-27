type ChatDraft = Readonly<{
  question: string;
  selected: readonly string[];
  busy: string;
  error: string;
  sent: boolean;
  completed: number;
}>;
function emptyDraft(): ChatDraft {
  return {
    question: "",
    selected: [],
    busy: "",
    error: "",
    sent: false,
    completed: 0,
  };
}
let identity: string | null = null;
let epoch = 0;
let draft = emptyDraft();
const inactiveDraft = emptyDraft();
const listeners = new Set<() => void>();

function publish(next: ChatDraft) {
  draft = next;
  for (const listener of listeners) listener();
}

// Deliberately memory-only: health questions disappear on reload or sign-out.
export function setChatDraftIdentity(next: string | null) {
  if (next === identity) return;
  identity = next;
  epoch++;
  publish(emptyDraft());
}

export function chatDraftSession() {
  const owner = epoch;
  const isCurrent = () => owner === epoch && identity !== null;
  return {
    read: () => (isCurrent() ? draft : inactiveDraft),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update: (update: Partial<Pick<ChatDraft, "question" | "selected">>) => {
      if (!isCurrent() || draft.busy) return;
      publish({
        ...draft,
        ...update,
        selected: update.selected ? [...update.selected] : draft.selected,
      });
    },
    startSubmission: () => {
      if (!isCurrent() || draft.busy) return false;
      publish({ ...draft, busy: "正在查閱仿單…", error: "", sent: false });
      return true;
    },
    progress: (busy: string) => {
      if (isCurrent()) publish({ ...draft, busy });
    },
    completeQuestion: (submitted: string) => {
      if (!isCurrent()) return;
      publish({
        ...draft,
        question: draft.question === submitted ? "" : draft.question,
        busy: "",
        error: "",
        sent: true,
        completed: draft.completed + 1,
      });
    },
    fail: (error: string) => {
      if (isCurrent()) publish({ ...draft, busy: "", error, sent: false });
    },
  };
}
