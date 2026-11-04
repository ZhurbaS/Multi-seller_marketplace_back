// Прості in-memory ліміти (без залежностей) для публічних маркетингових ендпойнтів.
// limiter({max, windowMs}) → { hit(key, now?) → {ok, remaining, retryAfterMs}, reset(key), size(), sweep(now?) }
// Фіксоване вікно на ключ; прострочені ключі видаляються періодичним очищенням (unref — не тримає процес).
// Увага: стан живе в пам'яті одного процесу — при кількох інстансах ліміт діє на кожен окремо.

function limiter({ max = 5, windowMs = 60 * 60 * 1000, sweepMs } = {}) {
  const lim = Math.max(1, Number(max) || 1);
  const win = Math.max(1, Number(windowMs) || 1);
  const map = new Map(); // key → { count, resetAt }

  function sweep(now = Date.now()) {
    for (const [k, v] of map) if (v.resetAt <= now) map.delete(k);
  }

  const timer = setInterval(sweep, Math.max(1000, Math.min(sweepMs || win, 10 * 60 * 1000)));
  if (typeof timer.unref === "function") timer.unref();

  function hit(key, now = Date.now()) {
    const k = String(key ?? "");
    let e = map.get(k);
    if (!e || e.resetAt <= now) {
      e = { count: 0, resetAt: now + win };
      map.set(k, e);
    }
    e.count += 1;
    const ok = e.count <= lim;
    return { ok, remaining: Math.max(0, lim - e.count), retryAfterMs: ok ? 0 : e.resetAt - now };
  }

  return {
    hit,
    reset: (key) => map.delete(String(key ?? "")),
    size: () => map.size,
    sweep,
    stop: () => clearInterval(timer),
  };
}

// Express-middleware на основі limiter. keyFn(req) → ключ (типово — IP)
function middleware(opts = {}, keyFn = (req) => req.ip || req.socket?.remoteAddress || "") {
  const l = limiter(opts);
  const message = opts.message || "Забагато запитів. Спробуйте пізніше";
  const mw = (req, res, next) => {
    const r = l.hit(keyFn(req));
    if (r.ok) return next();
    res.set("Retry-After", String(Math.ceil(r.retryAfterMs / 1000)));
    return res.status(429).json({ error: message });
  };
  mw.limiter = l;
  return mw;
}

// Значення для app.set("trust proxy") з env TRUST_PROXY. Ліміти рахуються за req.ip: за реверс-проксі
// (Render/Railway/Nginx) без trust proxy всі клієнти мають IP проксі (спільний ліміт на весь сайт), а
// "true" дозволило б підробити IP через X-Forwarded-For. Тому: число хопів ("1"), "loopback"/підмережі; "true" ігнорується.
function trustProxyValue(v) {
  const s = String(v ?? "").trim();
  if (!s || /^(false|0|off|no)$/i.test(s)) return false;
  if (/^\d{1,2}$/.test(s)) return Number(s);
  if (/^true$/i.test(s)) return false;
  return s; // "loopback", "10.0.0.0/8, 127.0.0.1" тощо
}

module.exports = { limiter, middleware, trustProxyValue };
