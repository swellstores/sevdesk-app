/**
 * The ledger: one record in the app's `documents` collection per invoice and per credit note.
 *
 * sevdesk has no idempotency key and cannot search by the app's reference, so the ledger is
 * what keeps an order from being invoiced twice. The record is written first, under a key
 * that is unique in the collection; whoever comes second finds it and continues it. The
 * sevdesk ids are saved on it after each step, so an attempt that is cut short is picked
 * up where it stopped.
 */

import type { StoreClient } from "./settings";

export type DocumentStatus = "pending" | "created" | "failed" | "skipped" | "resolved";
export type SevdeskStatus = "draft" | "open" | "partly_paid" | "paid";

export interface RateAmount {
  rate: number;
  gross: number;
}

export interface DocumentRecord {
  id: string;
  key: string;
  /** What the dashboard calls the record: the document number, or the order until there is one */
  name?: string;
  type: "invoice" | "credit_note";
  status: DocumentStatus;
  source?: string;
  order_id?: string;
  order_number?: string;
  account_id?: string;
  payment_id?: string;
  refund_id?: string;
  reference?: string;
  customer_name?: string;
  customer_email?: string;
  language?: "de" | "en";
  amount?: number;
  currency?: string;
  /** The sevdesk tax rule, in words */
  tax_rule?: string;
  sevdesk_id?: string | null;
  /** draft, open, partly_paid or paid, as it was when the app last read it */
  sevdesk_status?: SevdeskStatus | null;
  sevdesk_url?: string | null;
  number?: string | null;
  invoice_number?: string | null;
  contact_id?: string | null;
  contact_key?: string | null;
  /** The PDF's language has been set in sevdesk */
  language_set?: boolean;
  /** Credit notes: the refund's payment method, which decides the account the payout is booked on */
  payment_method?: string | null;
  /** Credit notes: what the document holds at each tax rate, in EUR including tax */
  rates?: RateAmount[] | null;
  /** What sevdesk holds as paid on the document after the app's bookings */
  booked_amount?: number | null;
  /** What the app did about the payments, in words */
  booking_note?: string | null;
  /** Set once the payments have been dealt with, whether or not anything was booked */
  date_booked?: string | null;
  pdf?: { id?: string; url?: string; filename?: string } | null;
  problem?: string | null;
  problem_code?: string | null;
  attempts?: number;
  date_attempted?: string | null;
  date_submitted?: string | null;
  /** Since when the record has been waiting for sevdesk. Empty once it is created, failed or skipped */
  date_pending?: string | null;
  date_issued?: string | null;
  locked_until?: string | null;
  notify_customer?: boolean;
  date_created?: string;
}

export function isRecordId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{24}$/i.test(value);
}

/** Records whose document is a draft in sevdesk */
export const DRAFT = { status: "created", sevdesk_status: "draft" };

/** Records that are not finished: they need the merchant, or another attempt */
export const UNFINISHED = {
  $or: [{ status: "failed" }, { status: "pending" }, { status: "created", problem_code: "temporary" }],
};

/** Records that wait for another attempt and have had none since `before` (an ISO date) */
export function stale(before: string) {
  return {
    $and: [
      { $or: [{ status: "pending" }, { status: "created", problem_code: "temporary" }] },
      { date_attempted: { $lt: before } },
    ],
  };
}

export function invoiceKey(orderId: string): string {
  return `invoice:${orderId}`;
}

export function creditNoteKey(refundId: string): string {
  return `credit_note:${refundId}`;
}

export async function findByKey(swell: StoreClient, key: string): Promise<DocumentRecord | undefined> {
  const found = (await swell.get("/documents", { where: { key }, limit: 1 })) as { results?: DocumentRecord[] };
  return found?.results?.[0];
}

/**
 * Returns the record for `key`, creating it when there is none. Two callers that arrive
 * together both get the same record: the unique key lets only one create it.
 */
export async function claim(
  swell: StoreClient,
  key: string,
  data: Partial<DocumentRecord>,
  /** The caller has just looked and found none */
  absent = false,
): Promise<{ doc: DocumentRecord; created: boolean }> {
  const existing = absent ? undefined : await findByKey(swell, key);
  if (existing) {
    return { doc: existing, created: false };
  }
  let created: any;
  let failure: unknown;
  try {
    created = await swell.post("/documents", { ...data, key, status: "pending", attempts: 1 });
  } catch (err) {
    failure = err;
  }
  // A workflow's client reports a refused write as `errors` and does not throw
  if (created?.id && !created.errors) {
    return { doc: created as DocumentRecord, created: true };
  }
  const winner = await findByKey(swell, key);
  if (winner) {
    return { doc: winner, created: false };
  }
  throw failure || new Error(`Unable to create the document record: ${JSON.stringify(created?.errors || created)}`);
}

/**
 * Takes the record for one attempt. The attempt counter is raised by the store itself, so
 * of several callers that read the record at the same moment at most one finds it exactly
 * one higher than it was. Only that caller may go on; false tells the others to stop.
 */
export async function take(swell: StoreClient, doc: DocumentRecord, changes: Partial<DocumentRecord>): Promise<boolean> {
  const before = doc.attempts || 0;
  const stored: any = await swell.put(`/documents/${doc.id}`, { ...changes, $inc: { attempts: 1 } });
  if (stored?.errors) {
    throw new Error(`Unable to update the document record: ${JSON.stringify(stored.errors)}`);
  }
  Object.assign(doc, changes, { attempts: stored?.attempts ?? before + 1 });
  return doc.attempts === before + 1;
}

const NOTIFY = { $events: true, $notify: "document-ready.v2" };

/** Writes `changes` and keeps `doc` in step with what was stored */
export async function save(swell: StoreClient, doc: DocumentRecord, changes: Partial<DocumentRecord>): Promise<void> {
  // The customer's e-mail is sent by the event of this change, and a write made in a
  // workflow raises no events unless it asks for them. It also has to name the
  // notification: without the name, the store drops the e-mail of some workflow writes
  const stored: any = await swell.put(`/documents/${doc.id}`, changes.notify_customer === true ? { ...changes, ...NOTIFY } : changes);
  if (stored?.errors) {
    throw new Error(`Unable to update the document record: ${JSON.stringify(stored.errors)}`);
  }
  Object.assign(doc, changes);
  if ("pdf" in changes && stored?.pdf) {
    doc.pdf = stored.pdf;
  }
}

/** The record's name in the dashboard while sevdesk has not numbered the document */
export function provisionalName(type: DocumentRecord["type"], orderNumber: string | undefined): string {
  return `${type === "invoice" ? "Invoice" : "Credit note"} for order ${orderNumber || "?"}`;
}

export function describe(doc: DocumentRecord): string {
  const what = doc.type === "invoice" ? "Invoice" : "Credit note";
  return doc.number ? `${what} ${doc.number}` : `${what} for order ${doc.order_number || doc.order_id || ""}`.trim();
}
