import { vi } from "vitest";
import { pacing } from "../../functions/lib/sevdesk";

type Row = Record<string, any>;

export interface SevdeskCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
}

function round(value: number): number {
  return (Math.sign(value) * Math.round(Math.abs(value) * 100 + 1e-7)) / 100;
}

/** The rates sevdesk takes under each tax rule, as it answered on 2026-10-12. `null`: the destination country's */
const RULE_RATES: Record<number, number[] | null> = { 1: [0, 7, 19], 2: [0], 3: [0], 11: [0], 17: [0], 18: null, 19: null, 21: [0] };

/** sevdesk's totals: each position rounded on its own, the document the sum of its positions */
function withTotals(document: Row, positions: Row[]) {
  const net = document.showNet === true;
  let sumNet = 0;
  let sumGross = 0;
  const priced = positions.map((position) => {
    const amount = round(position.quantity * position.price);
    const lineNet = net ? amount : round(amount / (1 + position.taxRate / 100));
    const lineGross = net ? round(amount + round((amount * position.taxRate) / 100)) : amount;
    sumNet = round(sumNet + lineNet);
    sumGross = round(sumGross + lineGross);
    return { ...position, quantity: position.quantity === 1 ? true : position.quantity, sumNet: lineNet, sumGross: lineGross };
  });
  return { sums: { sumNet: String(sumNet), sumTax: String(round(sumGross - sumNet)), sumGross: String(sumGross) }, priced };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function refused(status: number, message: string): Response {
  return json(status, { error: { message }, objects: null });
}

/**
 * Replaces `fetch` with a small sevdesk: drafts without numbers, totals computed its way,
 * numbers on finalizing, payments, contacts and a PDF. `intercept` can answer any call
 * differently, to play refusals, outages and lost answers.
 */
export function createSevdesk(options: { smallBusiness?: boolean; version?: string; accounts?: Row[] } = {}) {
  pacing.rateLimitWaitsMs = [0, 0];

  const documents: Row[] = [];
  const contacts: Row[] = [];
  const emails: Row[] = [];
  const bookings: Row[] = [];
  const calls: SevdeskCall[] = [];
  const accounts = options.accounts || [
    { id: "500", name: "Online-Shop", type: "offline", status: "100" },
    { id: "501", name: "Gutscheine", type: "offline", status: "100" },
    { id: "502", name: "Sparkasse", type: "online", status: "100" },
  ];
  const state: {
    intercept?: (call: SevdeskCall) => Response | Promise<Response> | "lose-answer" | undefined;
    now?: () => Date;
  } = {};
  let sequence = 1000;

  function save(kind: string, body: Row): Row | Response {
    const invoice = kind === "Invoice";
    const head = invoice ? body.invoice : body.creditNote;
    const positions: Row[] = invoice ? body.invoicePosSave : body.creditNotePosSave;
    const allowed = RULE_RATES[Number(head.taxRule.id)];
    const wrong = positions.find((position) =>
      allowed ? !allowed.includes(position.taxRate) : [7, 19].includes(position.taxRate) || position.taxRate === 0,
    );
    if (wrong) {
      return refused(422, `The given tax rate (${wrong.taxRate}) is not allowed. Allowed values are: ${(allowed || []).join(", ")}.`);
    }
    if (Number(head.taxRule.id) === 3 && !contacts.find((contact) => contact.id === String(head.contact.id))?.vatNumber) {
      return refused(422, "The contacts VAT number is required");
    }
    const { sums, priced } = withTotals(head, positions);
    if (!invoice) {
      const source = documents.find((document) => document.kind === "Invoice" && document.id === String(head.refSrcInvoice.id));
      if (!source || Number(source.status) < 200) {
        return refused(422, "Draft document is not allowed!");
      }
    }
    sequence += 1;
    const document = {
      ...head,
      ...sums,
      kind,
      id: String(sequence),
      [invoice ? "invoiceNumber" : "creditNoteNumber"]: null,
      status: "100",
      paidAmount: 0,
      showNet: head.showNet ? "1" : "0",
      positions: priced,
      create: (state.now?.() || new Date()).toISOString(),
    };
    documents.push(document);
    return document;
  }

  const mock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const call: SevdeskCall = {
      method: init.method || "GET",
      path: url.pathname.replace("/api/v1", ""),
      query: url.searchParams,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);

    const [, resource, id, sub] = call.path.split("/");
    const intercepted = await state.intercept?.(call);
    if (intercepted === "lose-answer") {
      // sevdesk performs the call, but the answer never arrives
      if (id === "Factory") {
        save(resource, call.body);
      }
      throw new TypeError("network connection lost");
    }
    if (intercepted) {
      return intercepted;
    }

    if (resource === "Tools") {
      return json(200, { objects: { version: options.version || "2.0" } });
    }
    if (resource === "SevClient") {
      return json(200, { objects: [{ id: "1", name: "Test GmbH", smallSettlement: options.smallBusiness ? "1" : "0", invoiceTimeToPay: "14" }] });
    }
    if (resource === "SevUser") {
      return json(200, { objects: [{ id: "77", fullname: "Test User" }] });
    }
    if (resource === "CheckAccount") {
      return json(200, { objects: accounts });
    }
    if (resource === "Contact") {
      if (call.method === "POST") {
        const contact = { ...call.body, id: `c${contacts.length + 1}`, customerNumber: String(1000 + contacts.length) };
        contacts.push(contact);
        return json(201, { objects: contact });
      }
      const contact = contacts.find((entry) => entry.id === id);
      return contact ? json(200, { objects: [contact] }) : refused(404, `No Model_Contact with the id ${id} was found`);
    }
    if (resource === "ContactAddress") {
      return json(201, { objects: { id: "a1", ...call.body } });
    }
    if (resource === "CommunicationWay") {
      if (call.method === "POST") {
        emails.push(call.body);
        return json(201, { objects: { id: `e${emails.length}`, ...call.body } });
      }
      const value = (call.query.get("value") || "").toLowerCase();
      const found = emails
        .filter((email) => String(email.value).toLowerCase() === value)
        .map((email) => ({ value: email.value, contact: contacts.find((contact) => contact.id === email.contact.id) }));
      return json(200, { objects: found });
    }
    if (resource === "Invoice" || resource === "CreditNote") {
      if (id === "Factory") {
        const saved = save(resource, call.body);
        if (saved instanceof Response) {
          return saved;
        }
        return json(201, { objects: { [resource === "Invoice" ? "invoice" : "creditNote"]: saved } });
      }
      if (!id) {
        const contact = call.query.get("contact[id]");
        const status = call.query.get("status");
        const listed = documents
          .filter((document) => document.kind === resource)
          .filter((document) => String(document.contact.id) === contact && (!status || document.status === status));
        return json(200, { objects: [...listed].reverse() });
      }
      const index = documents.findIndex((document) => document.kind === resource && document.id === id);
      const document = documents[index];
      if (!document) {
        return refused(404, `No Model_${resource} with the id ${id} was found`);
      }
      if (call.method === "DELETE") {
        if (document.status !== "100") {
          return refused(409, `${resource} can only be deleted in status 100`);
        }
        documents.splice(index, 1);
        return json(200, { objects: [null] });
      }
      if (sub === "getPositions") {
        return json(200, { objects: document.positions.map((position: Row, i: number) => ({ ...position, positionNumber: String(i) })) });
      }
      if (sub === "render") {
        // The two layouts name their languages differently, and an account's default is its own
        const values = resource === "Invoice" ? ["en", "de", "de_AT"] : ["de_DE", "de_AT", "en_US"];
        document.rendered = true;
        document.language = document.language || values[0];
        return json(201, { objects: { parameters: [{ key: "language", value: document.language, values: values.map((value) => ({ value })) }] } });
      }
      if (sub === "changeParameter") {
        if (!document.rendered) {
          return refused(500, "Syntax error");
        }
        document.language = call.body.value;
        return json(200, { objects: { result: 1 } });
      }
      if (sub === "sendBy") {
        if (document.status === "100") {
          const prefix = resource === "Invoice" ? "RE" : "GU";
          const count = documents.filter((entry) => entry.kind === resource && entry.status !== "100").length;
          document[resource === "Invoice" ? "invoiceNumber" : "creditNoteNumber"] = `${prefix}-${1000 + count}`;
          document.status = "200";
        }
        return json(200, { objects: document });
      }
      if (sub === "bookAmount") {
        const total = Number(document.sumGross);
        if (resource === "Invoice" && round(document.paidAmount + call.body.amount) > total) {
          return refused(400, "Invoice has already been paid");
        }
        const account = accounts.find((entry) => entry.id === String(call.body.checkAccount.id));
        if (!account) {
          return refused(404, `No Model_CheckAccount with the id ${call.body.checkAccount.id} was found`);
        }
        bookings.push({ document: document.id, amount: call.body.amount, account: account.name, date: call.body.date });
        document.paidAmount = round(document.paidAmount + Math.abs(call.body.amount));
        const from = document.status;
        document.status = document.paidAmount >= total ? "1000" : "750";
        return json(200, { objects: { fromStatus: from, toStatus: document.status } });
      }
      if (sub === "getPdf") {
        return json(200, { objects: { filename: "x.pdf", mimetype: "application/pdf", base64Encoded: true, content: btoa(`%PDF ${document.id}`) } });
      }
      return json(200, { objects: [document] });
    }
    return refused(404, `Unexpected call ${call.method} ${call.path}`);
  });
  vi.stubGlobal("fetch", mock);

  return {
    documents,
    contacts,
    emails,
    bookings,
    calls,
    state,
    json,
    refused,
    /** The calls that created a draft so far */
    drafts(kind?: string) {
      return calls.filter((call) => call.method === "POST" && call.path.includes("/Factory/") && (!kind || call.path.startsWith(`/${kind}/`)));
    },
    invoices() {
      return documents.filter((document) => document.kind === "Invoice");
    },
    creditNotes() {
      return documents.filter((document) => document.kind === "CreditNote");
    },
  };
}
