const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const wa = require("../utiles/messengers/whatsapp");
const vb = require("../utiles/messengers/viber");
const link = require("../utiles/invoiceLink");

test("WhatsApp: payload шаблону з документом і змінними", () => {
  const p = wa.buildPayload({ to: "+380 50 123 45 67", pdfUrl: "https://x/f.pdf", filename: "r.pdf", orderLabel: "№100123", total: 1500, template: "invoice_uk" });
  assert.equal(p.to, "380501234567");
  assert.equal(p.type, "template");
  assert.equal(p.template.name, "invoice_uk");
  assert.equal(p.template.components[0].parameters[0].document.link, "https://x/f.pdf");
  assert.deepEqual(p.template.components[1].parameters.map((x) => x.text), ["№100123", "1500"]);
});

test("WhatsApp: підпис вебхука й розбір статусів", () => {
  const body = Buffer.from(JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: "wamid.1", status: "delivered" }, { id: "wamid.2", status: "failed", errors: [{ title: "x" }] }] } }] }] }));
  const sig = "sha256=" + crypto.createHmac("sha256", "secret").update(body).digest("hex");
  assert.ok(wa.verifySignature(body, sig, "secret"));
  assert.ok(!wa.verifySignature(body, sig, "other"));
  assert.ok(!wa.verifySignature(body, "", "secret"));
  assert.deepEqual(wa.parseStatuses(JSON.parse(body)), [
    { id: "wamid.1", status: "delivered", error: null },
    { id: "wamid.2", status: "failed", error: "x" },
  ]);
});

test("Viber: payload, секрет вебхука, статуси", () => {
  const p = vb.buildPayload({ to: "+380501234567", pdfUrl: "https://x/f.pdf", filename: "r.pdf", orderLabel: "№1", total: 10, sender: "Shop" });
  assert.equal(p.receiver, "380501234567");
  assert.equal(p.button.url, "https://x/f.pdf");
  assert.ok(vb.verifySecret("abc", "abc"));
  assert.ok(!vb.verifySecret("abd", "abc"));
  assert.ok(!vb.verifySecret("", "abc"));
  assert.deepEqual(vb.parseStatuses({ message_id: "m1", status: "Delivered" }), [{ id: "m1", status: "delivered", error: null }]);
  assert.deepEqual(vb.parseStatuses({}), []);
});

test("адаптери без ключів не вважаються налаштованими", () => {
  for (const k of ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID", "WHATSAPP_TEMPLATE_INVOICE", "VIBER_API_URL", "VIBER_TOKEN", "VIBER_SENDER"]) delete process.env[k];
  assert.equal(wa.isConfigured(), false);
  assert.equal(vb.isConfigured(), false);
});

test("підписане посилання на PDF: діє, не підробляється, спливає", () => {
  process.env.SECRET = "test-secret";
  const id = "507f1f77bcf86cd799439011";
  const { exp, sig } = link.make(id, 1000);
  assert.ok(link.verify(id, exp, sig, 2000));
  assert.ok(!link.verify("507f1f77bcf86cd799439012", exp, sig, 2000));
  assert.ok(!link.verify(id, exp + 1, sig, 2000));
  assert.ok(!link.verify(id, exp, sig, exp + 1));
  assert.match(link.url("https://api.x/", id, 1000), /^https:\/\/api\.x\/api\/invoice-file\/507f1f77bcf86cd799439011\/\d+\/[a-f0-9]{40}\.pdf$/);
});
