const jwt = require("jsonwebtoken");

// Для admin/seller — читає accessToken (виставляється authControllers.js)
module.exports.authMiddleware = async (req, res, next) => {
  const { accessToken } = req.cookies;

  if (!accessToken) {
    return res.status(409).json({ error: "Please Login First 🙏" });
  } else {
    try {
      const deCodeToken = await jwt.verify(accessToken, process.env.SECRET);
      req.role = deCodeToken.role;
      req.id = deCodeToken.id;
      next();
    } catch (error) {
      return res.status(409).json({ error: "Please Login" });
    }
  }
};

// Для клієнтів магазину — читає customerToken (виставляється customerAuthController.js).
// Раніше customer-роути взагалі не мали жодної middleware для перевірки автентифікації,
// бо існуючий authMiddleware шукає інший cookie і в токені клієнта немає поля role.
module.exports.customerAuthMiddleware = async (req, res, next) => {
  const { customerToken } = req.cookies;

  if (!customerToken) {
    return res.status(409).json({ error: "Please Login First 🙏" });
  } else {
    try {
      const deCodeToken = await jwt.verify(customerToken, process.env.SECRET);
      req.role = "customer";
      req.id = deCodeToken.id;
      next();
    } catch (error) {
      return res.status(409).json({ error: "Please Login" });
    }
  }
};

// Перевірка ролі — ставити ПІСЛЯ authMiddleware/customerAuthMiddleware,
// які визначають req.role.
module.exports.requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.role)) {
    return res.status(403).json({ error: "Access denied" });
  }
  next();
};