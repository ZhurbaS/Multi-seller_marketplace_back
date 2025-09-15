const { responseReturn } = require("../../utiles/response");
const customerModel = require("../../models/customerModel");
const bcrypt = require("bcrypt");
const sellerCustomerModel = require("../../models/chat/sellerCustomerModel");
const { createToken } = require("../../utiles/tokenCreate");

class customerAuthController {
  customer_register = async (req, res) => {
    console.log(req.body);
    const { name, email, phone, password } = req.body;
    try {
      const customer = await customerModel.findOne({ email });
      if (customer) {
        return responseReturn(res, 404, { error: "Email already exists" });
      } else {
        const createdCustomer = await customerModel.create({
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim(),
          password: await bcrypt.hash(password, 10),
          method: "menualy",
        });
        await sellerCustomerModel.create({
          myId: createdCustomer.id,
        });
        const token = await createToken({
          id: createdCustomer.id,
          name: createdCustomer.name,
          email: createdCustomer.email,
          phone: createdCustomer.phone,
          method: createdCustomer.method,
        });

        res.cookie("customerToken", token, {
          expires: new Date(
            Date.now() + process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000
          ),
        });
        responseReturn(res, 200, {
          token,
          message: "User registration successful",
        });
      }
    } catch (error) {
      console.error(
        "💥 Error in customerAuthController: customer_register:",
        error
      );
      return responseReturn(res, 500, {
        error: error.message || "Something went wrong",
      });
    }
  };

  customer_login = async (req, res) => {
    // console.log(req.body);
    const { email, phone, password } = req.body;
    try {
      const customer = await customerModel
        .findOne({ email })
        .select("+password");
      if (customer) {
        const match = await bcrypt.compare(password, customer.password);
        if (match) {
          const token = await createToken({
            id: customer.id,
            name: customer.name,
            email: customer.email,
            phone: customer.phone,
            method: customer.method,
          });
          res.cookie("customerToken", token, {
            expires: new Date(
              Date.now() +
                process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000
            ),
          });
          return responseReturn(res, 201, {
            token,
            message: "User login successful",
          });
        } else {
          return responseReturn(res, 404, {
            error: "Password wrong",
          });
        }
      } else {
        return responseReturn(res, 404, {
          error: "Email not found",
        });
      }
    } catch (error) {
      console.error(
        "💥 Error in customerAuthController: customer_login:",
        error
      );
      return responseReturn(res, 500, {
        error: error.message || "Something went wrong",
      });
    }
  };

  async customer_logout(req, res) {
    res.cookie("customerToken", "", {
      expires: new Date(Date.now()),
    });

    return responseReturn(res, 200, {
      message: "Logout successful",
    });
  }
}

module.exports = new customerAuthController();
