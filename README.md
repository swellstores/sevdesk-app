# sevdesk for Swell

Creates invoices and credit notes in [sevdesk](https://sevdesk.de/) for a Swell store's orders, and books their payments. An order that becomes paid gets an invoice, which arrives in sevdesk as paid. A refund gets a credit note for that invoice, which arrives as paid out. Each document is listed on its order in Swell, and its page shows the number, the status in sevdesk, the PDF and a link into sevdesk.

Data flows one way, from Swell to sevdesk, with the merchant's own API token. The app reads orders, payments and customers. It writes only its own records in Swell, and only new documents, bookings and contacts in sevdesk.

## Setup

1. Install the app from Apps in the Swell dashboard.
2. In sevdesk: complete the company and tax settings. Add a clearing account for shop payments under Bank → Verrechnungskonto. Copy the API token of your user under Einstellungen → Benutzer.
3. In Swell, open Apps → sevdesk → Settings, paste the token under **API token**, save, and press **Test connection**. It fills in **Connected account** with the name of the sevdesk account, and says whether the account invoices with VAT, whether documents are created as drafts or finalized, which sevdesk accounts take bookings, and how the payment settings match them.
4. Under **Payments**, enter the name of the clearing account, and add a row under **Payment method exceptions** for each method that arrives elsewhere. See "Payments".
5. Under **Documents**, choose:
   - **Create documents as**: drafts or finalized documents. New installs create drafts. See "Drafts and finalized documents".
   - **Document language**: German, English, or by country: German for Germany, Austria, Switzerland and Liechtenstein, English elsewhere.
   - **Sales to other EU countries**: by the tax rate charged, or always under the One-Stop-Shop. See "Tax".
   - **Create credit notes for refunds**: on for new installs. Switched off, refunds create nothing.
   - **E-mail finalized documents to customers, with a link to the PDF**: off for new installs.
6. Turn on **Create documents automatically for paid orders and refunds**. Until then nothing is created by itself; the buttons work either way.

Settings are separate for the store's test and live environments, and both start empty. The app needs an account on sevdesk's current bookkeeping system ("sevdesk-Update 2.0", which every account opened since mid-2024 has); Test connection says so if yours is not.

## What is created

| In Swell | In sevdesk |
| --- | --- |
| An order becomes paid | An invoice, and a booking for each of its payments |
| A payment of an invoiced order is refunded, in part or in full | A credit note for the invoice, and the booking of the payout |
| A customer's first order | A contact. Later orders use it again |
| **Create sevdesk invoice** on an order, or **Create sevdesk invoices** on selected orders | An invoice, paid or not |

**The invoice.** Addressed to the billing address. The head text names the Swell order, and the order number is in sevdesk's reference field. Then one position per order item, one for shipping, and discounts as a negative position per tax rate, named after the coupon. A paid order's invoice says that it is already paid, and how. Layout, letterhead and number range come from the sevdesk account, and so does the due date: the invoice gets the payment term set for invoices in sevdesk, so one that is still open is listed there as open, not as overdue the next day. An unpaid order's invoice carries no payment instructions of its own: keep your bank details in the footer of the sevdesk layout, or create drafts and add a text in sevdesk before finalizing.

**The credit note.** A refund in Swell is an amount and names no items. A refund of the whole invoice repeats the invoice's positions. A partial refund becomes one position per tax rate. sevdesk limits the credit notes of an invoice per tax rate, so each refund is split in the proportion of what the invoice still holds at each rate.

**The contact.** The customer is looked for in sevdesk by e-mail address, then among the contacts the app used for the same customer before. If there is none, a contact is created with the billing address and the e-mail address. A business with a VAT ID gets a contact of its own that carries the VAT ID, which sevdesk needs for a tax-free invoice. Existing contacts are never changed.

**Orders without a document.** An order in another currency than EUR is skipped. A refund of an order the app did not invoice is ignored. A free order never becomes "paid" in Swell and gets no invoice; use the action if one is wanted.

## Payments

sevdesk books a payment directly only on an account without a bank behind it: its "Basiskonto", a cash register or a clearing account. On a connected bank or PayPal account a booking needs the imported transaction, which only sevdesk has.

- **sevdesk account for shop payments**: the name of the clearing account. Each payment of an order is booked there with its own amount and date. Later you book the payout of your payment provider as a transfer from the clearing account to your bank account, as with every shop connector for sevdesk.
- **Payment method exceptions**: a row per payment method that does not arrive on that account. Give it another account, or no account to book nothing for it. Booking nothing is right for bank transfers, and for a PayPal account that is connected to sevdesk: sevdesk matches the imported transactions to the open invoices itself.
- **Gift cards and store credit** are not booked unless they have a row with an account. They are no money arriving, and how they are booked depends on how the sale of the gift card was.
- An invoice whose payments are not all booked stays open or partly paid in sevdesk. Its page in Swell says what was booked and what was not. An order paid partly by gift card, for example, arrives as partly paid: the gift card's part stays open until you book it.
- With no account entered at all, nothing is booked and every invoice arrives as open.

## Tax

The app does not decide what tax is due. It takes the tax Swell charged and chooses the sevdesk tax rule that says the same:

| Order | sevdesk tax rule |
| --- | --- |
| The sevdesk account is a small business (§ 19 UStG) | Steuer nicht erhoben nach § 19 UStG |
| Germany | Umsatzsteuerpflichtige Umsätze: 19, 7 and 0 % |
| Another EU country, charged German rates | Umsatzsteuerpflichtige Umsätze |
| Another EU country, charged other rates | One-Stop-Shop: goods, or electronic services when nothing is shipped |
| Another EU country, no tax, customer has a VAT ID | Innergemeinschaftliche Lieferungen, or Reverse Charge when nothing is shipped |
| Outside the EU, no tax | Ausfuhren, or "Nicht im Inland steuerbare Leistung" when nothing is shipped |
| Outside the EU, charged German rates | Umsatzsteuerpflichtige Umsätze |

sevdesk prints the line that says why a document carries no tax, from the rule. A document's page in Swell names its rule in English, for example "Taxable revenue" or "One-Stop-Shop, goods".

**Sales to other EU countries.** By default the rate decides: German rates are booked as German revenue, any other rate under the One-Stop-Shop. If you are registered for the One-Stop-Shop, choose "Always under the One-Stop-Shop", so that a country whose rate equals a German one (Cyprus charges 19 %) is booked correctly too.

An order that fits none of the rules is not sent. It is listed under **Needs attention** with the reason. The usual reasons:

- **No tax where tax is due**: a German or EU consumer order that was charged no tax. Gift cards are the exception.
- **Rates sevdesk does not accept under the rule**: for example 16 % in Germany. sevdesk decides this and names the rates it allows; the app passes on its answer.
- **Goods and services to another country on one order**: sevdesk books them under different rules, and a document has only one.
- **Tax that is not what the rates give**: the store calculates tax before discounts. Tax has to be calculated after discounts (Settings → Taxes in Swell).
- **Tax on an order of a small-business account**: the sevdesk account invoices without VAT, and the store charged tax.
- **A rate that is not a German one, to a country outside the EU**: sevdesk has no rule for it.

**To the cent.** sevdesk computes all totals itself, position by position. Swell computes tax per item with four decimals and rounds the order total. The app builds the invoice so that sevdesk's total is the order's: with the store's net prices when that gives the total, otherwise with the same lines as gross amounts. Then it compares the total of sevdesk's draft with the order. A draft with another total is deleted, and nothing gets a number.

## Drafts and finalized documents

Every document starts in sevdesk as a **draft**: it has no number, and can be edited and deleted there. **Finalizing** gives it the next number of your range and, in most accounts, locks it. The app does the rest only for a finalized document: booking the payment, storing the PDF, e-mailing the customer.

- New installs stop at the draft until the setting is changed to finalized documents.
- To finalize a draft from Swell, open the document and choose **Finalize draft**, or select several on the **Drafts** tab and choose **Finalize drafts**.
- After finalizing a draft in sevdesk itself, choose **Read again from sevdesk** on the document in Swell: the app fetches the number and the PDF and books the payment. For many at once, select them on the Drafts tab and choose **Retry**.
- A refund of an order whose invoice is still a draft waits under Needs attention: sevdesk accepts a credit note only for a finalized invoice.
- sevdesk has no sandbox. A token always belongs to a real account. In the store's test environment use a sevdesk trial account, or keep drafts: a draft costs nothing and can be deleted.

## In the dashboard

- **Orders → sevdesk documents** lists every invoice and credit note, with tabs for **Needs attention**, **In sevdesk**, **Drafts** and **Skipped**. A document's page shows the number, the PDF, the status in sevdesk, the tax rule and what was done about the payment, and has **View in sevdesk**.
- **The order's sevdesk tab** shows the order's documents. **Create sevdesk invoice** is in the order's Actions menu.
- A document that needs attention has **Retry** and **Mark as resolved**. Resolve it after creating the document in sevdesk by hand, or when none is needed: the app will then not create it. A document that exists in sevdesk and could not be finished stays there as it is.
- **Retry failed documents**, in the Actions menu of the app's settings page, retries everything under Needs attention.

The buttons start a run in the background. The dashboard shows that it started and reloads the page when it has finished, usually after ten to twenty seconds. "Finished" means the run has ended, also when the document could not be created: what came of it is on the document.

Through the API, an order's documents expand as `$app.sevdesk.documents`.

## Day-to-day use

Once the app is switched on, a paid or refunded order needs nothing from you: its document appears in sevdesk and on the order about twenty seconds later.

- **Drafts.** While the app creates drafts, review them in sevdesk and finalize them there or in Swell.
- **Needs attention.** When the e-mail "Action needed" arrives, open Orders → sevdesk documents → **Needs attention** and read the reason. Correct the cause and choose **Retry**, or choose **Mark as resolved** after creating the document in sevdesk by hand.
- **Orders the automation does not cover.** For unpaid orders, such as bank transfer, and for orders from before the install, choose **Create sevdesk invoice** on the order, or select orders in the order list. When such an order is paid later, its payment is booked on the invoice. If the app was switched off at that moment, choose the action on the order again: it creates no second invoice and books the payment.
- **Payouts.** Book the payouts of your payment provider from the clearing account to your bank account in sevdesk.

## When something goes wrong

| What happens | What the app does |
| --- | --- |
| sevdesk is down or slow | The run tries again for about ten minutes. After that the document is tried again every half hour, for a day. Then it is listed under Needs attention |
| An answer from sevdesk is lost | The next attempt looks before it writes: for its draft among the customer's drafts, by the reference; for the number on the document; for what sevdesk already holds as paid |
| The same event arrives twice | The second one finds the document's record and continues it, or finds nothing left to do |
| Two attempts reach the same document at the same moment | One of them takes the record, the other waits and finds the work done |
| sevdesk refuses the token | Affected documents are listed under Needs attention. The store's administrators get one e-mail. After the token is corrected, **Retry failed documents** creates them |
| sevdesk refuses a document, or no invoice can be built | Listed under Needs attention with the reason. The administrators get one e-mail while such documents wait, not one per order |
| An order is paid after its invoice was created, and the booking cannot be made at that moment | The invoice's record is marked as waiting for its booking when the payment arrives. Whatever attempt comes next books it: the run's own repeats, the half-hourly run, or a retry |
| One document of a bulk run cannot be worked on | It keeps the message, and the run goes on with the next document |
| The payment account's name is wrong, or it names an account that is connected to a bank | The invoice is finalized and has its PDF; the booking waits under Needs attention. **Retry** books it after the name is corrected |
| A draft was deleted in sevdesk, or the token now belongs to another account | The next time the app reads the document it is listed under Needs attention. **Retry** creates it again, **Mark as resolved** leaves it |
| A refund's invoice is gone from sevdesk, or was marked as resolved | The credit note is listed under Needs attention. Create it in sevdesk by hand, then choose **Mark as resolved** |

E-mails to administrators are sent by the notification "sevdesk needs attention", and the customer's e-mail by "sevdesk document for the customer". Both can be edited or switched off under Settings → Notifications. The administrators' e-mail goes to the store's users who have logged in and have notifications switched on for their user; if nobody has, nobody is told.

## Limits and known issues

- **EUR only.** Orders in other currencies are skipped and listed under **Skipped**.
- **sevdesk-Update 2.0 only.** An account on sevdesk's older bookkeeping system is refused, with a message that says so.
- **No sandbox.** A token always belongs to a real sevdesk account, in the store's test environment too. See "Drafts and finalized documents".
- **Payments on a connected bank or PayPal account cannot be booked** by the app. sevdesk matches those itself from the imported transactions.
- **Payment provider fees and payouts** are not booked. The transfer from the clearing account to the bank is yours to book.
- **Changes to an order after its invoice** (edited or canceled items without a refund) are not followed.
- **Credit notes are by amount**, not by item, because a Swell refund names no items. A cancellation invoice (Stornorechnung) is never created.
- **Goods and items that are not shipped on one order to another country** are not invoiced: see "Tax". The same goes for a gift card sold together with taxed items to another EU country under the One-Stop-Shop, whose rules have no 0 %: sevdesk refuses it, and it is listed with the reason.
- **Subscription renewals that create no order** are not invoiced. Renewals that create an order are.
- **E-invoices** (XRechnung, ZUGFeRD) are not created.
- **More than about sixty paid orders and refunds a minute** start more runs than Swell allows an app. The ones above that are picked up a minute later.
- **The PDF link is not protected.** The PDF is stored as a file in Swell at an address that cannot be guessed, like other Swell files. Anyone with the link can open it.
- The customer's e-mail carries a link to the PDF, not an attachment.
- A contact whose creation was cut short in sevdesk can be left behind without documents.

## How it is built

| Block | Files | Job |
| --- | --- | --- |
| Manifest | `swell.json` | Integration app. Scopes: `read_orders`, `read_payments`, `read_accounts` |
| Settings | `settings/connection.json`, `documents.json`, `payments.json` | Token, switch, document options, payment accounts; **Test connection** and **Retry failed documents** |
| Models | `models/documents.json`, `alerts.json`, `orders.json` | The ledger of documents; open alerts; a link from the order to its documents |
| Views | `content/documents.json`, `content/orders.json` | The documents list and page; the order's tab and actions |
| Event functions | `functions/invoice-order.ts`, `credit-refund.ts` | `order.paid` and `payment.refund.succeeded`, only while the app is switched on. They write the document's record and start a run |
| Workflow | `functions/process-documents.ts` | The one place where documents are worked on: for an event, a button, a bulk action, or the sweep |
| Cron function | `functions/sweep.ts` | Every half hour: starts a run for documents that still wait for sevdesk |
| Actions | `functions/test-connection.ts`, `resolve-document.ts` | The two buttons that answer at once |
| Notifications | `notifications/document-ready.*`, `alert.*` | The customer's e-mail; the administrators' alert |
| Library | `functions/lib/` | See below |

One document is eight to ten calls to sevdesk, and takes eight to nine seconds from where Swell runs functions. A function may run for ten. So the functions that receive the store's events do not call sevdesk: they write the record and start a run of the workflow, whose steps have minutes and are repeated by the platform when they fail.

`functions/lib/`:

- `process.ts` is the state machine: claim the record, contact, draft, check the total, finalize, book, PDF, e-mail. Every step is saved before the next, so any run can continue a record. Start here.
- `documents.ts` is the ledger. A record is created under a unique key per order or refund before anything is sent, which is what keeps a document from being created twice. A later attempt takes the record by raising its attempt counter in the store, so two attempts that start together cannot both go on.
- `invoice.ts` and `credit-note.ts` build the documents. Both are pure. `tax.ts` chooses the tax rule, `payments.ts` decides what is booked where, `money.ts` does the arithmetic in whole numbers.
- `sevdesk.ts` is the API client. It marks a write without an answer as uncertain, and never repeats a refused request: sevdesk can block a token after repeated failing requests.
- `start.ts`, `alerts.ts`, `settings.ts`, `texts.ts`, `dates.ts`, `countries.ts` are small.

Three things about the platform that the code depends on:

- **A write made in a workflow raises no events** unless it carries `$events: true`. The two e-mails are sent by events, so the write that marks a document for the customer's e-mail (`documents.ts`) and the one that creates an alert (`alerts.ts`) ask for them.
- **A workflow write names its notification.** With `$events: true` alone the event was raised every time, but the store did not send the e-mail for every such write. The two writes therefore also carry `$notify` with the notification's name and the suffix `.v2` (`document-ready.v2`, `alert.v2`), which sent every e-mail in the runs made with it. Where the platform sends the notifications of workflow writes by itself, the key changes nothing.
- `models/orders.json` and `content/orders.json` name the documents collection by its short name, `documents`. The platform turns a short name into the app's own collection when the app is installed. Do not write `apps/sevdesk/documents` there: that form is stored as written, the dashboard cannot resolve it, and the order page fails to open.

## Development

```bash
npm install
npm test            # unit tests, no network
npm run typecheck
swell app push      # deploys to the test environment of the logged-in store
```

The unit tests replace sevdesk with an in-memory stand-in (`test/helpers/sevdesk.ts`) that computes totals the way sevdesk was seen to, and the store with another (`test/helpers/store.ts`). The orders in `test/fixtures/orders.ts` are real API responses.

After a change in `functions/lib/` only, push with `--force`: push skips function files whose own content did not change. A workflow run started in the first two minutes after a push can fail its first attempts; it repeats them by itself.

### App Store listing

| What | Where |
| --- | --- |
| Full description | `DESCRIPTION.md` |
| Short description | `description` in `swell.json` (up to 70 characters) |
| Icon | `assets/icon.png` (600 × 600, the square filled: the dashboard rounds the corners itself) |
| Screenshots | `assets/images/*.png` (3200 × 1800), listed in `images` in `swell.json` |
| Social card | `assets/image.png` (1200 × 630) |

## License

[MIT](LICENSE.md)
