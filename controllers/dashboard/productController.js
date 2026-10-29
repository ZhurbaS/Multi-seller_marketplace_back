const { responseReturn } = require("../../utiles/response");
const cloudinary = require("cloudinary").v2;
const slugify = require("slugify");
const { nanoid } = require("nanoid");
const { IncomingForm } = require("formidable");
const productModel = require("../../models/productModel");
const cardModel = require("../../models/cardModel");
const wishlistModel = require("../../models/wishlistModel");
const reviewModel = require("../../models/reviewModel");
const bannerModel = require("../../models/bannerModel");
const mongoose = require("mongoose");
const pricing = require("../../utiles/pricing");
const { notifyBackInStock } = require("../../utiles/notifyBackInStock");
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET,
  secure: true,
});

// Cloudinary повертає http_code 420 (або 429), коли перевищено ліміт запитів.
// Завантажуємо зображення по одному й повторюємо спробу з наростаючою
// затримкою (1с, 2с, 4с), щоб кілька фото поспіль не ламали додавання товару.
const uploadImageWithRetry = async (filepath, options = {}) => {
  const delays = [1000, 2000, 4000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await cloudinary.uploader.upload(filepath, options);
    } catch (error) {
      const rateLimited = error?.http_code === 420 || error?.http_code === 429;
      if (!rateLimited || attempt >= delays.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
};

const isCloudinaryRateLimit = (error) =>
  error?.http_code === 420 || error?.http_code === 429;

const RATE_LIMIT_MESSAGE =
  "Сервіс зображень тимчасово перевантажений. Зачекайте хвилину і спробуйте ще раз (або додайте менше фото).";

// Витягує public_id з URL Cloudinary:
// https://res.cloudinary.com/<cloud>/image/upload/v123/products/abc.jpg -> "products/abc"
const getCloudinaryPublicId = (url) => {
  if (typeof url !== "string") return null;
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-zA-Z0-9]+$/);
  return match ? match[1] : null;
};

// Допоміжна функція для отримання "першого значення" поля
const getFieldValue = (field) =>
  Array.isArray(field) ? field[0] : field || "";

//  Валідація обов’язкових полів
const validateRequiredFields = (fields, requiredKeys) => {
  const missing = requiredKeys.filter((key) => {
    const value = getFieldValue(fields[key]);

    if (Array.isArray(value)) {
      return value.length === 0;
    }

    return !value?.toString().trim(); // (! ...) перевіряє, чи результат є порожнім рядком ("") або undefined/null
  });

  return missing.length
    ? `Missing required fields: ${missing.join(", ")}`
    : null;
};

class productController {
  add_product = async (req, res) => {
    const { id } = req;

    const form = new IncomingForm({
      multiples: true,
      keepExtensions: true,
      allowEmptyFiles: false,
      maxFileSize: parseInt(process.env.MAX_FILE_SIZE) * 1024 * 1024,
    });

    form.parse(req, async (err, fields, files) => {
      if (err) {
        console.error("❌ Помилка обробки форми:", err);
        return responseReturn(res, 400, { error: "Помилка обробки форми" });
      }

      try {
        const requiredFields = [
          "name",
          "category",
          "description",
          "stock",
          "discount",
          "brand",
          "price",
          "shopName",
        ];

        const validationError = validateRequiredFields(fields, requiredFields);
        if (validationError) {
          return responseReturn(res, 400, { error: validationError });
        }

        const name = getFieldValue(fields.name).trim();
        const categoryId = getFieldValue(fields.category);
        // console.log("Received category:", fields.category);

        if (!mongoose.Types.ObjectId.isValid(categoryId)) {
          return responseReturn(res, 400, { error: "Некоректний ідентифікатор категорії" });
        }
        const description = getFieldValue(fields.description).trim();
        const stock = parseInt(getFieldValue(fields.stock)) || 0;
        const discount = parseInt(getFieldValue(fields.discount)) || 0;
        const brand = getFieldValue(fields.brand).trim();
        const price = parseInt(getFieldValue(fields.price)) || 0;
        const shopName = getFieldValue(fields.shopName).trim();

        if (stock < 0 || price < 0 || discount < 0 || discount > 100) {
          return responseReturn(res, 400, {
            error: "Кількість, ціна й знижка мають бути невід'ємними, знижка — до 100%",
          });
        }

        // Умови продажу: мін. замовлення, крок, знижки за кількість, терміни поставки.
        // У multipart-формі всі значення — рядки (priceTiers — JSON-рядок).
        const saleRules = pricing.sanitizeSaleRules({
          minOrderQty: getFieldValue(fields.minOrderQty),
          orderStep: getFieldValue(fields.orderStep),
          packLabel: getFieldValue(fields.packLabel),
          priceTiers: getFieldValue(fields.priceTiers),
          restockDaysMin: getFieldValue(fields.restockDaysMin),
          restockDaysMax: getFieldValue(fields.restockDaysMax),
          allowPreorder: getFieldValue(fields.allowPreorder),
        });
        if (saleRules.error) {
          return responseReturn(res, 400, { error: saleRules.error });
        }

        // Характеристики — необов'язкове поле, приходить як JSON-рядок
        // (FormData не вміє передавати масиви об'єктів напряму). Порожні
        // рядки (продавець додав рядок, але нічого не вписав) відфільтровуємо.
        let specifications = [];
        const rawSpecifications = getFieldValue(fields.specifications);
        if (rawSpecifications) {
          try {
            const parsed = JSON.parse(rawSpecifications);
            if (Array.isArray(parsed)) {
              specifications = parsed
                .map((s) => ({
                  key: String(s.key || "").trim(),
                  value: String(s.value || "").trim(),
                }))
                .filter((s) => s.key && s.value);
            }
          } catch {
            return responseReturn(res, 400, {
              error: "Некоректний формат характеристик",
            });
          }
        }

        const slugBase = slugify(name, {
          lower: true,
          strict: true,
          locale: "uk",
        });
        const slug = `${slugBase}-${nanoid(6)}`;

        // Завантаження зображень
        const images = files.images;
        const imageArray = Array.isArray(images)
          ? images
          : images
          ? [images]
          : [];
        const allImageUrl = [];
        for (let img of imageArray) {
          const result = await uploadImageWithRetry(img.filepath, {
            folder: "products",
          });
          allImageUrl.push(result.url);
        }

        // Створення продукту
        const newProduct = await productModel.create({
          sellerId: id,
          name,
          slugBase,
          slug,
          shopName,
          category: categoryId,
          brand,
          price,
          stock,
          discount,
          description,
          images: allImageUrl,
          specifications,
          ...saleRules.value,
        });

        return responseReturn(res, 201, {
          message: "Товар успішно додано 🫡",
          product: newProduct,
        });
      } catch (error) {
        console.error("❌ Error in add_product:", error);
        if (isCloudinaryRateLimit(error)) {
          return responseReturn(res, 429, { error: RATE_LIMIT_MESSAGE });
        }
        return responseReturn(res, 500, {
          error: "Щось пішло не так",
        });
      }
    });
  };

  products_get = async (req, res) => {
    const { page, searchValue, perPage } = req.query;
    const { id } = req;

    const pageNum = parseInt(page) || 1;
    const perPageNum = parseInt(perPage) || 5;
    const skipPage = perPageNum * (pageNum - 1);

    try {
      const filter = searchValue
        ? { $text: { $search: searchValue }, sellerId: id }
        : { sellerId: id };

      const products = await productModel
        .find(filter)
        .skip(skipPage)
        .limit(perPageNum)
        .sort({ createdAt: -1 })
        .populate("category");

      const totalProduct = await productModel.countDocuments(filter);

      responseReturn(res, 200, { products, totalProduct });
    } catch (error) {
      console.log(error.message);
      responseReturn(res, 500, {
        error: "Щось пішло не так",
      });
    }
  };

  product_get = async (req, res) => {
    const { productId } = req.params;
    try {
      const product = await productModel
        .findById(productId)
        .populate("category");

      if (!product) {
        return responseReturn(res, 404, { error: "Товар не знайдено" });
      }
      // Раніше будь-який залогінений продавець міг переглянути чужий товар
      // за productId. Дозволяємо власнику товару або адміну.
      if (req.role !== "admin" && product.sellerId.toString() !== req.id) {
        return responseReturn(res, 403, { error: "Доступ заборонено" });
      }
      responseReturn(res, 200, { product });
    } catch (error) {
      console.log(error.message);
      responseReturn(res, 500, {
        error: "Щось пішло не так",
      });
    }
  };

  product_update = async (req, res) => {
    try {
      let {
        name,
        description,
        stock,
        discount,
        brand,
        price,
        category,
        productId,
        specifications,
      } = req.body;

      // Умови продажу (JSON-запит). Форма редагування завжди надсилає всі поля;
      // відсутні поля трактуються як значення за замовчуванням (мін. 1, крок 1).
      const saleRules = pricing.sanitizeSaleRules(req.body);
      if (saleRules.error) {
        return responseReturn(res, 400, { error: saleRules.error });
      }

      if (!productId) {
        return responseReturn(res, 400, { error: "Потрібен ідентифікатор товару" });
      }
      if (!name) {
        return responseReturn(res, 400, { error: "Назва обов'язкова" });
      }

      // Раніше будь-який залогінений продавець міг оновити чужий товар,
      // знаючи лише productId. Перевіряємо власника перед будь-якими змінами.
      const existingProduct = await productModel.findById(productId);
      if (!existingProduct) {
        return responseReturn(res, 404, { error: "Товар не знайдено" });
      }
      if (
        req.role !== "admin" &&
        existingProduct.sellerId.toString() !== req.id
      ) {
        return responseReturn(res, 403, { error: "Доступ заборонено" });
      }

      name = name.trim();

      const slugBase = slugify(name, {
        lower: true,
        strict: true,
        locale: "uk",
      });

      const slug = `${slugBase}-${nanoid(6)}`;

      const stockNum = Number(stock);
      const priceNum = Number(price);
      const discountNum = Number(discount);
      if (
        !Number.isInteger(stockNum) || stockNum < 0 ||
        !Number.isFinite(priceNum) || priceNum < 0 ||
        !Number.isFinite(discountNum) || discountNum < 0 || discountNum > 100
      ) {
        return responseReturn(res, 400, {
          error: "Кількість, ціна й знижка мають бути невід'ємними, знижка — до 100%",
        });
      }

      // Підготовка об'єкту для оновлення
      const updateData = {
        name,
        description,
        stock: stockNum,
        discount: discountNum,
        brand,
        price: priceNum,
        slug,
        slugBase,
        ...saleRules.value,
      };

      if (category) {
        updateData.category = category; // просто _id
      }

      if (Array.isArray(specifications)) {
        updateData.specifications = specifications
          .map((s) => ({
            key: String(s?.key || "").trim(),
            value: String(s?.value || "").trim(),
          }))
          .filter((s) => s.key && s.value);
      }

      // Використовуємо populate, щоб підвантажити дані категорії
      const product = await productModel
        .findByIdAndUpdate(productId, updateData, { new: true })
        .populate("category"); // тут ім’я поля категорії у схемі productModel

      if (!product) {
        return responseReturn(res, 404, { error: "Товар не знайдено" });
      }

      // Товар знову в наявності — повідомляємо підписників (не блокуємо відповідь).
      if (existingProduct.stock <= 0 && product.stock > 0) {
        notifyBackInStock(product._id).catch((e) =>
          console.error("💥 notifyBackInStock:", e.message)
        );
      }

      responseReturn(res, 200, {
        product,
        message: "Товар успішно оновлено 🫡",
      });
    } catch (error) {
      console.error("❌ Error in product_update:", error);
      responseReturn(res, 500, {
        error: "Щось пішло не так",
      });
    }
  };

  // Видалення товару: тільки власник (або адмін). Замовлення зберігають власний
  // знімок товару (назва, ціна, фото), тому історія замовлень не ламається.
  product_delete = async (req, res) => {
    const { productId } = req.params;

    try {
      if (!mongoose.Types.ObjectId.isValid(productId)) {
        return responseReturn(res, 400, {
          error: "Некоректний ідентифікатор товару",
        });
      }

      const product = await productModel.findById(productId);
      if (!product) {
        return responseReturn(res, 404, { error: "Товар не знайдено" });
      }
      if (req.role !== "admin" && product.sellerId.toString() !== req.id) {
        return responseReturn(res, 403, { error: "Доступ заборонено" });
      }

      // Видаляємо фото з Cloudinary. Помилка видалення фото не блокує
      // видалення товару: файл можна прибрати вручну, а товар уже не потрібен.
      const publicIds = (Array.isArray(product.images) ? product.images : [])
        .map(getCloudinaryPublicId)
        .filter(Boolean);
      for (const publicId of publicIds) {
        try {
          await cloudinary.uploader.destroy(publicId);
        } catch (imgError) {
          console.error("⚠️ Cloudinary destroy failed:", publicId, imgError);
        }
      }

      // Прибираємо «осиротілі» записи, що посилаються на товар
      await Promise.all([
        cardModel.deleteMany({ productId }),
        wishlistModel.deleteMany({ productId }),
        reviewModel.deleteMany({ productId }),
        bannerModel.deleteMany({ productId }),
      ]);

      await productModel.findByIdAndDelete(productId);

      return responseReturn(res, 200, {
        message: "Товар видалено",
        productId,
      });
    } catch (error) {
      console.error("❌ Error in product_delete:", error);
      return responseReturn(res, 500, { error: "Щось пішло не так" });
    }
  };

  product_image_update = async (req, res) => {
    const form = new IncomingForm({
      multiples: true,
      keepExtensions: true,
      allowEmptyFiles: false,
      maxFileSize: parseInt(process.env.MAX_FILE_SIZE) * 1024 * 1024,
    });
    form.parse(req, async (err, fields, files) => {
      // console.log("FIELDS: ", fields);
      // console.log("FILES: ", files);

      if (err) {
        console.error("❌ Помилка обробки форми:", err);
        return responseReturn(res, 400, { error: "Помилка обробки форми" });
      }

      try {
        const oldImageRaw = fields.oldImage;
        const newImageRaw = files.newImage;
        const productId = fields.productId;

        // oldImage точно буде масивом, беремо перше значення
        const oldImage = Array.isArray(oldImageRaw)
          ? oldImageRaw[0]
          : oldImageRaw || "";

        // newImage може бути масивом або одиночним файлом
        const newImageArray = Array.isArray(newImageRaw)
          ? newImageRaw
          : newImageRaw
          ? [newImageRaw]
          : [];

        if (!oldImage || newImageArray.length === 0) {
          return responseReturn(res, 400, {
            error: "Не передано старе або нове зображення",
          });
        }

        // Отримуємо продукт
        const product = await productModel.findById(productId);
        if (!product) {
          return responseReturn(res, 404, { error: "Товар не знайдено" });
        }
        // Раніше будь-який залогінений продавець міг замінити фото чужого товару.
        if (req.role !== "admin" && product.sellerId.toString() !== req.id) {
          return responseReturn(res, 403, { error: "Доступ заборонено" });
        }

        let { images } = product;

        // Знаходимо індекс старого зображення
        const index = images.findIndex((img) => img === oldImage);
        if (index === -1) {
          return responseReturn(res, 404, {
            error: "Старе зображення не знайдено в товарі",
          });
        }

        // Завантажуємо всі нові картинки
        const newUrls = [];
        for (let newImg of newImageArray) {
          const result = await uploadImageWithRetry(newImg.filepath, {
            folder: "products",
          });

          if (!result || !result.url) {
            return responseReturn(res, 500, {
              error: "Помилка під час завантаження зображення",
            });
          }

          newUrls.push(result.url);
        }

        // Замінюємо одне старе зображення на одне або кілька нових array.splice(startIndex, deleteCount, item1, item2, ...)
        images.splice(index, 1, ...newUrls);

        // Оновлюємо продукт
        await productModel.findByIdAndUpdate(productId, { images });

        const updatedProduct = await productModel.findById(productId);
        return responseReturn(res, 200, {
          product: updatedProduct,
          message: `Зображення успішно оновлено 👍`,
        });
      } catch (error) {
        console.error("❌ Error in product_image_update:", error);
        if (isCloudinaryRateLimit(error)) {
          return responseReturn(res, 429, { error: RATE_LIMIT_MESSAGE });
        }
        return responseReturn(res, 404, {
          error: "Щось пішло не так",
        });
      }
    });
  };
}

module.exports = new productController();
