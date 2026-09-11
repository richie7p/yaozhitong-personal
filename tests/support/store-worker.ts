import { MemoryStore } from "../../server/store.js";
const store = await new MemoryStore(process.argv[2]).load();
for (let i = 0; i < Number(process.argv[3]); i++) {
  await store.transaction(async (tx) => {
    const current = await tx.get("counters", "shared");
    tx.set("counters", "shared", { value: (current?.value || 0) + 1 });
  });
}
