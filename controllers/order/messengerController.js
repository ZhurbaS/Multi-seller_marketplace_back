// Месенджери для рахунків: налаштування адміна, публічні канали, посилання на PDF, вебхуки статусів.
const customerOrderModel = require("../../models/customerOrderModel");
const messengers = require("../../utiles/messengers");
const wa = require("../../utiles/messengers/whatsapp");
const vb = require("../../utiles/messengers/viber");
const invoiceLink = require("../../utiles/invoiceLink");
const invoiceService = require("../../utiles/invoiceService");
const { responseReturn } = require("../../utiles/response");

async function applyStatuses(list) {
  for (const s of list) {
    if (!s.id) continue;
    const set = { "invoice.messageStatus": s.status };
    if (s.status === "failed") set["invoice.sendError"] = `Месенджер: доставка не вдалась${s.error ? ` (${s.error})` : ""} — надішліть повторно`;
    await customerOrderModel.updateOne({ "invoice.messageId": s.id }, { $set: set });
  }
}

class messengerController {
  // Покупець: які канали пропонувати для рахунку (e-mail є завжди)
  async channels(req, res) {
    try {
      responseReturn(res, 200, { channels: await messengers.publicChannels() });
    } catch (e) {
      responseReturn(res, 200, { channels: ["email"] });
    }
  }

  async admin_get(req, res) {
    try {
      responseReturn(res, 200, { messengers: await messengers.adminState() });
    } catch (e) {
      console.error("💥 messengers.admin_get:", e.message);
      responseReturn(res, 500, { error: "Щось пішло не так" });
    }
  }

  async admin_save(req, res) {
    try {
      responseReturn(res, 200, { messengers: await messengers.save(req.body), message: "Збережено" });
    } catch (e) {
      console.error("💥 messengers.admin_save:", e.message);
      responseReturn(res, 500, { error: "Щось пішло не так" });
    }
  }

  // Публічне підписане посилання на PDF (його відкривають WhatsApp/Viber). Без підпису — 404.
  async invoice_file(req, res) {
    try {
      const { orderId, exp, sig } = req.params;
      if (!/^[a-f\d]{24}$/i.test(orderId) || !invoiceLink.verify(orderId, exp, sig)) return res.sendStatus(404);
      const order = await customerOrderModel.findById(orderId);
      if (!order?.invoice?.number) return res.sendStatus(404);
      const pdf = await invoiceService.pdfFor(order);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="rahunok-${order.invoice.number}.pdf"`);
      res.setHeader("Cache-Control", "private, max-age=300");
      res.send(pdf);
    } catch (e) {
      console.error("💥 invoice_file:", e.message);
      res.sendStatus(500);
    }
  }

  // WhatsApp: підтвердження вебхука (GET) і статуси (POST, підпис X-Hub-Signature-256)
  whatsapp_verify(req, res) {
    const ok =
      req.query["hub.mode"] === "subscribe" &&
      process.env.WHATSAPP_VERIFY_TOKEN &&
      req.query["hub.verify_token"] === process.env.WHATSAPP_VERIFY_TOKEN;
    return ok ? res.status(200).send(String(req.query["hub.challenge"] || "")) : res.sendStatus(403);
  }

  async whatsapp_hook(req, res) {
    try {
      if (!wa.verifySignature(req.rawBody, req.get("x-hub-signature-256"))) return res.sendStatus(401);
      await applyStatuses(wa.parseStatuses(req.body));
      res.sendStatus(200);
    } catch (e) {
      console.error("💥 whatsapp_hook:", e.message);
      res.sendStatus(500);
    }
  }

  async viber_hook(req, res) {
    try {
      if (!vb.verifySecret(req.get("x-webhook-secret"))) return res.sendStatus(401);
      await applyStatuses(vb.parseStatuses(req.body));
      res.sendStatus(200);
    } catch (e) {
      console.error("💥 viber_hook:", e.message);
      res.sendStatus(500);
    }
  }
}

module.exports = new messengerController();
