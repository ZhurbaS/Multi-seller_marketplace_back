// Адмін CRM і розсилки (MARKETING_SPEC.md §7). Префікс /api/admin/crm; лише admin.
// Підключення в server.js: app.use("/api", require("./routes/crmRoutes")).
// Статичні шляхи (export.csv, import, merge, bulk, preview, rename…) — ДО параметричних `/:id`.
const express = require("express");
const crm = require("../controllers/crmController");
const camp = require("../controllers/campaignController");
const { authMiddleware, requireRole } = require("../middleware/authMiddleware");

const router = express.Router();
const P = "/admin/crm";
const admin = [authMiddleware, requireRole("admin")];

// Контакти
router.get(`${P}/contacts`, ...admin, crm.list_contacts);
router.get(`${P}/contacts/export.csv`, ...admin, crm.export_contacts);
router.post(`${P}/contacts/import`, ...admin, crm.import_contacts);
router.post(`${P}/contacts/merge`, ...admin, crm.merge_contacts);
router.post(`${P}/contacts/bulk`, ...admin, crm.bulk);
router.post(`${P}/contacts`, ...admin, crm.create_contact);
router.get(`${P}/contacts/:id`, ...admin, crm.get_contact);
router.put(`${P}/contacts/:id/status`, ...admin, crm.set_status);
router.put(`${P}/contacts/:id`, ...admin, crm.update_contact);
router.delete(`${P}/contacts/:id`, ...admin, crm.delete_contact);

// Теги
router.get(`${P}/tags`, ...admin, crm.list_tags);
router.put(`${P}/tags/rename`, ...admin, crm.rename_tag);
router.delete(`${P}/tags/:tag`, ...admin, crm.delete_tag);

// Сегменти
router.get(`${P}/segments`, ...admin, crm.list_segments);
router.post(`${P}/segments/preview`, ...admin, crm.preview_segment);
router.post(`${P}/segments`, ...admin, crm.create_segment);
router.get(`${P}/segments/:id/contacts`, ...admin, crm.segment_contacts);
router.put(`${P}/segments/:id`, ...admin, crm.update_segment);
router.delete(`${P}/segments/:id`, ...admin, crm.delete_segment);

// Кампанії
router.get(`${P}/campaigns`, ...admin, camp.list);
router.post(`${P}/campaigns`, ...admin, camp.create);
router.get(`${P}/campaigns/:id/report`, ...admin, camp.report);
router.post(`${P}/campaigns/:id/duplicate`, ...admin, camp.duplicate);
router.post(`${P}/campaigns/:id/preview`, ...admin, camp.preview);
router.post(`${P}/campaigns/:id/test`, ...admin, camp.test);
router.post(`${P}/campaigns/:id/estimate`, ...admin, camp.estimate);
router.post(`${P}/campaigns/:id/send`, ...admin, camp.send);
router.post(`${P}/campaigns/:id/cancel`, ...admin, camp.cancel);
router.get(`${P}/campaigns/:id`, ...admin, camp.get);
router.put(`${P}/campaigns/:id`, ...admin, camp.update);
router.delete(`${P}/campaigns/:id`, ...admin, camp.remove);

// Автоматизації, налаштування, health, аналітика, RFM, товари для блоку «products»
router.get(`${P}/automations/stats`, ...admin, crm.automation_stats);
router.get(`${P}/automations`, ...admin, crm.get_automations);
router.put(`${P}/automations`, ...admin, crm.save_automations);
router.get(`${P}/settings`, ...admin, crm.get_settings);
router.put(`${P}/settings`, ...admin, crm.save_settings);
router.get(`${P}/health`, ...admin, crm.health);
router.get(`${P}/analytics`, ...admin, crm.analytics);
router.post(`${P}/rfm/recompute`, ...admin, crm.rfm_recompute);
router.get(`${P}/product-search`, ...admin, crm.product_search);

module.exports = router;
