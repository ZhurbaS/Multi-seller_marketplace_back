// Збережені отримувачі та організації покупця (для швидкого оформлення наступних замовлень).
// Нові — на початок списку; дубль (той самий телефон / код ЄДРПОУ) оновлюється; максимум MAX.

const MAX = 10;

const upsert = (list, item, sameKey) => {
  const rest = (list || []).filter((x) => sameKey(x) !== sameKey(item));
  return [item, ...rest].slice(0, MAX);
};

// recipient: sanitizeShipping().value.recipient (телефон вже нормалізований)
function upsertRecipient(list, r) {
  if (!r || !r.other) return list || [];
  const item = {
    lastName: r.lastName,
    firstName: r.firstName,
    middleName: r.middleName || "",
    phone: r.phone,
  };
  return upsert(list, item, (x) => x.phone);
}

// buyer: sanitizeBuyer().value
function upsertCompany(list, b) {
  if (!b || b.kind !== "company") return list || [];
  const item = { companyName: b.companyName, edrpou: b.edrpou, ipn: b.ipn || "" };
  return upsert(list, item, (x) => x.edrpou);
}

module.exports = { MAX, upsertRecipient, upsertCompany };
