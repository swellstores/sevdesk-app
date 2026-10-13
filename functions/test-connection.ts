import { clearAlert } from "./lib/alerts";
import { SevdeskError, getCheckAccounts, getProfile } from "./lib/sevdesk";
import type { Api, CheckAccount, Profile } from "./lib/sevdesk";
import { apiToken, finalizes } from "./lib/settings";
import type { Settings } from "./lib/settings";

export const config: SwellConfig = {
  description: "Check the saved API token with sevdesk and show how the account is set up",
  action: true,
};

function same(a: string | null | undefined, b: string): boolean {
  return (a || "").trim().toLowerCase() === b.trim().toLowerCase();
}

/** How the payment settings match the accounts sevdesk has, in the merchant's words */
export function describePayments(settings: Settings, accounts: CheckAccount[]): string {
  const direct = accounts.filter((account) => account.active && account.type === "offline");
  const available = direct.length > 0 ? `Accounts in sevdesk that take bookings: ${direct.map((account) => account.name).join(", ")}.` : "sevdesk has no account that takes bookings directly: add a clearing account (Verrechnungskonto) under Bank.";
  const names = [settings.payments?.account, ...(settings.payments?.exceptions || []).map((row) => row?.account)]
    .map((name) => (name || "").trim())
    .filter((name, index, all) => name && all.indexOf(name) === index);

  if (names.length === 0) {
    return `Payments are not booked: name a payment account under Payments. ${available}`;
  }
  const unknown = names.filter((name) => !accounts.some((account) => same(account.name, name) || account.id === name));
  const banks = names.filter((name) => accounts.some((account) => same(account.name, name) && account.type !== "offline"));
  if (unknown.length > 0) {
    return `sevdesk has no payment account named ${unknown.map((name) => `"${name}"`).join(", ")}. ${available}`;
  }
  if (banks.length > 0) {
    return `${banks.map((name) => `"${name}"`).join(", ")} is connected to a bank, where sevdesk books payments only from imported transactions. ${available}`;
  }
  return `Payments are booked on ${names.map((name) => `"${name}"`).join(", ")}.`;
}

export default async function (req: SwellRequest) {
  const started = Date.now();
  const settings = ((await req.swell.settings()) || {}) as Settings;
  const token = apiToken(settings);
  if (!token) {
    throw new SwellError("Enter the API token, save the settings, then test again.", { status: 400 });
  }

  // The merchant waits for the answer, and a function has ten seconds
  const api: Api = { token, abortAt: started + 8000 };
  let profile: Profile;
  let accounts: CheckAccount[];
  try {
    [profile, accounts] = await Promise.all([getProfile(api), getCheckAccounts(api)]);
  } catch (err) {
    if (err instanceof SevdeskError && err.kind === "credentials") {
      throw new SwellError(
        "sevdesk did not accept the API token. Copy it again from your user in sevdesk (Einstellungen → Benutzer → API-Token).",
        { status: 400 },
      );
    }
    if (err instanceof SevdeskError && err.connection) {
      throw new SwellError(err.message, { status: 400 });
    }
    throw new SwellError(`${(err as Error).message} Try again in a minute.`, { status: 502 });
  }
  if (profile.version !== "2.0") {
    throw new SwellError(
      `The sevdesk account uses the bookkeeping system ${profile.version || "1.0"}. The app needs sevdesk-Update 2.0, which sevdesk offers under Einstellungen → System.`,
      { status: 400 },
    );
  }

  const company = profile.clientName || "your sevdesk account";
  if (settings.connection?.company !== profile.clientName) {
    try {
      await req.swell.put(`/settings/${req.appId}`, { connection: { company: profile.clientName || null } });
    } catch (err) {
      // Only the display of the account name depends on it
      console.error("Unable to save the sevdesk account name", (err as Error).message);
    }
  }
  await clearAlert(req.swell, "connection");

  const waiting = (await req.swell.get("/documents", { where: { status: "failed" }, limit: 1 })) as { count?: number };
  const parts = [
    `Connected to ${company} (${profile.smallBusiness ? "small business, invoices without VAT" : "regular VAT"}).`,
    finalizes(settings) ? "Documents are created finalized." : "Documents are created as drafts.",
    describePayments(settings, accounts),
  ];
  if (settings.connection?.enabled !== true) {
    parts.push('Turn on "Create documents automatically for paid orders and refunds" to start.');
  }
  if ((waiting?.count || 0) > 0) {
    parts.push(
      `${waiting.count} ${waiting.count === 1 ? "document needs" : "documents need"} attention: choose Retry failed documents in the Actions menu.`,
    );
  }
  return { message: parts.join(" ") };
}
