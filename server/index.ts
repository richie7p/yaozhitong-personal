import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { CloudTasksClient } from "@google-cloud/tasks";
import { config } from "./config.js";
import { makeStore } from "./store.js";
import { Domain } from "./domain.js";
import { createApp } from "./app.js";
import { tick } from "./scheduler.js";
import { LocalRunner } from "./local-runner.js";
const domain = new Domain(await makeStore());
const localRunner = new LocalRunner((id) => domain.processJob(id));
domain.enqueue = async (id) => {
  if (config.mode === "local") {
    return localRunner.enqueue(id);
  }
  const client = new CloudTasksClient();
  await client.createTask({
    parent: client.queuePath(config.project, config.location, config.queue),
    task: {
      httpRequest: {
        httpMethod: "POST",
        url: config.workerUrl + "/internal/jobs/" + id,
        oidcToken: {
          serviceAccountEmail: config.workerEmail,
          audience: config.workerUrl,
        },
        headers: { "content-type": "application/json" },
        body: Buffer.from("{}").toString("base64"),
      },
      dispatchDeadline: { seconds: 600 },
    },
  });
};
const app = createApp(domain);
if (config.role === "web") {
  app.get("/assets/*", serveStatic({ root: "./dist/web" }));
  for (const p of [
    "/sw.js",
    "/manifest.webmanifest",
    "/icon.svg",
    "/icon-192.png",
    "/icon-512.png",
  ])
    app.get(p, serveStatic({ root: "./dist/web" }));
  app.get("/", serveStatic({ root: "./dist/web", path: "index.html" }));
}
serve(
  {
    fetch: app.fetch,
    port: config.port,
    hostname: config.mode === "local" ? "127.0.0.1" : "0.0.0.0",
  },
  () =>
    console.log(`藥智通 API http://127.0.0.1:${config.port} (${config.mode})`),
);
if (config.mode === "local") {
  let ticking = false;
  const runTick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await tick(domain);
    } catch {
      console.error("scheduler_failed");
    } finally {
      ticking = false;
    }
  };
  // Recover persisted queued/expired jobs immediately after a restart.
  void runTick();
  setInterval(runTick, 60000).unref();
}
