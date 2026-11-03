// Публічна оферта (та інші юридичні документи): зберігання, публікація, версії, прийняття покупцем.
//
// Стан у storeSettings.legal[slug]:
//   template  — текст шаблону (якщо адмін його не змінював — береться типовий)
//   vars      — { brand, domain, claimsEmail }
//   published — чи показувати покупцям (вимикач адміна)
//   snapshots — зафіксовані редакції [{ version, text, hash, baseHash, at }]: те, що бачили й приймали покупці
//
// Покупці бачать і приймають лише останню зафіксовану редакцію (snapshot), а не поточний чернетковий текст.
// Редакція фіксується при публікації й при збереженні опублікованого документа.

const storeSettingsModel = require("../models/storeSettingsModel");
const invoiceLib = require("./invoice");
const returnPolicy = require("./returnPolicy");
const docs = require("./legalDocs");

class LegalError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const MAX_SNAPSHOTS = 50;

function def(slug) {
  const d = docs.DOCS[slug];
  if (!d) throw new LegalError("Документ не знайдено", 404);
  return d;
}

async function loadRaw() {
  return (await storeSettingsModel.findOne({ key: "main" }).lean()) || {};
}

function envOf(raw) {
  return {
    company: invoiceLib.normalizeCompany(raw.company),
    returns: returnPolicy.normalizePolicy(raw.returns),
    cardDays: Number(process.env.ORDER_PAYMENT_CHECK_IN) || 3,
  };
}

const lastSnapshot = (st) => (st.snapshots || []).at(-1) || null;

// Поля «Бренд/Домен/E-mail/Години» спільні для всіх документів (раніше зберігались у оферті)
const sharedVars = (raw) => raw.legal?._vars || raw.legal?.oferta?.vars || {};

// Рендер поточної чернетки; date не підставляємо (для baseHash), якщо withDate не передано
function renderDraft(slug, st, raw, date) {
  const d = def(slug);
  const template = st.template || d.template;
  const values = docs.buildValues({ ...envOf(raw), vars: sharedVars(raw), date });
  return { template, ...docs.render(template, values) };
}

// Стан для адмін-сторінки
async function adminState(slug) {
  const raw = await loadRaw();
  const st = raw.legal?.[slug] || {};
  const preview = renderDraft(slug, st, raw, docs.dateUa(new Date()));
  const base = renderDraft(slug, st, raw); // без дати
  const last = lastSnapshot(st);
  return {
    slug,
    title: def(slug).title,
    template: preview.template,
    isDefaultTemplate: !st.template || st.template === def(slug).template,
    vars: {
      brand: sharedVars(raw).brand || "",
      domain: sharedVars(raw).domain || "",
      claimsEmail: sharedVars(raw).claimsEmail || "",
      hours: sharedVars(raw).hours || "",
    },
    path: docs.DOCS[slug].path,
    published: !!st.published,
    version: last?.version || 0,
    publishedAt: last?.at || null,
    // Поточна чернетка відрізняється від того, що бачать покупці
    stale: !!last && last.baseHash !== docs.sha(base.text),
    preview: { text: preview.text, missing: preview.missing, missingLabels: docs.missingLabels(preview.missing) },
  };
}

// Зафіксувати редакцію, якщо текст змінився. Повертає оновлений масив snapshots.
function withSnapshot(st, base, rendered) {
  const snaps = [...(st.snapshots || [])];
  const baseHash = docs.sha(base.text);
  const last = snaps.at(-1);
  if (last && last.baseHash === baseHash) return snaps;
  const date = docs.dateUa(new Date());
  const text = rendered(date);
  snaps.push({
    version: (last?.version || 0) + 1,
    text,
    hash: docs.sha(text),
    baseHash,
    at: new Date(),
  });
  return snaps.slice(-MAX_SNAPSHOTS);
}

async function writeState(slug, patch) {
  const $set = {};
  for (const [k, v] of Object.entries(patch)) $set[`legal.${slug}.${k}`] = v;
  await storeSettingsModel.findOneAndUpdate({ key: "main" }, { $set }, { upsert: true, new: true });
}

// Зберегти текст і поля. Якщо документ опублікований — нова редакція має бути повною (без незаповнених змінних).
async function save(slug, body) {
  def(slug);
  const t = docs.sanitizeTemplate(body?.template);
  if (t.error) throw new LegalError(t.error);
  const v = docs.sanitizeVars(body?.vars);
  if (v.error) throw new LegalError(v.error);

  const raw0 = await loadRaw();
  const raw = { ...raw0, legal: { ...(raw0.legal || {}), _vars: v.value } };
  const st = { ...(raw.legal?.[slug] || {}), template: t.value };
  const patch = { template: t.value };

  if (st.published) {
    const base = renderDraft(slug, st, raw);
    if (base.missing.length) {
      throw new LegalError(
        `Документ опублікований, тому має бути заповнений повністю. Не вистачає: ${docs.missingLabels(base.missing).join(", ")}. ` +
          "Заповніть або спочатку вимкніть показ."
      );
    }
    patch.snapshots = withSnapshot(st, base, (date) => renderDraft(slug, st, raw, date).text);
  }
  await storeSettingsModel.findOneAndUpdate({ key: "main" }, { $set: { "legal._vars": v.value } }, { upsert: true });
  await writeState(slug, patch);
  return adminState(slug);
}

// Вимикач «показувати покупцям»
async function setPublished(slug, flag) {
  def(slug);
  const raw = await loadRaw();
  const st = raw.legal?.[slug] || {};
  const patch = { published: !!flag };
  if (flag) {
    const base = renderDraft(slug, st, raw);
    if (base.missing.length) {
      throw new LegalError(`Неможливо опублікувати. Заповніть: ${docs.missingLabels(base.missing).join(", ")}.`);
    }
    patch.snapshots = withSnapshot(st, base, (date) => renderDraft(slug, st, raw, date).text);
  }
  await writeState(slug, patch);
  return adminState(slug);
}

// Повернути типовий текст (поля й реквізити не змінюються; опублікована редакція покупців теж)
async function resetTemplate(slug) {
  def(slug);
  await writeState(slug, { template: null });
  return adminState(slug);
}

// ---- публічна частина

async function publicStatus() {
  const raw = await loadRaw();
  const out = {};
  for (const slug of Object.keys(docs.DOCS)) {
    const st = raw.legal?.[slug] || {};
    const last = lastSnapshot(st);
    out[slug] = { published: !!(st.published && last), version: st.published && last ? last.version : 0 };
  }
  return out;
}

async function publicDoc(slug) {
  const d = def(slug);
  const raw = await loadRaw();
  const st = raw.legal?.[slug] || {};
  const last = lastSnapshot(st);
  if (!st.published || !last) return { published: false };
  return { published: true, title: d.title, text: last.text, version: last.version, effectiveAt: last.at };
}

// Актуальні опубліковані редакції вказаних документів → [{ doc, version, hash }]
async function publishedRefs(slugs) {
  const raw = await loadRaw();
  const out = [];
  for (const slug of slugs) {
    const st = raw.legal?.[slug] || {};
    const last = lastSnapshot(st);
    if (st.published && last) out.push({ doc: slug, version: last.version, hash: last.hash });
  }
  return out;
}

// Згода при реєстрації / першому вході: якщо оферта чи політика конфіденційності опубліковані — потрібна
// галочка; повертає записи для збереження в акаунті. marketing — окрема необов'язкова згода.
// → { ok: true, records, marketing } | { ok: false, error }
async function consentFor({ accepted, marketing, method = "checkbox" }) {
  const refs = await publishedRefs(["oferta", "privacy"]);
  if (refs.length && accepted !== true) {
    return { ok: false, error: "Підтвердіть, що ознайомились з публічною офертою та політикою конфіденційності" };
  }
  const at = new Date();
  return {
    ok: true,
    records: refs.map((r) => ({ ...r, at, method })),
    marketing: marketing === true ? { granted: true, at, method } : { granted: false, at, method },
  };
}

// Для оформлення замовлення: якщо оферта опублікована — потрібна згода; повертає запис для збереження в замовленні.
// → { ok: true, acceptance } (acceptance = null, якщо оферта не показується) | { ok: false, error }
async function acceptanceFor(slug, accepted) {
  const raw = await loadRaw();
  const st = raw.legal?.[slug] || {};
  const last = lastSnapshot(st);
  if (!st.published || !last) return { ok: true, acceptance: null };
  if (accepted !== true) {
    return { ok: false, error: "Підтвердіть, що ознайомились з публічною офертою та приймаєте її умови" };
  }
  // Разом фіксуємо редакції пов'язаних документів, що діяли на момент замовлення
  const related = (await publishedRefs(["delivery", "returns", "warranty", "privacy"])).map((r) => ({ doc: r.doc, version: r.version, hash: r.hash }));
  return { ok: true, acceptance: { doc: slug, version: last.version, hash: last.hash, acceptedAt: new Date(), related } };
}

module.exports = {
  LegalError,
  adminState,
  save,
  setPublished,
  resetTemplate,
  publicStatus,
  publicDoc,
  acceptanceFor,
  publishedRefs,
  consentFor,
};
