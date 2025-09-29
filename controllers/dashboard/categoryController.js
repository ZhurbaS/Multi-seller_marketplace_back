const { IncomingForm } = require("formidable");
const { responseReturn } = require("../../utiles/response");
const cloudinary = require("cloudinary").v2;
const categoryModel = require("../../models/categoryModel");
const slugify = require("slugify");
const { nanoid } = require("nanoid");
const handleError = require("../../utiles/handleError");

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET,
  secure: true,
});

class categoryController {
  add_category = async (req, res) => {
    const form = new IncomingForm();
    form.parse(req, async (err, fields, files) => {
      if (err) {
        return responseReturn(res, 400, { error: "😢 Parse error" });
      }

      let { name } = fields;
      name = Array.isArray(name) ? name[0] : name;

      let { image } = files;
      image = Array.isArray(image) ? image[0] : image;

      if (!name || !image) {
        return responseReturn(res, 400, {
          error: "Name and image are required",
        });
      }

      if (!image.filepath) {
        return responseReturn(res, 400, {
          error: "No valid image file provided",
        });
      }

      name = name.trim();
      const slugBase = slugify(name, {
        lower: true,
        strict: true,
        locale: "uk",
      });
      const slug = `${slugBase}-${nanoid(6)}`;

      try {
        // 🔍 перевірка на існуючу категорію
        const existing = await categoryModel.findOne({ name });
        if (existing) {
          return responseReturn(res, 400, {
            error: "Category with this name already exists",
          });
        }

        // ⬆️ завантаження в Cloudinary
        const result = await cloudinary.uploader.upload(image.filepath, {
          folder: "categories",
        });

        if (result) {
          const category = await categoryModel.create({
            name,
            slugBase,
            slug,
            image: result.secure_url, // краще завжди брати secure_url
            imageId: result.public_id, // збереження public_id
          });
          return responseReturn(res, 201, {
            category,
            message: "Category added successfully 🫡",
          });
        } else {
          return responseReturn(res, 500, {
            error: "😢 Image upload failed...",
          });
        }
      } catch (error) {
        console.error("❌ Error in add_category:", error);
        return responseReturn(res, 500, {
          error: "🤖 Internal server error...",
        });
      }
    });
  };

  get_category = async (req, res) => {
    const { page, searchValue, perPage } = req.query;

    try {
      let skipPage = "";
      if (perPage && page) {
        skipPage = parseInt(perPage) * (parseInt(page) - 1);
      }

      if (searchValue && page && perPage) {
        const categories = await categoryModel
          .find({
            $text: { $search: searchValue },
          })
          .skip(skipPage)
          .limit(parseInt(perPage))
          .sort({ createdAt: -1 });
        const totalCategory = await categoryModel
          .find({
            $text: { $search: searchValue },
          })
          .countDocuments();
        responseReturn(res, 200, { categories, totalCategory });
      } else if (searchValue === "" && page && perPage) {
        const categories = await categoryModel
          .find({})
          .skip(skipPage)
          .limit(parseInt(perPage))
          .sort({ createdAt: -1 });
        const totalCategory = await categoryModel.find({}).countDocuments();
        responseReturn(res, 200, { categories, totalCategory });
      } else {
        const categories = await categoryModel.find({}).sort({ createdAt: -1 });
        const totalCategory = await categoryModel.find({}).countDocuments();
        responseReturn(res, 200, { categories, totalCategory });
      }
    } catch (error) {
      console.error("💥 categoryController: get_category error:", error);
      responseReturn(res, 500, { error: "Internal server error" });
    }
  };

  update_category = async (req, res) => {
    const form = new IncomingForm();
    form.parse(req, async (err, fields, files) => {
      if (err) {
        return responseReturn(res, 400, { error: "😢 Parse error" });
      }

      let { name } = fields;
      name = Array.isArray(name) ? name[0] : name;

      let { image } = files;
      image = Array.isArray(image) ? image[0] : image;

      const { id } = req.params;

      name = name.trim();
      const slugBase = slugify(name, {
        lower: true,
        strict: true,
        locale: "uk",
      });
      const slug = `${slugBase}-${nanoid(6)}`;

      try {
        let result = null;
        if (image) {
          result = await cloudinary.uploader.upload(image.filepath, {
            folder: "categories",
          });
        }

        const updateData = { name, slug, slugBase };

        if (result) {
          updateData.image = result.secure_url;
          updateData.imageId = result.public_id;
        }

        const category = await categoryModel.findByIdAndUpdate(id, updateData, {
          new: true,
        });
        return responseReturn(res, 200, {
          category,
          message: "Категорія оновлена успішно 🫡",
        });
      } catch (error) {
        console.error("❌ Error in update_category:", error);
        return handleError(res, error, "categoryController → update_category");
      }
    });
  };

  async deleteCategory(req, res) {
    try {
      const categoryId = req.params.id;
      const deleteCategory = await categoryModel.findByIdAndDelete(categoryId);

      if (!deleteCategory) {
        console.log(`Категорія з ID ${categoryId} не знайдена`);
        return res.status(404).json({ message: "Категорія не знайдена" });
      }
      return res.status(200).json({ message: "Категорія видалена успішно" });
    } catch (error) {
      // console.error("❌ Error in deleteCategory:", error);
      return handleError(res, error, "categoryController → deleteCategory");
    }
  }
}

module.exports = new categoryController();
