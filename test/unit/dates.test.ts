import { describe, expect, it } from "vitest";
import { daysBetween, displayDate, unixTime } from "../../functions/lib/dates";

describe("dates", () => {
  it("prints the German day of a moment", () => {
    expect(displayDate("2026-10-09T22:30:00.000Z", "de")).toBe("10.10.2026");
    expect(displayDate("2026-10-09T22:30:00.000Z", "en")).toBe("10 Oct 2026");
  });

  it("gives sevdesk seconds", () => {
    expect(unixTime("2026-10-12T18:00:00.500Z")).toBe(1791828000);
  });

  it("counts German days between two moments", () => {
    expect(daysBetween("2026-11-25T10:00:00.000Z", "2026-12-25T10:00:00.000Z")).toBe(30);
    // 23:30 UTC is the next day in Germany
    expect(daysBetween("2026-11-25T23:30:00.000Z", "2026-12-25T22:30:00.000Z")).toBe(29);
    expect(daysBetween("2026-11-25T10:00:00.000Z", "2026-11-20T10:00:00.000Z")).toBe(-5);
  });
});
