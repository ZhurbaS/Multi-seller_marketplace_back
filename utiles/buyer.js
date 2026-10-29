// Дані покупця: фізична чи юридична особа (назва, ЄДРПОУ, ІПН).
// Перевірка на сервері; фронт лише підказує.

// Контрольна цифра ЄДРПОУ (8 цифр). Для кодів у діапазоні 30 000 000 – 60 000 000
// використовується інший набір вагових коефіцієнтів. Якщо залишок від ділення на 11 дорівнює 10,
// ваги збільшують на 2 і розраховують ще раз (якщо знову 10 — контрольна цифра 0).
function isValidEdrpou(code) {
  if (!/^\d{8}$/.test(code)) return false;
  const n = Number(code);
  const digits = code.split("").map(Number);
  const base = n > 30000000 && n < 60000000 ? [7, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6, 7];
  const calc = (weights) =>
    weights.reduce((s, w, i) => s + w * digits[i], 0) % 11;
  let check = calc(base);
  if (check === 10) {
    check = calc(base.map((w) => w + 2));
    if (check === 10) check = 0;
  }
  return check === digits[7];
}

// → { value } | { error }
function sanitizeBuyer(input) {
  const kind = input?.kind === "company" ? "company" : "individual";
  if (kind === "individual") {
    return { value: { kind, companyName: "", edrpou: "", ipn: "" } };
  }
  const companyName = String(input?.companyName || "").trim().replace(/\s+/g, " ");
  if (companyName.length < 2 || companyName.length > 200) {
    return { error: "Вкажіть повну назву організації (від 2 до 200 символів)" };
  }
  // ЄДРПОУ юрособи — 8 цифр; ФОП вказує РНОКПП (ІПН) — 10 цифр.
  const edrpou = String(input?.edrpou || "").replace(/\s+/g, "");
  if (!/^\d{8}$|^\d{10}$/.test(edrpou)) {
    return { error: "Код ЄДРПОУ — 8 цифр (для ФОП — 10 цифр РНОКПП)" };
  }
  if (edrpou.length === 8 && !isValidEdrpou(edrpou)) {
    return { error: "Код ЄДРПОУ не пройшов перевірку контрольної цифри — перевірте, будь ласка" };
  }
  // ІПН платника ПДВ — 12 цифр; необов'язковий (не всі організації платники ПДВ).
  const ipn = String(input?.ipn || "").replace(/\s+/g, "");
  if (ipn && !/^\d{10}$|^\d{12}$/.test(ipn)) {
    return { error: "ІПН — 12 цифр (платник ПДВ) або 10 цифр" };
  }
  return { value: { kind, companyName, edrpou, ipn } };
}

module.exports = { isValidEdrpou, sanitizeBuyer };
