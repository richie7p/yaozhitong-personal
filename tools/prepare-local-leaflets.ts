import { readFile } from "node:fs/promises";
import { config } from "../server/config.js";
import { makeStore } from "../server/store.js";
import { Domain, hash } from "../server/domain.js";
import { localPeople } from "../server/auth.js";
if (config.mode !== "local")
  throw Error("These source reviews are for local software testing only.");
const review = JSON.parse(
  await readFile("data/leaflets/local-reviewed.json", "utf8"),
);
const d = new Domain(await makeStore());
await d.account(localPeople.find((p) => p.admin)!);
for (const item of review.items) {
  const l = (await d.store.list("leaflets")).find(
    (l) => l.licenseNo === item.licenseNo && l.sha256 === item.sha256,
  );
  if (!l || l.version !== item.version)
    throw Error(
      "Reviewed source version is missing or changed: " + item.licenseNo,
    );
  if (hash(await d.blobs.get(l.storagePath)) !== item.sha256)
    throw Error("Source PDF hash changed");
  if (l.status !== "published") {
    await d.store.set("leaflets", l.id, {
      ...l,
      sourceReview: {
        reviewer: review.reviewer,
        scope: review.scope,
        reviewedAt: review.reviewedAt,
      },
    });
    await d.publish("local-admin", l.id);
    await d.audit("local-admin", "leaflet.local-agent-source-review", l.id);
  }
  console.log(
    JSON.stringify({
      licenseNo: l.licenseNo,
      status: "published-for-local-testing",
      reviewScope: review.scope,
    }),
  );
}
