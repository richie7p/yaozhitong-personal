import { describe, expect, it } from "vitest";
import { parseReminderTimes } from "../src/reminder-times";

describe("manually entered daily reminder times", () => {
  it.each([
    ["08:00, 20:00", ["08:00", "20:00"]],
    ["8:00，12:30、20:00", ["08:00", "12:30", "20:00"]],
    ["  8:05\n12:30\t20:00  ", ["08:05", "12:30", "20:00"]],
    ["23:59,00:00", ["23:59", "00:00"]],
  ])(
    "accepts explicit times in %s without inferring other times",
    (input, times) => {
      expect(parseReminderTimes(input)).toEqual({ times });
    },
  );

  it.each(["", "   ", "，、,\n"])(
    "requires at least one explicit time for %j",
    (input) => {
      expect(parseReminderTimes(input)).toEqual({
        error: "請至少填寫一個提醒時間，例如：08:00。",
      });
    },
  );

  it.each([
    "8",
    "8pm",
    "0800",
    "08:0",
    "08.00",
    "08:00pm",
    "08：00",
    "24:00",
    "23:60",
    "-1:00",
    "08:000",
    "08:00, 無效時間",
  ])("rejects malformed or out-of-range input %j", (input) => {
    const parsed = parseReminderTimes(input);
    expect(parsed.error).toContain("24 小時制");
    expect(parsed.times).toBeUndefined();
  });

  it.each(["08:00,08:00", "8:00，08:00"])(
    "asks the user to resolve duplicate times in %s",
    (input) => {
      expect(parseReminderTimes(input)).toEqual({
        error: "提醒時間 08:00 重複了，請只保留一次。",
      });
    },
  );

  it("accepts eight times and explains the limit when more are entered", () => {
    const eight = "00:00,03:00,06:00,09:00,12:00,15:00,18:00,21:00";
    expect(parseReminderTimes(eight).times).toHaveLength(8);
    expect(parseReminderTimes(eight + ",23:00")).toEqual({
      error: "每天最多可設定 8 個提醒時間，請依藥袋用法確認後再填寫。",
    });
  });
});
