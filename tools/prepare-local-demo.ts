/** Restore only the two fixed, previously transcribed official sources for local testing. */
import { readFile } from "node:fs/promises";
import { config } from "../server/config.js";
import { makeStore } from "../server/store.js";
import { Domain, hash } from "../server/domain.js";
import { extractLeaflet } from "../server/leaflets.js";
import { refreshCatalog } from "../server/import-catalog.js";
import { localPeople } from "../server/auth.js";
import type { Leaflet } from "../shared/schema.js";

if (config.mode !== "local")
  throw Error("This preparation is restricted to local software testing.");
const review = JSON.parse(
  await readFile("data/leaflets/local-reviewed.json", "utf8"),
);
const manifest = JSON.parse(
  await readFile("data/leaflets/collection-manifest.json", "utf8"),
);
const d = new Domain(await makeStore());
if (!(await d.store.get("settings", "catalog"))) {
  console.log("Downloading the official drug index…");
  await refreshCatalog(d.store, d.blobs);
  d.catalog.invalidate();
}
await d.account(localPeople.find((p) => p.admin)!);
for (const item of review.items) {
  let leaflet = (await d.store.list<Leaflet>("leaflets")).find(
    (l) =>
      l.licenseNo === item.licenseNo &&
      l.sha256 === item.sha256 &&
      l.version === item.version,
  );
  if (!leaflet) {
    const entry = manifest.items.find(
      (m: any) => m.licenseNo === item.licenseNo,
    );
    if (!entry?.sourceUrl)
      throw Error("Missing fixed official source: " + item.licenseNo);
    const source = new URL(entry.sourceUrl);
    if (
      source.protocol !== "https:" ||
      !(
        source.hostname === "fda.gov.tw" ||
        source.hostname.endsWith(".fda.gov.tw")
      )
    )
      throw Error("The source must be an official HTTPS URL.");
    const response = await fetch(source, {
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw Error("Official PDF download failed: " + item.licenseNo);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes) !== item.sha256)
      throw Error(
        "Source changed; a new transcription review is needed: " +
          item.licenseNo,
      );
    leaflet = await extractLeaflet(bytes, item.licenseNo, entry.sourceUrl);
    if (
      leaflet.version !== item.version ||
      Math.max(...leaflet.chunks.map((c) => c.page)) !== item.pages ||
      leaflet.chunks.some((c) => c.text.includes("\uFFFD"))
    )
      throw Error(
        "Source extraction does not match the reviewed version: " +
          item.licenseNo,
      );
    await d.blobs.put(leaflet.storagePath, bytes, "application/pdf");
    await d.store.set("leaflets", leaflet.id, leaflet);
  }
  if (hash(await d.blobs.get(leaflet.storagePath)) !== item.sha256)
    throw Error("Stored PDF hash differs from its reviewed source.");
  if (leaflet.status !== "published") {
    await d.store.set("leaflets", leaflet.id, {
      ...leaflet,
      sourceReview: {
        reviewer: review.reviewer,
        scope: review.scope,
        reviewedAt: review.reviewedAt,
      },
    });
    await d.publish("local-admin", leaflet.id);
    await d.audit(
      "local-admin",
      "leaflet.local-agent-source-review",
      leaflet.id,
    );
  }
  console.log(
    JSON.stringify({
      licenseNo: item.licenseNo,
      status: "published-for-local-testing",
      scope: review.scope,
    }),
  );
}
