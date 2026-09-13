const rateLimit = require("express-rate-limit");

// Захист від перебору пароля: не більше 10 спроб логіну за 15 хвилин з однієї
// IP-адреси. Раніше жодного обмеження не було — демо-пароль адміна ("123456")
// можна було підбирати без жодної затримки.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Забагато спроб входу. Спробуйте ще раз через 15 хвилин." },
});

module.exports = { loginLimiter };
