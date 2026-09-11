import {
  readFile,
  mkdir,
  writeFile,
  rename,
  open,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname } from "node:path";
import { initializeApp, getApps, applicationDefault } from "firebase-admin/app";
import { getFirestore, type Transaction } from "firebase-admin/firestore";
import { config } from "./config.js";
export type Doc = Record<string, any>;
export interface Tx {
  get<T = Doc>(collection: string, id: string): Promise<T | null>;
  set(collection: string, id: string, value: unknown): void;
  delete(collection: string, id: string): void;
}
export interface Store {
  get<T = Doc>(collection: string, id: string): Promise<T | null>;
  list<T = Doc>(
    collection: string,
    where?: [string, unknown],
    and?: [string, unknown],
  ): Promise<T[]>;
  set(collection: string, id: string, value: unknown): Promise<void>;
  delete(collection: string, id: string): Promise<void>;
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}
export function firebaseApp() {
  return (
    getApps()[0] ||
    initializeApp({
      credential: applicationDefault(),
      projectId: config.project,
      storageBucket: config.bucket,
    })
  );
}
export class MemoryStore implements Store {
  data: Record<string, Record<string, any>> = {};
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private file?: string) {}
  async load() {
    if (this.file)
      try {
        this.data = JSON.parse(await readFile(this.file, "utf8"));
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
    return this;
  }
  async get<T = Doc>(c: string, id: string): Promise<T | null> {
    if (this.file) await this.load();
    return structuredClone(this.data[c]?.[id] ?? null);
  }
  async list<T = Doc>(
    c: string,
    where?: [string, unknown],
    and?: [string, unknown],
  ): Promise<T[]> {
    if (this.file) await this.load();
    return structuredClone(
      Object.values(this.data[c] || {}).filter(
        (x) =>
          (!where || x[where[0]] === where[1]) &&
          (!and || x[and[0]] === and[1]),
      ),
    );
  }
  async set(c: string, id: string, v: unknown) {
    await this.transaction(async (tx) => {
      tx.set(c, id, v);
    });
  }
  async delete(c: string, id: string) {
    await this.transaction(async (tx) => {
      tx.delete(c, id);
    });
  }
  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const task = this.tail.then(async () => {
      let lock: Awaited<ReturnType<typeof open>> | undefined;
      if (this.file) {
        await mkdir(dirname(this.file), { recursive: true });
        for (let attempt = 0; !lock; attempt++) {
          try {
            lock = await open(this.file + ".lock", "wx");
          } catch (e: any) {
            // On Windows, another process removing the lock can briefly leave
            // a delete-pending handle. Exclusive open reports EPERM/EACCES,
            // not EEXIST. Retry briefly without treating it as a stale lock.
            if (
              process.platform === "win32" &&
              ["EPERM", "EACCES", "EBUSY"].includes(e.code) &&
              attempt < 100
            ) {
              await new Promise((r) => setTimeout(r, 10));
              continue;
            }
            if (e.code !== "EEXIST") throw e;
            const info = await stat(this.file + ".lock").catch(() => null);
            if (info && Date.now() - info.mtimeMs > 30000)
              await unlink(this.file + ".lock").catch(() => {});
            if (attempt > 3000) throw Error("Local store lock timeout");
            await new Promise((r) => setTimeout(r, 10));
          }
        }
      }
      try {
        if (this.file) await this.load();
        const draft = structuredClone(this.data);
        const result = await fn({
          get: async (c, id) => structuredClone(draft[c]?.[id] ?? null),
          set: (c, id, v) => {
            (draft[c] ||= {})[id] = structuredClone(v);
          },
          delete: (c, id) => {
            delete draft[c]?.[id];
          },
        });
        if (this.file) {
          await mkdir(dirname(this.file), { recursive: true });
          await writeFile(this.file + ".tmp", JSON.stringify(draft));
          for (let retry = 0; ; retry++) {
            try {
              await rename(this.file + ".tmp", this.file);
              break;
            } catch (e: any) {
              if (!["EPERM", "EACCES", "EBUSY"].includes(e.code) || retry >= 5)
                throw e;
              await new Promise((r) => setTimeout(r, 25 * (retry + 1)));
            }
          }
        }
        this.data = draft;
        return result;
      } finally {
        if (lock) {
          await lock.close();
          await unlink(this.file! + ".lock").catch(() => {});
        }
      }
    });
    this.tail = task.catch(() => {});
    return task;
  }
}
export class FirestoreStore implements Store {
  db = getFirestore(firebaseApp());
  async get<T = Doc>(c: string, id: string): Promise<T | null> {
    const d = await this.db.collection(c).doc(id).get();
    return d.exists ? (d.data() as T) : null;
  }
  async list<T = Doc>(
    c: string,
    where?: [string, unknown],
    and?: [string, unknown],
  ): Promise<T[]> {
    let q = where
      ? this.db.collection(c).where(where[0], "==", where[1])
      : this.db.collection(c);
    if (and) q = q.where(and[0], "==", and[1]);
    const rows: T[] = [];
    for await (const d of q.stream()) rows.push((d as any).data() as T);
    return rows;
  }
  async set(c: string, id: string, v: unknown) {
    await this.db
      .collection(c)
      .doc(id)
      .set(v as Doc);
  }
  async delete(c: string, id: string) {
    await this.db.collection(c).doc(id).delete();
  }
  transaction<T>(fn: (tx: Tx) => Promise<T>) {
    return this.db.runTransaction((t) => fn(this.wrap(t)));
  }
  private wrap(t: Transaction): Tx {
    return {
      get: async <T>(c: string, id: string) => {
        const d = await t.get(this.db.collection(c).doc(id));
        return d.exists ? (d.data() as T) : null;
      },
      set: (c, id, v) => {
        t.set(this.db.collection(c).doc(id), v as Doc);
      },
      delete: (c, id) => {
        t.delete(this.db.collection(c).doc(id));
      },
    };
  }
}
export async function makeStore(): Promise<Store> {
  return config.mode === "firebase"
    ? new FirestoreStore()
    : new MemoryStore(config.localPath + "/db.json").load();
}
