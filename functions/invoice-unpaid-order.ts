import { claimInvoice } from "./lib/process";
import { invoicesUnpaid } from "./lib/settings";
import { handleEvent } from "./lib/start";

export const config: SwellConfig = {
  description: "Record the sevdesk invoice for an unpaid order placed with a payment method chosen in the settings, and start its run",
  model: {
    events: ["order.submitted"],
    conditions: { $settings: { connection: { enabled: true } } },
  },
};

export default async function (req: SwellRequest) {
  return handleEvent(req, async (ctx) => {
    // A paid order is invoiced by order.paid. The same record serves both, so when the
    // order is paid later, order.paid finds this invoice and books the payment on it
    if (req.data.paid === true || !invoicesUnpaid(ctx.settings, req.data.billing?.method)) {
      return undefined;
    }
    return claimInvoice(ctx, req.data.id as string, "order.submitted", false);
  });
}
