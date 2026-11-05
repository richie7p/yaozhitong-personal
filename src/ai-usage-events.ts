const listeners = new Set<() => void>();

export function onAiUsageChanged(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyAiUsageChanged() {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* A display cannot change an AI operation. */
    }
  }
}

export function mayChangeAiUsage(path: string, method: string) {
  return (
    method === "POST" &&
    (["/recognitions", "/bundles", "/chat", "/interactions"].includes(path) ||
      /^\/jobs\/[^/]+\/retry$/.test(path))
  );
}
