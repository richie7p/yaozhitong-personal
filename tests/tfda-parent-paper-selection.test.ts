import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertParentLicenseSelectionUnchanged, main, parseParentLicenseSelection, readParentLicenseSelection } from "../tools/prepare-tfda-parent-papers";
import { publicationHash } from "../tools/tfda-publication-core";

// Synthetic selection identifiers only. No source extraction, network, cloud or AI.
const license = "衛部藥製字第999976號", otherPrefix = "衛署藥製字第999976號";
const folders: string[] = [];
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

describe("explicit immutable current-paper license selection", () => {
  it("preserves complete prefixes, R codes and literal order in a frozen selection", () => {
    const input = [license, otherPrefix, "衛署菌疫輸字第R00091號"], parsed = parseParentLicenseSelection(bytes(input));
    expect(parsed).toEqual(input); expect(Object.isFrozen(parsed)).toBe(true);
    expect(() => (parsed as string[]).push("衛部藥製字第999977號")).toThrow();
  });
  it.each([["null", null], ["object", {}], ["empty", []], ["duplicate", [license, license]], ["suffix only", ["999976"]],
    ["whitespace", ["衛部藥製字第999976號 "]], ["non-string", [1]],
    ["over limit", Array.from({ length: 5001 }, (_, i) => `衛部藥製字第${1000000 + i}號`)]])(
    "rejects a malformed, empty, duplicate or excessive selection: %s", (_label, value) => {
      expect(() => parseParentLicenseSelection(bytes(value))).toThrow();
    });
  it("rejects invalid JSON and bounds the original byte payload", () => {
    expect(() => parseParentLicenseSelection(Buffer.from("[broken"))).toThrow("parent_license_list_invalid_json");
    expect(() => parseParentLicenseSelection(Buffer.alloc(2_000_001))).toThrow("parent_license_list_exceeds_2000000_bytes");
  });
  it("pins actual source bytes and rejects even a same-value reserialization after loading", async () => {
    const folder = await mkdtemp(join(tmpdir(), "synthetic-tfda-selection-")); folders.push(folder);
    const path = join(folder, "selection.json"), original = Buffer.from("\uFEFF" + JSON.stringify([license], null, 2) + "\n");
    await writeFile(path, original); const selection = await readParentLicenseSelection(path);
    expect(selection.sha256).toBe(publicationHash(original)); expect(selection.path).toBe(path);
    expect(Object.isFrozen(selection)).toBe(true); await assertParentLicenseSelectionUnchanged(selection);
    await writeFile(path, bytes([license]));
    await expect(assertParentLicenseSelectionUnchanged(selection)).rejects.toThrow("parent_license_list_changed_during_evaluation");
    expect(selection.licenses).toEqual([license]); expect(await readFile(path)).toEqual(bytes([license]));
  });
  it("rejects mutually exclusive selection flags and invalid evaluation limits before reading sources or creating outputs", async () => {
    const folder = await mkdtemp(join(tmpdir(), "synthetic-tfda-selection-cli-")); folders.push(folder);
    const args = ["--inventory", join(folder, "inventory"), "--corpus", join(folder, "corpus"), "--archive", join(folder, "archive"),
      "--output", join(folder, "output"), "--protected", join(folder, "protected.json")];
    await expect(main([...args, "--license", license, "--license-list", join(folder, "missing.json")]))
      .rejects.toThrow("parent_prepare_license_and_list_mutually_exclusive");
    await expect(main([...args, "--limit", "5001"])).rejects.toThrow("parent_prepare_limit_must_be_1_to_5000");
    expect(await readdir(folder)).toEqual([]);
  });
});
