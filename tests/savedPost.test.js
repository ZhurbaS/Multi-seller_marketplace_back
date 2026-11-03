const test = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeRecipient } = require("../utiles/shipping");
const { sanitizeBuyer } = require("../utiles/buyer");

test("отримувач: валідація імені/телефону, нормалізація телефону", () => {
  assert.ok(/прізвище/i.test(sanitizeRecipient({ lastName: "", firstName: "Іван", phone: "0501234567" }).error));
  assert.ok(/ім'я/i.test(sanitizeRecipient({ lastName: "Петренко", firstName: "", phone: "0501234567" }).error));
  assert.ok(/отримувача/i.test(sanitizeRecipient({ lastName: "Петренко", firstName: "Іван", phone: "123" }).error));
  const ok = sanitizeRecipient({ lastName: " Петренко ", firstName: "Іван", phone: "050 123 45 67" });
  assert.equal(ok.value.phone, "+380501234567");
  assert.equal(ok.value.lastName, "Петренко");
});

test("організація: назва й код обов'язкові (kind=company)", () => {
  assert.ok(sanitizeBuyer({ kind: "company", companyName: "ТОВ Тест", edrpou: "12" }).error);
  assert.ok(sanitizeBuyer({ kind: "company", companyName: "X", edrpou: "1234567890" }).error);
  assert.equal(sanitizeBuyer({ kind: "company", companyName: "ФОП Іваненко", edrpou: "1234567890" }).value.edrpou, "1234567890");
});
