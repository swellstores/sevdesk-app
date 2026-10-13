import { describe, expect, it } from "vitest";
import { accountFor, describeBooking, planBookings, resolveAccount } from "../../functions/lib/payments";

const settings = {
  payments: { account: "Online-Shop", exceptions: [{ method: "bank_transfer", account: "" }, { method: "Giftcard", account: "Gutscheine" }] },
};
const accounts = [
  { id: "500", name: "Online-Shop", type: "offline", active: true },
  { id: "502", name: "Sparkasse", type: "online", active: true },
];
const payment = (method: string, amount: number, date: string, extra = {}) => ({
  id: date, method, amount, success: true, captured: true, date_created: date, ...extra,
});

describe("accountFor", () => {
  it("uses the shop account, the listed exception, or nothing", () => {
    expect(accountFor(settings, "card")).toBe("Online-Shop");
    expect(accountFor(settings, "bank_transfer")).toBeUndefined();
    expect(accountFor(settings, "giftcard")).toBe("Gutscheine");
    expect(accountFor(settings, "account")).toBeUndefined();
    expect(accountFor({}, "card")).toBeUndefined();
  });
});

describe("planBookings", () => {
  it("books each successful payment in order, up to the invoice total", () => {
    const plan = planBookings(
      [payment("card", 80, "2026-10-02"), payment("account", 20, "2026-10-01"), payment("card", 5, "2026-10-03", { success: false })],
      settings,
      9000,
    );
    expect(plan.open).toEqual([{ method: "account", cents: 2000 }]);
    expect(plan.bookings).toMatchObject([{ method: "card", cents: 7000, account: "Online-Shop" }]);
  });
});

describe("resolveAccount", () => {
  it("finds the account by name, whatever the case", () => {
    expect(resolveAccount(accounts, " online-shop ").id).toBe("500");
  });

  it("refuses a name sevdesk does not have, and a connected bank account", () => {
    expect(() => resolveAccount(accounts, "Shop")).toThrowError(/no payment account/);
    expect(() => resolveAccount(accounts, "Sparkasse")).toThrowError(/connected to a bank/);
  });
});

describe("describeBooking", () => {
  it("says what was booked and what was left alone", () => {
    const plan = { bookings: [], open: [{ method: "giftcard", cents: 2000 }] };
    expect(describeBooking(plan, 8000, 10000, true)).toMatch(/80\.00 of 100\.00.*giftcard/);
    expect(describeBooking({ bookings: [], open: [] }, 10000, 10000, true)).toMatch(/^Paid/);
    expect(describeBooking(plan, 0, 10000, false)).toMatch(/no sevdesk payment account/);
  });
});
