/**
 * Decides which of an order's payments are booked in sevdesk, and on which payment account.
 *
 * sevdesk books a payment directly only on an account without a bank behind it: its own
 * "Basiskonto", a cash register or a clearing account (Verrechnungskonto). On a connected
 * bank or PayPal account the booking needs the imported transaction, which the API cannot
 * know. So the merchant names a clearing account for shop payments, and may send single
 * payment methods to another account or leave them alone. Gift cards and store credit are
 * no money arriving and are left alone unless the merchant names an account for them.
 */

import { Problem } from "./invoice";
import type { SwellRecord } from "./invoice";
import { formatCents, toCents } from "./money";
import type { CheckAccount } from "./sevdesk";
import type { Settings } from "./settings";

/** Methods that pay with value the customer already holds */
const NOT_MONEY = ["giftcard", "account"];

export interface Booking {
  method: string;
  cents: number;
  /** Unix time of the payment */
  date: number;
  /** The sevdesk account's name, as the merchant wrote it */
  account: string;
}

export interface BookingPlan {
  bookings: Booking[];
  /** Payments that are not booked, because their method has no account */
  open: { method: string; cents: number }[];
}

function normal(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

/** The sevdesk account a payment method is booked on, or nothing when it is left alone */
export function accountFor(settings: Settings, method: string | undefined | null): string | undefined {
  const key = normal(method);
  const exception = (settings.payments?.exceptions || []).find((row) => normal(row?.method) === key && key !== "");
  if (exception) {
    return (exception.account || "").trim() || undefined;
  }
  if (NOT_MONEY.includes(key)) {
    return undefined;
  }
  return (settings.payments?.account || "").trim() || undefined;
}

/** The order's successful payments in the order they were made, capped at the invoice total */
export function planBookings(payments: SwellRecord[], settings: Settings, totalCents: number): BookingPlan {
  const plan: BookingPlan = { bookings: [], open: [] };
  const paid = payments
    .filter((payment) => payment?.success === true && payment.captured !== false && !payment.void)
    .sort((a, b) => String(a.date_created || "").localeCompare(String(b.date_created || "")) || String(a.id).localeCompare(String(b.id)));
  let left = totalCents;

  for (const payment of paid) {
    const cents = Math.min(toCents(payment.amount), left);
    if (cents <= 0) {
      continue;
    }
    left -= cents;
    const method = String(payment.method || "");
    const account = accountFor(settings, method);
    if (account) {
      const time = new Date(payment.date_created || Date.now()).getTime();
      plan.bookings.push({ method, cents, date: Math.floor((Number.isNaN(time) ? Date.now() : time) / 1000), account });
    } else {
      plan.open.push({ method, cents });
    }
  }
  return plan;
}

/** The sevdesk account with this name (or id). Throws what the merchant has to correct */
export function resolveAccount(accounts: CheckAccount[], name: string): CheckAccount {
  const key = normal(name);
  const account = accounts.find((entry) => normal(entry.name) === key) || accounts.find((entry) => entry.id === key);
  if (!account) {
    throw new Problem(
      "failed",
      "no_account",
      `sevdesk has no payment account named "${name}", so the payment was not booked. Correct the name under Payments in the app's settings (Test connection lists the accounts), then retry.`,
    );
  }
  if (account.type !== "offline") {
    throw new Problem(
      "failed",
      "online_account",
      `The sevdesk account "${account.name}" is connected to a bank, and sevdesk books payments there only from its imported transactions. Name a clearing account (Verrechnungskonto) under Payments in the app's settings, then retry.`,
    );
  }
  return account;
}

/** What was done about the payments, for the merchant */
export function describeBooking(plan: BookingPlan, paidCents: number, totalCents: number, hasAccount: boolean): string {
  const parts: string[] = [];
  if (paidCents >= totalCents && totalCents > 0) {
    parts.push("Paid in sevdesk.");
  } else if (paidCents > 0) {
    parts.push(`${formatCents(paidCents)} of ${formatCents(totalCents)} EUR booked in sevdesk.`);
  }
  if (plan.open.length > 0) {
    const methods = [...new Set(plan.open.map((entry) => entry.method || "unknown"))].join(", ");
    const cents = plan.open.reduce((sum, entry) => sum + entry.cents, 0);
    parts.push(
      hasAccount
        ? `Not booked: ${formatCents(cents)} EUR paid by ${methods}, which has no sevdesk account in the app's settings.`
        : `Not booked: no sevdesk payment account is set in the app's settings.`,
    );
  } else if (plan.bookings.length === 0 && paidCents < totalCents) {
    parts.push("Not booked: the order has no payment yet.");
  }
  return parts.join(" ");
}
