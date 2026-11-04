// Бекфіл CRM-контактів з наявних покупців (MARKETING_SPEC.md §6).
//   node scripts/backfillContacts.js [--dry]
// Для кожного покупця з e-mail: створює/знаходить Contact (статус 'none'), переносить стару згоду
// customer.marketing.granted → email 'subscribed' + ConsentLog(opt_in_explicit, source 'legacy_customer', оригінальний at),
// перераховує stats замовлень. Безпечно запускати повторно: згода переноситься лише для статусу 'none' і лише
// якщо запису legacy_customer ще немає; відписки/bounce/скарги не перезаписуються. Обробка пакетами.
require("dotenv").config();
const mongoose = require("mongoose");
const { dbConnect } = require("../utiles/db");
const customerModel = require("../models/customerModel");
const Contact = require("../models/contactModel");
const ConsentLog = require("../models/consentLogModel");
const cs = require("../utiles/contactService");
const { refreshStats } = require("../utiles/contactStats");

const BATCH = 200;
const DRY = process.argv.includes("--dry");

async function migrateConsent(doc, customer) {
  const m = customer.marketing;
  if (!m || m.granted !== true || !doc.email) return false;
  if ((doc.channels?.email?.status || "none") !== "none") return false;
  if (await ConsentLog.exists({ contactId: doc._id, source: "legacy_customer" })) return false;
  const at = m.at && Number.isFinite(new Date(m.at).getTime()) ? new Date(m.at) : new Date();
  doc.set("channels.email.status", "subscribed");
  doc.set("channels.email.subscribedAt", at);
  doc.set("channels.email.topics", cs.defaultTopics());
  await doc.save();
  await ConsentLog.create({
    contactId: doc._id,
    channel: "email",
    topic: "all",
    action: "opt_in_explicit",
    source: "legacy_customer",
    at,
    text: "Згода на розсилки, надана в акаунті до запуску CRM (customer.marketing)",
    textVersion: "legacy",
    meta: { method: m.method || "", customerId: String(customer._id) },
  });
  return true;
}

(async () => {
  const sum = { scanned: 0, created: 0, existing: 0, subscribed: 0, skipped: 0, errors: 0 };
  try {
    await dbConnect();
    let lastId = null;
    for (;;) {
      const q = { email: { $exists: true, $nin: [null, ""] }, ...(lastId ? { _id: { $gt: lastId } } : {}) };
      const batch = await customerModel.find(q).sort({ _id: 1 }).limit(BATCH).select("name email phone marketing isGuest savedCompanies").lean();
      if (!batch.length) break;
      lastId = batch.at(-1)._id;
      for (const c of batch) {
        sum.scanned++;
        try {
          const email = cs.normalizeEmail(c.email || "");
          if (!email) {
            sum.skipped++;
            continue;
          }
          if (await cs.isHashSuppressed(email)) {
            sum.skipped++; // дані видалено на запит людини — не відновлюємо
            continue;
          }
          const existing = await Contact.findOne({ $or: [{ customerId: c._id }, { email }] });
          if (DRY) {
            existing ? sum.existing++ : sum.created++;
            const st = existing?.channels?.email?.status || "none";
            if (c.marketing?.granted === true && st === "none") sum.subscribed++;
            continue;
          }
          const doc = await cs.upsertFromCustomer({ customer: c, source: "customer", explicit: false });
          if (!doc) {
            sum.skipped++;
            continue;
          }
          existing ? sum.existing++ : sum.created++;
          if (await migrateConsent(doc, c)) sum.subscribed++;
          await refreshStats(c._id);
        } catch (e) {
          sum.errors++;
          console.error(`⚠️ ${c._id}: ${e.message}`);
        }
      }
      console.log(`… оброблено ${sum.scanned}`);
    }
    console.log(`${DRY ? "🔎 DRY-RUN (нічого не змінено)" : "✅ Готово"}:`, sum);
  } catch (error) {
    console.error("❌ Помилка:", error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect().catch(() => {});
    process.exit();
  }
})();
