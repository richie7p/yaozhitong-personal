/** Copy a successful synthetic acceptance run; never replace model outputs or an existing snapshot. */
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, relative, join, dirname } from "node:path";
import { GROUNDING_VERSION } from "../server/ai.js";

const source = resolve(process.argv[2] || "");
const destination = resolve(process.argv[3] || "");
const root = resolve(".local");
const sourceRelative = relative(root, source).replaceAll("\\", "/");
const targetRelative = relative(root, destination).replaceAll("\\", "/");
if (
  !/^seminar-flow-[\w-]+$/.test(sourceRelative) ||
  !/^seminar-demo-[\w-]+$/.test(targetRelative)
)
  throw Error(
    "Use a seminar-flow run and a new seminar-demo snapshot directly inside .local.",
  );
if (
  await stat(destination).then(
    () => true,
    () => false,
  )
)
  throw Error(
    "The destination already exists; snapshots are never overwritten.",
  );
const report = JSON.parse(await readFile(join(source, "report.json"), "utf8"));
if (report.status !== "passed")
  throw Error("The source workflow did not pass.");
const db = JSON.parse(await readFile(join(source, "db.json"), "utf8"));
const learning = Object.values(db.learning || {}) as any[];
if (
  learning.length !== 2 ||
  learning.some(
    (r) =>
      r.groundingVersion !== GROUNDING_VERSION ||
      !r.result?.quiz?.length ||
      r.result.status !== "supported",
  )
)
  throw Error(
    "The source lacks both current-version explanations and quizzes.",
  );
const main = JSON.parse(await readFile(join(root, "db.json"), "utf8"));
const catalog = main.settings?.catalog;
if (
  !catalog?.path ||
  typeof catalog.path !== "string" ||
  catalog.path.includes("..") ||
  !/^catalog\/[\w./-]+$/.test(catalog.path)
)
  throw Error("The main official catalog path is invalid.");
const catalogBytes = await readFile(join(root, "blobs", catalog.path));
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
if (
  digest(catalogBytes).slice(0, 16) !== catalog.version ||
  JSON.parse(catalogBytes.toString()).length !== catalog.count
)
  throw Error("The main official catalog checksum or count is invalid.");
await cp(source, destination, {
  recursive: true,
  errorOnExist: true,
  force: false,
});
const protectedCollections = [
  "medications",
  "schedules",
  "learning",
  "generated",
  "jobs",
  "profiles",
];
const before = Object.fromEntries(
  protectedCollections.map((key) => [
    key,
    digest(JSON.stringify(db[key] || {})),
  ]),
);
db.settings.catalog = structuredClone(catalog);
await mkdir(dirname(join(destination, "blobs", catalog.path)), {
  recursive: true,
});
await writeFile(join(destination, "blobs", catalog.path), catalogBytes);
await writeFile(join(destination, "db.json"), JSON.stringify(db));
const saved = JSON.parse(await readFile(join(destination, "db.json"), "utf8"));
if (
  protectedCollections.some(
    (key) => digest(JSON.stringify(saved[key] || {})) !== before[key],
  )
)
  throw Error("Unexpected demonstration-content change during copy.");
const preparation = {
  preparedAt: new Date().toISOString(),
  copiedFrom: sourceRelative,
  directory: destination,
  groundingVersion: GROUNDING_VERSION,
  restoredPublicCatalogCount: catalog.count,
  originalOutputsPreserved: true,
  protectedCollectionHashes: before,
  note: "Independent content QA must also be passed before presenting this copy.",
};
await writeFile(
  join(destination, "demo-preparation.json"),
  JSON.stringify(preparation, null, 2),
);
console.log(JSON.stringify(preparation, null, 2));
