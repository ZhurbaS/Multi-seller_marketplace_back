const adminModel = require("../models/adminModel");
const sellerModel = require("../models/sellerModel");
const sellerCustomerModel = require("../models/chat/sellerCustomerModel");
const { responseReturn } = require("../utiles/response");
const bcrypt = require("bcrypt");
const { createToken } = require("../utiles/tokenCreate");
const { IncomingForm } = require("formidable");
const cloudinary = require("cloudinary").v2;

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
      const admin = await adminModel.findOne({ email }).select("+password");
      // console.log(admin);
      if (admin) {
        const match = await bcrypt.compare(password, admin.password);
        // console.log(match);
        if (match) {
          const token = await createToken({
            id: admin.id,
            role: admin.role,
          });
          res.cookie("accessToken", token, {
            expires: new Date(
              Date.now() +
                process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000
            ),
          });
          responseReturn(res, 200, { token, message: "Login Success" });
        } else {
          responseReturn(res, 404, { error: "Password is wrong! Try again" });
        }
      } else {
        responseReturn(res, 404, { error: "Email not found" });
      }
    } catch (error) {
      responseReturn(res, 500, { error: error.message });
    }
  }

  seller_login = async (req, res) => {
    const { email, password } = req.body;
    try {
      const seller = await sellerModel.findOne({ email }).select("+password");
      // console.log(admin);
      if (seller) {
        const match = await bcrypt.compare(password, seller.password);
        // console.log(match);
        if (match) {
          const token = await createToken({
            id: seller.id,
            role: seller.role,
          });
          res.cookie("accessToken", token, {
            expires: new Date(
              Date.now() +
                process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000
            ),
          });
          responseReturn(res, 200, { token, message: "Login Success ✔️" });
        } else {
          responseReturn(res, 404, {
            error: "💥 Wrong Password! Try again",
          });
        }
      } else {
        responseReturn(res, 404, { error: "Email not found" });
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
        responseReturn(res, 404, { error: "Email Already Exists..." });
      } else {
        const seller = await sellerModel.create({
          name,
          email,
          password: await bcrypt.hash(password, 10),
          method: "menualy",
          shopInfo: {},
        });
        await sellerCustomerModel.create({
          myId: seller.id,
        });
        const token = await createToken({
          id: seller.id,
          role: seller.role,
        });
        res.cookie("accessToken", token, {
          expires: new Date(
            Date.now() + process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000
          ),
        });
        responseReturn(res, 201, {
          token,
          message: "Registration Successful ✔️",
        });
      }
    } catch (error) {
      responseReturn(res, 500, { error: "Internal Server Error 🤖" });
    }
  };

  getUser = async (req, res) => {
    const { id, role } = req;
    try {
      if (role === "admin") {
        const user = await adminModel.findById(id);
        responseReturn(res, 200, { userInfo: user });
      } else {
        const seller = await sellerModel.findById(id);
        responseReturn(res, 200, { userInfo: seller });
      }
    } catch (error) {
      responseReturn(res, 500, { error: "Internal Server Error 🤖" });
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
        console.error("❌ Parse error:", err);
        return responseReturn(res, 400, { error: "Parse error" });
      }

      if (!files.image) {
        return responseReturn(res, 400, { error: "No image file uploaded" });
      }

      const imageRaw = files.image;
      const image = Array.isArray(imageRaw) ? imageRaw[0] : imageRaw;
      try {
        const result = await cloudinary.uploader.upload(image.filepath, {
          folder: "profile",
        });

        if (!result || !result.url) {
          return responseReturn(res, 500, { error: "Image upload failed" });
        }
        await sellerModel.findByIdAndUpdate(id, {
          image: result.url,
        });
        const userInfo = await sellerModel.findById(id);
        return responseReturn(res, 200, {
          message: "Profile image uploaded successfully 👍",
          userInfo,
        });
      } catch (error) {
        console.error("❌ Error in profile_image_upload:", error);
        return responseReturn(res, 500, {
          error: error.message || "Something went wrong",
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
        message: "Profile info added successfully 👍",
        userInfo,
      });
    } catch (error) {
      console.error("❌ Error in profile_info_add:", error);
      return responseReturn(res, 500, {
        error: error.message || "Something went wrong",
      });
    }
  };

  async logout(req, res) {
    try {
      res.cookie("accessToken", null, {
        expires: new Date(Date.now()),
        httpOnly: true,
      });
      return responseReturn(res, 200, {
        message: "Logout successfully 👍",
      });
    } catch (error) {
      return handleError(res, error, "authController → logout");
    }
  }
}

module.exports = new authControllers();
