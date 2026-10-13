import { afterEach, describe, expect, it, vi } from "vitest";
import { Problem, buildInvoice, simulate } from "../../functions/lib/invoice";
import type { BuiltInvoice, Layout } from "../../functions/lib/invoice";
import { saveDraft } from "../../functions/lib/sevdesk";
import * as orders from "../fixtures/orders";
import { createSevdesk } from "../helpers/sevdesk";

const regular = { smallBusiness: false, language: "de" };

function problem(run: () => unknown): Problem {
  try {
    run();
  } catch (err) {
    return err as Problem;
  }
  throw new Error("Expected a problem");
}

/** What sevdesk makes of a layout, in cents */
async function sevdeskTotal(built: BuiltInvoice, layout: Layout = built.layout): Promise<number> {
  const sevdesk = createSevdesk();
  sevdesk.contacts.push({ id: "c1", vatNumber: built.contact.vatNumber });
  const saved = await saveDraft({ token: "t" }, "Invoice", {
    contactId: "c1", contactPersonId: "77", date: 1, deliveryDate: built.deliveryDate, header: built.header, address: built.address,
    countryId: built.countryId, taxRule: built.decision.rule.id, showNet: layout.showNet, reference: built.reference, positions: layout.positions,
  });
  return Math.round(saved.sumGross * 100);
}

afterEach(() => vi.unstubAllGlobals());

describe("buildInvoice", () => {
  it("sends a net-price order with the store's own prices when sevdesk's total is the order's", async () => {
    const built = buildInvoice(orders.mixedRates, regular);
    expect(built.layout).toEqual({
      showNet: true,
      positions: [
        { name: "T-Shirt", quantity: 3, price: 24.99, taxRate: 19, unity: 1 },
        { name: "Buch", quantity: 1, price: 12.99, taxRate: 7, unity: 1 },
        { name: "Versand (DHL Paket)", quantity: 1, price: 4.9, taxRate: 19, unity: 7 },
      ],
    });
    expect(await sevdeskTotal(built)).toBe(10894);
    // The same lines as gross amounts are kept ready, in case sevdesk's draft differs
    expect(await sevdeskTotal(built, built.fallback)).toBe(10894);
    expect(built).toMatchObject({ reference: "100302", countryId: 1, address: "Erika Musterfrau\nHauptstr. 5\n2. OG\n80331 München" });
  });

  it("sends gross amounts when sevdesk's rounding per position would be a cent off", async () => {
    const built = buildInvoice(orders.singleRate, regular);
    expect(built.layout.showNet).toBe(false);
    expect(built.fallback).toBeUndefined();
    expect(await sevdeskTotal(built)).toBe(7661);
  });

  it("shows a coupon as one negative position per tax rate", async () => {
    const built = buildInvoice(orders.withCoupon, regular);
    const discounts = built.layout.positions.filter((position) => position.price < 0);
    expect(discounts.map((position) => position.taxRate)).toEqual([19, 7]);
    expect(discounts[0].name).toContain("HERBST10");
    expect(await sevdeskTotal(built)).toBe(9863);
  });

  it("says that a paid order is paid, and names the order", () => {
    const built = buildInvoice(orders.withCoupon, regular);
    expect(built.headText).toBe("Bestellung Nr. 100303 vom 10.10.2026");
    expect(built.footText).toContain("beglichen");
    expect(buildInvoice(orders.mixedRates, regular).footText).toBeUndefined();
  });

  it("books a French consumer under the One-Stop-Shop with French rates", async () => {
    const built = buildInvoice(orders.frenchConsumer, { ...regular, language: "auto" });
    expect(built.decision.rule.id).toBe(18);
    expect(built.layout.positions.map((position) => position.taxRate)).toEqual([20, 5.5, 20]);
    expect(built).toMatchObject({ language: "en", header: "Invoice", countryId: 11 });
    expect(await sevdeskTotal(built)).toBe(8556);
  });

  it("books an export and an EU business without tax", async () => {
    const swiss = buildInvoice(orders.swissExport, regular);
    expect(swiss.decision.rule.id).toBe(2);
    expect(swiss.layout.positions.every((position) => position.taxRate === 0)).toBe(true);
    expect(await sevdeskTotal(swiss)).toBe(7287);

    const belgian = buildInvoice(orders.belgianBusiness, regular);
    expect(belgian.decision.rule.id).toBe(3);
    expect(belgian.contact).toMatchObject({ company: "Peeters BV", vatNumber: "BE0123456789" });
    expect(belgian.contactKey).toContain("BE0123456789");
    expect(belgian.address.split("\n").slice(0, 2)).toEqual(["Peeters BV", "Anna Peeters"]);
    expect(await sevdeskTotal(belgian)).toBe(7287);
  });

  it("keeps orders without an account apart by their e-mail, or by the order", () => {
    const { account, account_id, ...guest } = orders.swissExport as Record<string, any>;
    expect(buildInvoice({ ...guest, account_email: "Gast@Example.com" }, regular).contactKey).toBe("gast@example.com|");
    expect(buildInvoice(guest, regular).contactKey).toBe(`order:${guest.id}|`);
    expect(buildInvoice(orders.swissExport, regular).contactKey).toBe(`${account_id}|`);
  });

  it("invoices a small business without VAT", () => {
    const built = buildInvoice({ ...orders.swissExport, shipping: { ...orders.swissExport.shipping, country: "DE" }, billing: { ...orders.swissExport.billing, country: "DE" } }, { ...regular, smallBusiness: true });
    expect(built.decision.rule.id).toBe(11);
    expect(problem(() => buildInvoice(orders.mixedRates, { ...regular, smallBusiness: true })).code).toBe("tax_unexpected");
  });

  it("names the delivery country when the goods go to another country than the invoice", () => {
    const built = buildInvoice({ ...orders.frenchConsumer, billing: { ...orders.frenchConsumer.billing, country: "DE" } }, regular);
    expect(built).toMatchObject({ countryId: 1, deliveryCountryId: 11 });
    expect(built.decision.rule.id).toBe(18);
  });

  it("uses the store's gross prices for a store with prices including tax", async () => {
    const order = {
      ...orders.singleRate, item_tax_included: true, shipment_tax_included: true, shipment_price: 4.9, shipment_tax: 0.7824, grand_total: 64.88,
      items: [{ ...orders.singleRate.items[0], quantity: 2, price: 29.99, price_total: 59.98, discount_total: 0, tax_total: 9.5767 }],
    };
    const built = buildInvoice(order, regular);
    expect(built.layout).toMatchObject({ showNet: false, positions: [{ quantity: 2, price: 29.99, taxRate: 19 }, { price: 4.9, taxRate: 19 }] });
    expect(await sevdeskTotal(built)).toBe(6488);
  });

  it("skips another currency and holds what cannot be invoiced", () => {
    expect(problem(() => buildInvoice({ ...orders.singleRate, currency: "USD" }, regular))).toMatchObject({ status: "skipped", code: "currency" });
    expect(problem(() => buildInvoice({ ...orders.singleRate, items: [] }, regular)).code).toBe("no_items");
    expect(problem(() => buildInvoice({ ...orders.singleRate, billing: {}, shipping: {}, account: {} }, regular)).code).toBe("no_address");
    expect(problem(() => buildInvoice({ ...orders.singleRate, grand_total: 80 }, regular)).code).toBe("total_mismatch");
    expect(problem(() => buildInvoice({ ...orders.mixedRates, taxes: [], items: orders.mixedRates.items.map((item) => ({ ...item, tax_total: 0, taxes: [] })), shipment_tax: 0, grand_total: 92.86 }, regular)).code).toBe("no_tax");
  });
});

describe("simulate", () => {
  it("rounds each position on its own, the way sevdesk was seen to", () => {
    // Read from a sevdesk draft on 2026-10-12: net 18.73, tax 3.23, gross 21.96
    const lines = [
      { quantity: 3, unit: 33333, rate: 19 },
      { quantity: 1, unit: 1250, rate: 7 },
      { quantity: 7, unit: 10050, rate: 19 },
      { quantity: 1, unit: -11150, rate: 19 },
      { quantity: 1, unit: 26750, rate: 7 },
    ];
    expect(simulate(lines, true)).toEqual({ gross: 2196, tax: 323 });
  });
});
