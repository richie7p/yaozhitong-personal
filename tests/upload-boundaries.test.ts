import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app";
import { Domain, hash } from "../server/domain";
import { MemoryStore } from "../server/store";
import { config, fail } from "../server/config";
import sharp from "sharp";
import { recognitionPhotoType } from "../src/photo-input";
import type { Blobs } from "../server/blobs";
import type { Identity } from "../shared/schema";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC",
  "base64",
);
const limits = { userLimit: config.userLimit, globalLimit: config.globalLimit };
afterEach(() => Object.assign(config, limits));

async function fixture(verified = true, eligible = true) {
  const store = new MemoryStore();
  // Memory-only photos and AI boundary. This suite never writes health data,
  // accesses cloud services, requests a camera, or calls a real model.
  const files = new Map<string, Buffer>();
  const blobs = {
    put: vi.fn(async (key: string, value: Buffer) => {
      files.set(key, Buffer.from(value));
      return key;
    }),
    get: vi.fn(async (key: string) => {
      const value = files.get(key);
      if (!value) throw new Error("Synthetic photo missing");
      return value;
    }),
    delete: vi.fn(async (key: string) => {
      files.delete(key);
    }),
  };
  const model = {
    json: vi.fn(async () => {
      throw new Error("Synthetic model failure");
    }),
  };
  const domain = new Domain(store, blobs as unknown as Blobs, () => model);
  const identity: Identity = {
    uid: "synthetic-upload-owner",
    email: "upload@example.test",
    name: "Synthetic upload",
    verified,
    admin: false,
  };
  const account = await domain.account(identity);
  await store.set("users", identity.uid, { ...account, eligible });
  const app = createApp(domain, async (token) => {
    if (!token) return fail("unauthenticated", "請先登入。", 401);
    return token === "synthetic-other"
      ? { ...identity, uid: "synthetic-upload-other" }
      : identity;
  });
  const submit = (
    bytes = png,
    mediaType = "image/png",
    key = "synthetic-upload-001",
    token = "synthetic-owner",
  ) =>
    app.request("/api/v1/recognitions", {
      method: "POST",
      headers: {
        ...(token ? { Authorization: "Bearer " + token } : {}),
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({ image: bytes.toString("base64"), mediaType }),
    });
  return { store, blobs, files, model, domain, app, submit, identity };
}

describe("photo upload API boundaries without devices or real AI", () => {
  it.each(["anonymous", "unverified", "disabled"])(
    "rejects an unfinished %s body before it can hold the photo slot",
    async (kind) => {
      const { app, submit, identity, store } = await fixture(
        kind !== "unverified",
      );
      if (kind === "disabled") {
        const account = (await store.get("users", identity.uid))!;
        await store.set("users", identity.uid, { ...account, disabled: true });
      }
      let pulls = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulls++ === 0)
            controller.enqueue(new TextEncoder().encode('{"image":"'));
        },
      });
      const response = await app.request("/api/v1/recognitions", {
        method: "POST",
        headers: {
          ...(kind === "anonymous"
            ? {}
            : { Authorization: "Bearer synthetic-owner" }),
          "Content-Type": "application/json",
          "Idempotency-Key": "unfinished-body-001",
        },
        body: stream,
        duplex: "half",
      } as RequestInit);
      expect(response.status).toBe(kind === "anonymous" ? 401 : 403);
      expect(pulls).toBeLessThanOrEqual(1);
      await store.set("users", identity.uid, {
        ...(await store.get("users", identity.uid))!,
        disabled: false,
      });
      const authorizedApp =
        kind === "unverified"
          ? createApp(
              new Domain(
                store,
                { put: async (key: string) => key } as unknown as Blobs,
                () => ({ json: vi.fn() }),
              ),
              async () => ({ ...identity, verified: true }),
            )
          : app;
      const valid =
        kind === "unverified"
          ? await authorizedApp.request("/api/v1/recognitions", {
              method: "POST",
              headers: {
                Authorization: "Bearer synthetic-owner",
                "Content-Type": "application/json",
                "Idempotency-Key": "valid-body-001",
              },
              body: JSON.stringify({
                image: png.toString("base64"),
                mediaType: "image/png",
              }),
            })
          : await submit();
      expect(valid.status).toBe(202);
    },
  );

  it("queues chunked photo bodies before buffering and preserves duplicate-request quota", async () => {
    const { app, submit, blobs, store, model } = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalPut = blobs.put.getMockImplementation()!;
    blobs.put.mockImplementation(async (key, value) => {
      entered();
      await blocked;
      return originalPut(key, value);
    });
    const first = submit();
    await started;
    const json = JSON.stringify({
      image: png.toString("base64"),
      mediaType: "image/png",
    });
    const chunks = [json.slice(0, 20), json.slice(20, 40), json.slice(40)];
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[pulls++];
        if (chunk === undefined) controller.close();
        else controller.enqueue(new TextEncoder().encode(chunk));
      },
    });
    let secondFinished = false;
    const second = Promise.resolve(
      app.request("/api/v1/recognitions", {
        method: "POST",
        headers: {
          Authorization: "Bearer synthetic-owner",
          "Content-Type": "application/json",
          "Idempotency-Key": "synthetic-upload-001",
        },
        body: stream,
        duplex: "half",
      } as RequestInit),
    ).then((response) => {
      secondFinished = true;
      return response;
    });
    // A stream can prefetch one chunk itself, but middleware must not drain it
    // while an earlier upload owns the bounded photo admission slot.
    await new Promise((resolve) => setImmediate(resolve));
    expect(pulls).toBeLessThanOrEqual(1);
    expect(secondFinished).toBe(false);
    release();
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    const bodies = await Promise.all(
      responses.map((response) => response.json()),
    );
    expect(bodies[0].jobId).toBe(bodies[1].jobId);
    expect(blobs.put).toHaveBeenCalledOnce();
    expect(await store.list("jobs")).toHaveLength(1);
    expect((await store.list("usage")).map((usage) => usage.count)).toEqual([
      1, 1,
    ]);
    expect(model.json).not.toHaveBeenCalled();
  });

  it("accepts original PNG bytes and hides the private input from job responses", async () => {
    const { submit, files, store, app } = await fixture();
    const response = await submit();
    expect(response.status).toBe(202);
    const { jobId } = await response.json();
    const job = await store.get("jobs", jobId);
    expect(job?.input.imagePath).toMatch(/^uploads\/synthetic-upload-owner\//);
    expect(files.get(job!.input.imagePath)).toEqual(png);
    const own = await app.request("/api/v1/jobs/" + jobId, {
      headers: { Authorization: "Bearer synthetic-owner" },
    });
    expect(own.status).toBe(200);
    expect(await own.json()).not.toHaveProperty("input");
    const other = await app.request("/api/v1/jobs/" + jobId, {
      headers: { Authorization: "Bearer synthetic-other" },
    });
    expect(other.status).toBe(404);
  });

  it.each([
    ["empty", Buffer.alloc(0), "image/png"],
    ["renamed executable", Buffer.from("MZsynthetic"), "image/png"],
    [
      "SVG",
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      "image/png",
    ],
    ["HEIC", Buffer.from("0000ftypheic"), "image/heic"],
    ["mismatched PNG", png, "image/jpeg"],
    ["PNG signature only", png.subarray(0, 8), "image/png"],
    ["PNG with truncated pixels", png.subarray(0, 55), "image/png"],
    ["JPEG signature only", Buffer.from([255, 216, 255]), "image/jpeg"],
  ])(
    "rejects %s without writing a photo or charging quota",
    async (_label, bytes, type) => {
      const { submit, blobs, store } = await fixture();
      expect((await submit(bytes, type)).status).toBe(400);
      expect(blobs.put).not.toHaveBeenCalled();
      expect(await store.list("jobs")).toEqual([]);
      expect(await store.list("usage")).toEqual([]);
    },
  );

  it("rejects a decoded photo larger than 8 MB before writing storage", async () => {
    const { submit, blobs, store } = await fixture();
    const tooLarge = Buffer.alloc(8_000_001);
    png.copy(tooLarge);
    const response = await submit(tooLarge);
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("invalid_image");
    expect(blobs.put).not.toHaveBeenCalled();
    expect(await store.list("usage")).toEqual([]);
  });

  it.each([1, 4, 8, 12])(
    "rejects PNG with its last %s IEND bytes missing even when all pixels decode",
    async (missing) => {
      const { submit, blobs, model, store } = await fixture();
      const incomplete = png.subarray(0, png.length - missing);
      await expect(
        sharp(incomplete, { failOn: "warning" }).raw().toBuffer(),
      ).resolves.toBeInstanceOf(Buffer);
      const response = await submit(incomplete);
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe("invalid_image");
      expect(blobs.put).not.toHaveBeenCalled();
      expect(model.json).not.toHaveBeenCalled();
      expect(await store.list("jobs")).toEqual([]);
      expect(await store.list("usage")).toEqual([]);
    },
  );

  it.each([
    "oversized chunk",
    "IEND inside a chunk",
    "nonempty IEND",
    "bad IEND CRC",
    "non-ASCII IEND type",
    "trailing chunk",
  ])(
    "rejects PNG with %s rather than trusting an IEND suffix",
    async (problem) => {
      const { submit, blobs } = await fixture();
      let malformed = Buffer.from(png);
      const end = malformed.length - 12;
      if (problem === "oversized chunk") malformed.writeUInt32BE(0xffffffff, 8);
      if (problem === "IEND inside a chunk")
        malformed.writeUInt32BE(24, end - 24);
      if (problem === "nonempty IEND") malformed.writeUInt32BE(1, end);
      if (problem === "bad IEND CRC") malformed[end + 8] ^= 1;
      if (problem === "non-ASCII IEND type") malformed[end + 4] |= 0x80;
      if (problem === "trailing chunk")
        malformed = Buffer.concat([malformed, malformed.subarray(end)]);
      const response = await submit(malformed);
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe("invalid_image");
      expect(blobs.put).not.toHaveBeenCalled();
    },
  );

  it("blocks unauthenticated uploads before writing storage", async () => {
    const { submit, blobs } = await fixture();
    expect(
      (await submit(png, "image/png", "synthetic-upload-001", "")).status,
    ).toBe(401);
    expect(blobs.put).not.toHaveBeenCalled();
  });

  it("rejects an invalid operation key before writing storage", async () => {
    const { submit, blobs } = await fixture();
    const response = await submit(png, "image/png", "short");
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("invalid_request");
    expect(blobs.put).not.toHaveBeenCalled();
  });

  it.each(["userLimit", "globalLimit"] as const)(
    "rejects new uploads at %s without blob writes while allowing an existing completed job to resume",
    async (limit) => {
      const { submit, files, store, blobs, domain } = await fixture();
      config[limit] = 1;
      const first = await submit();
      const { jobId } = await first.json();
      domain.catalog.all = async () => [];
      await domain.processJob(jobId);
      blobs.put.mockClear();
      const denied = await submit(png, "image/png", "synthetic-new-operation");
      expect(denied.status).toBe(429);
      expect((await denied.json()).code).toBe("quota_exceeded");
      expect(blobs.put).not.toHaveBeenCalled();
      const repeated = await submit();
      expect(repeated.status).toBe(202);
      expect(await repeated.json()).toEqual({ jobId, status: "failed" });
      expect(blobs.put).not.toHaveBeenCalled();
      expect(files.size).toBe(0);
      expect(await store.list("jobs")).toHaveLength(1);
      expect((await store.list("usage")).map((r) => r.count)).toEqual([1, 1]);
    },
  );

  it.each([
    [4000, 3000],
    [5712, 4284],
  ])(
    "fully decodes a normal %sx%s phone JPEG while retaining original bytes",
    async (width, height) => {
      const { submit, files } = await fixture();
      const jpeg = await sharp({
        create: { width, height, channels: 3, background: "white" },
      })
        .jpeg()
        .toBuffer();
      const response = await submit(jpeg, "image/jpeg");
      expect(response.status).toBe(202);
      expect([...files.values()]).toEqual([jpeg]);
    },
  );

  it("rejects a JPEG whose pixel stream is truncated even though its header is readable", async () => {
    const { submit, blobs, store } = await fixture();
    const original = await sharp({
      create: { width: 32, height: 32, channels: 3, background: "white" },
    })
      .jpeg()
      .toBuffer();
    const truncated = original.subarray(0, original.length - 3);
    expect((await sharp(truncated).metadata()).format).toBe("jpeg");
    const response = await submit(truncated, "image/jpeg");
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("invalid_image");
    expect(blobs.put).not.toHaveBeenCalled();
    expect(await store.list("jobs")).toEqual([]);
  });

  it("rejects an otherwise valid photo over 32 MP before blob storage", async () => {
    const { submit, blobs } = await fixture();
    const huge = await sharp({
      create: { width: 8000, height: 4001, channels: 3, background: "white" },
    })
      .jpeg()
      .toBuffer();
    const response = await submit(huge, "image/jpeg");
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("invalid_image");
    expect(blobs.put).not.toHaveBeenCalled();
  });

  it("rechecks eligibility after storage and removes the photo if access changed", async () => {
    const { submit, blobs, files, store, identity } = await fixture();
    const put = blobs.put.getMockImplementation()!;
    blobs.put.mockImplementationOnce(async (key, bytes) => {
      const result = await put(key, bytes);
      const account = await store.get("users", identity.uid);
      await store.set("users", identity.uid, { ...account, eligible: false });
      return result;
    });
    const response = await submit();
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("not_eligible");
    expect(files.size).toBe(0);
    expect(await store.list("jobs")).toEqual([]);
    expect(await store.list("usage")).toEqual([]);
  });

  it.each([
    [false, true, "email_unverified"],
    [true, false, "not_eligible"],
  ])(
    "blocks verified=%s eligible=%s without retaining photos or jobs",
    async (verified, eligible, code) => {
      const { submit, files, store, model, blobs } = await fixture(
        verified,
        eligible,
      );
      const response = await submit();
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe(code);
      expect(files.size).toBe(0);
      expect(blobs.put).not.toHaveBeenCalled();
      expect(await store.list("jobs")).toEqual([]);
      expect(await store.list("usage")).toEqual([]);
      expect(model.json).not.toHaveBeenCalled();
    },
  );

  it.each(["userLimit", "globalLimit"] as const)(
    "enforces %s under concurrent uploads and releases rejected photos",
    async (limit) => {
      const { submit, files, store } = await fixture();
      config[limit] = 1;
      const responses = await Promise.all([
        submit(png, "image/png", "synthetic-upload-first"),
        submit(png, "image/png", "synthetic-upload-second"),
      ]);
      expect(responses.map((r) => r.status).sort()).toEqual([202, 429]);
      expect(await store.list("jobs")).toHaveLength(1);
      expect((await store.list("usage")).map((r) => r.count)).toEqual([1, 1]);
      expect(files.size).toBe(1);
    },
  );

  it("deletes an uploaded photo on recognition failure and makes the failure safe to read", async () => {
    const { submit, files, domain, store, app, model } = await fixture();
    domain.catalog.all = async () => [];
    const response = await submit();
    const { jobId } = await response.json();
    await domain.processJob(jobId);
    expect(model.json).toHaveBeenCalled();
    const job = await store.get("jobs", jobId);
    expect(job?.status).toBe("failed");
    expect(job?.input).toEqual({});
    expect(files.size).toBe(0);
    const publicResponse = await app.request("/api/v1/jobs/" + jobId, {
      headers: { Authorization: "Bearer synthetic-owner" },
    });
    expect(JSON.stringify(await publicResponse.json())).not.toContain(
      "Synthetic model failure",
    );
  });

  it("account cleanup removes a queued original photo and its usage records", async () => {
    const { submit, files, domain, store, identity } = await fixture();
    await submit();
    expect(files.size).toBe(1);
    await domain.deleteAccount(identity.uid);
    await domain.processJob("delete-" + hash(identity.uid));
    expect(files.size).toBe(0);
    expect(await store.list("jobs")).toEqual([]);
    expect(await store.list("usage", ["ownerId", identity.uid])).toEqual([]);
    await expect(domain.active(identity.uid)).rejects.toMatchObject({
      code: "account_disabled",
    });
  });
});

describe("photo selection without camera access", () => {
  it("recognizes PNG by bytes when the picker supplies no MIME metadata", async () => {
    await expect(recognitionPhotoType(new Blob([png]))).resolves.toBe(
      "image/png",
    );
  });
  it("rejects a renamed executable before any API call", async () => {
    await expect(
      recognitionPhotoType(new Blob(["MZsynthetic"], { type: "image/png" })),
    ).rejects.toThrow("請選擇 JPEG 或 PNG");
  });
});
