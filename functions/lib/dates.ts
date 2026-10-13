/**
 * sevdesk takes dates as Unix timestamps and shows them in the account's time zone. The few
 * dates the app prints itself, in a document's text, are German days: an order placed at
 * 23:30 UTC belongs to the next day on a German invoice.
 */

const BERLIN = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function asDate(value: Date | string | undefined | null): Date {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

/** The moment in seconds since 1970, as sevdesk expects it */
export function unixTime(value: Date | string | undefined | null): number {
  return Math.floor(asDate(value).getTime() / 1000);
}

/** The day as printed on a document: 10.10.2026 in German, 10 Oct 2026 in English */
export function displayDate(value: Date | string | undefined | null, language: "de" | "en"): string {
  const parts: Record<string, string> = {};
  for (const part of BERLIN.formatToParts(asDate(value))) {
    parts[part.type] = part.value;
  }
  if (language === "de") {
    return `${parts.day}.${parts.month}.${parts.year}`;
  }
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${+parts.day} ${months[+parts.month - 1]} ${parts.year}`;
}
