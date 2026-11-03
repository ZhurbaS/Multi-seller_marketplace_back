// Дані доставки: які поля обов'язкові залежно від способу доставки, телефон, «інший отримувач».
// Перевірка на сервері (фронт лише підказує). → { value } | { error }

const TYPES = ["nova_poshta_warehouse", "nova_poshta_postomat", "nova_poshta_courier", "ukrposhta", "pickup"];

const str = (v, max) => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, max);

// Український телефон → +380XXXXXXXXX (приймає +380…, 380…, 0…, з пробілами/дужками/дефісами)
function normalizePhone(raw) {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.startsWith("380") && d.length === 12) d = d.slice(2);
  else if (d.length === 9 && d[0] !== "0") d = `0${d}`;
  if (!/^0\d{9}$/.test(d)) return null;
  return `+38${d}`;
}

const PHONE_ERR = "Вкажіть коректний номер телефону, напр. +380501234567";

function sanitizeShipping(input) {
  const s = input && typeof input === "object" ? input : {};
  const deliveryType = String(s.deliveryType || "");
  if (!TYPES.includes(deliveryType)) return { error: "Оберіть спосіб доставки" };

  const name = str(s.name, 100);
  if (name.length < 2) return { error: "Вкажіть ім'я" };
  const phone = normalizePhone(s.phone);
  if (!phone) return { error: PHONE_ERR };

  const out = {
    deliveryType,
    name,
    phone,
    district: "",
    city: "",
    warehouse: "",
    address: "",
    post: "",
    area: "",
    recipient: { other: false, lastName: "", firstName: "", middleName: "", phone: "" },
    // Ідентифікатори Нової пошти (для майбутнього створення ТТН); необов'язкові
    cityRef: "",
    settlementRef: "",
    warehouseRef: "",
  };
  const ref = (v) => (/^[0-9a-f-]{36}$/i.test(String(v ?? "")) ? String(v).toLowerCase() : "");
  out.cityRef = ref(s.cityRef);
  out.warehouseRef = ref(s.warehouseRef);
  out.settlementRef = ref(s.settlementRef);

  if (deliveryType !== "pickup") {
    out.district = str(s.district, 100);
    out.city = str(s.city, 100);
    if (!out.district) return { error: "Вкажіть область" };
    if (!out.city) return { error: "Вкажіть місто" };
    if (deliveryType === "nova_poshta_warehouse" || deliveryType === "nova_poshta_postomat") {
      out.warehouse = str(s.warehouse, 40);
      if (!out.warehouse) {
        return { error: deliveryType === "nova_poshta_postomat" ? "Вкажіть № поштомата Нової пошти" : "Вкажіть № відділення Нової пошти" };
      }
    } else {
      // кур'єр Нової пошти — вулиця, будинок, квартира (адреса одним рядком); Укрпошта — ще індекс і район
      out.address = str(s.address, 200);
      if (out.address.length < 3) return { error: "Вкажіть адресу (вулиця, № будинку, квартира)" };
      if (deliveryType === "ukrposhta") {
        out.post = String(s.post ?? "").replace(/\s+/g, "");
        out.area = str(s.area, 100);
        if (!/^\d{5}$/.test(out.post)) return { error: "Індекс — 5 цифр" };
        if (!out.area) return { error: "Вкажіть район" };
      }
    }
  }

  const r = s.recipient && typeof s.recipient === "object" ? s.recipient : {};
  if (r.other === true || r.other === "true") {
    const lastName = str(r.lastName, 60);
    const firstName = str(r.firstName, 60);
    if (!lastName) return { error: "Вкажіть прізвище отримувача" };
    if (!firstName) return { error: "Вкажіть ім'я отримувача" };
    const rPhone = normalizePhone(r.phone);
    if (!rPhone) return { error: `Телефон отримувача: ${PHONE_ERR.toLowerCase()}` };
    out.recipient = { other: true, lastName, firstName, middleName: str(r.middleName, 60), phone: rPhone };
  }
  return { value: out };
}

// Коментар до замовлення (контакт, побажання): до 1000 символів, переноси рядків зберігаємо
function sanitizeComment(v) {
  return String(v ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 1000);
}

// Збережена адреса доставки (без імені/телефону): тип, місто, відділення/поштомат або вулиця-будинок-квартира
function sanitizeAddress(input) {
  const r = sanitizeShipping({ ...(input || {}), name: "Адреса", phone: "0500000000" });
  if (r.error) return r;
  const v = r.value;
  if (v.deliveryType === "pickup") return { error: "Самовивіз не зберігаємо як адресу" };
  return {
    value: {
      deliveryType: v.deliveryType,
      district: v.district,
      city: v.city,
      cityRef: v.cityRef,
      settlementRef: v.settlementRef,
      warehouse: v.warehouse,
      warehouseRef: v.warehouseRef,
      address: v.address,
      post: v.post,
      area: v.area,
    },
  };
}

module.exports = { TYPES, normalizePhone, sanitizeShipping, sanitizeComment, sanitizeAddress };
