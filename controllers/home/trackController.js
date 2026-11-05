// POST /api/home/track — перегляд сторінки товару (DASHBOARD_SPEC.md §4).
// Завжди відповідає 204 (клієнт ніколи не бачить помилок), нічого не пише в cookie.
// Сирі IP/UA не зберігаються і не логуються (див. utiles/tracking.js).
const express = require("express");
const tracking = require("../../utiles/tracking");
const { limiter } = require("../../utiles/rateLimit");

const MAX_BODY = 1024; // 1 КБ
const ipLimiter = limiter({ max: 120, windowMs: 60 * 1000 });

// sendBeacon надсилає text/plain — читаємо його сирим текстом (≤1 КБ); JSON уже розібрав глобальний bodyParser
const textParser = express.text({ type: ["text/plain"], limit: MAX_BODY });
const parseText = (req, res, next) =>
  textParser(req, res, (err) => {
    if (err) req.trackRejected = true; // завелике/битe тіло — тихо ігноруємо
    next();
  });

function ownHosts() {
  return [process.env.client_customer_production_url, ...(process.env.ALLOWED_ORIGINS || "").split(",")]
    .map((s) => String(s || "").trim())
    .filter(Boolean);
}

async function track(req, res) {
  res.status(204).end(); // відповідаємо одразу; запис — у фоні
  try {
    if (req.trackRejected) return;
    const len = Number(req.headers["content-length"]) || (req.rawBody ? req.rawBody.length : 0);
    if (len > MAX_BODY) return;
    const ua = String(req.headers["user-agent"] || "");
    if (tracking.isBot(ua)) return;
    const ip = req.ip || req.socket?.remoteAddress || "";
    if (!ipLimiter.hit(ip).ok) return;
    const body = tracking.parseTrackBody(req.body);
    if (!body) return;
    await tracking.recordView({ ...body, ip, ua, ownHosts: ownHosts() });
  } catch (e) {
    // лише текст помилки, без IP/UA
    console.error("track:", e?.message);
  }
}

module.exports = { track, parseText, MAX_BODY };
