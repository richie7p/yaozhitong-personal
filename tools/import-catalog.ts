import { readFile } from "node:fs/promises";
import { makeStore } from "../server/store.js";
import { refreshCatalog } from "../server/import-catalog.js";
const bytes = process.argv[2] ? await readFile(process.argv[2]) : undefined;
console.log(
  JSON.stringify(
    await refreshCatalog(await makeStore(), undefined, bytes),
    null,
    2,
  ),
);
