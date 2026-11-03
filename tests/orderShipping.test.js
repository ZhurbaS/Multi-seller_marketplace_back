const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("../utiles/orderShipping");

test("editBlocker: дозволено до відправлення", () => {
  for (const s of ["pending", "placed", "processing", "packing"]) {
    assert.equal(os.editBlocker({ delivery_status: s, trackingNumber: "" }, []), "");
  }
});

test("editBlocker: заборонено після відправлення, скасування, ТТН, відправлених підзамовлень", () => {
  assert.ok(os.editBlocker({ delivery_status: "shipped" }, []));
  assert.ok(os.editBlocker({ delivery_status: "delivered" }, []));
  assert.ok(os.editBlocker({ delivery_status: "cancelled" }, []));
  assert.ok(os.editBlocker({ delivery_status: "processing", trackingNumber: "20450000000000" }, []));
  assert.ok(os.editBlocker({ delivery_status: "processing" }, [{ delivery_status: "shipped" }]));
  assert.ok(os.editBlocker(null, []));
});

test("describe і changed", () => {
  const a = { name: "Ол", phone: "+380501234567", deliveryType: "nova_poshta_warehouse", city: "Київ", warehouse: "5", recipient: { other: false } };
  assert.match(os.describe(a), /Ол, \+380501234567/);
  assert.match(os.describe(a), /Нова пошта, відділення: Київ, 5/);
  const b = { ...a, recipient: { other: true, lastName: "П", firstName: "І", phone: "+380671112233" } };
  assert.match(os.describe(b), /П І, \+380671112233/);
  assert.ok(os.changed(a, b));
  assert.ok(!os.changed(a, { ...a }));
});
