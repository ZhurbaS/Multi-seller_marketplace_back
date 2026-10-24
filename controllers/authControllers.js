const adminModel = require('../models/adminModel');
const sellerModel = require('../models/sellerModel');
const sellerCustomerModel = require('../models/chat/sellerCustomerModel');
const { responseReturn } = require('../utiles/response');
const bcrypt = require('bcrypt');
const { createToken } = require('../utiles/tokenCreate');
const { IncomingForm } = require('formidable');
const handleError = require('../utiles/handleError');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET,
  secure: true,
});

class authControllers {
  async admin_login(req, res) {
    const { email, password } = req.body;
    try {
      const admin = await adminModel.findOne({ email }).select('+password');
      // console.log(admin);
      if (admin) {
        const match = await bcrypt.compare(password, admin.password);
        // console.log(match);
        if (match) {
          const token = await createToken({
            id: admin.id,
            role: admin.role,
          });
          res.cookie('accessToken', token, {
            httpOnly: true,
            secure: true,
            sameSite: 'none',
            maxAge: process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000,
          });
          responseReturn(res, 200, { token, message: 'Вхід виконано успішно' });
        } else {
          responseReturn(res, 404, { error: 'Невірний пароль. Спробуйте ще раз' });
        }
      } else {
        responseReturn(res, 404, { error: 'Email не знайдено' });
      }
    } catch (error) {
      responseReturn(res, 500, { error: error.message });
    }
  }

  seller_login = async (req, res) => {
    const { email, password } = req.body;
    try {
      const seller = await sellerModel.findOne({ email }).select('+password');
      // console.log(admin);
      if (seller) {
        const match = await bcrypt.compare(password, seller.password);
        // console.log(match);
        if (match) {
          const token = await createToken({
            id: seller.id,
            role: seller.role,
          });
          res.cookie('accessToken', token, {
            httpOnly: true,
            secure: true,
            sameSite: 'none',
            maxAge: process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000,
          });
          responseReturn(res, 200, { token, message: 'Вхід виконано успішно ✔️' });
        } else {
          responseReturn(res, 404, {
            error: '💥 Невірний пароль! Спробуйте ще раз',
          });
        }
      } else {
        responseReturn(res, 404, { error: 'Email не знайдено' });
      }
    } catch (error) {
      responseReturn(res, 500, { error: error.message });
    }
  };

  seller_register = async (req, res) => {
    const { name, email, password } = req.body;
    try {
      const getUser = await sellerModel.findOne({ email });
      if (getUser) {
        responseReturn(res, 404, { error: 'Користувач з таким Email вже існує' });
      } else {
        const saltRounds = parseInt(process.env.SALT_ROUNDS) || 10;
        const seller = await sellerModel.create({
          name,
          email,
          password: await bcrypt.hash(password, saltRounds),
          method: 'manually',
          shopInfo: {},
        });
        await sellerCustomerModel.create({
          myId: seller.id,
        });
        const token = await createToken({
          id: seller.id,
          role: seller.role,
        });
        res.cookie('accessToken', token, {
          expires: new Date(
            Date.now() +
              process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000,
          ),
        });
        responseReturn(res, 201, {
          token,
          message: 'Реєстрація успішна ✔️',
        });
      }
    } catch (error) {
      responseReturn(res, 500, { error: 'Внутрішня помилка сервера 🤖' });
    }
  };

  getUser = async (req, res) => {
    const { id, role } = req;
    try {
      if (role === 'admin') {
        const user = await adminModel.findById(id);
        responseReturn(res, 200, { userInfo: user });
      } else {
        const seller = await sellerModel.findById(id);
        responseReturn(res, 200, { userInfo: seller });
      }
    } catch (error) {
      responseReturn(res, 500, { error: 'Внутрішня помилка сервера 🤖' });
    }
  };

  profile_image_upload = async (req, res) => {
    const { id } = req;
    const form = new IncomingForm({
      multiples: true,
      keepExtensions: true,
      allowEmptyFiles: false,
      maxFileSize: parseInt(process.env.MAX_FILE_SIZE) * 1024 * 1024,
    });

    form.parse(req, async (err, _, files) => {
      if (err) {
        console.error('❌ Помилка обробки форми:', err);
        return responseReturn(res, 400, { error: 'Помилка обробки форми' });
      }

      if (!files.image) {
        return responseReturn(res, 400, { error: 'Зображення не завантажено' });
      }

      const imageRaw = files.image;
      const image = Array.isArray(imageRaw) ? imageRaw[0] : imageRaw;
      try {
        const result = await cloudinary.uploader.upload(image.filepath, {
          folder: 'profile',
        });

        if (!result || !result.url) {
          return responseReturn(res, 500, { error: 'Не вдалося завантажити зображення' });
        }
        await sellerModel.findByIdAndUpdate(id, {
          image: result.url,
        });
        const userInfo = await sellerModel.findById(id);
        return responseReturn(res, 200, {
          message: 'Фото профілю завантажено 👍',
          userInfo,
        });
      } catch (error) {
        console.error('❌ Error in profile_image_upload:', error);
        return responseReturn(res, 500, {
          error: error.message || 'Щось пішло не так',
        });
      }
    });
  };

  profile_info_add = async (req, res) => {
    const { city, district, address, shopName, shopWebPage } = req.body;
    const { id } = req;
    try {
      await sellerModel.findByIdAndUpdate(id, {
        shopInfo: {
          shopName,
          shopWebPage,
          city,
          district,
          address,
        },
      });
      const userInfo = await sellerModel.findById(id);
      return responseReturn(res, 201, {
        message: 'Інформацію профілю збережено 👍',
        userInfo,
      });
    } catch (error) {
      console.error('❌ Error in profile_info_add:', error);
      return responseReturn(res, 500, {
        error: error.message || 'Щось пішло не так',
      });
    }
  };

  async logout(req, res) {
    try {
      res.cookie('accessToken', null, {
        expires: new Date(Date.now()),
        httpOnly: true,
      });
      return responseReturn(res, 200, {
        message: 'Ви успішно вийшли 👍',
      });
    } catch (error) {
      return handleError(res, error, 'authController → logout');
    }
  }

  async change_password(req, res) {
    const { email, old_password, new_password } = req.body;
    // console.log(`Password change requested for ${email}`);

    try {
      const user = await sellerModel.findOne({ email }).select('+password');
      if (!user)
        return res
          .status(404)
          .json({ message: `Користувача ${email} не знайдено` });

      const isMatch = await bcrypt.compare(old_password, user.password);
      if (!isMatch)
        return res.status(400).json({ message: `Старий пароль невірний` });

      if (old_password === new_password) {
        return res
          .status(400)
          .json({ message: 'Новий пароль не може співпадати зі старим' });
      }

      const saltRounds = parseInt(process.env.SALT_ROUNDS) || 10;
      user.password = await bcrypt.hash(new_password, saltRounds);
      await user.save();
      res.json({ message: 'Пароль змінений успішно' });
    } catch (error) {
      return handleError(res, error, 'authController → change_password');
    }
  }
}

module.exports = new authControllers();
