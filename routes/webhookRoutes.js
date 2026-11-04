// Вебхуки маркетингу (MARKETING_SPEC.md §5). Підключаються через routes/home/subscriptionRoutes.js.
// Підпис Svix рахується від СИРОГО тіла: для application/json його зберігає глобальний bodyParser.json
// (verify → req.rawBody у server.js); для інших Content-Type тіло читає express.raw нижче.
const express = require("express");
const webhook = require("../controllers/webhookController");

const router = express.Router();
const raw = express.raw({ type: () => true, limit: "1mb" });

router.post("/webhooks/resend", raw, webhook.resend);
router.post("/webhooks/telegram", webhook.telegram);

module.exports = router;
