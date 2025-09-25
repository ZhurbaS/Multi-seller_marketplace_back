const dashboardController = require("../../controllers/dashboard/dashboardController");

const { authMiddleware } = require("../../middleware/authMiddleware");

const router = require("express").Router();

router.get(
  "/admin/get-dashboard-data",
  authMiddleware,
  dashboardController.get_admin_dashboard_data
);

module.exports = router;
