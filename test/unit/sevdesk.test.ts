import { afterEach, describe, expect, it, vi } from "vitest";
import { SevdeskError, getDocument, saveDraft } from "../../functions/lib/sevdesk";
import type { DocumentDraft } from "../../functions/lib/sevdesk";
import { createSevdesk } from "../helpers/sevdesk";

const api = { token: "token" };
const draft: DocumentDraft = {
  contactId: "c1", contactPersonId: "77", date: 1, deliveryDate: 1, header: "Rechnung", address: "A", countryId: 1,
  taxRule: 1, showNet: true, reference: "1", positions: [{ name: "X", quantity: 1, price: 10, taxRate: 19, unity: 1 }],
};

async function failure(run: () => Promise<unknown>): Promise<SevdeskError> {
  try {
    await run();
  } catch (err) {
    return err as SevdeskError;
  }
  throw new Error("Expected the call to fail");
}

afterEach(() => vi.unstubAllGlobals());

describe("the sevdesk client", () => {
  it("sends the token bare and reads sevdesk's totals from the draft", async () => {
    const sevdesk = createSevdesk();
    const saved = await saveDraft(api, "Invoice", draft);
    expect(saved).toMatchObject({ number: null, status: 100, sumGross: 11.9, showNet: true });
    expect((vi.mocked(fetch).mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: "token" });
    expect(sevdesk.drafts("Invoice")).toHaveLength(1);
  });

  it("tells a refused token, a refusal and an outage apart", async () => {
    const sevdesk = createSevdesk();
    sevdesk.state.intercept = () => sevdesk.json(401, { status: 401, message: "Authentication required" });
    expect(await failure(() => getDocument(api, "Invoice", "1"))).toMatchObject({ kind: "credentials", connection: true });

    sevdesk.state.intercept = () => sevdesk.refused(422, "The given tax rate (16) is not allowed.");
    expect(await failure(() => saveDraft(api, "Invoice", draft))).toMatchObject({ kind: "rejected", temporary: false, uncertain: false });

    sevdesk.state.intercept = () => sevdesk.json(503, {});
    expect(await failure(() => saveDraft(api, "Invoice", draft))).toMatchObject({ kind: "unavailable", temporary: true, uncertain: true });
  });

  it("treats a 500 with a message as a refusal that may still have written", async () => {
    const sevdesk = createSevdesk();
    sevdesk.state.intercept = () => sevdesk.refused(500, "Integrity constraint violation");
    expect(await failure(() => saveDraft(api, "Invoice", draft))).toMatchObject({ kind: "rejected", uncertain: true });
  });

  it("marks a write without an answer as uncertain, and a read as not", async () => {
    const sevdesk = createSevdesk();
    sevdesk.state.intercept = () => "lose-answer";
    expect(await failure(() => saveDraft(api, "Invoice", draft))).toMatchObject({ kind: "unavailable", uncertain: true });
    expect(await failure(() => getDocument(api, "Invoice", "1"))).toMatchObject({ uncertain: false });
  });

  it("repeats a call that sevdesk rate-limited, and gives up when no time is left", async () => {
    const sevdesk = createSevdesk();
    let limited = 2;
    sevdesk.state.intercept = () => (limited-- > 0 ? sevdesk.json(429, {}) : undefined);
    await expect(saveDraft(api, "Invoice", draft)).resolves.toMatchObject({ status: 100 });

    const before = sevdesk.calls.length;
    expect(await failure(() => saveDraft({ ...api, abortAt: Date.now() - 1 }, "Invoice", draft))).toMatchObject({ temporary: true });
    expect(sevdesk.calls).toHaveLength(before);
  });
});
