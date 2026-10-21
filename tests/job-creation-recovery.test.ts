import { describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app";
import { Domain } from "../server/domain";
import { MemoryStore } from "../server/store";
import type { Blobs } from "../server/blobs";
import type { Identity } from "../shared/schema";

const identity: Identity = {
  uid: "synthetic-recovery-owner",
  email: "synthetic@example.test",
  name: "Synthetic recovery test",
  verified: true,
  admin: false,
};
const image =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC";

function fixture() {
  const store = new MemoryStore();
  // A memory-only blob boundary: these tests never write photos or call an AI service.
  const blobs = {
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const domain = new Domain(store, blobs as unknown as Blobs, () => ({
    json: async () => ({}),
  }));
  domain.enqueue = vi.fn().mockResolvedValue(undefined);
  const app = createApp(domain, async () => identity);
  const submit = (key = "synthetic-operation-001", bodyImage = image) =>
    app.request("http://test/api/v1/recognitions", {
      method: "POST",
      headers: {
        Authorization: "Bearer synthetic-owner",
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({ image: bodyImage, mediaType: "image/png" }),
    });
  return { store, blobs, domain, submit };
}

describe("AI creation recovery through the real API and quota transaction", () => {
  it("returns the same recognition after a lost response without another quota charge or retained upload", async () => {
    const { submit, store, blobs } = fixture();
    const first = await submit();
    expect(first.status).toBe(202);
    const { jobId } = await first.json();
    const original = await store.get("jobs", jobId);
    // The client did not receive the first response, then replays the same operation.
    const replay = await submit();
    expect(replay.status).toBe(202);
    expect((await replay.json()).jobId).toBe(jobId);
    expect(await store.list("jobs")).toHaveLength(1);
    expect((await store.list("usage")).map((row) => row.count)).toEqual([1, 1]);
    expect(blobs.put).toHaveBeenCalledOnce();
    expect(blobs.delete).not.toHaveBeenCalled();
    expect((await store.get("jobs", jobId))?.input.imagePath).toBe(
      original!.input.imagePath,
    );
  });

  it("recovers a queue failure after commit using the original job and image", async () => {
    const { submit, store, blobs, domain } = fixture();
    vi.mocked(domain.enqueue!).mockRejectedValueOnce(
      new Error("Synthetic queue unavailable"),
    );
    const first = await submit();
    expect(first.status).toBe(503);
    expect((await first.json()).code).toBe("queue_unavailable");
    const [original] = await store.list("jobs");
    expect(original.status).toBe("queued");
    expect(blobs.delete).not.toHaveBeenCalled();

    const replay = await submit();
    expect(replay.status).toBe(202);
    expect((await replay.json()).jobId).toBe(original.id);
    expect(await store.list("jobs")).toHaveLength(1);
    expect((await store.list("usage")).map((row) => row.count)).toEqual([1, 1]);
    expect(blobs.put).toHaveBeenCalledOnce();
    expect(blobs.delete).not.toHaveBeenCalled();
    expect(domain.enqueue).toHaveBeenNthCalledWith(2, original.id);
  });

  it("rejects a changed photo under the same key without replacing the original job or charging again", async () => {
    const { submit, store, blobs } = fixture();
    const originalResponse = await submit();
    const { jobId } = await originalResponse.json();
    const original = await store.get("jobs", jobId);
    const changed =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgYGAAAAAEAAGjChXjAAAAAElFTkSuQmCC";
    const conflict = await submit("synthetic-operation-001", changed);
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe("idempotency_conflict");
    expect(await store.list("jobs")).toHaveLength(1);
    expect((await store.list("usage")).map((row) => row.count)).toEqual([1, 1]);
    expect(await store.get("jobs", jobId)).toEqual(original);
    expect(blobs.put).toHaveBeenCalledOnce();
    expect(blobs.delete).not.toHaveBeenCalled();
  });
});
