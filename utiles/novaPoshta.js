// Проксі до API Нової пошти (ключ лишається на сервері): пошук міст, відділень/поштоматів, вулиць.
// Без NOVA_POSHTA_API_KEY isEnabled() = false — фронт переходить на ручне введення.
// Відповіді кешуються в пам'яті (довідники міняються рідко), щоб не впиратися в ліміти API.

const URL = "https://api.novaposhta.ua/v2.0/json/";
const POSTOMAT_TYPE_REF = "f9316480-5f2d-425d-bc2c-ac7cd29decf0";
const TTL_MS = 10 * 60 * 1000;
const cache = new Map();

const isEnabled = () => !!process.env.NOVA_POSHTA_API_KEY;

async function call(modelName, calledMethod, methodProperties) {
  const key = JSON.stringify([modelName, calledMethod, methodProperties]);
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.data;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  let json;
  try {
    const r = await fetch(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: process.env.NOVA_POSHTA_API_KEY, modelName, calledMethod, methodProperties }),
      signal: ctrl.signal,
    });
    json = await r.json();
  } finally {
    clearTimeout(timer);
  }
  if (!json || json.success === false) {
    throw new Error((json?.errors && json.errors[0]) || "Помилка API Нової пошти");
  }
  const data = json.data || [];
  if (cache.size > 500) cache.clear();
  cache.set(key, { exp: Date.now() + TTL_MS, data });
  return data;
}

const clean = (q, max = 60) => String(q ?? "").trim().replace(/\s+/g, " ").slice(0, max);

async function searchCities(q) {
  const name = clean(q, 50);
  if (name.length < 2) return [];
  const data = await call("Address", "searchSettlements", { CityName: name, Limit: 15, Page: 1 });
  const addrs = (data[0] && data[0].Addresses) || [];
  return addrs
    .filter((a) => a.DeliveryCity) // лише населені пункти, куди є доставка
    .map((a) => ({
      ref: a.DeliveryCity,
      settlementRef: a.Ref,
      name: a.MainDescription,
      area: a.Area,
      region: a.Region || "",
      title: a.Present,
    }));
}

// type: "warehouse" (відділення) | "postomat"
async function searchWarehouses(cityRef, q, type) {
  if (!/^[0-9a-f-]{36}$/i.test(String(cityRef))) return [];
  const props = { CityRef: cityRef, Limit: 50, Page: 1, Language: "UA" };
  const find = clean(q, 60);
  if (find) props.FindByString = find;
  if (type === "postomat") props.TypeOfWarehouseRef = POSTOMAT_TYPE_REF;
  const data = await call("Address", "getWarehouses", props);
  return data
    .filter((w) => (type === "postomat" ? w.TypeOfWarehouse === POSTOMAT_TYPE_REF || w.CategoryOfWarehouse === "Postomat" : w.CategoryOfWarehouse !== "Postomat" && w.TypeOfWarehouse !== POSTOMAT_TYPE_REF))
    .map((w) => ({ ref: w.Ref, number: w.Number, title: w.Description, address: w.ShortAddress || "" }));
}

async function searchStreets(settlementRef, q) {
  if (!/^[0-9a-f-]{36}$/i.test(String(settlementRef))) return [];
  const name = clean(q, 50);
  if (name.length < 2) return [];
  const data = await call("Address", "searchSettlementStreets", { StreetName: name, SettlementRef: settlementRef, Limit: 15 });
  const addrs = (data[0] && data[0].Addresses) || [];
  return addrs.map((a) => ({ ref: a.SettlementStreetRef, title: a.Present, name: a.SettlementStreetDescription }));
}

module.exports = { isEnabled, searchCities, searchWarehouses, searchStreets, POSTOMAT_TYPE_REF };
