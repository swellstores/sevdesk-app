/**
 * Turns a Swell refund into a sevdesk credit note for the order's invoice.
 *
 * A refund in Swell is an amount on a payment. It names no items. The credit note is
 * therefore built from the invoice as sevdesk holds it:
 * - a refund of the whole invoice repeats the invoice's positions
 * - a partial refund becomes one position per tax rate, as gross amounts that add up to
 *   exactly the refunded amount
 *
 * sevdesk checks the credit notes of an invoice per tax rate: together they may not exceed
 * what the invoice holds at that rate. So a partial refund is split in the proportion of
 * what the invoice still holds at each rate after the earlier credit notes.
 */

import type { RateAmount } from "./documents";
import { Problem } from "./invoice";
import { allocate, formatCents, toCents } from "./money";
import type { DocumentDraft, Position, SevDocument, SevPosition } from "./sevdesk";
import { formatRate, texts } from "./texts";
import type { Language } from "./texts";

export interface CreditNoteInput {
  /** The invoice and its positions as read from sevdesk */
  invoice: SevDocument;
  positions: SevPosition[];
  refundCents: number;
  /** The earlier credit notes of the same invoice: their totals, and their split over the rates when known */
  earlier: { cents: number; rates?: RateAmount[] | null }[];
  orderNumber: string;
  /** Tells the refunds of one order apart, on the document and in sevdesk's reference field */
  reference: string;
  language: Language;
  /** Unix time of the credit note */
  date: number;
}

export interface BuiltCreditNote {
  draft: DocumentDraft;
  totalCents: number;
  rates: RateAmount[];
}

/** What the positions hold at each tax rate, in cents including tax, highest rate first */
function sumByRate(positions: { taxRate: number; sumGross: number }[]): Map<number, number> {
  const sums = new Map<number, number>();
  for (const position of positions) {
    sums.set(position.taxRate, (sums.get(position.taxRate) || 0) + toCents(position.sumGross));
  }
  return new Map([...sums.entries()].sort((a, b) => b[0] - a[0]));
}

export function buildCreditNote(input: CreditNoteInput): BuiltCreditNote {
  const { invoice, refundCents, language } = input;
  const invoiceCents = toCents(invoice.sumGross);
  const invoiceNumber = invoice.number || "";
  const creditedCents = input.earlier.reduce((sum, credit) => sum + credit.cents, 0);
  const t = texts(language);

  if (refundCents <= 0) {
    throw new Problem("failed", "no_amount", "The refund has no amount.");
  }
  if (creditedCents + refundCents > invoiceCents) {
    throw new Problem(
      "failed",
      "refund_exceeds",
      `Refunds of ${formatCents(creditedCents + refundCents)} EUR are more than invoice ${invoiceNumber} of ${formatCents(invoiceCents)} EUR. Create this credit note in sevdesk by hand.`,
    );
  }

  const held = sumByRate(input.positions);
  if (held.size === 0) {
    // Without them the tax rates are unknown, and a guess would book the refund at the wrong VAT
    throw new Problem(
      "failed",
      "invoice_no_positions",
      `sevdesk shows no positions for invoice ${invoiceNumber}, so the credit note cannot be split by tax rate. Create this credit note in sevdesk by hand, then mark it as resolved.`,
    );
  }
  let positions: Position[];
  let showNet = invoice.showNet;
  let rates: RateAmount[];

  if (refundCents === invoiceCents && creditedCents === 0 && input.positions.length > 0) {
    positions = input.positions.map(({ sumGross, ...position }) => position);
    rates = [...held.entries()].map(([rate, cents]) => ({ rate, gross: cents / 100 }));
  } else {
    // What each rate still holds: the invoice, less the earlier credit notes
    const left = new Map(held);
    for (const credit of input.earlier) {
      const known = credit.rates?.length ? credit.rates.map((entry) => ({ rate: entry.rate, cents: toCents(entry.gross) })) : undefined;
      const order = [...left.keys()];
      const parts = known || allocate(credit.cents, order.map((rate) => Math.max(left.get(rate) || 0, 0))).map((cents, i) => ({ rate: order[i], cents }));
      for (const part of parts) {
        left.set(part.rate, (left.get(part.rate) || 0) - part.cents);
      }
    }
    const open = [...left.entries()].map(([rate, cents]) => ({ rate, cents: Math.max(cents, 0) }));
    if (open.reduce((sum, entry) => sum + entry.cents, 0) < refundCents) {
      throw new Problem(
        "failed",
        "refund_exceeds",
        `The refund of ${formatCents(refundCents)} EUR is more than invoice ${invoiceNumber} still holds after its earlier credit notes. Create this credit note in sevdesk by hand.`,
      );
    }
    const parts = allocate(refundCents, open.map((entry) => entry.cents));
    const split = open.map((entry, index) => ({ rate: entry.rate, cents: parts[index] })).filter((entry) => entry.cents > 0);
    // Gross amounts add up to the refund exactly. Net amounts would leave the last cent to sevdesk's rounding
    showNet = false;
    positions = split.map((entry) => ({
      name: t.refundLine(held.size > 1 ? formatRate(entry.rate, language) : undefined),
      quantity: 1,
      price: entry.cents / 100,
      taxRate: entry.rate,
      unity: 7,
    }));
    rates = split.map((entry) => ({ rate: entry.rate, gross: entry.cents / 100 }));
  }

  const delivered = invoice.deliveryDate ? Math.floor(new Date(invoice.deliveryDate).getTime() / 1000) : NaN;

  return {
    draft: {
      contactId: invoice.contactId,
      contactPersonId: invoice.contactPersonId,
      date: input.date,
      // sevdesk wants the invoice's delivery date repeated, and none earlier than it
      deliveryDate: Number.isFinite(delivered) ? delivered : input.date,
      header: t.creditNote(invoiceNumber),
      headText: t.refund(input.orderNumber, input.reference),
      address: invoice.address,
      countryId: invoice.countryId,
      ...(invoice.deliveryCountryId ? { deliveryCountryId: invoice.deliveryCountryId } : {}),
      taxRule: invoice.taxRule,
      showNet,
      reference: `${input.orderNumber} / ${input.reference}`,
      positions,
      invoiceId: invoice.id,
    },
    totalCents: refundCents,
    rates,
  };
}
