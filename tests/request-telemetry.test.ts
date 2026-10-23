import { expect, it, vi } from "vitest";
import {
  clientRequestCorrelation,
  requestCompletionEvent,
} from "../server/request-telemetry";
import { Domain } from "../server/domain";
import { MemoryStore } from "../server/store";
import { createApp } from "../server/app";

it("accepts only opaque UUID correlation and strips unregistered URL paths", () => {
  expect(clientRequestCorrelation("patient@example.invalid")).toBeUndefined();
  expect(clientRequestCorrelation("\nsecret")).toBeUndefined();
  expect(clientRequestCorrelation("A1234567-1234-1234-1234-123456789ABC")).toBe(
    "a1234567-1234-1234-1234-123456789abc",
  );
  expect(
    requestCompletionEvent({
      requestId: "opaque",
      method: "GET",
      route: "/api/v1/medications/:id",
      status: 200,
      latencyMs: 2.3,
    }),
  ).toMatchObject({ route: "/api/v1/medications/:id", latencyMs: 2 });
  expect(
    requestCompletionEvent({
      requestId: "opaque",
      method: "GET",
      route: "/api/v1/secret?token=private",
      status: 200,
      latencyMs: 0,
    }),
  ).toMatchObject({ route: "unmatched" });
});
it("correlates an actual API response to a safe completion event without identity or inputs", async () => {
  const output = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const app = createApp(new Domain(new MemoryStore()));
    const client = "a1234567-1234-1234-1234-123456789abc";
    const response = await app.request(
      "http://localhost/api/v1/config?private=must-not-log",
      { headers: { "X-Client-Request-Id": client } },
    );
    expect(response.status).toBe(200);
    const event = JSON.parse(output.mock.calls.at(-1)![0]);
    expect(event).toMatchObject({
      event: "http_request_completed",
      clientRequestId: client,
      requestId: response.headers.get("X-Request-Id"),
      method: "GET",
      route: "/api/v1/config",
      status: 200,
    });
    expect(JSON.stringify(event)).not.toContain("must-not-log");
    expect(Object.keys(event).sort()).toEqual(
      [
        "event",
        "clientRequestId",
        "requestId",
        "method",
        "route",
        "status",
        "latencyMs",
      ].sort(),
    );
  } finally {
    output.mockRestore();
  }
});
