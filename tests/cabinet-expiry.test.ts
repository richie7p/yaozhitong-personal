import { describe, expect, it } from "vitest";
import { cabinetExpiryStatus, taipeiDay } from "../shared/dates";

describe("Taipei calendar day", () => {
  it.each([
    ["2026-10-19T15:59:59.999Z", "2026-10-19"],
    ["2026-10-19T16:00:00.000Z", "2026-10-20"],
    ["2026-10-19T17:00:00.000Z", "2026-10-20"],
    ["2026-10-19T23:59:59.999Z", "2026-10-20"],
    ["2026-10-20T00:00:00.000Z", "2026-10-20"],
    ["2024-02-28T16:00:00.000Z", "2024-02-29"],
    ["2024-02-29T16:00:00.000Z", "2024-03-01"],
    ["2026-12-31T16:00:00.000Z", "2027-01-01"],
  ])(
    "formats %s as %s independently of the machine timezone",
    (instant, day) => {
      expect(taipeiDay(new Date(instant))).toBe(day);
    },
  );
});

describe("cabinet expiry status", () => {
  it.each([
    ["2026-10-19", false, "expired"],
    ["2026-10-20", false, "stored"],
    ["2026-10-21", false, "stored"],
    [null, false, "stored"],
    [undefined, false, "stored"],
    ["2026-10-19", true, "disposed"],
    [null, true, "disposed"],
  ] as const)(
    "expiry %s, disposed %s is %s on the date",
    (expiresAt, disposed, status) => {
      expect(cabinetExpiryStatus({ expiresAt, disposed }, "2026-10-20")).toBe(
        status,
      );
    },
  );

  it("marks yesterday expired at 01:00 Taipei and keeps it expired after 08:00", () => {
    const item = { expiresAt: "2026-10-19", disposed: false };
    for (const instant of ["2026-10-19T17:00:00Z", "2026-10-20T00:00:00Z"])
      expect(cabinetExpiryStatus(item, taipeiDay(new Date(instant)))).toBe(
        "expired",
      );
  });

  it("keeps the expiry date marked stored through 23:59 and changes at Taipei midnight", () => {
    const item = { expiresAt: "2026-10-20", disposed: false };
    expect(
      cabinetExpiryStatus(item, taipeiDay(new Date("2026-10-20T15:59:59Z"))),
    ).toBe("stored");
    expect(
      cabinetExpiryStatus(item, taipeiDay(new Date("2026-10-20T16:00:00Z"))),
    ).toBe("expired");
  });

  it("respects February 29 through the following Taipei midnight", () => {
    const item = { expiresAt: "2024-02-29", disposed: false };
    expect(
      cabinetExpiryStatus(item, taipeiDay(new Date("2024-02-29T15:59:59Z"))),
    ).toBe("stored");
    expect(
      cabinetExpiryStatus(item, taipeiDay(new Date("2024-02-29T16:00:00Z"))),
    ).toBe("expired");
  });
});
