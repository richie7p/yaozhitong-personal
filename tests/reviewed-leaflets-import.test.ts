import { describe, expect, it } from "vitest";
import { MemoryStore } from "../server/store";
import type { Leaflet } from "../shared/schema";
import {
  applyReviewedSource,
  rollbackReviewedSource,
  sourceHash,
  validateReviewedDraft,
  inspectPublication,
} from "../tools/reviewed-leaflets-core";

const run = {
  runId: "synthetic-import",
  manifestSha256: "a".repeat(64),
  actor: "source-literal-verification",
};
function draft(text = "完整合成原文與全部必要條件。", html = false): Leaflet {
  const licenseNo = "SYNTHETIC-LICENSE",
    sha256 = sourceHash("synthetic raw source"),
    id = sourceHash(licenseNo + "|" + sha256),
    version = sha256.slice(0, 16);
  return {
    id,
    licenseNo,
    version,
    sourceUrl: "https://mcp.fda.gov.tw/synthetic",
    sha256,
    storagePath: `leaflets/${id}.${html ? "html" : "pdf"}`,
    chunks: [
      {
        id: `${id.slice(0, 16)}-1-0-whole-page-v1-${sourceHash(text).slice(0, 16)}`,
        licenseNo,
        version,
        page: 1,
        start: 0,
        text,
        ...(html ? { sourceFormat: "html" as const } : {}),
      },
    ],
    status: "draft",
    checkedBy: null,
    checkedAt: null,
    ...(html ? { sourceMediaType: "text/html" as const } : {}),
  };
}
const operation = (d = draft()) => ({
  draft: d,
  before: { leaflet: null, pointer: null },
});

describe("source-only reviewed leaflet import", () => {
  it("atomically publishes only the source, pointer and explicit literal audits", async () => {
    const store = new MemoryStore();
    store.data.users = { real: { untouched: true } };
    store.data.learning = { real: { untouched: true } };
    const op = operation(draft(undefined, true));
    expect(await applyReviewedSource(store, op, run)).toBe("published");
    expect(store.data.published[sourceHash(op.draft.licenseNo)].leafletId).toBe(
      op.draft.id,
    );
    expect(store.data.leaflets[op.draft.id]).toMatchObject({
      status: "published",
      sourceMediaType: "text/html",
      checkedBy: run.actor,
    });
    expect(
      Object.values(store.data.audit)
        .map((x) => x.action)
        .sort(),
    ).toEqual([
      "leaflet.publish",
      "leaflet.source_verification.literal_not_clinical",
    ]);
    expect(store.data.users).toEqual({ real: { untouched: true } });
    expect(store.data.learning).toEqual({ real: { untouched: true } });
    expect(Object.keys(store.data).sort()).toEqual([
      "audit",
      "leaflets",
      "learning",
      "published",
      "users",
    ]);
  });
  it("preserves an existing identical publication and its reviewer as a true no-op", async () => {
    const store = new MemoryStore(),
      op = operation();
    await applyReviewedSource(store, op, run);
    const before = structuredClone(store.data);
    expect(
      await applyReviewedSource(store, op, {
        ...run,
        runId: "other-run",
        actor: "other-reviewer",
      }),
    ).toBe("same_source_no_op");
    expect(store.data).toEqual(before);
    expect(await applyReviewedSource(store, op, run)).toBe(
      "recovered_own_publication",
    );
  });
  it("refuses a different current source without retiring or overwriting it", async () => {
    const store = new MemoryStore(),
      op = operation();
    store.data.published = {
      [sourceHash(op.draft.licenseNo)]: {
        leafletId: "different",
        version: "different",
      },
    };
    const before = structuredClone(store.data);
    await expect(applyReviewedSource(store, op, run)).rejects.toThrow(
      "different_source_already_published",
    );
    expect(store.data).toEqual(before);
  });
  it("CAS rejects draft changes after inspection", async () => {
    const store = new MemoryStore(),
      op = operation();
    store.data.leaflets = { [op.draft.id]: { ...op.draft } };
    await expect(applyReviewedSource(store, op, run)).rejects.toThrow(
      "publication_changed_since_inspection",
    );
  });
  it("serializes competing publishers into one publication and one no-op", async () => {
    const store = new MemoryStore(),
      op = operation();
    const results = await Promise.all([
      applyReviewedSource(store, op, run),
      applyReviewedSource(store, op, { ...run, runId: "competing-run" }),
    ]);
    expect(results).toEqual(["published", "same_source_no_op"]);
    expect(Object.keys(store.data.audit)).toHaveLength(2);
  });
  it("rolls back only its pointer, keeps new source retired and remains idempotent", async () => {
    const store = new MemoryStore(),
      op = operation();
    store.data.users = { real: { untouched: true } };
    await applyReviewedSource(store, op, run);
    expect(await rollbackReviewedSource(store, op, run)).toBe("rolled_back");
    expect(
      await store.get("published", sourceHash(op.draft.licenseNo)),
    ).toBeNull();
    expect(store.data.leaflets[op.draft.id].status).toBe("retired");
    expect(store.data.users.real).toEqual({ untouched: true });
    expect(await rollbackReviewedSource(store, op, run)).toBe(
      "already_rolled_back",
    );
  });
  it("restores the exact preexisting draft and leaves prior audits intact", async () => {
    const store = new MemoryStore(),
      d = draft();
    const existing = {
      ...d,
      privateReviewNote: "original cloud draft metadata",
    };
    store.data.leaflets = { [d.id]: existing };
    const op = {
      draft: d,
      before: { leaflet: structuredClone(existing), pointer: null },
    };
    await applyReviewedSource(store, op, run);
    await rollbackReviewedSource(store, op, run);
    expect(store.data.leaflets[d.id]).toEqual(existing);
    expect(Object.keys(store.data.audit)).toHaveLength(3);
  });
  it("rollback refuses another writer's marker or changed source", async () => {
    for (const mutate of [
      (store: MemoryStore, op: ReturnType<typeof operation>) => {
        store.data.published[
          sourceHash(op.draft.licenseNo)
        ].sourceImport.runId = "other-writer";
      },
      (store: MemoryStore, op: ReturnType<typeof operation>) => {
        store.data.leaflets[op.draft.id].chunks[0].text += " changed";
      },
      (store: MemoryStore, op: ReturnType<typeof operation>) => {
        store.data.leaflets[op.draft.id].checkedAt = "different-review-time";
      },
    ]) {
      const store = new MemoryStore(),
        op = operation();
      await applyReviewedSource(store, op, run);
      mutate(store, op);
      const before = structuredClone(store.data);
      await expect(rollbackReviewedSource(store, op, run)).rejects.toThrow(
        /rollback_/,
      );
      expect(store.data).toEqual(before);
    }
  });
  it("never withdraws a publication that already existed during inspection", async () => {
    const store = new MemoryStore(),
      d = draft();
    await applyReviewedSource(store, operation(d), run);
    const op = {
      draft: d,
      before: {
        leaflet: await store.get("leaflets", d.id),
        pointer: await store.get("published", sourceHash(d.licenseNo)),
      },
    };
    const before = structuredClone(store.data);
    expect(
      await rollbackReviewedSource(store, op, { ...run, runId: "later-run" }),
    ).toBe("unchanged_no_op");
    expect(store.data).toEqual(before);
  });
  it("rejects imported account fields, fake local review identity, split chunks and source tampering", () => {
    expect(() =>
      validateReviewedDraft({ ...draft(), users: {} } as Leaflet),
    ).toThrow("non_source_draft_field");
    expect(() =>
      validateReviewedDraft({ ...draft(), checkedBy: "local-admin" }),
    ).toThrow("local_review_identity");
    const split = draft();
    split.chunks.push({ ...split.chunks[0], start: 1000 });
    expect(() => validateReviewedDraft(split)).toThrow();
    const changed = draft();
    changed.chunks[0].text += " changed";
    expect(() => validateReviewedDraft(changed)).toThrow(
      "canonical_source_chunk",
    );
    expect(() =>
      inspectPublication(draft(), {
        leaflet: { ...draft(), status: "published" },
        pointer: null,
      }),
    ).toThrow("published_pointer_missing");
  });
});
