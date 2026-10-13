/**
 * The words the app itself prints on a document. The layout, the letterhead, the footer and
 * the labels of the totals come from the merchant's sevdesk account. That includes the line
 * that says why a document carries no tax ("Innergemeinschaftliche Lieferung 0%"), which
 * sevdesk prints from the tax rule.
 */

export type Language = "de" | "en";

const GERMAN_SPEAKING = ["DE", "AT", "CH", "LI"];

/** The document language for a setting of "de", "en" or "auto" (German for DE, AT, CH and LI) */
export function chooseLanguage(setting: string | undefined | null, country: string | undefined): Language {
  if (setting === "en") {
    return "en";
  }
  if (setting === "auto") {
    return !country || GERMAN_SPEAKING.includes(country.toUpperCase()) ? "de" : "en";
  }
  return "de";
}

const PAYMENT_METHODS: Record<string, { de: string; en: string }> = {
  card: { de: "Kreditkarte", en: "credit card" },
  paypal: { de: "PayPal", en: "PayPal" },
  amazon: { de: "Amazon Pay", en: "Amazon Pay" },
  apple: { de: "Apple Pay", en: "Apple Pay" },
  google: { de: "Google Pay", en: "Google Pay" },
  klarna: { de: "Klarna", en: "Klarna" },
  ideal: { de: "iDEAL", en: "iDEAL" },
  bancontact: { de: "Bancontact", en: "Bancontact" },
  twint: { de: "TWINT", en: "TWINT" },
  sepa: { de: "SEPA-Lastschrift", en: "SEPA direct debit" },
  bank_transfer: { de: "Überweisung", en: "bank transfer" },
  cash: { de: "Barzahlung", en: "cash" },
  account: { de: "Kundenguthaben", en: "store credit" },
  giftcard: { de: "Geschenkgutschein", en: "gift card" },
};

export interface Texts {
  invoice: string;
  order(number: string, date: string): string;
  shipping(service?: string): string;
  discount(code?: string): string;
  discountAtRate(rate: string, code?: string): string;
  paid(method?: string): string;
  creditNote(invoice: string): string;
  refund(order: string, reference: string): string;
  refundLine(rate?: string): string;
}

const TEXTS: Record<Language, Texts> = {
  de: {
    invoice: "Rechnung",
    order: (number, date) => `Bestellung Nr. ${number} vom ${date}`,
    shipping: (service) => (service ? `Versand (${service})` : "Versand"),
    discount: (code) => (code ? `Rabatt (${code})` : "Rabatt"),
    discountAtRate: (rate, code) => `Rabatt (${code ? `${code}, ` : ""}${rate} % USt)`,
    paid: (method) =>
      method ? `Der Rechnungsbetrag wurde bereits per ${method} beglichen.` : "Der Rechnungsbetrag wurde bereits beglichen.",
    creditNote: (invoice) => `Rechnungskorrektur zur Rechnung Nr. ${invoice}`,
    refund: (order, reference) => `Erstattung zur Bestellung Nr. ${order} (Ref. ${reference})`,
    refundLine: (rate) => (rate ? `Erstattung (${rate} % USt)` : "Erstattung"),
  },
  en: {
    invoice: "Invoice",
    order: (number, date) => `Order no. ${number} of ${date}`,
    shipping: (service) => (service ? `Shipping (${service})` : "Shipping"),
    discount: (code) => (code ? `Discount (${code})` : "Discount"),
    discountAtRate: (rate, code) => `Discount (${code ? `${code}, ` : ""}${rate}% VAT)`,
    paid: (method) => (method ? `The invoice amount has been paid by ${method}.` : "The invoice amount has been paid."),
    creditNote: (invoice) => `Credit note for invoice no. ${invoice}`,
    refund: (order, reference) => `Refund for order no. ${order} (ref. ${reference})`,
    refundLine: (rate) => (rate ? `Refund (${rate}% VAT)` : "Refund"),
  },
};

export function texts(language: Language): Texts {
  return TEXTS[language];
}

export function paymentMethodName(method: string | undefined | null, language: Language): string | undefined {
  return method ? PAYMENT_METHODS[method]?.[language] : undefined;
}

export function formatRate(rate: number, language: Language): string {
  const text = String(Math.round(rate * 100) / 100);
  return language === "de" ? text.replace(".", ",") : text;
}
