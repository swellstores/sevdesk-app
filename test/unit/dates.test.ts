import { describe, expect, it } from "vitest";
import { displayDate, unixTime } from "../../functions/lib/dates";

describe("dates", () => {
  it("prints the German day of a moment", () => {
    expect(displayDate("2026-10-09T22:30:00.000Z", "de")).toBe("10.10.2026");
    expect(displayDate("2026-10-09T22:30:00.000Z", "en")).toBe("10 Oct 2026");
  });

  it("gives sevdesk seconds", () => {
    expect(unixTime("2026-10-12T18:00:00.500Z")).toBe(1791828000);
  });
});
