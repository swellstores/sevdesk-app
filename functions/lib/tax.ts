/**
 * Chooses the sevdesk tax rule for an order.
 *
 * The app does not decide what tax is due. It takes the tax Swell charged and finds the
 * sevdesk rule that says the same thing. An order that fits none of them is not sent: a
 * wrong rule on a finalized invoice cannot be corrected through the API.
 *
 * sevdesk allows one rule per document, and each rule allows certain rates. Checked against
 * a sevdesk account on 2026-10-12: rule 1 takes 0, 7 and 19 %; the One-Stop-Shop rules take
 * the destination country's rates and refuse German ones; rules 2, 3, 17 and 21 take 0 %;
 * rule 3 needs the VAT ID on the sevdesk contact. A refusal names the allowed rates.
 */

export const EU_COUNTRIES = [
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU",
  "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
];

const GERMAN_RATES = [0, 7, 19];

export const RULES = {
  taxable: { id: 1, label: "Taxable revenue" },
  export: { id: 2, label: "Export" },
  intraCommunity: { id: 3, label: "Intra-community supply" },
  smallBusiness: { id: 11, label: "No VAT, § 19 UStG" },
  notTaxable: { id: 17, label: "Not taxable in Germany" },
  ossGoods: { id: 18, label: "One-Stop-Shop, goods" },
  ossElectronic: { id: 19, label: "One-Stop-Shop, electronic services" },
  reverseCharge: { id: 21, label: "Reverse charge, EU" },
} as const;

export interface TaxDecision {
  rule: { id: number; label: string };
  /** The document carries the tax Swell charged. False: every position is at 0 % */
  taxed: boolean;
  /** The sevdesk contact has to be a business with this VAT ID */
  vatNumber?: string;
}

export interface TaxProblem {
  code: "no_tax" | "tax_unexpected" | "no_country" | "mixed_supply" | "foreign_rates";
  message: string;
}

export interface TaxInput {
  /** Where the goods go, or where the customer is for an order that ships nothing */
  country?: string;
  taxCharged: boolean;
  /** The rates of the order's taxed lines, in percent */
  rates: number[];
  vatNumber?: string;
  /** The order ships goods */
  goods: boolean;
  /** The order also holds items that are not shipped: downloads, services, subscriptions */
  services: boolean;
  /** Everything on the order is a gift card or free, so no tax is expected anywhere */
  taxExempt: boolean;
  smallBusiness: boolean;
  /** The merchant's choice to book every taxed EU sale under the One-Stop-Shop rules */
  ossAlways?: boolean;
}

export function isProblem(result: TaxDecision | TaxProblem): result is TaxProblem {
  return "code" in result;
}

function germanRates(rates: number[]): boolean {
  return rates.every((rate) => GERMAN_RATES.some((german) => Math.abs(german - rate) < 0.005));
}

export function classify(input: TaxInput): TaxDecision | TaxProblem {
  const country = (input.country || "").toUpperCase();
  const vatNumber = (input.vatNumber || "").replace(/[\s.-]+/g, "").toUpperCase() || undefined;

  if (!country) {
    return {
      code: "no_country",
      message: "The order has no country in its billing or shipping address, so the tax rule cannot be chosen.",
    };
  }

  if (input.smallBusiness) {
    if (input.taxCharged) {
      return {
        code: "tax_unexpected",
        message:
          "The order was charged tax, but the sevdesk account is a small business (§ 19 UStG) that issues invoices without VAT. Correct the tax settings in Swell or in sevdesk.",
      };
    }
    return { rule: RULES.smallBusiness, taxed: false };
  }

  const noTax: TaxProblem = {
    code: "no_tax",
    message:
      "The order was charged no tax, and nothing shows why: it is not an export and not a sale to an EU business with a VAT ID. Check the store's tax rules. If no tax is correct, create this invoice in sevdesk by hand.",
  };
  // Goods and services to another country fall under different sevdesk rules, and a document has one
  const mixed: TaxProblem = {
    code: "mixed_supply",
    message:
      "The order ships goods and also holds items that are not shipped. For a customer in another country sevdesk books the two under different tax rules, and a document can have only one. Create this invoice in sevdesk by hand.",
  };

  if (country === "DE") {
    if (!input.taxCharged && !input.taxExempt) {
      return noTax;
    }
    return { rule: RULES.taxable, taxed: true };
  }

  if (EU_COUNTRIES.includes(country)) {
    if (input.taxCharged) {
      // Tax was charged, so the sale is booked the way a sale to a consumer is, whoever
      // bought. German rates mean the merchant taxes EU sales at home (below the EU
      // threshold); any other rate is the destination's, which is the One-Stop-Shop
      if (!input.ossAlways && germanRates(input.rates)) {
        return { rule: RULES.taxable, taxed: true };
      }
      if (input.goods && input.services) {
        return mixed;
      }
      return { rule: input.goods ? RULES.ossGoods : RULES.ossElectronic, taxed: true };
    }
    if (vatNumber) {
      if (input.goods && input.services) {
        return mixed;
      }
      return input.goods
        ? { rule: RULES.intraCommunity, taxed: false, vatNumber }
        : { rule: RULES.reverseCharge, taxed: false, vatNumber };
    }
    return input.taxExempt ? { rule: RULES.taxable, taxed: true } : noTax;
  }

  if (input.taxCharged) {
    if (!germanRates(input.rates)) {
      return {
        code: "foreign_rates",
        message: `The order goes to ${country} and was charged tax at a rate that is not a German one. sevdesk has no tax rule for that. Create this invoice in sevdesk by hand.`,
      };
    }
    return { rule: RULES.taxable, taxed: true };
  }
  if (input.goods && input.services) {
    return mixed;
  }
  return input.goods
    ? { rule: RULES.export, taxed: false }
    : { rule: RULES.notTaxable, taxed: false };
}
