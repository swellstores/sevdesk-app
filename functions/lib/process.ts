/**
 * Creates documents in sevdesk, one step at a time, with the ledger record as the state.
 *
 *   claim the record → contact → draft → check the total → finalize → book the payment → PDF → e-mail
 *
 * Every step is saved before the next begins, so any caller (a store event, a dashboard
 * action, the bulk workflow, a retry of any of them) can pick a record up where the last
 * attempt stopped. What keeps a step from happening twice:
 * - a record that is being worked on is locked, and of several attempts that start at the
 *   same moment only one gets it
 * - a draft has no number and can be deleted, so everything uncertain happens on the
 *   draft. Before the create call the record is marked as submitted; a record still marked
 *   on a later attempt means the answer never came, and the draft is looked for in sevdesk
 *   before another one is created
 * - finalizing a finalized document changes nothing
 * - before a payment is booked, the app reads what sevdesk already holds as paid
 *
 * One document is eight to ten calls to sevdesk and takes longer than a function may run,
 * so the work is done in workflow steps (functions/process-documents.ts). The functions
 * that receive the store's events only write the record and start a run.
 */

import { raiseAlert, settleAlerts } from "./alerts";
import { buildCreditNote } from "./credit-note";
import { unixTime } from "./dates";
import { claim, creditNoteKey, describe, findByKey, invoiceKey, provisionalName, save, take } from "./documents";
import type { DocumentRecord, SevdeskStatus } from "./documents";
import { Problem, buildInvoice, checkOrder } from "./invoice";
import type { BuiltInvoice, Layout, SwellRecord } from "./invoice";
import { formatCents, toCents } from "./money";
import { accountFor, describeBooking, planBookings, resolveAccount } from "./payments";
import {
  STATUS,
  SevdeskError,
  addContactDetails,
  bookAmount,
  contactExists,
  createContact,
  deleteDraft,
  documentLink,
  finalize,
  findContactsByEmail,
  getCheckAccounts,
  getDocument,
  getInvoicePositions,
  getPdf,
  getProfile,
  listDrafts,
  saveDraft,
  setLanguage,
} from "./sevdesk";
import type { Api, CheckAccount, DocumentDraft, Kind, Profile, SevDocument } from "./sevdesk";
import { apiToken, creditNotesEnabled, finalizes } from "./settings";
import type { Settings, StoreClient } from "./settings";

// Longer than a run takes when sevdesk is slow. A run that dies leaves the record locked
// for this long, then the next attempt takes it
const LOCK_MS = 2 * 60 * 1000;
// sevdesk may finish a request after the app stopped waiting for it
const SETTLE_MS = 60 * 1000;

export interface Context {
  swell: StoreClient;
  settings: Settings;
  /** Finalize the document although the settings say drafts: the merchant chose it for this one */
  finalize?: boolean;
  /** Look at the order's payments again, also for an invoice whose payments were dealt with */
  rebook?: boolean;
  /** Read once per context */
  profile?: Profile;
  accounts?: CheckAccount[];
  /** Orders read while their record was claimed, by id */
  orders?: Record<string, SwellRecord>;
  now?: () => Date;
}

export type Result =
  /** The document is in sevdesk and everything after it is done */
  | "created"
  /** It was complete already */
  | "exists"
  /** Another attempt is working on it right now */
  | "busy"
  /** It needs the merchant. The record says why */
  | "failed"
  /** The app does not handle this order */
  | "skipped"
  /** sevdesk could not be reached or is busy. The same attempt can succeed later */
  | "retry";

export interface Outcome {
  doc: DocumentRecord;
  result: Result;
  message: string;
}

function lock(from: Date): Partial<DocumentRecord> {
  return { locked_until: new Date(from.getTime() + LOCK_MS).toISOString(), date_attempted: from.toISOString() };
}

/** What a new record starts with: waiting since now, and locked when the caller works on it at once */
function attempt(from: Date, locked: boolean): Partial<DocumentRecord> {
  return { date_attempted: from.toISOString(), date_pending: from.toISOString(), ...(locked ? lock(from) : {}) };
}

function now(ctx: Context): Date {
  return ctx.now ? ctx.now() : new Date();
}

function api(ctx: Context): Api {
  return { token: apiToken(ctx.settings) };
}

function kindOf(doc: DocumentRecord): Kind {
  return doc.type === "invoice" ? "Invoice" : "CreditNote";
}

function wantsFinal(ctx: Context): boolean {
  return ctx.finalize === true || finalizes(ctx.settings);
}

function wantsEmail(ctx: Context, doc: DocumentRecord): boolean {
  return ctx.settings.documents?.send_email === true && Boolean(doc.customer_email);
}

function statusName(status: number): SevdeskStatus {
  if (status >= STATUS.paid) {
    return "paid";
  }
  if (status >= STATUS.partlyPaid) {
    return "partly_paid";
  }
  return status >= STATUS.open ? "open" : "draft";
}

function isComplete(ctx: Context, doc: DocumentRecord): boolean {
  if (doc.status !== "created" || !doc.sevdesk_id || !doc.number) {
    return false;
  }
  // A draft is read again each time: the merchant may have finalized or deleted it in sevdesk
  if (!doc.sevdesk_status || doc.sevdesk_status === "draft") {
    return false;
  }
  if (!doc.date_booked || (ctx.rebook && doc.type === "invoice" && toCents(doc.booked_amount) < toCents(doc.amount))) {
    return false;
  }
  return Boolean(doc.pdf) && (!wantsEmail(ctx, doc) || doc.notify_customer === true);
}

/** False for a record that has nothing left to do */
export function needsWork(ctx: Context, doc: DocumentRecord): boolean {
  return doc.status !== "resolved" && !isComplete(ctx, doc);
}

async function profileOf(ctx: Context): Promise<Profile> {
  const profile = ctx.profile || (await getProfile(api(ctx)));
  if (profile.version !== "2.0") {
    throw new SevdeskError(
      "permission",
      0,
      `The sevdesk account uses the bookkeeping system ${profile.version || "1.0"}. The app needs sevdesk-Update 2.0, which sevdesk offers under Einstellungen → System.`,
    );
  }
  ctx.profile = profile;
  return profile;
}

/** The app's own draft among the contact's drafts, recognised by the reference it carries */
async function findDraft(ctx: Context, kind: Kind, contactId: string, reference: string): Promise<SevDocument | undefined> {
  const drafts = await listDrafts(api(ctx), kind, contactId);
  return drafts.find((draft) => draft.reference === reference);
}

/**
 * Creates the draft, or finds the one an earlier attempt created without learning of it.
 * `details` are saved with the mark, in one write.
 */
async function submit(
  ctx: Context,
  doc: DocumentRecord,
  draft: DocumentDraft,
  details: Partial<DocumentRecord>,
): Promise<SevDocument> {
  const kind = kindOf(doc);
  if (doc.date_submitted) {
    const found = await findDraft(ctx, kind, draft.contactId, draft.reference);
    if (found) {
      return found;
    }
    if (now(ctx).getTime() - new Date(doc.date_submitted).getTime() < SETTLE_MS) {
      throw new SevdeskError("unavailable", 0, "sevdesk has not confirmed the last attempt yet. Try again in a minute.");
    }
  }
  await save(ctx.swell, doc, { ...details, date_submitted: now(ctx).toISOString() });
  try {
    return await saveDraft(api(ctx), kind, draft);
  } catch (err) {
    if (err instanceof SevdeskError && !err.uncertain) {
      // sevdesk answered and did not create anything
      await save(ctx.swell, doc, { date_submitted: null });
    }
    throw err;
  }
}

/** Removes a draft of the app that is not wanted after all. It has no number */
async function discard(ctx: Context, doc: DocumentRecord, id: string): Promise<void> {
  await deleteDraft(api(ctx), kindOf(doc), id);
  await save(ctx.swell, doc, { date_submitted: null });
}

/**
 * The sevdesk contact for the order's customer: the one that carries the customer's e-mail
 * address, the one an earlier order of the customer used, or a new one. Existing contacts
 * are never changed.
 */
async function ensureContact(ctx: Context, doc: DocumentRecord, built: BuiltInvoice): Promise<string> {
  if (doc.contact_id && doc.contact_key === built.contactKey) {
    return doc.contact_id;
  }
  const wanted = built.contact.vatNumber;
  const sameVat = (value: string | null) => (value || "").replace(/[\s.-]+/g, "").toUpperCase() === wanted;
  const [byEmail, earlier] = await Promise.all([
    built.contact.email ? findContactsByEmail(api(ctx), built.contact.email) : [],
    ctx.swell.get("/documents", {
      where: { contact_key: built.contactKey, contact_id: { $ne: null } },
      sort: "date_created desc",
      limit: 1,
    }) as Promise<{ results?: DocumentRecord[] }>,
  ]);

  // A tax-free invoice to a business needs a contact that carries its VAT ID
  let id = (wanted ? byEmail.find((contact) => sameVat(contact.vatNumber)) : byEmail[0])?.id;
  const known = earlier?.results?.[0]?.contact_id;
  if (!id && known && (await contactExists(api(ctx), known))) {
    id = known;
  }
  if (!id) {
    id = await createContact(api(ctx), built.contact);
    try {
      await addContactDetails(api(ctx), id, built.contact);
    } catch (err) {
      // The invoice carries the address itself, and the customer's later orders find the
      // contact through the ledger
      console.error("Unable to add the address or e-mail to the sevdesk contact", (err as Error).message);
    }
  }
  await save(ctx.swell, doc, { contact_id: id, contact_key: built.contactKey });
  return id;
}

function invoiceDetails(order: SwellRecord, built: BuiltInvoice): Partial<DocumentRecord> {
  return {
    name: provisionalName("invoice", String(order.number || "")),
    order_number: String(order.number || ""),
    account_id: order.account_id,
    customer_name: built.customerName,
    customer_email: built.customerEmail,
    language: built.language,
    amount: built.totalCents / 100,
    currency: "EUR",
    tax_rule: built.decision.rule.label,
  };
}

/** What the documents list shows about an order, known before any invoice can be built */
function orderDetails(order: SwellRecord): Partial<DocumentRecord> {
  const euro = String(order.currency || "").toUpperCase() === "EUR";
  return {
    name: provisionalName("invoice", String(order.number || "")),
    order_number: String(order.number || ""),
    account_id: order.account_id,
    // The total column is in EUR. An order in another currency is listed without one
    ...(euro ? { amount: order.grand_total } : {}),
    currency: order.currency,
    customer_name: order.billing?.name || order.shipping?.name || order.account?.name,
    customer_email: order.account?.email,
  };
}

function readOrder(ctx: Context, orderId: string): Promise<SwellRecord> {
  return ctx.swell.get(`/orders/${orderId}`, { expand: ["account"] }) as Promise<SwellRecord>;
}

async function readPayments(ctx: Context, orderId: string): Promise<SwellRecord[]> {
  const found = (await ctx.swell.get("/payments", { where: { order_id: orderId }, limit: 100 })) as { results?: SwellRecord[] };
  return found?.results || [];
}

function toDraft(built: BuiltInvoice, layout: Layout, contactId: string, profile: Profile, date: Date): DocumentDraft {
  return {
    contactId,
    contactPersonId: profile.userId,
    date: unixTime(date),
    deliveryDate: built.deliveryDate,
    header: built.header,
    headText: built.headText,
    footText: built.footText,
    address: built.address,
    countryId: built.countryId,
    deliveryCountryId: built.deliveryCountryId,
    taxRule: built.decision.rule.id,
    showNet: layout.showNet,
    reference: built.reference,
    positions: layout.positions,
    // The account's own payment term, as on an invoice written in sevdesk. Left out, an
    // invoice that is still open is listed there as overdue the day after
    timeToPay: profile.timeToPay,
  };
}

async function createInvoice(ctx: Context, doc: DocumentRecord): Promise<SevDocument> {
  const orderId = doc.order_id as string;
  const [order, profile] = await Promise.all([
    ctx.orders?.[orderId] || readOrder(ctx, orderId),
    // Held back until the order is known to need sevdesk at all
    profileOf(ctx).catch((err: unknown) => err as Error),
  ]);
  if (!order?.id) {
    throw new Problem("failed", "no_order", "The order no longer exists.");
  }

  let built: BuiltInvoice;
  try {
    checkOrder(order);
    if (profile instanceof Error) {
      throw profile;
    }
    built = buildInvoice(order, {
      smallBusiness: profile.smallBusiness,
      language: ctx.settings.documents?.language,
      ossAlways: ctx.settings.documents?.oss === "always",
    });
  } catch (err) {
    // What is known about the order is kept even when no invoice can be built for it
    if (!doc.order_number) {
      await save(ctx.swell, doc, orderDetails(order));
    }
    throw err;
  }

  const contactId = await ensureContact(ctx, doc, built);
  const details = invoiceDetails(order, built);
  const started = now(ctx);
  try {
    // sevdesk's own total on the draft decides. A net draft that is a cent off is replaced
    // by the same lines as gross amounts; if that differs too, nothing gets a number
    let saved = await submit(ctx, doc, toDraft(built, built.layout, contactId, profile, started), details);
    if (toCents(saved.sumGross) !== built.totalCents && built.fallback) {
      await discard(ctx, doc, saved.id);
      saved = await submit(ctx, doc, toDraft(built, built.fallback, contactId, profile, started), details);
    }
    if (toCents(saved.sumGross) !== built.totalCents) {
      await discard(ctx, doc, saved.id);
      throw new Problem(
        "failed",
        "total_mismatch",
        `sevdesk calculates ${formatCents(toCents(saved.sumGross))} EUR for this order, and its total is ${formatCents(built.totalCents)} EUR. No invoice was created. Create it in sevdesk by hand.`,
      );
    }
    return saved;
  } catch (err) {
    if (err instanceof SevdeskError && err.kind === "rejected") {
      err.hint = explainRejection(err.message, built);
    }
    throw err;
  }
}

async function createCreditNote(ctx: Context, doc: DocumentRecord): Promise<SevDocument> {
  const orderId = doc.order_id as string;
  const invoiceDoc = await findByKey(ctx.swell, invoiceKey(orderId));
  if (invoiceDoc?.status === "resolved") {
    throw new Problem(
      "failed",
      "invoice_by_hand",
      "The invoice for this order was resolved by hand, so the app does not know it in sevdesk. Create this credit note in sevdesk by hand, then mark it as resolved.",
    );
  }
  if (!invoiceDoc?.sevdesk_id) {
    throw new Problem(
      "failed",
      "no_invoice",
      "The invoice for this order has not been created in sevdesk yet. Create it first, then retry this credit note.",
    );
  }

  const [invoice, positions, earlier] = await Promise.all([
    getDocument(api(ctx), "Invoice", invoiceDoc.sevdesk_id).catch((err: unknown) => {
      if (err instanceof SevdeskError && err.notFound) {
        throw new Problem(
          "failed",
          "invoice_gone",
          `${describe(invoiceDoc)} no longer exists in the connected sevdesk account, so the credit note cannot be built from it. Create this credit note in sevdesk by hand, then mark it as resolved.`,
        );
      }
      throw err;
    }),
    getInvoicePositions(api(ctx), invoiceDoc.sevdesk_id).catch(() => []),
    ctx.swell.get("/documents", {
      where: { order_id: orderId, type: "credit_note", sevdesk_id: { $ne: null }, id: { $ne: doc.id } },
      limit: 100,
    }) as Promise<{ results?: DocumentRecord[] }>,
  ]);
  if (invoice.status < STATUS.open) {
    throw new Problem(
      "failed",
      "invoice_draft",
      `${describe(invoiceDoc)} is still a draft in sevdesk, and sevdesk accepts a credit note only for a finalized invoice. Finalize the invoice, then retry this credit note.`,
    );
  }

  const reference = doc.reference || String(doc.refund_id || doc.id).slice(-8).toUpperCase();
  const built = buildCreditNote({
    invoice,
    positions,
    refundCents: toCents(doc.amount),
    earlier: (earlier?.results || []).map((credit) => ({ cents: toCents(credit.amount), rates: credit.rates })),
    orderNumber: doc.order_number || invoiceDoc.order_number || "",
    reference,
    language: invoiceDoc.language === "en" ? "en" : "de",
    date: unixTime(now(ctx)),
  });

  const details: Partial<DocumentRecord> = {
    reference,
    invoice_number: invoice.number,
    language: invoiceDoc.language === "en" ? "en" : "de",
    tax_rule: invoiceDoc.tax_rule,
    contact_id: invoice.contactId,
    rates: built.rates,
  };
  const saved = await submit(ctx, doc, built.draft, details);
  if (toCents(saved.sumGross) !== built.totalCents) {
    await discard(ctx, doc, saved.id);
    throw new Problem(
      "failed",
      "total_mismatch",
      `sevdesk calculates ${formatCents(toCents(saved.sumGross))} EUR for this credit note, and the refund is ${formatCents(built.totalCents)} EUR. No credit note was created. Create it in sevdesk by hand.`,
    );
  }
  return saved;
}

/** What the app did about the invoice's payments: each one booked on the account its method has */
async function bookInvoice(ctx: Context, doc: DocumentRecord, remote: SevDocument): Promise<Partial<DocumentRecord>> {
  const orderId = doc.order_id as string;
  const payments = await readPayments(ctx, orderId);
  const total = toCents(remote.sumGross);
  const plan = planBookings(payments, ctx.settings, total);
  let paid = toCents(remote.paidAmount);
  let status = remote.status;

  if (plan.bookings.length > 0 && paid < total) {
    ctx.accounts = ctx.accounts || (await getCheckAccounts(api(ctx)));
    const accounts = plan.bookings.map((booking) => resolveAccount(ctx.accounts as CheckAccount[], booking.account));
    // What sevdesk holds as paid already is counted against the first payments, so a
    // booking whose answer was lost is not made again
    let covered = paid;
    for (const [index, booking] of plan.bookings.entries()) {
      if (covered >= booking.cents) {
        covered -= booking.cents;
        continue;
      }
      const cents = Math.min(booking.cents - covered, total - paid);
      covered = 0;
      if (cents <= 0) {
        continue;
      }
      status = await bookAmount(api(ctx), "Invoice", remote.id, {
        amount: cents / 100,
        date: booking.date,
        accountId: accounts[index].id,
      });
      paid += cents;
    }
  }
  return {
    booked_amount: paid / 100,
    date_booked: now(ctx).toISOString(),
    booking_note: describeBooking(plan, paid, total, Boolean((ctx.settings.payments?.account || "").trim())),
    sevdesk_status: statusName(Math.max(status, paid >= total ? STATUS.paid : paid > 0 ? STATUS.partlyPaid : STATUS.open)),
  };
}

/** The payout of a credit note, booked on the account of the refund's payment method */
async function bookCreditNote(ctx: Context, doc: DocumentRecord, remote: SevDocument): Promise<Partial<DocumentRecord>> {
  const name = accountFor(ctx.settings, doc.payment_method);
  let status = remote.status;
  if (name && status < STATUS.paid) {
    ctx.accounts = ctx.accounts || (await getCheckAccounts(api(ctx)));
    const account = resolveAccount(ctx.accounts, name);
    status = await bookAmount(api(ctx), "CreditNote", remote.id, {
      amount: -remote.sumGross,
      date: unixTime(doc.date_created),
      accountId: account.id,
    });
  }
  const paidOut = status >= STATUS.paid;
  return {
    booked_amount: paidOut ? remote.sumGross : 0,
    date_booked: now(ctx).toISOString(),
    booking_note: paidOut
      ? "Paid out in sevdesk."
      : `Not booked: ${doc.payment_method ? `refunds by ${doc.payment_method} have` : "the refund has"} no sevdesk account in the app's settings.`,
    sevdesk_status: statusName(status),
  };
}

async function fetchPdf(ctx: Context, doc: DocumentRecord, number: string | null): Promise<Partial<DocumentRecord>> {
  const file = await getPdf(api(ctx), kindOf(doc), doc.sevdesk_id as string);
  return {
    pdf: {
      filename: `${number || doc.sevdesk_id}.pdf`,
      content_type: "application/pdf",
      data: { $base64: file.base64 },
    } as DocumentRecord["pdf"],
  };
}

/**
 * Everything after the draft exists: the PDF's language, the number, the payment, the PDF,
 * the customer's e-mail. Returns the changes for the caller to save in one write with the
 * final status. `known` is the document as sevdesk just answered it.
 */
async function finish(ctx: Context, doc: DocumentRecord, known?: SevDocument): Promise<Partial<DocumentRecord>> {
  const kind = kindOf(doc);
  const id = doc.sevdesk_id as string;
  let remote =
    known ||
    (await getDocument(api(ctx), kind, id).catch(async (err: unknown) => {
      if (!(err instanceof SevdeskError && err.notFound)) {
        throw err;
      }
      const gone = describe(doc);
      await save(ctx.swell, doc, {
        sevdesk_id: null,
        sevdesk_url: null,
        sevdesk_status: null,
        number: null,
        date_issued: null,
        language_set: false,
        date_booked: null,
        name: provisionalName(doc.type, doc.order_number),
      });
      throw new Problem(
        "failed",
        "gone",
        `${gone} no longer exists in the connected sevdesk account: the draft was deleted in sevdesk, or the API token now belongs to another account. Retry to create the document again, or mark it as resolved.`,
      );
    }));
  const changes: Partial<DocumentRecord> = { amount: remote.sumGross };

  if (remote.status < STATUS.open) {
    if (!doc.language_set && doc.language) {
      try {
        await setLanguage(api(ctx), kind, id, doc.language);
      } catch (err) {
        // The language of the PDF's labels is not worth holding a document back for.
        // An outage is another matter: the next attempt sets it
        if (!(err instanceof SevdeskError) || err.kind !== "rejected") {
          throw err;
        }
        console.error("Unable to set the language of the sevdesk document", err.message);
      }
      changes.language_set = true;
    }
    if (!wantsFinal(ctx)) {
      return { ...changes, sevdesk_status: "draft" };
    }
    remote = await finalize(api(ctx), kind, id);
  }
  if (!doc.number || doc.sevdesk_status === "draft" || !doc.sevdesk_status) {
    Object.assign(changes, {
      number: remote.number,
      ...(remote.number ? { name: remote.number } : {}),
      sevdesk_status: statusName(remote.status),
      date_issued: remote.date ? new Date(remote.date).toISOString() : now(ctx).toISOString(),
    });
  }

  // The payment and the PDF do not depend on each other
  const booked = Boolean(doc.date_booked) && !(ctx.rebook && doc.type === "invoice");
  const [booking, pdf] = await Promise.allSettled([
    booked ? {} : doc.type === "invoice" ? bookInvoice(ctx, doc, remote) : bookCreditNote(ctx, doc, remote),
    doc.pdf ? {} : fetchPdf(ctx, doc, remote.number),
  ]);
  const done: Partial<DocumentRecord> = {
    ...(booking.status === "fulfilled" ? booking.value : {}),
    ...(pdf.status === "fulfilled" ? pdf.value : {}),
  };
  if ((doc.pdf || done.pdf) && wantsEmail(ctx, doc) && !doc.notify_customer) {
    // The notification is bound to this change (see models/documents.json)
    done.notify_customer = true;
  }
  const failure = [booking, pdf].find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
  if (failure) {
    // Keep what was done before the failure is reported
    await save(ctx.swell, doc, { ...changes, ...done });
    throw failure.reason;
  }
  return { ...changes, ...done };
}

/** sevdesk's validation messages, with what the merchant can do about the common ones */
function explainRejection(message: string, built: BuiltInvoice): string | undefined {
  if (/tax rate/i.test(message) && /not allowed/i.test(message)) {
    return `sevdesk does not accept the order's tax rates under its tax rule "${built.decision.rule.label}". Check the store's tax rules for the customer's country${
      built.decision.rule.id === 1 ? "" : ', and the setting "Sales to other EU countries" of the app'
    }. (sevdesk: ${message})`;
  }
  if (/VAT number/i.test(message)) {
    return `sevdesk needs the customer's VAT ID on its contact for a tax-free invoice to a business in another EU country. Check the VAT ID on the order. (sevdesk: ${message})`;
  }
  return undefined;
}

function successMessage(doc: DocumentRecord): string {
  if (doc.sevdesk_status === "draft") {
    return `${describe(doc)} is a draft in sevdesk. Finalize it there, or choose Finalize draft on the document in Swell.`;
  }
  return [`${describe(doc)} is in sevdesk.`, doc.booking_note].filter(Boolean).join(" ");
}

function alertSubject(doc: DocumentRecord): string {
  return `${doc.type === "invoice" ? "Invoice" : "Credit note"} for order ${doc.order_number || doc.order_id || ""}`.trim();
}

/**
 * Works on one record until it is complete or something stops it. Never throws for a
 * sevdesk or data problem. `fresh` says the caller created the record a moment ago,
 * with the lock already on it.
 */
export async function run(ctx: Context, doc: DocumentRecord, fresh = false): Promise<Outcome> {
  if (doc.status === "resolved") {
    return { doc, result: "exists", message: `${describe(doc)} was marked as resolved.` };
  }
  if (isComplete(ctx, doc)) {
    return { doc, result: "exists", message: `${describe(doc)} is in sevdesk already.` };
  }
  if (!fresh) {
    const started = now(ctx);
    const held = doc.locked_until && new Date(doc.locked_until).getTime() > started.getTime();
    if (held || !(await take(ctx.swell, doc, lock(started)))) {
      return { doc, result: "busy", message: `${describe(doc)} is being worked on right now. Try again in a moment.` };
    }
  }

  // The attempt is over, one way or the other, and the record is waiting for nothing
  const settled = { locked_until: null, date_pending: null };
  try {
    let draft: SevDocument | undefined;
    if (!doc.sevdesk_id) {
      draft = await (doc.type === "invoice" ? createInvoice(ctx, doc) : createCreditNote(ctx, doc));
      await save(ctx.swell, doc, {
        sevdesk_id: draft.id,
        sevdesk_url: documentLink(kindOf(doc), draft.id),
        sevdesk_status: "draft",
        date_submitted: null,
      });
    }
    const changes = await finish(ctx, doc, draft);
    await save(ctx.swell, doc, { ...changes, status: "created", problem: null, problem_code: null, ...settled });
    // Only now, with the record no longer failed: settled any earlier, a failure of the
    // steps above would raise an alert while the old one is being removed
    await settleAlerts(ctx.swell);
    return { doc, result: "created", message: successMessage(doc) };
  } catch (err) {
    if (err instanceof Problem) {
      await save(ctx.swell, doc, { status: err.status, problem: err.message, problem_code: err.code, ...settled });
      if (err.status === "failed") {
        await raiseAlert(ctx.swell, "documents", err.message, alertSubject(doc));
      }
      return { doc, result: err.status, message: err.message };
    }

    if (err instanceof SevdeskError) {
      if (err.temporary) {
        // The record keeps what it has. With a sevdesk id it only needs finishing
        await save(ctx.swell, doc, {
          status: doc.status === "created" ? "created" : "pending",
          problem: err.message,
          problem_code: "temporary",
          locked_until: null,
          date_pending: doc.date_pending || now(ctx).toISOString(),
        });
        return { doc, result: "retry", message: err.message };
      }
      // Also for a document that exists in sevdesk and could not be finished: it needs the
      // merchant, and Retry finishes it without creating anything
      const message = err.connection ? err.message : err.hint || `sevdesk refused the ${doc.sevdesk_id ? "request" : "document"}: ${err.message}`;
      await save(ctx.swell, doc, {
        status: "failed",
        problem: message,
        problem_code: err.connection ? "connection" : "rejected",
        ...settled,
      });
      await raiseAlert(ctx.swell, err.connection ? "connection" : "documents", message, alertSubject(doc));
      return { doc, result: "failed", message };
    }

    // A fault of the store API or of the app itself. Release the record and let the caller see it
    try {
      await save(ctx.swell, doc, { locked_until: null, problem: String((err as Error)?.message || err), problem_code: "internal" });
    } catch {
      // The lock ends by itself
    }
    throw err;
  }
}

// How long a document that sevdesk cannot take right now is tried again before it is
// handed to the merchant
const GIVE_UP_MS = 24 * 60 * 60 * 1000;

/** True for a record that has been waiting for sevdesk for a day */
export function waitedTooLong(ctx: Context, doc: DocumentRecord): boolean {
  return Boolean(doc.date_pending) && now(ctx).getTime() - new Date(doc.date_pending as string).getTime() > GIVE_UP_MS;
}

/** Marks a record that could not be completed in time as needing attention */
export async function giveUp(ctx: Context, doc: DocumentRecord): Promise<void> {
  const message = `The document could not be finished within a day. ${doc.problem || ""}`.trim();
  await save(ctx.swell, doc, {
    status: "failed",
    problem: message,
    problem_code: "unavailable",
    locked_until: null,
    date_pending: null,
  });
  await raiseAlert(ctx.swell, "documents", message, alertSubject(doc));
}

/**
 * The record for an order's invoice: found, or written now. `locked` says the caller goes
 * on to work on it in the same breath; a function that only starts a run leaves it free.
 */
export async function claimInvoice(
  ctx: Context,
  orderId: string,
  source: string,
  locked: boolean,
): Promise<{ doc: DocumentRecord; created: boolean }> {
  const key = invoiceKey(orderId);
  const [existing, order] = await Promise.all([findByKey(ctx.swell, key), readOrder(ctx, orderId).catch(() => undefined)]);
  if (order?.id) {
    ctx.orders = { ...ctx.orders, [orderId]: order };
  }
  if (existing) {
    return { doc: existing, created: false };
  }
  return claim(
    ctx.swell,
    key,
    { type: "invoice", order_id: orderId, source, ...(order?.id ? orderDetails(order) : {}), ...attempt(now(ctx), locked) },
    true,
  );
}

/**
 * The record for a refund's credit note. Returns nothing when the refund is none of the
 * app's business: it belongs to no order, or to an order the app never invoiced.
 */
export async function claimCreditNote(
  ctx: Context,
  refund: SwellRecord,
  source: string,
): Promise<{ doc: DocumentRecord; created: boolean } | undefined> {
  if (!creditNotesEnabled(ctx.settings) || !refund?.id || !refund.order_id) {
    return undefined;
  }
  const key = creditNoteKey(refund.id);
  const [invoiceDoc, existing] = await Promise.all([
    findByKey(ctx.swell, invoiceKey(refund.order_id)),
    findByKey(ctx.swell, key),
  ]);
  if (!invoiceDoc || invoiceDoc.status === "skipped") {
    return undefined;
  }
  if (existing) {
    return { doc: existing, created: false };
  }
  return claim(
    ctx.swell,
    key,
    {
      type: "credit_note",
      name: provisionalName("credit_note", invoiceDoc.order_number),
      source,
      order_id: refund.order_id,
      order_number: invoiceDoc.order_number,
      account_id: invoiceDoc.account_id,
      payment_id: refund.parent_id,
      refund_id: refund.id,
      payment_method: refund.method,
      reference: String(refund.number || refund.id).slice(-8).toUpperCase(),
      customer_name: invoiceDoc.customer_name,
      customer_email: invoiceDoc.customer_email,
      amount: refund.amount,
      currency: "EUR",
      ...attempt(now(ctx), false),
    },
    true,
  );
}

/**
 * Marks an invoice whose payments were dealt with before they covered it as waiting for
 * its booking again: the order was paid since, or the merchant asks for another look. The
 * record says so itself, so an attempt that fails leaves the booking to the next one, and
 * the sweep finds the record when no run comes for it at all.
 */
export async function awaitBooking(ctx: Context, doc: DocumentRecord): Promise<void> {
  if (doc.type !== "invoice" || !doc.sevdesk_id || !doc.date_booked || toCents(doc.booked_amount) >= toCents(doc.amount)) {
    return;
  }
  if (doc.status !== "created" && doc.status !== "failed") {
    return;
  }
  await save(ctx.swell, doc, {
    date_booked: null,
    ...(doc.status === "created" ? { status: "pending", ...attempt(now(ctx), false) } : {}),
  });
}

/** The invoice for an order: created now, or continued from where its record stands */
export async function invoiceOrder(ctx: Context, orderId: string, source: string): Promise<Outcome> {
  const { doc, created } = await claimInvoice(ctx, orderId, source, true);
  if (!created && ctx.rebook) {
    await awaitBooking(ctx, doc);
  }
  return run(ctx, doc, created);
}
