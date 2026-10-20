/** Append verified acceptance cases to a new, inactive demonstration copy. */
import { cp, readFile, writeFile, access } from "node:fs/promises";
import { resolve, relative, isAbsolute, join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { GROUNDING_VERSION } from "../server/ai.js";
import { Domain } from "../server/domain.js";
import { MemoryStore } from "../server/store.js";
import { equivalentSourceLayoutAudit } from "./source-equivalence.js";

const digest = (value: any) =>
  createHash("sha256")
    .update(Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest("hex");
const read = async (path: string) =>
  JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
const local = resolve(".local");
function inside(path: string) {
  const absolute = resolve(path),
    rel = relative(local, absolute);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw Error("Use isolated local acceptance paths.");
  return absolute;
}
const [targetArg, fixtureArg, ...caseArgs] = process.argv.slice(2);
if (!targetArg || !fixtureArg || !caseArgs.length)
  throw Error(
    "Usage: target-demo fixture-directory passed-case-directory [...]",
  );
const target = inside(targetArg),
  fixturePath = inside(fixtureArg);
if (!/^seminar-demo-[\w-]+$/.test(relative(local, target)))
  throw Error("Use a new demonstration copy.");
const marker = await read(".local/launcher/server-8085.json").catch(
  () => undefined,
);
if (
  marker?.dataPath &&
  resolve(marker.dataPath).toLowerCase() === target.toLowerCase()
)
  throw Error("Cannot extend the active demonstration dataset.");
const backup = join(target, "db-before-extension.json");
if (
  await access(backup).then(
    () => true,
    () => false,
  )
)
  throw Error("An extension already exists; never replace its evidence.");
const db = await read(join(target, "db.json"));
const before = structuredClone(db);
const fixture = await read(join(fixturePath, "db.json"));
const originalPreparation = await read(join(target, "demo-preparation.json"));
const profile = (value: any) =>
  Object.fromEntries(
    [
      "age",
      "sex",
      "conditions",
      "allergies",
      "pregnancy",
      "notes",
      "notifyFamily",
      "timezone",
    ].map((key) => [key, value?.[key]]),
  );
const protectedCollections = [
  "medications",
  "learning",
  "generated",
  "jobs",
  "schedules",
  "doseLogs",
];
const provenance: any[] = [];
const selectedDirectories = new Set<string>();
for (const argument of caseArgs) {
  const directory = inside(argument);
  if (selectedDirectories.has(directory.toLowerCase()))
    throw Error("The same case was selected twice.");
  selectedDirectories.add(directory.toLowerCase());
  const report = await read(join(directory, "report.json"));
  const qa = await read(
    join(dirname(directory), "independent-content-qa.json"),
  );
  if (
    report.status !== "passed" ||
    !["passed", "published_content_passed"].includes(qa.status)
  )
    throw Error("A selected case has not passed independent QA: " + directory);
  const source = await read(join(directory, "db.json"));
  const incomingLearning = Object.values<any>(source.learning || {});
  if (
    !incomingLearning.length ||
    incomingLearning.some(
      (row) =>
        row.groundingVersion !== GROUNDING_VERSION ||
        row.result?.status !== "supported" ||
        !row.result.quiz?.length ||
        !row.passed,
    )
  )
    throw Error("Incomplete current-version saved learning.");
  if (
    resolve(report.directory || "").toLowerCase() !== directory.toLowerCase() ||
    resolve(qa.directory || "").toLowerCase() !==
      dirname(directory).toLowerCase()
  )
    throw Error(
      "The selected workflow or QA report belongs to another directory.",
    );
  const qaAttempts = Array.isArray(qa.attempts)
    ? qa.attempts.filter(
        (attempt: any) =>
          attempt.id === report.id &&
          attempt.repeat === report.repeat &&
          resolve(attempt.directory || "").toLowerCase() ===
            directory.toLowerCase(),
      )
    : [];
  const reviewedBundles = qaAttempts.flatMap((attempt: any) =>
    Array.isArray(attempt.bundles) ? attempt.bundles : [],
  );
  for (const row of incomingLearning)
    if (
      !reviewedBundles.some(
        (bundle: any) => bundle.learningId === row.id && bundle.passed === true,
      )
    )
      throw Error(
        "Saved learning lacks a passed independent case review: " + row.id,
      );
  for (const row of Object.values<any>(source.profiles || {})) {
    if (digest(profile(row)) !== digest(profile(db.profiles?.[row.id])))
      throw Error(
        "Profile facts differ; do not make saved learning falsely current.",
      );
    if (
      source.users?.[row.id]?.profileVersion !==
      db.users?.[row.id]?.profileVersion
    )
      throw Error("Profile versions differ.");
  }
  if (
    Object.values<any>(source.jobs || {}).some(
      (job) => job.status !== "succeeded",
    )
  )
    throw Error("Unfinished or failed job in selected demonstration case.");
  for (const collection of protectedCollections) {
    db[collection] ||= {};
    for (const [id, value] of Object.entries(source[collection] || {})) {
      if (db[collection][id] && digest(db[collection][id]) !== digest(value))
        throw Error("Record collision: " + collection + "/" + id);
      db[collection][id] = value;
    }
  }
  db.usage ||= {};
  for (const [id, value] of Object.entries<any>(source.usage || {})) {
    const old = db.usage[id];
    if (old && (old.date !== value.date || old.ownerId !== value.ownerId))
      throw Error("Usage counter identity differs.");
    db.usage[id] = { ...value, count: (old?.count || 0) + value.count };
  }
  provenance.push({
    directory,
    reportSha256: digest(await readFile(join(directory, "report.json"))),
    independentQa: join(dirname(directory), "independent-content-qa.json"),
    independentQaStatus: qa.status,
    independentQaScope:
      "Source support of every published claim and quiz; complete leaflet warning coverage is separately reported and is not certified by this merge.",
    independentQaSha256: digest(
      await readFile(join(dirname(directory), "independent-content-qa.json")),
    ),
    originalRecords: Object.fromEntries(
      protectedCollections.map((key) => [
        key,
        Object.fromEntries(
          Object.entries(source[key] || {}).map(([id, value]) => [
            id,
            digest(value),
          ]),
        ),
      ]),
    ),
  });
}
const equivalentSourceLayouts: ReturnType<
  typeof equivalentSourceLayoutAudit
>[] = [];
db.leaflets ||= {};
for (const [id, value] of Object.entries<any>(fixture.leaflets || {})) {
  if (value.id !== id || (db.leaflets[id] && db.leaflets[id].id !== id))
    throw Error("Source record key differs from its identity: " + id);
  if (db.leaflets[id]) {
    if (digest(db.leaflets[id]) !== digest(value)) {
      try {
        equivalentSourceLayouts.push(
          equivalentSourceLayoutAudit(db.leaflets[id], value),
        );
      } catch (error) {
        throw Error("Source collision: " + id, { cause: error });
      }
    }
    // Keep the entire existing record, including old citation ids and review.
    continue;
  }
  db.leaflets[id] = value;
}
db.published ||= {};
for (const [id, value] of Object.entries(fixture.published || {})) {
  if (db.published[id] && digest(db.published[id]) !== digest(value))
    throw Error("Published source mapping collision: " + id);
  db.published[id] = value;
}
const catalog = fixture.settings?.catalog;
if (!catalog?.path || catalog.path.includes(".."))
  throw Error("Missing verified catalog.");
const catalogBytes = await readFile(join(fixturePath, "blobs", catalog.path));
if (
  digest(catalogBytes).slice(0, 16) !== catalog.version ||
  JSON.parse(catalogBytes.toString()).length !== catalog.count
)
  throw Error("Catalog checksum/count differs.");
db.settings.catalog = structuredClone(catalog);
for (const row of Object.values<any>(db.learning || {}))
  if (row.groundingVersion !== GROUNDING_VERSION)
    throw Error("A stale explanation remains in the new copy.");
const currentStore = new MemoryStore();
currentStore.data = db;
const domain = new Domain(currentStore);
for (const row of Object.values<any>(db.learning || {}))
  if (!(await domain.learningCurrent(row.ownerId, row)))
    throw Error("Saved learning is not current after merge: " + row.id);
for (const collection of protectedCollections)
  for (const [id, value] of Object.entries(before[collection] || {}))
    if (digest(db[collection][id]) !== digest(value))
      throw Error("An original saved record was changed.");
await cp(join(fixturePath, "blobs"), join(target, "blobs"), {
  recursive: true,
  force: false,
  errorOnExist: false,
});
const copiedCatalogBytes = await readFile(join(target, "blobs", catalog.path));
if (
  digest(copiedCatalogBytes) !== digest(catalogBytes) ||
  JSON.parse(copiedCatalogBytes.toString()).length !== catalog.count
)
  throw Error("The copied target catalog checksum/count differs.");
for (const leaflet of Object.values<any>(db.leaflets || {}))
  if (
    leaflet.status === "published" &&
    digest(await readFile(join(target, "blobs", leaflet.storagePath))) !==
      leaflet.sha256
  )
    throw Error("An official source checksum differs.");
const expectedCounts = Object.fromEntries(
  ["medications", "learning", "jobs", "generated"].map((key) => [
    key,
    Object.keys(db[key] || {}).length,
  ]),
);
expectedCounts.questions = Object.values<any>(db.learning || {}).reduce(
  (count, row) => count + row.result.quiz.length,
  0,
);
expectedCounts.recognitionJobs = Object.values<any>(db.jobs || {}).filter(
  (job) => job.kind === "recognition",
).length;
await writeFile(backup, JSON.stringify(before));
await writeFile(
  join(target, "demo-preparation-before-extension.json"),
  JSON.stringify(originalPreparation, null, 2),
);
await writeFile(join(target, "db.json"), JSON.stringify(db));
await writeFile(
  join(target, "demo-preparation.json"),
  JSON.stringify(
    {
      ...originalPreparation,
      extendedAt: new Date().toISOString(),
      groundingVersion: GROUNDING_VERSION,
      restoredPublicCatalogCount: catalog.count,
      expectedCounts,
      originalOutputsPreserved: true,
      acceptanceScope:
        "Workflow and published-content source support. Oracle-checked safety fields are shown in full, with at least one key-point question per field; this does not assess every subordinate item or clinical scenario.",
      appendedPassedCases: provenance,
      equivalentSourceLayouts: [
        ...(originalPreparation.equivalentSourceLayouts || []),
        ...equivalentSourceLayouts,
      ],
      officialSourceFixture: fixturePath,
      note: "All existing and appended model outputs and answers are retained exactly; the combined copy requires a fresh service and UI acceptance.",
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    { directory: target, expectedCounts, originalOutputsPreserved: true },
    null,
    2,
  ),
);
