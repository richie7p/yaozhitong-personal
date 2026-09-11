import { readFile } from "node:fs/promises";
import { makeStore } from "../server/store.js";
import { Domain } from "../server/domain.js";
import { extractLeaflet } from "../server/leaflets.js";
const [file, licenseNo, sourceUrl] = process.argv.slice(2);
if (!file || !licenseNo || !sourceUrl)
  throw Error(
    "Usage: npm run import:leaflet -- file.pdf 許可證字號 https://...fda.gov.tw/...",
  );
const bytes = await readFile(file);
const d = new Domain(await makeStore());
const leaflet = await extractLeaflet(bytes, licenseNo, sourceUrl);
await d.blobs.put(leaflet.storagePath, bytes, "application/pdf");
await d.store.set("leaflets", leaflet.id, leaflet);
console.log(
  JSON.stringify({
    id: leaflet.id,
    licenseNo,
    status: leaflet.status,
    chunks: leaflet.chunks.length,
    instruction: "到管理後台核對原文並發布。",
  }),
);
