const storeSettingsModel = require("../models/storeSettingsModel");
const theme = require("../utiles/theme");
const { responseReturn } = require("../utiles/response");

async function load() {
  const s = (await storeSettingsModel.findOne({ key: "main" }).lean()) || {};
  return s.theme || {};
}

// Публічно: готовий CSS теми + хеш. Якщо хеш збігається — віддаємо 304-подібну відповідь.
exports.get_public = async (req, res) => {
  try {
    const t = await load();
    const { css, hash } = theme.build(theme.normalize(t));
    res.set("Cache-Control", "public, max-age=300");
    if (req.query.hash && req.query.hash === hash) return res.status(200).json({ hash, css });
    return res.status(200).json({ hash, css });
  } catch (e) {
    console.error("💥 theme.get_public:", e.message);
    responseReturn(res, 500, { error: "Щось пішло не так" });
  }
};

exports.admin_get = async (req, res) => {
  try {
    const t = await load();
    const norm = theme.normalize(t);
    const { css, hash } = theme.build(norm);
    responseReturn(res, 200, {
      theme: norm,
      css,
      hash,
      presets: theme.PRESETS,
      history: (t.history || []).slice(0, 5),
      ...theme.validate(norm),
    });
  } catch (e) {
    console.error("💥 theme.admin_get:", e.message);
    responseReturn(res, 500, { error: "Щось пішло не так" });
  }
};

// Попередній перегляд без збереження: повертає CSS і перевірку контрасту
exports.admin_preview = async (req, res) => {
  const norm = theme.normalize(req.body);
  const v = theme.validate(norm);
  responseReturn(res, 200, { theme: norm, css: theme.buildCss(norm), ...v });
};

exports.admin_save = async (req, res) => {
  try {
    const norm = theme.normalize(req.body);
    const v = theme.validate(norm);
    if (v.errors.length) return responseReturn(res, 400, { error: v.errors.join("; "), ...v });
    const prev = await load();
    const history = [
      { preset: prev.preset, overrides: prev.overrides, at: new Date() },
      ...(prev.history || []),
    ]
      .filter((h) => h.preset)
      .slice(0, 5);
    await storeSettingsModel.findOneAndUpdate(
      { key: "main" },
      { $set: { theme: { ...norm, history, updatedAt: new Date() } } },
      { upsert: true }
    );
    const { css, hash } = theme.build(norm);
    responseReturn(res, 200, { theme: norm, css, hash, warnings: v.warnings, message: "Тему збережено" });
  } catch (e) {
    console.error("💥 theme.admin_save:", e.message);
    responseReturn(res, 500, { error: "Щось пішло не так" });
  }
};
