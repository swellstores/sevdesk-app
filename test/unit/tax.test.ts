import { describe, expect, it } from "vitest";
import { RULES, classify, isProblem } from "../../functions/lib/tax";
import type { TaxInput } from "../../functions/lib/tax";

const base: TaxInput = { country: "DE", taxCharged: true, rates: [19], goods: true, services: false, taxExempt: false, smallBusiness: false };

function rule(input: Partial<TaxInput>) {
  const result = classify({ ...base, ...input });
  return isProblem(result) ? result.code : result.rule.id;
}

describe("classify", () => {
  it("books German sales as taxable revenue", () => {
    expect(rule({})).toBe(RULES.taxable.id);
    expect(rule({ rates: [19, 7] })).toBe(RULES.taxable.id);
  });

  it("holds a German order without tax, unless nothing on it is taxable", () => {
    expect(rule({ taxCharged: false, rates: [] })).toBe("no_tax");
    expect(rule({ taxCharged: false, rates: [], taxExempt: true })).toBe(RULES.taxable.id);
  });

  it("books a small business without VAT and refuses tax on its orders", () => {
    expect(rule({ smallBusiness: true, taxCharged: false, rates: [] })).toBe(RULES.smallBusiness.id);
    expect(rule({ smallBusiness: true })).toBe("tax_unexpected");
  });

  it("books EU sales by the rate charged: the destination's under the One-Stop-Shop, German ones at home", () => {
    expect(rule({ country: "FR", rates: [20, 5.5] })).toBe(RULES.ossGoods.id);
    expect(rule({ country: "FR", rates: [20], goods: false, services: true })).toBe(RULES.ossElectronic.id);
    expect(rule({ country: "FR", rates: [19, 7] })).toBe(RULES.taxable.id);
  });

  it("follows the merchant's choice where the destination's rate equals a German one", () => {
    expect(rule({ country: "CY", rates: [19] })).toBe(RULES.taxable.id);
    expect(rule({ country: "CY", rates: [19], ossAlways: true })).toBe(RULES.ossGoods.id);
  });

  it("books an untaxed EU sale to a business as intra-community supply or reverse charge", () => {
    const supply = classify({ ...base, country: "BE", taxCharged: false, rates: [], vatNumber: "be 0428.759.497" });
    expect(supply).toMatchObject({ rule: RULES.intraCommunity, taxed: false, vatNumber: "BE0428759497" });
    expect(rule({ country: "BE", taxCharged: false, rates: [], vatNumber: "BE1", goods: false, services: true })).toBe(RULES.reverseCharge.id);
    expect(rule({ country: "BE", taxCharged: false, rates: [] })).toBe("no_tax");
  });

  it("books untaxed sales outside the EU as export, or as not taxable when nothing ships", () => {
    expect(rule({ country: "CH", taxCharged: false, rates: [] })).toBe(RULES.export.id);
    expect(rule({ country: "US", taxCharged: false, rates: [], goods: false, services: true })).toBe(RULES.notTaxable.id);
    expect(rule({ country: "CH", rates: [19] })).toBe(RULES.taxable.id);
    expect(rule({ country: "CH", rates: [8.1] })).toBe("foreign_rates");
  });

  it("does not send an order that needs two rules", () => {
    expect(rule({ country: "FR", rates: [20], services: true })).toBe("mixed_supply");
    expect(rule({ country: "CH", taxCharged: false, rates: [], services: true })).toBe("mixed_supply");
    expect(rule({ country: "DE", services: true })).toBe(RULES.taxable.id);
  });

  it("needs a country", () => {
    expect(rule({ country: "" })).toBe("no_country");
  });
});
