const legal = require("../utiles/legalService");
const { responseReturn } = require("../utiles/response");

const fail = (res, error, where) => {
  if (error instanceof legal.LegalError) return responseReturn(res, error.status, { error: error.message });
  console.error(`💥 legalController.${where}:`, error.message);
  responseReturn(res, 500, { error: "Щось пішло не так" });
};

class legalController {
  // Публічно: які документи опубліковано (для футера й оформлення замовлення)
  async status(req, res) {
    try {
      responseReturn(res, 200, { docs: await legal.publicStatus() });
    } catch (e) {
      fail(res, e, "status");
    }
  }

  // Публічно: текст опублікованої редакції (поки вимкнено — published:false)
  async public_doc(req, res) {
    try {
      responseReturn(res, 200, await legal.publicDoc(req.params.slug));
    } catch (e) {
      fail(res, e, "public_doc");
    }
  }

  // Адмін
  async admin_get(req, res) {
    try {
      responseReturn(res, 200, await legal.adminState(req.params.slug));
    } catch (e) {
      fail(res, e, "admin_get");
    }
  }

  async admin_save(req, res) {
    try {
      const state = await legal.save(req.params.slug, req.body);
      responseReturn(res, 200, { ...state, message: "Збережено" });
    } catch (e) {
      fail(res, e, "admin_save");
    }
  }

  async admin_publish(req, res) {
    try {
      const state = await legal.setPublished(req.params.slug, req.body?.published === true);
      responseReturn(res, 200, {
        ...state,
        message: state.published ? "Оферту опубліковано — покупці її бачать і приймають при оформленні" : "Показ оферти вимкнено",
      });
    } catch (e) {
      fail(res, e, "admin_publish");
    }
  }

  async admin_reset(req, res) {
    try {
      const state = await legal.resetTemplate(req.params.slug);
      responseReturn(res, 200, { ...state, message: "Повернено типовий текст" });
    } catch (e) {
      fail(res, e, "admin_reset");
    }
  }
}

module.exports = new legalController();
