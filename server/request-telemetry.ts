/** Opaque correlation and registered route patterns only. Never log URL
 * parameters, authorization, user identity, request bodies or medical data. */
export function clientRequestCorrelation(value: string | undefined) {
  return value &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      value,
    )
    ? value.toLowerCase()
    : undefined;
}
export function requestCompletionEvent(input: {
  requestId: string;
  clientRequestId?: string;
  method: string;
  route: string;
  status: number;
  latencyMs: number;
}) {
  return {
    event: "http_request_completed",
    requestId: input.requestId,
    ...(input.clientRequestId
      ? { clientRequestId: input.clientRequestId }
      : {}),
    method: /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(input.method)
      ? input.method
      : "OTHER",
    route: /^\/(?:api(?:\/[a-z0-9:_*-]+)*|health)$/i.test(input.route)
      ? input.route
      : "unmatched",
    status: input.status,
    latencyMs: Math.max(0, Math.round(input.latencyMs)),
  };
}
