import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { config, fail } from "../server/config";
import { Domain, hash } from "../server/domain";
import { MemoryStore, type Doc, type Tx } from "../server/store";
import type { Identity } from "../shared/schema";

const previousMode = config.mode;
afterEach(() => {
  config.mode = previousMode;
});
const token = "synthetic-not-a-real-device-token";
async function fixture() {
  config.mode = "local";
  const store = new MemoryStore(),
    domain = new Domain(store);
  const identities: Record<string, Identity> = {};
  for (const uid of ["owner", "other"]) {
    identities[uid] = {
      uid,
      name: uid,
      email: uid + "@example.test",
      verified: true,
      admin: false,
    };
    await domain.account(identities[uid]);
  }
  const app = createApp(
    domain,
    async (who) =>
      identities[who] || fail("unauthenticated", "請先登入。", 401),
  );
  const request = (who: string, method = "POST") =>
    app.request(
      "/api/v1/devices" + (method === "DELETE" ? "/" + hash(token) : ""),
      {
        method,
        headers: {
          Authorization: "Bearer " + who,
          "Content-Type": "application/json",
        },
        body: method === "POST" ? JSON.stringify({ token }) : undefined,
      },
    );
  return { store, domain, request };
}

/** Pause before the transaction actually starts, after HTTP authentication.
 * Other requests can complete; the resumed write must recheck current state. */
function pauseNextTransaction(store: MemoryStore) {
  const original = store.transaction.bind(store);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  let first = true;
  store.transaction = async <T>(fn: (tx: Tx) => Promise<T>) => {
    if (first) {
      first = false;
      entered();
      await blocked;
    }
    return original(fn);
  };
  return { started, release };
}

describe("device lifecycle and account ownership", () => {
  it("does not recreate a token when registration overlaps completed account deletion", async () => {
    const { store, domain, request } = await fixture();
    const gate = pauseNextTransaction(store);
    const pending = request("owner");
    await gate.started;
    await domain.deleteAccount("owner");
    await domain.cleanupUser("owner");
    expect(await store.list("devices")).toEqual([]);
    gate.release();
    expect((await pending).status).toBe(403);
    expect(await store.list("devices")).toEqual([]);
    expect(await store.get("users", "owner")).toHaveProperty("deletedAt");
  });

  it("does not let a stale logout remove a token transferred to a new account", async () => {
    const { store, request } = await fixture();
    expect((await request("owner")).status).toBe(200);
    const gate = pauseNextTransaction(store);
    const pending = request("owner", "DELETE");
    await gate.started;
    expect((await request("other")).status).toBe(200);
    gate.release();
    expect((await pending).status).toBe(404);
    expect(await store.get("devices", hash(token))).toMatchObject({
      ownerId: "other",
      token,
    });
  });

  it("checks disabled state again inside a registration and leaves no token behind", async () => {
    const { store, request } = await fixture();
    const gate = pauseNextTransaction(store);
    const pending = request("owner");
    await gate.started;
    await store.set("users", "owner", {
      ...(await store.get("users", "owner")),
      disabled: true,
    });
    gate.release();
    expect((await pending).status).toBe(403);
    expect(await store.list("devices")).toEqual([]);
  });

  it("preserves a token transferred after account cleanup listed the old owner's devices", async () => {
    const { store, domain, request } = await fixture();
    expect((await request("owner")).status).toBe(200);
    await domain.deleteAccount("owner");
    const original = store.list.bind(store);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    store.list = async <T = Doc>(
      collection: string,
      where?: [string, unknown],
      and?: [string, unknown],
    ) => {
      const rows = await original<T>(collection, where, and);
      if (first && collection === "devices") {
        first = false;
        entered();
        await blocked;
      }
      return rows;
    };
    const cleanup = domain.cleanupUser("owner");
    await started;
    expect((await request("other")).status).toBe(200);
    release();
    await cleanup;
    expect(await store.get("devices", hash(token))).toMatchObject({
      ownerId: "other",
      token,
    });
  });

  it("allows owner deletion and rejects unauthenticated or cross-owner deletion", async () => {
    const { store, request } = await fixture();
    expect((await request("unknown")).status).toBe(401);
    expect((await request("owner")).status).toBe(200);
    expect((await request("other", "DELETE")).status).toBe(404);
    expect((await request("owner", "DELETE")).status).toBe(200);
    expect(await store.list("devices")).toEqual([]);
  });
});
