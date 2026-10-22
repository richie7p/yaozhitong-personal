import { describe, expect, it } from "vitest";
import { PublicationValidationError, safePublicationFailure } from "../tools/tfda-publication-core";

describe("safe publication diagnostics", () => {
  it.each([[14, "UNAVAILABLE"], [4, "DEADLINE_EXCEEDED"], ["ECONNRESET", "ECONNRESET"]])(
    "identifies a standard transient code %s without logging SDK messages",
    (code, expected) => {
      const failure = safePublicationFailure(Object.assign(new Error("SYNTHETIC_SECRET_TOKEN and SDK response details"), { code }));
      expect(failure.diagnostic).toEqual({ code: expected, validation: false, readOnlyTransient: true });
      expect(JSON.stringify(failure)).not.toContain("SYNTHETIC_SECRET_TOKEN");
    },
  );
  it("keeps quota and authentication failures nonretryable", () => {
    expect(safePublicationFailure({ code: 8 }).diagnostic).toEqual({ code: "RESOURCE_EXHAUSTED", validation: false, readOnlyTransient: false });
    expect(safePublicationFailure({ code: 16 }).diagnostic.readOnlyTransient).toBe(false);
    expect(safePublicationFailure({ code: 429 }).diagnostic).toMatchObject({ code: "HTTP_429", readOnlyTransient: false });
  });
  it("never treats a validation rejection as a transient SDK failure", () => {
    const error = Object.assign(new PublicationValidationError("candidate_raw_source_binding_mismatch"), { code: 14 });
    expect(safePublicationFailure(error)).toMatchObject({ error: "candidate_raw_source_binding_mismatch", diagnostic: {
      code: "VALIDATION_FAILED", validation: true, readOnlyTransient: false,
    } });
  });
  it("does not echo arbitrary codes, names, messages, headers, details or causes", () => {
    const secret = "SYNTHETIC_PRIVATE_VALUE";
    const failure = safePublicationFailure({ code: secret, name: secret, message: secret,
      details: secret, headers: { Authorization: secret }, cause: { code: secret } });
    expect(failure).toMatchObject({ error: "cloud_or_file_operation_failed", diagnostic: { code: "UNKNOWN", readOnlyTransient: false } });
    expect(JSON.stringify(failure)).not.toContain(secret);
  });
  it("can classify a wrapped standard SDK cause while preserving no cause payload", () => {
    expect(safePublicationFailure({ cause: { code: "ECONNRESET", message: "SYNTHETIC HIDDEN" } }).diagnostic)
      .toMatchObject({ code: "ECONNRESET", readOnlyTransient: true });
  });
});
