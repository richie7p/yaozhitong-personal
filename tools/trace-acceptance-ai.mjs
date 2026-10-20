// Loaded only by the opt-in, isolated synthetic-patient acceptance runner.
// Keep model responses in its ignored report directory; never save request headers.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const directory = process.env.NVIDIA_ACCEPTANCE_TRACE_DIR;
if (!directory)
  throw Error("This diagnostic requires an acceptance directory.");
const request = globalThis.fetch;
let sequence = 0;
globalThis.fetch = async (...args) => {
  const response = await request(...args);
  if (
    String(args[0]) !== "https://integrate.api.nvidia.com/v1/chat/completions"
  )
    return response;
  const entry = { status: response.status };
  try {
    const data = await response.clone().json();
    Object.assign(entry, {
      finishReason: data.choices?.[0]?.finish_reason,
      usage: data.usage,
      content: data.choices?.[0]?.message?.content,
    });
  } catch {
    entry.unreadableResponse = true;
  }
  await writeFile(
    join(directory, "model-response-" + ++sequence + ".json"),
    JSON.stringify(entry, null, 2),
  );
  return response;
};
