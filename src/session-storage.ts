// Some browsers disable storage entirely. Keep this tab usable in memory in
// that case; never put questions, photos or health form drafts in this store.
const memory = new Map<string, string>();
export function readTabValue(key: string) {
  try {
    return sessionStorage.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}
export function writeTabValue(key: string, value: string | null) {
  if (value === null) memory.delete(key);
  else memory.set(key, value);
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // The fallback deliberately lasts only until this page is reloaded.
  }
}
