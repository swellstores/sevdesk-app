import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentRecord } from "../../functions/lib/documents";
import { claimCreditNote, giveUp, invoiceOrder, run, waitedTooLong } from "../../functions/lib/process";
import type { Context } from "../../functions/lib/process";
import * as orders from "../fixtures/orders";
import { createSevdesk } from "../helpers/sevdesk";
import { createStore } from "../helpers/store";

const FINAL = {
  id: "app-record-id",
  connection: { api_token: "token", enabled: true },
  documents: { mode: "final", send_email: false },
  payments: { account: "Online-Shop" },
};
const DRAFTS = { ...FINAL, documents: { mode: "draft" } };

const order = orders.singleRate;
const paid = (source: Record<string, any>, method = "card", amount = source.grand_total) => ({
  id: `pay-${source.id}-${method}`, order_id: source.id, method, amount, success: true, captured: true, date_created: "2026-10-10T08:00:00.000Z",
});

let store: ReturnType<typeof createStore>;
let sevdesk: ReturnType<typeof createSevdesk>;
let clock: Date;

function context(settings: Record<string, any> = store.settings, extra: Partial<Context> = {}): Context {
  return { swell: store.swell, settings, now: () => clock, ...extra };
}

function setup(settings: Record<string, any> = FINAL, payments: Record<string, any>[] = [paid(order)]) {
  store = createStore({ settings, orders: Object.values(orders), payments });
}

/** Moves the clock on */
function later(seconds = 61) {
  clock = new Date(clock.getTime() + seconds * 1000);
}

async function refund(source: Record<string, any>, amount: number, id = "refund-1", settings?: Record<string, any>) {
  const ctx = context(settings);
  const claimed = await claimCreditNote(ctx, { id, order_id: source.id, parent_id: "pay-1", amount, method: "card", number: "100023" }, "test");
  return claimed && run(ctx, claimed.doc);
}

beforeEach(() => {
  clock = new Date("2026-10-12T10:00:00.000Z");
  sevdesk = createSevdesk();
  setup();
});

afterEach(() => vi.unstubAllGlobals());

describe("an invoice, finalized", () => {
  it("creates the contact, the draft, the number, the booking and the PDF, in that order", async () => {
    const outcome = await invoiceOrder(context(), order.id, "order.paid");

    expect(outcome.result).toBe("created");
    expect(store.documents).toHaveLength(1);
    expect(store.documents[0]).toMatchObject({
      key: `invoice:${order.id}`, status: "created", number: "RE-1000", name: "RE-1000", amount: 76.61, sevdesk_status: "paid",
      booked_amount: 76.61, language: "de", language_set: true, tax_rule: "Taxable revenue", problem: null, locked_until: null, date_pending: null,
    });
    expect(store.documents[0].pdf.url).toContain("RE-1000.pdf");
    expect(sevdesk.contacts).toMatchObject([{ surename: "Erika", familyname: "Musterfrau" }]);
    expect(sevdesk.emails).toMatchObject([{ value: "test-de@example.com" }]);
    expect(sevdesk.invoices()[0]).toMatchObject({ status: "1000", language: "de", customerInternalNote: "100304", timeToPay: 14 });
    expect(sevdesk.bookings).toMatchObject([{ amount: 76.61, account: "Online-Shop" }]);
    const writes = sevdesk.calls.filter((call) => call.method !== "GET").map((call) => call.path.split("/").pop());
    expect(writes.slice(-5, -1)).toEqual(["saveInvoice", "render", "changeParameter", "sendBy"]);
  });

  it("uses the customer's contact again for the next order", async () => {
    await invoiceOrder(context(), order.id, "order.paid");
    await invoiceOrder(context(), orders.mixedRates.id, "dashboard");
    expect(sevdesk.contacts).toHaveLength(1);
    expect(sevdesk.invoices()).toHaveLength(2);
  });

  it("gives a business with a VAT ID its own contact, also when the e-mail is known", async () => {
    sevdesk.contacts.push({ id: "c9", surename: "Anna", familyname: "Peeters" });
    sevdesk.emails.push({ value: "test-be@example.com", contact: { id: "c9" } });
    const outcome = await invoiceOrder(context(), orders.belgianBusiness.id, "dashboard");
    expect(outcome.result).toBe("created");
    expect(sevdesk.contacts[1]).toMatchObject({ name: "Peeters BV", vatNumber: "BE0123456789" });
    expect(store.documents[0].contact_id).toBe(sevdesk.contacts[1].id);
  });

  it("does nothing the second time", async () => {
    await invoiceOrder(context(), order.id, "order.paid");
    const calls = sevdesk.calls.length;
    const again = await invoiceOrder(context(), order.id, "dashboard");
    expect(again.result).toBe("exists");
    expect(sevdesk.calls).toHaveLength(calls);
  });

  it("lets only one of two attempts at the same moment go on", async () => {
    const outcomes = await Promise.all([invoiceOrder(context(), order.id, "a"), invoiceOrder(context(), order.id, "b")]);
    expect(outcomes.map((outcome) => outcome.result).sort()).toEqual(["busy", "created"]);
    expect(sevdesk.invoices()).toHaveLength(1);
  });

  it("leaves a record alone while another run holds it, and takes it when that run has died", async () => {
    store.documents.push({
      id: "d".repeat(24), key: `invoice:${order.id}`, type: "invoice", status: "pending", order_id: order.id, attempts: 1,
      locked_until: new Date(clock.getTime() + 60 * 1000).toISOString(),
    });
    expect((await run(context(), store.documents[0] as DocumentRecord)).result).toBe("busy");
    expect(fetch).not.toHaveBeenCalled();
    later(61);
    expect((await run(context(), store.documents[0] as DocumentRecord)).result).toBe("created");
  });

  it("marks the document for the customer's e-mail once the PDF is stored", async () => {
    setup({ ...FINAL, documents: { mode: "final", send_email: true } });
    await invoiceOrder(context(), order.id, "order.paid");
    expect(store.documents[0].notify_customer).toBe(true);
    // The e-mail is sent by the event of that write, which a workflow has to ask for
    expect(store.events).toEqual([`updated /documents/${store.documents[0].id}`]);
  });
});

describe("drafts", () => {
  beforeEach(() => setup(DRAFTS));

  it("stops at the draft, which has no number, no booking and no PDF", async () => {
    const outcome = await invoiceOrder(context(), order.id, "order.paid");
    expect(outcome.result).toBe("created");
    expect(store.documents[0]).toMatchObject({ status: "created", sevdesk_status: "draft", language_set: true, name: "Invoice for order 100304" });
    expect(store.documents[0].number ?? null).toBeNull();
    expect(sevdesk.invoices()[0]).toMatchObject({ status: "100", invoiceNumber: null });
    expect(sevdesk.bookings).toHaveLength(0);
  });

  it("finalizes the draft when the merchant asks for it", async () => {
    await invoiceOrder(context(), order.id, "order.paid");
    later();
    const outcome = await run(context(DRAFTS, { finalize: true }), store.documents[0] as DocumentRecord);
    expect(outcome.result).toBe("created");
    expect(store.documents[0]).toMatchObject({ number: "RE-1000", sevdesk_status: "paid" });
    expect(sevdesk.drafts()).toHaveLength(1);
  });

  it("reads a draft again, and finishes one that was finalized in sevdesk", async () => {
    await invoiceOrder(context(), order.id, "order.paid");
    later();
    await run(context(), store.documents[0] as DocumentRecord);
    expect(store.documents[0].sevdesk_status).toBe("draft");

    sevdesk.invoices()[0].status = "200";
    sevdesk.invoices()[0].invoiceNumber = "RE-2000";
    later();
    await run(context(), store.documents[0] as DocumentRecord);
    expect(store.documents[0]).toMatchObject({ number: "RE-2000", sevdesk_status: "paid", booked_amount: 76.61 });
    expect(store.documents[0].pdf).toBeTruthy();
  });

  it("creates a draft again after it was deleted in sevdesk", async () => {
    await invoiceOrder(context(), order.id, "order.paid");
    sevdesk.documents.length = 0;
    later();
    const gone = await run(context(), store.documents[0] as DocumentRecord);
    expect(gone.result).toBe("failed");
    expect(store.documents[0]).toMatchObject({ status: "failed", problem_code: "gone", sevdesk_id: null });

    later();
    const retried = await run(context(), store.documents[0] as DocumentRecord);
    expect(retried.result).toBe("created");
    expect(sevdesk.invoices()).toHaveLength(1);
  });
});

describe("the total", () => {
  it("replaces a net draft that sevdesk totals differently by gross amounts", async () => {
    let first = true;
    sevdesk.state.intercept = async (call) => {
      if (call.path === "/Invoice/Factory/saveInvoice" && first) {
        first = false;
        // sevdesk creates the draft, a cent above the order
        sevdesk.documents.push({ kind: "Invoice", id: "900", status: "100", contact: call.body.invoice.contact, customerInternalNote: "x" });
        return sevdesk.json(201, { objects: { invoice: { id: "900", status: "100", sumGross: "108.95", contact: call.body.invoice.contact } } });
      }
      return undefined;
    };
    const outcome = await invoiceOrder(context(), orders.mixedRates.id, "dashboard");
    expect(outcome.result).toBe("created");
    expect(sevdesk.invoices().map((invoice) => invoice.id)).not.toContain("900");
    expect(sevdesk.invoices()[0]).toMatchObject({ showNet: "0", sumGross: "108.94" });
  });

  it("creates nothing when no layout gives the order's total in sevdesk", async () => {
    sevdesk.state.intercept = async (call) => {
      if (call.path === "/Invoice/Factory/saveInvoice") {
        sevdesk.documents.push({ kind: "Invoice", id: "900", status: "100", contact: call.body.invoice.contact });
        return sevdesk.json(201, { objects: { invoice: { id: "900", status: "100", sumGross: "1.00", contact: call.body.invoice.contact } } });
      }
      return undefined;
    };
    const outcome = await invoiceOrder(context(), order.id, "dashboard");
    expect(outcome.result).toBe("failed");
    expect(store.documents[0]).toMatchObject({ status: "failed", problem_code: "total_mismatch" });
    expect(store.documents[0].sevdesk_id ?? null).toBeNull();
    expect(sevdesk.invoices()).toHaveLength(0);
  });
});

describe("when sevdesk does not answer", () => {
  it("finds the draft of a lost answer instead of creating another", async () => {
    sevdesk.state.intercept = (call) => (call.path === "/Invoice/Factory/saveInvoice" ? "lose-answer" : undefined);
    const first = await invoiceOrder(context(), order.id, "order.paid");
    expect(first.result).toBe("retry");
    expect(store.documents[0]).toMatchObject({ status: "pending", problem_code: "temporary" });
    expect(store.documents[0].date_submitted).toBeTruthy();
    expect(store.documents[0].date_pending).toBeTruthy();

    sevdesk.state.intercept = undefined;
    later(40);
    const second = await run(context(), store.documents[0] as DocumentRecord);
    expect(second.result).toBe("created");
    expect(sevdesk.invoices()).toHaveLength(1);
    expect(sevdesk.drafts()).toHaveLength(1);
    expect(store.documents[0]).toMatchObject({ number: "RE-1000", date_submitted: null, date_pending: null });
  });

  it("waits a minute before it creates a draft again that it cannot find", async () => {
    sevdesk.state.intercept = (call) => (call.path === "/Invoice/Factory/saveInvoice" ? sevdesk.json(504, {}) : undefined);
    await invoiceOrder(context(), order.id, "order.paid");
    sevdesk.state.intercept = undefined;

    later(40);
    expect((await run(context(), store.documents[0] as DocumentRecord)).result).toBe("retry");
    later(40);
    expect((await run(context(), store.documents[0] as DocumentRecord)).result).toBe("created");
    expect(sevdesk.invoices()).toHaveLength(1);
  });

  it("does not book a payment twice when the answer to the booking is lost", async () => {
    sevdesk.state.intercept = (call) => {
      if (call.path.endsWith("/bookAmount")) {
        const invoice = sevdesk.invoices()[0];
        invoice.paidAmount = call.body.amount;
        invoice.status = "1000";
        return sevdesk.json(504, {});
      }
      return undefined;
    };
    expect((await invoiceOrder(context(), order.id, "order.paid")).result).toBe("retry");
    // The number and the PDF are kept, although the attempt failed
    expect(store.documents[0]).toMatchObject({ number: "RE-1000", status: "pending" });
    expect(store.documents[0].pdf).toBeTruthy();

    sevdesk.state.intercept = undefined;
    later();
    expect((await run(context(), store.documents[0] as DocumentRecord)).result).toBe("created");
    expect(sevdesk.bookings).toHaveLength(0);
    expect(store.documents[0]).toMatchObject({ sevdesk_status: "paid", booked_amount: 76.61 });
  });

  it("hands a document to the merchant after a day of waiting", async () => {
    sevdesk.state.intercept = () => sevdesk.json(503, {});
    await invoiceOrder(context(), order.id, "order.paid");
    const doc = store.documents[0] as DocumentRecord;
    expect(waitedTooLong(context(), doc)).toBe(false);
    later(25 * 60 * 60);
    expect(waitedTooLong(context(), doc)).toBe(true);
    await giveUp(context(), doc);
    expect(store.documents[0]).toMatchObject({ status: "failed", problem_code: "unavailable", date_pending: null });
    expect(store.alerts).toMatchObject([{ key: "documents" }]);
  });
});

describe("when sevdesk refuses", () => {
  it("lists a refused document with sevdesk's reason and alerts once", async () => {
    const outcome = await invoiceOrder(context(), orders.doubleTaxed.id, "order.paid");
    expect(outcome.result).toBe("failed");
    expect(store.documents[0]).toMatchObject({ status: "failed", problem_code: "rejected", date_submitted: null });
    expect(store.documents[0].problem).toContain("tax rate (26)");
    expect(store.alerts).toMatchObject([{ key: "documents", count: 1 }]);
    expect(store.events).toEqual(["created /alerts"]);
    expect(sevdesk.drafts()).toHaveLength(1);
  });

  it("raises the connection alert for a refused token and clears it with the next document", async () => {
    sevdesk.state.intercept = () => sevdesk.json(401, { message: "Authentication required" });
    const outcome = await invoiceOrder(context(), order.id, "order.paid");
    expect(outcome).toMatchObject({ result: "failed" });
    expect(store.documents[0]).toMatchObject({ status: "failed", problem_code: "connection", order_number: "100304" });
    expect(store.alerts).toMatchObject([{ key: "connection" }]);

    sevdesk.state.intercept = undefined;
    later();
    expect((await run(context(), store.documents[0] as DocumentRecord)).result).toBe("created");
    expect(store.alerts).toHaveLength(0);
  });

  it("refuses an account on the old bookkeeping system", async () => {
    vi.unstubAllGlobals();
    sevdesk = createSevdesk({ version: "1.0" });
    const outcome = await invoiceOrder(context(), order.id, "order.paid");
    expect(outcome.result).toBe("failed");
    expect(store.documents[0].problem_code).toBe("connection");
    expect(sevdesk.drafts()).toHaveLength(0);
  });

  it("skips an order in another currency without an alert", async () => {
    store = createStore({ settings: FINAL, orders: [{ ...order, currency: "USD" }] });
    const outcome = await invoiceOrder(context(), order.id, "order.paid");
    expect(outcome.result).toBe("skipped");
    expect(store.documents[0]).toMatchObject({ status: "skipped", problem_code: "currency", currency: "USD" });
    expect(store.alerts).toHaveLength(0);
    expect(sevdesk.contacts).toHaveLength(0);
  });
});

describe("payments", () => {
  it("books each payment on the account of its method and leaves a gift card alone", async () => {
    setup(FINAL, [{ ...paid(order, "giftcard", 20), date_created: "2026-10-10T07:00:00.000Z" }, paid(order, "card", 56.61)]);
    await invoiceOrder(context(), order.id, "order.paid");
    expect(sevdesk.bookings).toMatchObject([{ amount: 56.61, account: "Online-Shop" }]);
    expect(store.documents[0]).toMatchObject({ status: "created", sevdesk_status: "partly_paid", booked_amount: 56.61 });
    expect(store.documents[0].booking_note).toContain("giftcard");
  });

  it("books nothing while no account is named", async () => {
    setup({ ...FINAL, payments: {} });
    await invoiceOrder(context(), order.id, "order.paid");
    expect(sevdesk.bookings).toHaveLength(0);
    expect(store.documents[0]).toMatchObject({ status: "created", sevdesk_status: "open", booked_amount: 0 });
    expect(store.documents[0].pdf).toBeTruthy();
  });

  it("keeps the finalized invoice and asks for the account when its name is wrong", async () => {
    setup({ ...FINAL, payments: { account: "Shop" } });
    const outcome = await invoiceOrder(context(), order.id, "order.paid");
    expect(outcome.result).toBe("failed");
    expect(store.documents[0]).toMatchObject({ status: "failed", problem_code: "no_account", number: "RE-1000" });
    expect(store.documents[0].pdf).toBeTruthy();

    later();
    const retried = await run(context(FINAL), store.documents[0] as DocumentRecord);
    expect(retried.result).toBe("created");
    expect(sevdesk.drafts()).toHaveLength(1);
    expect(sevdesk.bookings).toHaveLength(1);
  });

  it("books only what sevdesk does not hold yet, after an attempt that stopped between two payments", async () => {
    setup(FINAL, [{ ...paid(order, "card", 50), date_created: "2026-10-10T07:00:00.000Z" }, paid(order, "paypal", 26.61)]);
    let calls = 0;
    sevdesk.state.intercept = (call) => (call.path.endsWith("/bookAmount") && ++calls === 2 ? sevdesk.json(503, {}) : undefined);
    expect((await invoiceOrder(context(), order.id, "order.paid")).result).toBe("retry");

    sevdesk.state.intercept = undefined;
    later();
    expect((await run(context(), store.documents[0] as DocumentRecord)).result).toBe("created");
    expect(sevdesk.bookings.map((booking) => booking.amount)).toEqual([50, 26.61]);
  });

  it("books the payment of an invoice that was created before the order was paid", async () => {
    setup(FINAL, []);
    await invoiceOrder(context(), order.id, "dashboard");
    expect(store.documents[0]).toMatchObject({ status: "created", sevdesk_status: "open" });

    store.payments.push(paid(order));
    later();
    const outcome = await run(context(FINAL, { rebook: true }), store.documents[0] as DocumentRecord);
    expect(outcome.result).toBe("created");
    expect(sevdesk.bookings).toHaveLength(1);
    expect(store.documents[0].sevdesk_status).toBe("paid");
  });
});

describe("a credit note", () => {
  beforeEach(async () => {
    setup(FINAL, [paid(orders.mixedRates)]);
    await invoiceOrder(context(), orders.mixedRates.id, "order.paid");
    later();
  });

  it("splits a partial refund over the invoice's rates and books the payout", async () => {
    const outcome = await refund(orders.mixedRates, 10);
    expect(outcome?.result).toBe("created");
    const note = sevdesk.creditNotes()[0];
    expect(note).toMatchObject({ status: "1000", creditNoteNumber: "GU-1000", sumGross: "10", showNet: "0", bookingCategory: "UNDERACHIEVEMENT" });
    expect(note.refSrcInvoice.id).toBe(sevdesk.invoices()[0].id);
    expect(note.positions.map((position: any) => position.taxRate)).toEqual([19, 7]);
    expect(sevdesk.bookings[1]).toMatchObject({ amount: -10, account: "Online-Shop" });
    expect(store.documents[1]).toMatchObject({
      type: "credit_note", status: "created", number: "GU-1000", invoice_number: "RE-1000", amount: 10, reference: "100023", sevdesk_status: "paid",
    });
    expect(store.documents[1].pdf).toBeTruthy();
  });

  it("prints the credit note in the invoice's language, in the words its own layout uses", async () => {
    await refund(orders.mixedRates, 10);
    // The credit note layout is German already, so nothing is changed
    expect(sevdesk.creditNotes()[0].language).toBe("de_DE");
    expect(sevdesk.calls.filter((call) => call.path.endsWith("/changeParameter"))).toHaveLength(1);
    expect(store.documents[1]).toMatchObject({ language: "de", language_set: true });
  });

  it("goes on when sevdesk refuses to set the language", async () => {
    sevdesk.state.intercept = (call) => (call.path.endsWith("/render") ? sevdesk.refused(500, "Syntax error") : undefined);
    expect((await refund(orders.mixedRates, 10))?.result).toBe("created");
    expect(store.documents[1]).toMatchObject({ number: "GU-1000", language_set: true });
  });

  it("repeats the invoice's positions for a refund of everything", async () => {
    await refund(orders.mixedRates, 108.94);
    expect(sevdesk.creditNotes()[0].positions.map((position: any) => position.name)).toEqual(
      sevdesk.invoices()[0].positions.map((position: any) => position.name),
    );
    expect(sevdesk.creditNotes()[0].sumGross).toBe("108.94");
  });

  it("keeps several refunds of one order inside what the invoice holds at each rate", async () => {
    await refund(orders.mixedRates, 60, "refund-1");
    later();
    await refund(orders.mixedRates, 48.94, "refund-2");
    const perRate = new Map<number, number>();
    for (const note of sevdesk.creditNotes()) {
      for (const position of note.positions) {
        perRate.set(position.taxRate, Math.round(((perRate.get(position.taxRate) || 0) + position.sumGross) * 100) / 100);
      }
    }
    // The invoice holds 3 × 24.99 and 4.90 at 19 %, and 12.99 at 7 %
    expect([...perRate.entries()].sort()).toEqual([[19, 95.04], [7, 13.9]].sort());
    expect(store.documents.filter((doc) => doc.type === "credit_note" && doc.status === "created")).toHaveLength(2);
  });

  it("is none of the app's business without an invoice, or when credit notes are off", async () => {
    expect(await refund(orders.swissExport, 5)).toBeUndefined();
    expect(await refund(orders.mixedRates, 5, "refund-1", { ...FINAL, documents: { mode: "final", credit_notes: false } })).toBeUndefined();
    expect(store.documents).toHaveLength(1);
  });

  it("waits for the merchant while the invoice is a draft", async () => {
    setup(DRAFTS, []);
    await invoiceOrder(context(), orders.mixedRates.id, "dashboard");
    later();
    const outcome = await refund(orders.mixedRates, 10);
    expect(outcome?.result).toBe("failed");
    expect(store.documents[1]).toMatchObject({ status: "failed", problem_code: "invoice_draft" });
    expect(sevdesk.creditNotes()).toHaveLength(0);
  });
});
