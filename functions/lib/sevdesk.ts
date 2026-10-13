/**
 * Client for the sevdesk API (https://api.sevdesk.de/), system version 2.0.
 *
 * What shapes it:
 * - No idempotency key. When a write ends without an answer (timeout, 5xx), it may or may
 *   not have happened. Such errors are marked `uncertain`, and the caller looks before it
 *   writes again.
 * - sevdesk can block a token after repeated failing requests, so a refused request is
 *   never sent again by the client.
 * - Numbers arrive as strings, and every answer is wrapped in `objects`.
 */

const BASE_URL = "https://my.sevdesk.de/api/v1";
const USER_AGENT = "swell-sevdesk-app";

// One call is cut off before the function's own limit, so the function still has time to
// record what happened. A workflow step has minutes, and no deadline
const TIMEOUT_MS = 15000;

/** Waits before a call that sevdesk answered with 429 is repeated. Tests set these to zero */
export const pacing = { rateLimitWaitsMs: [500, 1000] };

export type SevdeskErrorKind =
  /** 401: the token is wrong or was replaced */
  | "credentials"
  /** 402, 403: the account or its plan does not allow the call */
  | "permission"
  /** 400, 404, 409, 422 and the like: sevdesk refuses this data. Sending it again cannot help */
  | "rejected"
  /** 429 after the waits */
  | "rate_limit"
  /** Network failure, timeout, 5xx, or no time left to wait for sevdesk */
  | "unavailable";

export class SevdeskError extends Error {
  kind: SevdeskErrorKind;
  status: number;
  /** True when a write may have been performed although no answer arrived */
  uncertain: boolean;
  /** The refusal in the merchant's terms, when the app knows what it means */
  hint?: string;

  constructor(kind: SevdeskErrorKind, status: number, message: string, uncertain = false) {
    super(message);
    this.name = "SevdeskError";
    this.kind = kind;
    this.status = status;
    this.uncertain = uncertain;
  }

  /** True for failures of the connection as a whole, which no single document can fix */
  get connection(): boolean {
    return this.kind === "credentials" || this.kind === "permission";
  }

  /** True when the same call can succeed later without anybody changing anything */
  get temporary(): boolean {
    return this.kind === "rate_limit" || this.kind === "unavailable";
  }

  get notFound(): boolean {
    return this.status === 404;
  }
}

/** How to reach one sevdesk account */
export interface Api {
  token: string;
  /** The moment (ms) by which a call has to be given up, because the function that makes it ends soon after */
  abortAt?: number;
}

export type Kind = "Invoice" | "CreditNote";

interface Ref {
  id: string | number;
  objectName: string;
}

export function ref(objectName: string, id: string | number): Ref {
  return { id, objectName };
}

/** sevdesk's document states */
export const STATUS = { draft: 100, open: 200, partlyPaid: 750, paid: 1000 };

export interface Position {
  name: string;
  /** Printed under the name */
  text?: string;
  quantity: number;
  /** Net or gross, as the document's `showNet` says. Up to four decimals */
  price: number;
  taxRate: number;
  /** sevdesk's unit id: 1 is "Stk", 7 is "pauschal" */
  unity: number;
}

/** The fields of an invoice and of a credit note that the app sets. Dates are Unix timestamps */
export interface DocumentDraft {
  contactId: string;
  contactPersonId: string;
  date: number;
  deliveryDate: number;
  header: string;
  headText?: string;
  footText?: string;
  /** Name and address lines. sevdesk prints the country itself, from `countryId` */
  address: string;
  countryId: number;
  /** Where the goods go, when that is another country: sevdesk checks One-Stop-Shop rates against it */
  deliveryCountryId?: number;
  taxRule: number;
  /** True when the position prices are net */
  showNet: boolean;
  /** Shown in sevdesk as "Referenz/Bestellnummer". The app finds its own drafts by it */
  reference: string;
  positions: Position[];
  /** Credit note only: the invoice it corrects */
  invoiceId?: string;
  /** Invoice only: days until it is due. Without it sevdesk takes the invoice date as the due date */
  timeToPay?: number;
}

export interface SevDocument {
  id: string;
  number: string | null;
  status: number;
  sumNet: number;
  sumTax: number;
  sumGross: number;
  /** Invoices only */
  paidAmount: number;
  showNet: boolean;
  taxRule: number;
  contactId: string;
  contactPersonId: string;
  countryId: number;
  deliveryCountryId: number;
  address: string;
  reference: string | null;
  date: string | null;
  deliveryDate: string | null;
  created: string | null;
}

export interface SevPosition extends Position {
  sumGross: number;
}

export interface CheckAccount {
  id: string;
  name: string;
  /** "offline" accounts take bookings directly; an "online" account needs its imported bank transaction */
  type: string;
  active: boolean;
}

export interface Profile {
  clientName: string;
  /** Kleinunternehmer, § 19 UStG: no VAT on any document */
  smallBusiness: boolean;
  /** "2.0" for accounts on the current bookkeeping system */
  version: string;
  /** The sevdesk user named on documents as the contact person */
  userId: string;
  /** The account's payment term for invoices, in days */
  timeToPay?: number;
}

export interface FoundContact {
  id: string;
  vatNumber: string | null;
  customerNumber: string | null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function num(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function describe(body: any, fallback: string): string {
  const message = body?.error?.message ?? body?.message;
  return typeof message === "string" && message ? message.slice(0, 500) : fallback;
}

function toError(status: number, body: any, write: boolean): SevdeskError {
  switch (status) {
    case 401:
      return new SevdeskError("credentials", status, "sevdesk did not accept the API token.");
    case 402:
    case 403:
      return new SevdeskError(
        "permission",
        status,
        `sevdesk does not allow this for the connected account: ${describe(body, "access denied")}. Check the plan and the user the API token belongs to.`,
      );
    case 429:
      return new SevdeskError("rate_limit", status, "sevdesk is receiving too many requests from this account.");
    default:
      if (status >= 500) {
        // sevdesk answers some refusals with 500 and a message. Those are refusals; a 5xx
        // without one is an outage. Either way a write may have gone through
        const message = body?.error?.message;
        if (status === 500 && typeof message === "string" && message) {
          return new SevdeskError("rejected", status, message.slice(0, 500), write);
        }
        return new SevdeskError("unavailable", status, `sevdesk is not available (${status}).`, write);
      }
      return new SevdeskError("rejected", status, describe(body, `sevdesk refused the request (${status}).`));
  }
}

async function send(api: Api, method: string, path: string, payload?: unknown): Promise<any> {
  const token = (api.token || "").trim();
  if (!token) {
    throw new SevdeskError("credentials", 401, "The sevdesk API token is missing in the app's settings.");
  }
  const write = method !== "GET";

  for (let attempt = 0; ; attempt++) {
    const timeout = api.abortAt ? Math.min(TIMEOUT_MS, api.abortAt - Date.now()) : TIMEOUT_MS;
    if (timeout <= 0) {
      throw new SevdeskError("unavailable", 0, "sevdesk is answering slowly, so the document is not finished yet.");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: token,
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch {
      throw new SevdeskError("unavailable", 0, "sevdesk did not answer in time.", write);
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429 && attempt < pacing.rateLimitWaitsMs.length) {
      await wait(pacing.rateLimitWaitsMs[attempt]);
      continue;
    }

    let body: any;
    try {
      const text = await response.text();
      body = text ? JSON.parse(text) : {};
    } catch {
      body = undefined;
    }
    if (response.ok && body !== undefined) {
      return body.objects;
    }
    throw toError(response.ok ? 502 : response.status, body, write);
  }
}

function toDocument(raw: any): SevDocument {
  return {
    id: String(raw.id),
    number: raw.invoiceNumber || raw.creditNoteNumber || null,
    status: num(raw.status),
    sumNet: num(raw.sumNet),
    sumTax: num(raw.sumTax),
    sumGross: num(raw.sumGross),
    paidAmount: num(raw.paidAmount),
    showNet: raw.showNet === true || raw.showNet === "1" || raw.showNet === 1,
    taxRule: num(raw.taxRule?.id),
    contactId: String(raw.contact?.id || ""),
    contactPersonId: String(raw.contactPerson?.id || ""),
    countryId: num(raw.addressCountry?.id),
    deliveryCountryId: num(raw.deliveryAddressCountry?.id),
    address: raw.address || "",
    reference: raw.customerInternalNote || null,
    date: raw.invoiceDate || raw.creditNoteDate || null,
    deliveryDate: raw.deliveryDate || null,
    created: raw.create || null,
  };
}

function toPosition(raw: any): SevPosition {
  return {
    name: raw.name || "",
    ...(raw.text ? { text: raw.text } : {}),
    // sevdesk answers a quantity of one as `true`
    quantity: raw.quantity === true ? 1 : num(raw.quantity),
    price: num(raw.price),
    taxRate: num(raw.taxRate),
    unity: num(raw.unity?.id) || 1,
    sumGross: num(raw.sumGross),
  };
}

function positionPayload(objectName: string, position: Position, index: number) {
  return {
    objectName,
    mapAll: true,
    quantity: position.quantity,
    price: position.price,
    name: position.name,
    ...(position.text ? { text: position.text } : {}),
    unity: ref("Unity", position.unity),
    taxRate: position.taxRate,
    positionNumber: index,
  };
}

/** The account's facts that every document depends on */
export async function getProfile(api: Api): Promise<Profile> {
  const [version, clients, users] = await Promise.all([
    send(api, "GET", "/Tools/bookkeepingSystemVersion"),
    send(api, "GET", "/SevClient"),
    send(api, "GET", "/SevUser"),
  ]);
  const client = Array.isArray(clients) ? clients[0] : clients;
  const user = (Array.isArray(users) ? users : []).find((entry: any) => entry?.id);
  if (!client?.id || !user?.id) {
    throw new SevdeskError("permission", 403, "sevdesk did not return the account or its user for this API token.");
  }
  return {
    clientName: client.name || "",
    smallBusiness: client.smallSettlement === true || client.smallSettlement === "1" || client.smallSettlement === 1,
    version: String(version?.version || ""),
    userId: String(user.id),
    ...(num(client.invoiceTimeToPay) > 0 ? { timeToPay: num(client.invoiceTimeToPay) } : {}),
  };
}

export async function getCheckAccounts(api: Api): Promise<CheckAccount[]> {
  const accounts = await send(api, "GET", "/CheckAccount?limit=200");
  return (Array.isArray(accounts) ? accounts : []).map((raw: any) => ({
    id: String(raw.id),
    name: String(raw.name || ""),
    type: String(raw.type || ""),
    active: num(raw.status) === 100,
  }));
}

/** The contacts that carry this e-mail address. sevdesk compares without regard to case */
export async function findContactsByEmail(api: Api, email: string): Promise<FoundContact[]> {
  const ways = await send(api, "GET", `/CommunicationWay?type=EMAIL&embed=contact&value=${encodeURIComponent(email)}`);
  const found = new Map<string, FoundContact>();
  for (const way of Array.isArray(ways) ? ways : []) {
    const contact = way?.contact;
    if (contact?.id && !found.has(String(contact.id))) {
      found.set(String(contact.id), {
        id: String(contact.id),
        vatNumber: contact.vatNumber || null,
        customerNumber: contact.customerNumber || null,
      });
    }
  }
  return [...found.values()];
}

/** False when sevdesk no longer has the contact */
export async function contactExists(api: Api, id: string): Promise<boolean> {
  try {
    const found = await send(api, "GET", `/Contact/${encodeURIComponent(id)}`);
    return Boolean((Array.isArray(found) ? found[0] : found)?.id);
  } catch (err) {
    if (err instanceof SevdeskError && err.notFound) {
      return false;
    }
    throw err;
  }
}

export interface ContactInput {
  /** A company when set, a person otherwise */
  company?: string;
  firstName?: string;
  lastName?: string;
  vatNumber?: string;
  email?: string;
  street?: string;
  zip?: string;
  city?: string;
  countryId: number;
}

/** Creates the contact as a customer and returns its id. The customer number is sevdesk's */
export async function createContact(api: Api, input: ContactInput): Promise<string> {
  const created = await send(api, "POST", "/Contact", {
    ...(input.company ? { name: input.company } : { surename: input.firstName || "", familyname: input.lastName || "" }),
    ...(input.vatNumber ? { vatNumber: input.vatNumber } : {}),
    category: ref("Category", 3),
    status: 1000,
  });
  return String(created.id);
}

/** The contact's billing address and e-mail address. Each is its own record in sevdesk */
export async function addContactDetails(api: Api, contactId: string, input: ContactInput): Promise<void> {
  const contact = ref("Contact", contactId);
  await Promise.all([
    send(api, "POST", "/ContactAddress", {
      contact,
      ...(input.street ? { street: input.street } : {}),
      ...(input.zip ? { zip: input.zip } : {}),
      ...(input.city ? { city: input.city } : {}),
      country: ref("StaticCountry", input.countryId),
      category: ref("Category", 47),
    }),
    input.email
      ? send(api, "POST", "/CommunicationWay", {
          contact,
          type: "EMAIL",
          value: input.email,
          key: ref("CommunicationWayKey", 8),
          main: true,
        })
      : undefined,
  ]);
}

/** Creates a draft: no number, changeable, deletable. The answer holds sevdesk's own totals */
export async function saveDraft(api: Api, kind: Kind, draft: DocumentDraft): Promise<SevDocument> {
  const invoice = kind === "Invoice";
  const document = {
    objectName: kind,
    mapAll: true,
    contact: ref("Contact", draft.contactId),
    contactPerson: ref("SevUser", draft.contactPersonId),
    [invoice ? "invoiceDate" : "creditNoteDate"]: draft.date,
    deliveryDate: draft.deliveryDate,
    status: STATUS.draft,
    header: draft.header,
    headText: draft.headText || null,
    footText: draft.footText || null,
    address: draft.address,
    addressCountry: ref("StaticCountry", draft.countryId),
    ...(draft.deliveryCountryId ? { deliveryAddressCountry: ref("StaticCountry", draft.deliveryCountryId) } : {}),
    taxRule: ref("TaxRule", draft.taxRule),
    // Required by the API and unused since system version 2.0, where the tax rule decides
    taxRate: 0,
    taxText: "Umsatzsteuer",
    taxType: "default",
    currency: "EUR",
    showNet: draft.showNet,
    customerInternalNote: draft.reference,
    ...(invoice
      ? { invoiceType: "RE", discount: 0, ...(draft.timeToPay ? { timeToPay: draft.timeToPay } : {}) }
      : { bookingCategory: "UNDERACHIEVEMENT", refSrcInvoice: ref("Invoice", draft.invoiceId as string) }),
  };
  const positions = draft.positions.map((position, index) => positionPayload(`${kind}Pos`, position, index));
  const saved = await send(
    api,
    "POST",
    `/${kind}/Factory/save${kind}`,
    invoice ? { invoice: document, invoicePosSave: positions } : { creditNote: document, creditNotePosSave: positions },
  );
  return toDocument(invoice ? saved.invoice : saved.creditNote);
}

export async function getDocument(api: Api, kind: Kind, id: string): Promise<SevDocument> {
  const found = await send(api, "GET", `/${kind}/${encodeURIComponent(id)}`);
  const raw = Array.isArray(found) ? found[0] : found;
  if (!raw?.id) {
    throw new SevdeskError("rejected", 404, `sevdesk has no ${kind} with the id ${id}.`);
  }
  return toDocument(raw);
}

export async function getInvoicePositions(api: Api, id: string): Promise<SevPosition[]> {
  const positions = await send(api, "GET", `/Invoice/${encodeURIComponent(id)}/getPositions?limit=1000`);
  return (Array.isArray(positions) ? positions : [])
    .map((raw: any) => ({ position: toPosition(raw), order: num(raw.positionNumber) }))
    .sort((a, b) => a.order - b.order)
    .map((entry) => entry.position);
}

/** The contact's drafts, newest first. sevdesk cannot search by the reference, so the caller compares it */
export async function listDrafts(api: Api, kind: Kind, contactId: string): Promise<SevDocument[]> {
  const query = `contact[id]=${encodeURIComponent(contactId)}&contact[objectName]=Contact&status=${STATUS.draft}&limit=100`;
  const found = await send(api, "GET", `/${kind}?${query}`);
  return (Array.isArray(found) ? found : []).map(toDocument);
}

/** Deletes a draft. sevdesk refuses to delete anything that has a number */
export async function deleteDraft(api: Api, kind: Kind, id: string): Promise<void> {
  await send(api, "DELETE", `/${kind}/${encodeURIComponent(id)}`);
}

/**
 * Sets the language of the document's labels in the PDF. The values differ between
 * sevdesk's layouts ("de" and "en" in one, "de_DE" and "en_US" in another), so the document
 * is rendered first, which answers with the values its layout takes and the one it has.
 * Rendering leaves a draft a draft. sevdesk also refuses the change on a document that was
 * never rendered.
 */
export async function setLanguage(api: Api, kind: Kind, id: string, language: "de" | "en"): Promise<void> {
  const path = `/${kind}/${encodeURIComponent(id)}`;
  const rendered = await send(api, "POST", `${path}/render`, {});
  const parameter = (Array.isArray(rendered?.parameters) ? rendered.parameters : []).find((entry: any) => entry?.key === "language");
  const values: string[] = (parameter?.values || []).map((entry: any) => String(entry?.value));
  const wanted = values.find((value) => value === language) || values.find((value) => value.startsWith(`${language}_`));
  if (!wanted || parameter.value === wanted) {
    return;
  }
  await send(api, "PUT", `${path}/changeParameter`, { key: "language", value: wanted });
}

/**
 * Finalizes a draft: sevdesk assigns the number and, in most accounts, locks the document.
 * Repeating the call on a finalized document changes nothing.
 */
export async function finalize(api: Api, kind: Kind, id: string): Promise<SevDocument> {
  const sent = await send(api, "PUT", `/${kind}/${encodeURIComponent(id)}/sendBy`, { sendType: "VPR", sendDraft: false });
  return toDocument(Array.isArray(sent) ? sent[0] : sent);
}

/**
 * Books a payment on a payment account that takes bookings directly; sevdesk creates the
 * transaction. A payout on a credit note is a negative amount. Returns the document's new status.
 */
export async function bookAmount(
  api: Api,
  kind: Kind,
  id: string,
  booking: { amount: number; date: number; accountId: string },
): Promise<number> {
  const log = await send(api, "PUT", `/${kind}/${encodeURIComponent(id)}/bookAmount`, {
    amount: booking.amount,
    date: booking.date,
    type: "N",
    checkAccount: ref("CheckAccount", booking.accountId),
  });
  return num(log?.toStatus);
}

/** The PDF as sevdesk renders it, base64-encoded. `preventSendBy` keeps a draft a draft */
export async function getPdf(api: Api, kind: Kind, id: string): Promise<{ base64: string }> {
  const file = await send(api, "GET", `/${kind}/${encodeURIComponent(id)}/getPdf?preventSendBy=true`);
  if (!file?.content) {
    throw new SevdeskError("unavailable", 502, "sevdesk returned no PDF for the document.");
  }
  return { base64: file.content as string };
}

/** The address of a document in sevdesk, for the merchant */
export function documentLink(kind: Kind, id: string): string {
  return kind === "Invoice"
    ? `https://my.sevdesk.de/fi/detail/type/RE/id/${id}`
    : `https://my.sevdesk.de/cn/detail/type/CN/id/${id}`;
}
