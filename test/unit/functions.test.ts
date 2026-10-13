import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import creditRefund from "../../functions/credit-refund";
import invoiceOrder from "../../functions/invoice-order";
import ProcessDocuments from "../../functions/process-documents";
import resolveDocument from "../../functions/resolve-document";
import sweep from "../../functions/sweep";
import testConnection, { describePayments } from "../../functions/test-connection";
import * as orders from "../fixtures/orders";
import { createMockRequest } from "../helpers/mock-request";
import { createSevdesk } from "../helpers/sevdesk";
import { createStore } from "../helpers/store";

const SETTINGS = {
  id: "app-record-id",
  connection: { api_token: "token", enabled: true },
  documents: { mode: "final", send_email: false },
  payments: { account: "Online-Shop" },
};
const order = orders.singleRate;
const ORDER_ID = order.id;

let store: ReturnType<typeof createStore>;
let sevdesk: ReturnType<typeof createSevdesk>;

function request(data: Record<string, any>) {
  return createMockRequest({ data, swell: store.swell as any, appId: "sevdesk" });
}

async function thrown(run: () => Promise<unknown>): Promise<any> {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error("Expected the function to throw");
}

/** A step runner that runs each step once, like a run without failures */
const step = {
  do: vi.fn(async (_name: string, _options: unknown, work: () => Promise<unknown>) => work()),
} as any;

function workflow(data: Record<string, any>, trigger = "action") {
  return new ProcessDocuments().run({ data, swell: store.swell, workflow: { trigger }, appId: "sevdesk" } as any, step) as Promise<any>;
}

/** Runs what the event functions started, the way the platform would */
async function runStarted() {
  const results = [];
  for (const started of store.runs.splice(0)) {
    results.push(await workflow(started.data, "function"));
  }
  return results;
}

function action(extra: Record<string, any>) {
  return { $action: { id: "x", source: "record", user_id: "user-1", ...extra } };
}

beforeEach(() => {
  store = createStore({
    settings: SETTINGS,
    orders: Object.values(orders),
    payments: [{ id: "pay-1", order_id: ORDER_ID, method: "card", amount: order.grand_total, success: true, date_created: "2026-10-10T08:00:00.000Z" }],
  });
  sevdesk = createSevdesk();
  step.do.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("order.paid", () => {
  it("writes the document's record and starts a run for it, without calling sevdesk", async () => {
    const result = await invoiceOrder(request({ ...order, $event: { type: "order.paid" } }));
    expect(store.documents).toMatchObject([{ key: `invoice:${ORDER_ID}`, status: "pending", source: "order.paid", order_number: "100304" }]);
    expect(store.documents[0].locked_until ?? null).toBeNull();
    expect(store.runs).toEqual([{ name: "process-documents", data: { document_id: store.documents[0].id, rebook: true } }]);
    expect(result).toMatchObject({ document: store.documents[0].id });
    expect(fetch).not.toHaveBeenCalled();

    expect(await runStarted()).toMatchObject([{ result: "created", number: "RE-1000" }]);
    expect(store.documents[0]).toMatchObject({ status: "created", sevdesk_status: "paid" });
  });

  it("starts nothing for an order whose invoice is complete, or while the app is switched off", async () => {
    await invoiceOrder(request({ ...order }));
    await runStarted();
    expect(await invoiceOrder(request({ ...order }))).toMatchObject({ skipped: expect.any(String) });
    expect(store.runs).toHaveLength(0);

    store.setSettings({ ...SETTINGS, connection: { api_token: "token", enabled: false } });
    await invoiceOrder(request({ ...orders.mixedRates }));
    expect(store.documents).toHaveLength(1);
  });

  it("books the payment of an order that was invoiced before it was paid, also after a failed attempt", async () => {
    const [payment] = store.payments.splice(0);
    await workflow(action({ id: "create-invoice", record_id: ORDER_ID }));
    expect(store.documents[0]).toMatchObject({ status: "created", sevdesk_status: "open", booked_amount: 0 });

    // The order is paid while sevdesk refuses the token
    store.payments.push(payment);
    store.documents[0].locked_until = null;
    sevdesk.state.intercept = () => sevdesk.json(401, {});
    await invoiceOrder(request({ ...order }));
    expect(store.documents[0]).toMatchObject({ status: "pending", date_booked: null });
    await runStarted();
    expect(store.documents[0]).toMatchObject({ status: "failed", problem_code: "connection", number: "RE-1000" });

    sevdesk.state.intercept = undefined;
    store.documents[0].locked_until = null;
    await workflow(action({ id: "retry-failed", source: "settings", settings: "connection" }));
    expect(store.documents[0]).toMatchObject({ status: "created", sevdesk_status: "paid", booked_amount: order.grand_total });
    expect(sevdesk.invoices()).toHaveLength(1);
  });

  it("fails the delivery when the run cannot be started, and keeps the record", async () => {
    store.swell.workflows.create.mockRejectedValueOnce(Object.assign(new Error("Too many requests"), { status: 429 }));
    const err = await thrown(() => invoiceOrder(request({ ...order })));
    expect(err.status).toBe(429);
    expect(store.documents).toHaveLength(1);

    // Swell delivers the event again
    await invoiceOrder(request({ ...order }));
    expect(store.documents).toHaveLength(1);
    expect(store.runs).toHaveLength(1);
  });
});

describe("payment.refund.succeeded", () => {
  it("starts a run for the credit note of an invoiced order only", async () => {
    const refund = { id: "refund-1", order_id: ORDER_ID, parent_id: "pay-1", amount: 10, method: "card", number: "100023" };
    expect(await creditRefund(request(refund))).toMatchObject({ skipped: expect.any(String) });

    await invoiceOrder(request({ ...order }));
    await runStarted();
    await creditRefund(request(refund));
    expect(await runStarted()).toMatchObject([{ result: "created", number: "GU-1000" }]);
    expect(store.documents[1]).toMatchObject({ type: "credit_note", payment_method: "card", amount: 10, status: "created" });
  });
});

describe("the workflow", () => {
  it("fails the step while sevdesk is unreachable, so the run waits and repeats it", async () => {
    await invoiceOrder(request({ ...order }));
    sevdesk.state.intercept = () => sevdesk.json(503, {});
    const [started] = store.runs.splice(0);
    await expect(workflow(started.data, "function")).rejects.toThrowError(/not available/);
    expect(store.documents[0]).toMatchObject({ status: "pending", problem_code: "temporary" });
  });

  it("creates the invoice for an order from the order's page", async () => {
    const result = await workflow(action({ id: "create-invoice", record_id: orders.mixedRates.id }));
    expect(result).toMatchObject({ result: "created" });
    expect(store.documents[0]).toMatchObject({ source: "dashboard", order_number: "100302", sevdesk_status: "open" });
  });

  it("books a payment that came after the invoice when the order's action is chosen again", async () => {
    const [payment] = store.payments.splice(0);
    await workflow(action({ id: "create-invoice", record_id: ORDER_ID }));
    store.payments.push(payment);
    store.documents[0].locked_until = null;

    expect(await workflow(action({ id: "create-invoice", record_id: ORDER_ID }))).toMatchObject({ result: "created", number: "RE-1000" });
    expect(store.documents[0]).toMatchObject({ status: "created", sevdesk_status: "paid", booked_amount: order.grand_total });
    expect(sevdesk.invoices()).toHaveLength(1);
  });

  it("finalizes a draft from the document's page, and only then", async () => {
    store.setSettings({ ...SETTINGS, documents: { mode: "draft" } });
    await workflow(action({ id: "create-invoice", record_id: ORDER_ID }));
    store.documents[0].locked_until = null;
    await workflow(action({ id: "refresh", record_id: store.documents[0].id }));
    expect(store.documents[0].sevdesk_status).toBe("draft");

    store.documents[0].locked_until = null;
    await workflow(action({ id: "finalize", record_id: store.documents[0].id }));
    expect(store.documents[0]).toMatchObject({ number: "RE-1000", sevdesk_status: "paid" });
  });

  it("ignores a run that names nothing, and an id that is none", async () => {
    expect(await workflow({}, "function")).toMatchObject({ result: "ignored" });
    expect(await workflow(action({ id: "retry", record_id: "../orders" }))).toMatchObject({ result: "ignored" });
    expect(step.do).not.toHaveBeenCalled();
  });

  it("invoices the selected orders, five to a step", async () => {
    const ids = [orders.singleRate.id, orders.mixedRates.id, orders.frenchConsumer.id];
    const result = await workflow(action({ id: "invoice-selected", source: "bulk", selection: { query: { $and: [{ id: { $in: ids } }] } } }));
    expect(result).toMatchObject({ created: 3, failed: 0 });
    expect(sevdesk.invoices()).toHaveLength(3);
  });

  it("finalizes the drafts of a selection and leaves the rest as it is", async () => {
    store.setSettings({ ...SETTINGS, documents: { mode: "draft" } });
    await workflow(action({ id: "create-invoice", record_id: ORDER_ID }));
    store.documents[0].locked_until = null;
    store.documents.push({ id: "c".repeat(24), key: `invoice:${orders.mixedRates.id}`, type: "invoice", status: "failed", order_id: orders.mixedRates.id });
    const ids = store.documents.map((doc) => doc.id);

    const result = await workflow(action({ id: "finalize-selected", source: "bulk", selection: { query: { $and: [{ id: { $in: ids } }] } } }));
    expect(result).toMatchObject({ created: 1, failed: 0 });
    expect(store.documents[0]).toMatchObject({ number: "RE-1000", sevdesk_status: "paid" });
    expect(store.documents[1]).toMatchObject({ status: "failed" });
    expect(sevdesk.invoices()).toHaveLength(1);
  });

  it("goes on with the next document when one cannot be worked on", async () => {
    await invoiceOrder(request({ ...order }));
    await invoiceOrder(request({ ...orders.mixedRates }));
    store.runs.length = 0;
    // The store refuses the first record's write
    store.swell.put.mockRejectedValueOnce(new Error("Server error"));

    const result = await workflow(action({ id: "retry-failed", source: "settings", settings: "connection" }));
    expect(result).toMatchObject({ created: 1, failed: 1 });
    expect(store.documents.map((doc) => doc.status)).toEqual(["pending", "created"]);
  });

  it("retries what is not finished and stops when sevdesk refuses the token", async () => {
    sevdesk.state.intercept = () => sevdesk.json(401, {});
    await workflow(action({ id: "invoice-selected", source: "bulk", selection: { query: { $and: [{ id: { $in: [ORDER_ID, orders.mixedRates.id] } }] } } }));
    expect(store.documents.map((doc) => doc.status)).toEqual(["failed"]);

    sevdesk.state.intercept = undefined;
    store.documents[0].locked_until = null;
    const result = await workflow(action({ id: "retry-failed", source: "settings", settings: "connection" }));
    expect(result).toMatchObject({ created: 1, halted: false });
    expect(store.alerts).toHaveLength(0);
  });
});

describe("the sweep", () => {
  it("starts a run only when a document has waited without an attempt", async () => {
    expect(await sweep(request({}))).toEqual({ waiting: 0 });
    await invoiceOrder(request({ ...order }));
    store.runs.length = 0;
    expect(await sweep(request({}))).toEqual({ waiting: 0 });

    store.documents[0].date_attempted = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    expect(await sweep(request({}))).toMatchObject({ waiting: 1 });
    expect(store.runs).toEqual([{ name: "process-documents", data: { stale: true } }]);
    expect(await runStarted()).toMatchObject([{ created: 1 }]);
  });

  it("hands over what has waited for a day", async () => {
    await invoiceOrder(request({ ...order }));
    Object.assign(store.documents[0], {
      date_attempted: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      date_pending: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });
    expect(await workflow({ stale: true }, "function")).toMatchObject({ failed: 1, created: 0 });
    expect(store.documents[0]).toMatchObject({ status: "failed", problem_code: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Test connection", () => {
  it("names the account, how documents and payments are set up, and what waits", async () => {
    store.documents.push({ id: "1", key: "k", status: "failed" });
    const result = await testConnection(request(action({ id: "test-connection", source: "field" })));
    expect(result.message).toMatch(/Test GmbH.*regular VAT.*finalized.*"Online-Shop".*1 document needs attention/);
    expect(store.settings.connection.company).toBe("Test GmbH");
  });

  it("explains a refused token, a missing token and the old bookkeeping system", async () => {
    sevdesk.state.intercept = () => sevdesk.json(401, {});
    expect((await thrown(() => testConnection(request({})))).status).toBe(400);

    store.setSettings({ ...SETTINGS, connection: {} });
    expect((await thrown(() => testConnection(request({})))).message).toMatch(/Enter the API token/);

    vi.unstubAllGlobals();
    createSevdesk({ version: "1.0" });
    store.setSettings(SETTINGS);
    expect((await thrown(() => testConnection(request({})))).message).toMatch(/2\.0/);
  });

  it("checks the payment accounts against sevdesk's", () => {
    const accounts = [
      { id: "500", name: "Online-Shop", type: "offline", active: true },
      { id: "502", name: "Sparkasse", type: "online", active: true },
    ];
    expect(describePayments({}, accounts)).toMatch(/not booked.*Online-Shop/);
    expect(describePayments({ payments: { account: "Shop" } }, accounts)).toMatch(/no payment account named "Shop"/);
    expect(describePayments({ payments: { account: "Sparkasse" } }, accounts)).toMatch(/connected to a bank/);
    expect(describePayments({ payments: { account: "online-shop" } }, accounts)).toMatch(/are booked on/);
  });
});

describe("Mark as resolved", () => {
  it("stops the app from creating the document, and keeps a number the merchant gives", async () => {
    store.documents.push({ id: "a".repeat(24), key: "k", type: "invoice", status: "failed", problem: "x" });
    store.alerts.push({ id: "1", key: "documents" });
    await resolveDocument(request({ number: " RE-77 ", ...action({ id: "resolve", record_id: "a".repeat(24) }) }));
    expect(store.documents[0]).toMatchObject({ status: "resolved", number: "RE-77" });
    expect(store.alerts).toHaveLength(0);

    store.documents[0].locked_until = null;
    expect(await workflow(action({ id: "retry", record_id: "a".repeat(24) }))).toMatchObject({ result: "exists" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves a document that is in sevdesk as it is", async () => {
    store.documents.push({ id: "b".repeat(24), key: "k", type: "invoice", status: "failed", sevdesk_id: "9", number: "RE-1" });
    await resolveDocument(request(action({ id: "resolve", record_id: "b".repeat(24) })));
    expect(store.documents[0]).toMatchObject({ status: "created", sevdesk_id: "9" });
  });
});
