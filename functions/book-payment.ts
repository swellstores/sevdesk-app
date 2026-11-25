import { findByKey, invoiceKey } from "./lib/documents";
import { awaitBooking } from "./lib/process";
import type { SwellRecord } from "./lib/invoice";
import { invoicesUnpaid } from "./lib/settings";
import { handleEvent } from "./lib/start";

export const config: SwellConfig = {
  description: "Book a payment on the sevdesk invoice of an order that was invoiced before it was paid, and start its run",
  model: {
    events: ["payment.succeeded"],
    conditions: { $settings: { connection: { enabled: true } } },
  },
};

/**
 * order.paid comes only once an order is paid in full. An order invoiced when it was placed
 * (functions/invoice-unpaid-order.ts) may be paid in parts, and each part is booked when it
 * arrives. The booking reads what sevdesk holds as paid first, so this and order.paid never
 * book the same payment twice.
 */
export default async function (req: SwellRequest) {
  return handleEvent(
    req,
    async (ctx) => {
      const orderId = req.data.order_id as string | undefined;
      if (!orderId) {
        return undefined;
      }
      const [order, doc] = await Promise.all([
        ctx.swell.get(`/orders/${orderId}`) as Promise<SwellRecord>,
        findByKey(ctx.swell, invoiceKey(orderId)),
      ]);
      if (!doc || doc.status === "skipped" || !invoicesUnpaid(ctx.settings, order?.billing?.method)) {
        return undefined;
      }
      await awaitBooking(ctx, doc);
      return { doc };
    },
    { rebook: true },
  );
}
