import { describe, expect, it } from "vitest";
import { buildCreditNote } from "../../functions/lib/credit-note";
import type { CreditNoteInput } from "../../functions/lib/credit-note";
import type { Problem } from "../../functions/lib/invoice";

/** An invoice of 41.99: 31.99 at 19 % and 10.00 at 7 %, with net prices */
const input: CreditNoteInput = {
  invoice: {
    id: "9", number: "RE-1000", status: 1000, sumNet: 36.23, sumTax: 5.76, sumGross: 41.99, paidAmount: 41.99, showNet: true, taxRule: 1,
    contactId: "c1", contactPersonId: "77", countryId: 1, deliveryCountryId: 0, address: "Erika Musterfrau\nHauptstr. 5\n80331 München",
    reference: "1042", date: "2026-10-12T00:00:00+02:00", deliveryDate: "2026-10-10T00:00:00+02:00", created: null,
  },
  positions: [
    { name: "T-Shirt", quantity: 2, price: 12.605, taxRate: 19, unity: 1, sumGross: 30 },
    { name: "Buch", quantity: 1, price: 9.3458, taxRate: 7, unity: 1, sumGross: 10 },
    { name: "Versand", quantity: 1, price: 4.1933, taxRate: 19, unity: 7, sumGross: 4.99 },
    { name: "Rabatt", quantity: 1, price: -2.521, taxRate: 19, unity: 7, sumGross: -3 },
  ],
  refundCents: 4199,
  earlier: [],
  orderNumber: "1042",
  reference: "A1B2C3D4",
  language: "de",
  date: 1791800000,
};

describe("buildCreditNote", () => {
  it("repeats the invoice's positions for a refund of the whole invoice", () => {
    const built = buildCreditNote(input);
    expect(built.draft.showNet).toBe(true);
    expect(built.draft.positions).toEqual(input.positions.map(({ sumGross, ...position }) => position));
    expect(built.rates).toEqual([{ rate: 19, gross: 31.99 }, { rate: 7, gross: 10 }]);
    expect(built.draft).toMatchObject({ invoiceId: "9", contactId: "c1", taxRule: 1, countryId: 1, reference: "1042 / A1B2C3D4" });
    expect(built.draft.header).toContain("RE-1000");
  });

  it("splits a partial refund over the invoice's tax rates, as gross amounts that add up exactly", () => {
    const built = buildCreditNote({ ...input, refundCents: 1000 });
    expect(built.draft.showNet).toBe(false);
    expect(built.draft.positions.map((position) => [position.taxRate, position.price])).toEqual([[19, 7.62], [7, 2.38]]);
    expect(built.totalCents).toBe(1000);
  });

  it("splits a later refund over what the invoice still holds at each rate", () => {
    // The first credit note took everything at 7 %
    const built = buildCreditNote({ ...input, refundCents: 2199, earlier: [{ cents: 2000, rates: [{ rate: 19, gross: 10 }, { rate: 7, gross: 10 }] }] });
    expect(built.draft.positions).toMatchObject([{ taxRate: 19, price: 21.99 }]);
  });

  it("refuses to guess the tax rates of an invoice without positions", () => {
    expect(() => buildCreditNote({ ...input, positions: [] })).toThrow(expect.objectContaining({ code: "invoice_no_positions" }) as Problem);
  });

  it("never dates the delivery before the invoice's", () => {
    expect(buildCreditNote(input).draft.deliveryDate).toBe(Math.floor(new Date("2026-10-10T00:00:00+02:00").getTime() / 1000));
  });

  it("carries the invoice's tax rule and delivery country", () => {
    const built = buildCreditNote({
      ...input,
      invoice: { ...input.invoice, taxRule: 2, sumGross: 100, deliveryCountryId: 2 },
      positions: [{ name: "T-Shirt", quantity: 1, price: 100, taxRate: 0, unity: 1, sumGross: 100 }],
      refundCents: 2500,
      language: "en",
    });
    expect(built.draft).toMatchObject({ taxRule: 2, deliveryCountryId: 2, positions: [{ taxRate: 0, price: 25, name: "Refund" }] });
  });

  it("refuses a refund the invoice cannot hold", () => {
    const run = () => buildCreditNote({ ...input, refundCents: 3000, earlier: [{ cents: 2000 }] });
    expect(run).toThrowError(/more than invoice RE-1000/);
    try {
      run();
    } catch (err) {
      expect((err as Problem).code).toBe("refund_exceeds");
    }
  });
});
