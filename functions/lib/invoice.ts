/**
 * Turns a Swell order into a sevdesk invoice.
 *
 * sevdesk computes every total itself, position by position: with net prices it rounds a
 * position to cents and adds the tax on that; with gross prices it rounds the position and
 * takes the tax out of it. Swell computes tax per item with four decimals and rounds only
 * the order total. The two agree most of the time and differ by a cent some of the time,
 * so the invoice is built to give the order's total to the cent:
 *
 * - A store with prices before tax gets a net invoice when sevdesk's net calculation gives
 *   the order total. When it would be a cent off, the same lines are sent as gross amounts,
 *   whose sum is the total by construction.
 * - A store with prices including tax gets a gross invoice.
 * - Discounts are shown as their own negative position per tax rate, so the unit prices on
 *   the invoice are the prices the customer saw.
 *
 * The calculation here only chooses the layout. What decides is sevdesk's own total on the
 * draft, which the caller compares with the order before anything gets a number.
 */

import { countryId } from "./countries";
import { displayDate, unixTime } from "./dates";
import {
  divideRounded,
  formatCents,
  microsToCents,
  netOfGross,
  rateToBasisPoints,
  taxOnNet,
  toCents,
  toMicros,
} from "./money";
import type { ContactInput, Position } from "./sevdesk";
import { RULES, classify, isProblem } from "./tax";
import type { TaxDecision } from "./tax";
import { chooseLanguage, formatRate, paymentMethodName, texts } from "./texts";
import type { Language } from "./texts";

export type SwellRecord = Record<string, any>;

/** A reason not to create a document. `failed` needs the merchant; `skipped` is outside what the app does */
export class Problem extends Error {
  status: "failed" | "skipped";
  code: string;

  constructor(status: "failed" | "skipped", code: string, message: string) {
    super(message);
    this.name = "Problem";
    this.status = status;
    this.code = code;
  }
}

/** sevdesk's unit ids */
const UNIT = { piece: 1, flat: 7 };

export interface Layout {
  /** True when the position prices are net */
  showNet: boolean;
  positions: Position[];
}

export interface BuiltInvoice {
  /** The layout to send first, and the one to send when sevdesk's total for the first is not the order's */
  layout: Layout;
  fallback?: Layout;
  decision: TaxDecision;
  language: Language;
  /** The order total in cents, which the draft has to show */
  totalCents: number;
  header: string;
  headText: string;
  footText?: string;
  /** Shown in sevdesk as the document's reference */
  reference: string;
  /** Name and address lines, without the country */
  address: string;
  countryId: number;
  /** Where the goods go, when that is another country than the address: sevdesk checks One-Stop-Shop rates against it */
  deliveryCountryId?: number;
  deliveryDate: number;
  contact: ContactInput;
  /** Orders with the same key share one sevdesk contact */
  contactKey: string;
  customerName: string;
  customerEmail?: string;
}

export interface BuildOptions {
  smallBusiness: boolean;
  /** "de", "en" or "auto" */
  language?: string | null;
  ossAlways?: boolean;
}

interface Component {
  kind: "item" | "shipping";
  name: string;
  description?: string;
  quantity: number;
  rate: number;
  taxIncluded: boolean;
  /** Price before discount, as the store states it (with or without tax), in micros */
  before: number;
  discount: number;
  tax: number;
}

interface PricedLine {
  name: string;
  description?: string;
  quantity: number;
  unity: number;
  /** Unit price in micros: sevdesk takes four decimals */
  unit: number;
  rate: number;
}

/** A rate has at most two decimals; rates within rounding of a half step are that step */
function tidyRate(rate: number): number {
  const half = Math.round(rate * 2) / 2;
  return Math.abs(rate - half) < 0.15 ? half : Math.round(rate * 100) / 100;
}

/**
 * The tax rate of an order line. Swell names the rule that taxed each item; the rate comes
 * from there and is checked against the tax actually charged. Imported orders carry no
 * rates, so the charged tax decides when the two disagree.
 */
function findRate(declared: number | undefined, component: Omit<Component, "rate">): number {
  const base = component.before - component.discount;
  if (base <= 0) {
    return declared ?? 0;
  }
  if (component.tax <= 0) {
    return 0;
  }
  const net = component.taxIncluded ? base - component.tax : base;
  const charged = net > 0 ? (component.tax / net) * 100 : 0;
  if (declared !== undefined && Math.abs(declared - charged) < 0.15) {
    return declared;
  }
  return tidyRate(charged);
}

function declaredRate(order: SwellRecord, ids: string[] | undefined, shipping: boolean): number | undefined {
  const taxes: SwellRecord[] = Array.isArray(order.taxes) ? order.taxes : [];
  const applied = shipping ? taxes.filter((tax) => tax.shipping) : taxes.filter((tax) => ids?.includes(tax.id));
  if (applied.length === 0 || applied.some((tax) => typeof tax.rate !== "number")) {
    return undefined;
  }
  return applied.reduce((sum, tax) => sum + tax.rate, 0);
}

function describeOptions(item: SwellRecord): string | undefined {
  if (item.variant_name || !Array.isArray(item.options)) {
    return undefined;
  }
  const parts = item.options
    .filter((option: SwellRecord) => option?.name && option?.value !== undefined && option?.value !== null)
    .map((option: SwellRecord) => `${option.name}: ${option.value}`);
  return parts.length > 0 ? parts.join(", ").slice(0, 1000) : undefined;
}

function readComponents(order: SwellRecord, language: Language): Component[] {
  const t = texts(language);
  const components: Component[] = [];

  for (const item of Array.isArray(order.items) ? order.items : []) {
    const quantity = Number(item.quantity) || 0;
    if (quantity <= 0) {
      continue;
    }
    const before = item.price_total !== undefined && item.price_total !== null
      ? toMicros(item.price_total)
      : toMicros(item.price) * quantity;
    const base = {
      kind: "item" as const,
      name: [item.product_name || "Artikel", item.variant_name].filter(Boolean).join(" – ").slice(0, 255),
      description: describeOptions(item),
      quantity,
      taxIncluded: Boolean(order.item_tax_included),
      before,
      discount: Math.min(toMicros(item.discount_total), before),
      tax: toMicros(item.tax_total),
    };
    const ids = Array.isArray(item.taxes) ? item.taxes.map((tax: SwellRecord) => tax.id) : undefined;
    components.push({ ...base, rate: findRate(declaredRate(order, ids, false), base) });
  }

  const shipmentPrice = toMicros(order.shipment_price);
  if (shipmentPrice > 0) {
    const base = {
      kind: "shipping" as const,
      name: t.shipping(order.shipping?.service_name || undefined).slice(0, 255),
      quantity: 1,
      taxIncluded: Boolean(order.shipment_tax_included),
      before: shipmentPrice,
      discount: Math.min(toMicros(order.shipment_discount), shipmentPrice),
      tax: toMicros(order.shipment_tax),
    };
    components.push({ ...base, rate: findRate(declaredRate(order, undefined, true), base) });
  }

  return components;
}

/** A line of `quantity` units that sevdesk will round to exactly `cents` */
function pricedLine(component: Component, cents: number): PricedLine {
  const { quantity } = component;
  const unity = component.kind === "item" ? UNIT.piece : UNIT.flat;
  const unit = divideRounded(cents * 100, quantity);
  if (divideRounded(unit * quantity, 100) === cents) {
    return { name: component.name, description: component.description, quantity, unity, unit, rate: component.rate };
  }
  // No unit price with four decimals multiplies back to the total: one line for the lot
  return {
    name: `${quantity} × ${component.name}`.slice(0, 255),
    description: component.description,
    quantity: 1,
    unity: UNIT.flat,
    unit: cents * 100,
    rate: component.rate,
  };
}

function discountLines(byRate: Map<number, number>, language: Language, code: string | undefined): PricedLine[] {
  const t = texts(language);
  const rates = [...byRate.entries()].filter(([, cents]) => cents > 0).sort((a, b) => b[0] - a[0]);
  return rates.map(([rate, cents]) => ({
    name: rates.length > 1 ? t.discountAtRate(formatRate(rate, language), code) : t.discount(code),
    quantity: 1,
    unity: UNIT.flat,
    unit: -cents * 100,
    rate,
  }));
}

/** Lines with the store's own net prices. sevdesk adds the tax, so the total has to be checked */
function linesNet(components: Component[], language: Language, code: string | undefined): PricedLine[] {
  const lines: PricedLine[] = [];
  const discounts = new Map<number, number>();

  for (const component of components) {
    lines.push(pricedLine(component, microsToCents(component.before)));
    discounts.set(component.rate, (discounts.get(component.rate) || 0) + component.discount);
  }
  for (const [rate, micros] of discounts) {
    discounts.set(rate, microsToCents(micros));
  }
  return [...lines, ...discountLines(discounts, language, code)];
}

/**
 * Lines with amounts that include tax and add up to exactly `totalCents`. Each component's
 * share of the total is what the customer paid for it; the fractions of a cent that Swell
 * carries are settled between the components.
 */
function linesGross(
  components: Component[],
  totalCents: number,
  language: Language,
  code: string | undefined,
): PricedLine[] | undefined {
  const exact = components.map((c) => c.before - c.discount + (c.taxIncluded ? 0 : c.tax));
  const after = exact.map((micros) => Math.floor(micros / 100));
  let left = totalCents - after.reduce((a, b) => a + b, 0);
  if (left < 0 || left > components.length) {
    return undefined;
  }
  const byLoss = exact
    .map((micros, index) => ({ index, lost: micros - Math.floor(micros / 100) * 100 }))
    .sort((a, b) => b.lost - a.lost || a.index - b.index);
  for (let i = 0; left > 0; i++, left--) {
    after[byLoss[i].index] += 1;
  }

  const lines: PricedLine[] = [];
  const discounts = new Map<number, number>();
  components.forEach((component, index) => {
    let before = after[index];
    if (component.discount > 0) {
      const listed = component.taxIncluded
        ? microsToCents(component.before)
        : divideRounded(component.before * (10000 + rateToBasisPoints(component.rate)), 1000000);
      before = Math.max(listed, after[index]);
    }
    lines.push(pricedLine(component, before));
    discounts.set(component.rate, (discounts.get(component.rate) || 0) + before - after[index]);
  });
  return [...lines, ...discountLines(discounts, language, code)];
}

/** sevdesk's own calculation, position by position. Amounts in cents */
export function simulate(
  lines: { quantity: number; unit: number; rate: number }[],
  showNet: boolean,
): { gross: number; tax: number } {
  let gross = 0;
  let tax = 0;
  for (const line of lines) {
    const amount = divideRounded(line.unit * line.quantity, 100);
    if (showNet) {
      const lineTax = taxOnNet(amount, line.rate);
      gross += amount + lineTax;
      tax += lineTax;
    } else {
      gross += amount;
      tax += amount - netOfGross(amount, line.rate);
    }
  }
  return { gross, tax };
}

function toLayout(lines: PricedLine[], showNet: boolean): Layout {
  return {
    showNet,
    positions: lines.map((line) => ({
      name: line.name,
      ...(line.description ? { text: line.description } : {}),
      quantity: line.quantity,
      price: line.unit / 10000,
      taxRate: line.rate,
      unity: line.unity,
    })),
  };
}

function splitName(name: string): { firstName?: string; lastName: string } {
  const words = name.trim().split(/\s+/);
  if (words.length < 2) {
    return { lastName: name.trim() };
  }
  return { firstName: words.slice(0, -1).join(" "), lastName: words[words.length - 1] };
}

function readRecipient(order: SwellRecord) {
  const billing: SwellRecord = order.billing || {};
  const shipping: SwellRecord = order.shipping || {};
  const source = billing.address1 || billing.country ? billing : shipping;
  const account: SwellRecord = order.account || {};

  const person = String(
    source.name ||
      [source.first_name, source.last_name].filter(Boolean).join(" ") ||
      billing.name ||
      shipping.name ||
      account.name ||
      [account.first_name, account.last_name].filter(Boolean).join(" ") ||
      "",
  ).trim();
  const company = String(source.company || "").trim();
  const country = String(source.country || "").toUpperCase();
  const street = [source.address1, source.address2].filter(Boolean).join(", ") || undefined;
  const place = [source.zip, source.city].filter(Boolean).join(" ") || undefined;
  const email = String(account.email || order.account_email || "").trim().toLowerCase() || undefined;

  return {
    person,
    company,
    country,
    street,
    zip: (source.zip || undefined) as string | undefined,
    city: (source.city || undefined) as string | undefined,
    email,
    // sevdesk prints the country under these lines itself
    address: [company, person, source.address1, source.address2, place].filter(Boolean).join("\n"),
  };
}

/** What rules an order out before sevdesk is asked anything */
export function checkOrder(order: SwellRecord): void {
  if (String(order.currency || "").toUpperCase() !== "EUR") {
    throw new Problem(
      "skipped",
      "currency",
      `The order is in ${order.currency || "an unknown currency"}. The app creates sevdesk documents in EUR only.`,
    );
  }
  if (order.draft) {
    throw new Problem("failed", "draft", "The order is a draft. Place it first.");
  }
}

/**
 * Builds the invoice for an order, or throws a Problem that says why there is none.
 * The order needs its `account` expanded for the customer's e-mail and VAT ID.
 */
export function buildInvoice(order: SwellRecord, options: BuildOptions): BuiltInvoice {
  checkOrder(order);

  const recipient = readRecipient(order);
  const customerName = recipient.company || recipient.person;
  if (!customerName) {
    throw new Problem("failed", "no_address", "The order has no name in its billing address.");
  }
  const addressCountryId = countryId(recipient.country);
  if (!addressCountryId) {
    throw new Problem(
      "failed",
      "no_country",
      recipient.country
        ? `sevdesk does not know the country "${recipient.country}" of the billing address.`
        : "The order has no country in its billing or shipping address.",
    );
  }

  const language = chooseLanguage(options.language, recipient.country);
  const t = texts(language);
  let components = readComponents(order, language);
  if (!components.some((component) => component.kind === "item")) {
    throw new Problem("failed", "no_items", "The order has no items.");
  }

  const totalCents = toCents(order.grand_total);
  const taxMicros = components.reduce((sum, component) => sum + component.tax, 0);
  const items: SwellRecord[] = (order.items || []).filter((item: SwellRecord) => Number(item.quantity) > 0);
  const untaxable = (item: SwellRecord) =>
    item.delivery === "giftcard" || toMicros(item.price_total) - toMicros(item.discount_total) <= 0;
  const goods = items.some((item) => item.delivery === "shipment");
  const services = items.some((item) => item.delivery !== "shipment" && !untaxable(item));
  const shippingCountry = String(order.shipping?.country || "").toUpperCase();
  const destination = goods ? shippingCountry || recipient.country : recipient.country || shippingCountry;

  const decision = classify({
    country: destination,
    taxCharged: taxMicros > 0,
    rates: [...new Set(components.filter((component) => component.tax > 0).map((component) => component.rate))],
    vatNumber: order.billing?.vat_number || order.account?.vat_number,
    goods,
    services,
    taxExempt: items.every(untaxable),
    smallBusiness: options.smallBusiness,
    ossAlways: options.ossAlways,
  });
  if (isProblem(decision)) {
    throw new Problem("failed", decision.code, decision.message);
  }

  const code: string | undefined = order.coupon_code || undefined;
  let lines: PricedLine[] | undefined;
  let showNet = false;
  let fallback: PricedLine[] | undefined;

  if (decision.taxed) {
    if (decision.rule === RULES.ossGoods || decision.rule === RULES.ossElectronic) {
      // The One-Stop-Shop rules have no 0 %. A line worth nothing takes the order's main rate
      const main = Math.max(...components.map((component) => component.rate));
      components = components.map((c) => (c.before - c.discount <= 0 ? { ...c, rate: main } : c));
    }
    const gross = linesGross(components, totalCents, language, code);
    if (components.every((component) => !component.taxIncluded)) {
      const net = linesNet(components, language, code);
      if (simulate(net, true).gross === totalCents) {
        lines = net;
        showNet = true;
        fallback = gross;
      }
    }
    lines = lines || gross;
  } else {
    // No tax on the document: what the customer paid is the net amount
    const untaxed = components.map((component) => ({ ...component, rate: 0, tax: 0 }));
    lines = linesGross(untaxed, totalCents, language, code);
    showNet = true;
  }

  const simulated = lines && simulate(lines, showNet);
  if (!lines || !simulated || simulated.gross !== totalCents) {
    throw new Problem(
      "failed",
      "total_mismatch",
      `The order's items, shipping, discounts and tax do not add up to its total of ${formatCents(totalCents)} EUR, so an invoice for exactly that amount cannot be built. Create this invoice in sevdesk by hand.`,
    );
  }

  const chargedCents = microsToCents(taxMicros);
  if (Math.abs(simulated.tax - chargedCents) > 2 + lines.length) {
    throw new Problem(
      "failed",
      "tax_mismatch",
      `The tax charged on the order (${formatCents(chargedCents)} EUR) is not what its tax rates give (${formatCents(simulated.tax)} EUR). Check the store's tax settings: tax has to be calculated on the price after discounts. Create this invoice in sevdesk by hand.`,
    );
  }

  const number = String(order.number || order.id);
  const destinationId = countryId(destination);
  const asCompany = Boolean(recipient.company || decision.vatNumber);
  const personName = recipient.person ? splitName(recipient.person) : undefined;

  return {
    layout: toLayout(lines, showNet),
    ...(fallback ? { fallback: toLayout(fallback, false) } : {}),
    decision,
    language,
    totalCents,
    header: t.invoice,
    headText: t.order(number, displayDate(order.date_created, language)),
    ...(order.paid ? { footText: t.paid(paymentMethodName(order.billing?.method, language)) } : {}),
    reference: number,
    address: recipient.address,
    countryId: addressCountryId,
    ...(destinationId && destinationId !== addressCountryId ? { deliveryCountryId: destinationId } : {}),
    deliveryDate: unixTime(order.date_created),
    contact: {
      ...(asCompany ? { company: recipient.company || recipient.person } : personName),
      ...(decision.vatNumber ? { vatNumber: decision.vatNumber } : {}),
      ...(recipient.email ? { email: recipient.email } : {}),
      street: recipient.street,
      zip: recipient.zip,
      city: recipient.city,
      countryId: addressCountryId,
    },
    // An order with neither an account nor an e-mail address stands alone: it must not be
    // filed under another customer's contact
    contactKey: [order.account_id || recipient.email || `order:${order.id}`, decision.vatNumber || ""].join("|"),
    customerName,
    customerEmail: recipient.email,
  };
}
