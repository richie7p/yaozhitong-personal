import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

const temporaryDirectories: string[] = [];
const createTraceDirectory = async (kind: string) => {
  const directory = await mkdtemp(
    resolve(tmpdir(), `yaozhitong-test-trace-${kind}-`),
  );
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const listen = (server: Server) =>
  new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      done();
    });
  });
const close = async (server: Server) => {
  server.closeAllConnections();
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
};

it("returns real loopback response headers before the diagnostic clone's withheld body finishes", async () => {
  const directory = await createTraceDirectory("proxy");
  vi.stubEnv("SEMINAR_AI_TRACE_DIR", directory);
  const nativeFetch = globalThis.fetch;
  const value = {
    choices: [
      { finish_reason: "stop", message: { content: '{"synthetic":true}' } },
    ],
    usage: { total_tokens: 17 },
  };
  const body = JSON.stringify(value);
  let finishBody = () => {};
  let headersSent = false;
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.flushHeaders();
    response.write(body.slice(0, 1));
    headersSent = true;
    finishBody = () => response.end(body.slice(1));
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Loopback fixture did not bind.");
  vi.stubGlobal(
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(
        "https://integrate.api.nvidia.com/v1/chat/completions",
      );
      return nativeFetch(
        `http://127.0.0.1:${address.port}/v1/chat/completions`,
        init,
      );
    },
  );
  const trace = await import(
    pathToFileURL(resolve("tools/trace-seminar-ai.mjs")).href +
      "?test=" +
      crypto.randomUUID()
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      globalThis.fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer synthetic-trace-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "synthetic/primary",
          messages: [{ role: "user", content: "synthetic fixture" }],
        }),
      }),
      new Promise<never>((_done, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Error(
                "Diagnostic body collection blocked delivery of response headers.",
              ),
            ),
          1500,
        );
      }),
    ]);
    clearTimeout(timer);
    expect(headersSent).toBe(true);
    expect(response.status).toBe(200);
    expect(await readdir(directory)).toEqual([]);
    finishBody();
    expect(await response.json()).toEqual(value);
    const settled = await trace.flushSeminarAiTraces();
    expect(
      settled.every(
        (item: PromiseSettledResult<unknown>) => item.status === "fulfilled",
      ),
    ).toBe(true);
    const files = await readdir(directory);
    expect(files).toEqual(["upstream-01.json"]);
    const saved = JSON.parse(
      await readFile(resolve(directory, files[0]), "utf8"),
    );
    expect(saved).toMatchObject({
      status: 200,
      request: { model: "synthetic/primary" },
      usage: { total_tokens: 17 },
      finishReason: "stop",
    });
    expect(JSON.stringify(saved)).not.toContain("synthetic-trace-secret");
  } finally {
    clearTimeout(timer);
    finishBody();
    await close(server);
    await trace.flushSeminarAiTraces();
  }
});

it("finishes an unreadable trace when the actual body is aborted, without inventing token usage", async () => {
  const directory = await createTraceDirectory("abort");
  vi.stubEnv("SEMINAR_AI_TRACE_DIR", directory);
  const nativeFetch = globalThis.fetch;
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.flushHeaders();
    response.write('{"choices":[');
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Loopback fixture did not bind.");
  vi.stubGlobal("fetch", (_url: unknown, init?: RequestInit) =>
    nativeFetch(`http://127.0.0.1:${address.port}`, init),
  );
  const trace = await import(
    pathToFileURL(resolve("tools/trace-seminar-ai.mjs")).href +
      "?test=" +
      crypto.randomUUID()
  );
  try {
    const response = await globalThis.fetch(
      "https://integrate.api.nvidia.com/v1/chat/completions",
      {
        method: "POST",
        body: '{"model":"synthetic/primary"}',
        signal: AbortSignal.timeout(150),
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).rejects.toBeTruthy();
    await trace.flushSeminarAiTraces();
    const saved = JSON.parse(
      await readFile(resolve(directory, "upstream-01.json"), "utf8"),
    );
    expect(saved).toMatchObject({ status: 200, unreadableResponse: true });
    expect(saved.usage).toBeUndefined();
    expect(saved.response).toBeUndefined();
  } finally {
    await close(server);
    await trace.flushSeminarAiTraces();
  }
});

it("redacts echoed keys in persisted request, response and fetch errors without changing the client response", async () => {
  const directory = await createTraceDirectory("echo");
  vi.stubEnv("SEMINAR_AI_TRACE_DIR", directory);
  const knownOpenai = "synthetic-known-openai-key";
  const knownNvidia = "synthetic-known-nvidia-key";
  const bearer = "synthetic-header-only-api-key";
  vi.stubEnv("OPENAI_API_KEY", knownOpenai);
  vi.stubEnv("NVIDIA_API_KEY", knownNvidia);
  const secrets = [
    knownOpenai,
    knownNvidia,
    bearer,
    "sk-proj-syntheticEchoKey0123456789XYZ",
    "nvapi-syntheticEchoNvidiaKey0123456789",
    "sk-proj-ABCD...WXYZ",
    "sk-proj-ABCD…WXYZ",
    "nvapi-ABCD****WXYZ",
  ];
  const value = {
    error: {
      code: "invalid_api_key",
      message: "synthetic public context " + secrets.join(" "),
      extra: secrets.map((secret) => ({ nestedEcho: secret })),
    },
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  };
  const nativeFetch = globalThis.fetch;
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Loopback fixture did not bind.");
  const fetchError = new Error("synthetic fetch failure " + secrets.join(" "));
  let calls = 0;
  vi.stubGlobal("fetch", (_url: unknown, init?: RequestInit) => {
    if (++calls === 2) throw fetchError;
    return nativeFetch(`http://127.0.0.1:${address.port}`, init);
  });
  const trace = await import(
    pathToFileURL(resolve("tools/trace-seminar-ai.mjs")).href +
      "?test=" +
      crypto.randomUUID()
  );
  const imageUrl = "data:image/png;base64,c3ludGhldGlj";
  const init = {
    method: "POST",
    headers: {
      authorization: "Bearer " + bearer,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-6-luna",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "synthetic " + secrets.join(" ") },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
    }),
  };
  try {
    const response = await globalThis.fetch(
      "https://api.openai.com/v1/chat/completions",
      init,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(value);
    await expect(
      globalThis.fetch("https://api.openai.com/v1/chat/completions", init),
    ).rejects.toBe(fetchError);
    await trace.flushSeminarAiTraces();
    const first = JSON.parse(
      await readFile(resolve(directory, "upstream-01.json"), "utf8"),
    );
    const second = JSON.parse(
      await readFile(resolve(directory, "upstream-02.json"), "utf8"),
    );
    expect(first).toMatchObject({
      status: 401,
      response: { error: { code: "invalid_api_key" } },
      usage: value.usage,
    });
    expect(first.response.error.message).toContain("synthetic public context");
    expect(first.request.messages[0].content[1].image_url.url).toMatchObject({
      syntheticImage: true,
      dataUrlSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(second.error.name).toBe("Error");
    expect(second.error.message).toContain("synthetic fetch failure");
    const persisted = JSON.stringify([first, second]);
    for (const secret of secrets) expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain(imageUrl);
    expect(persisted).not.toContain("authorization");
  } finally {
    await close(server);
    await trace.flushSeminarAiTraces();
  }
});
