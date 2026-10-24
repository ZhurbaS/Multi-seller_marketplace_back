const { responseReturn } = require('../../utiles/response');
const customerModel = require('../../models/customerModel');
const bcrypt = require('bcrypt');
const sellerCustomerModel = require('../../models/chat/sellerCustomerModel');
const { createToken } = require('../../utiles/tokenCreate');

class customerAuthController {
  customer_register = async (req, res) => {
    // console.log(req.body);
    const { name, email, phone, password } = req.body;
    try {
      const customer = await customerModel.findOne({ email });
      if (customer) {
        return responseReturn(res, 404, { error: 'Користувач з таким Email вже існує' });
      } else {
        const createdCustomer = await customerModel.create({
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim(),
          password: await bcrypt.hash(password, 10),
          method: 'manually',
        });
        await sellerCustomerModel.create({
          myId: createdCustomer.id,
        });
        const token = await createToken({
          id: createdCustomer.id,
          role: 'customer',
          name: createdCustomer.name,
          email: createdCustomer.email,
          phone: createdCustomer.phone,
          method: createdCustomer.method,
        });

        res.cookie('customerToken', token, {
          httpOnly: true,
          secure: true,
          sameSite: 'none',
          maxAge: process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000,
        });
        responseReturn(res, 200, {
          token,
          message: 'Реєстрацію успішно завершено',
        });
      }
    } catch (error) {
      console.error(
        '💥 Error in customerAuthController: customer_register:',
        error,
      );
      return responseReturn(res, 500, {
        error: "Щось пішло не так",
      });
    }
  };

  customer_login = async (req, res) => {
    // console.log(req.body);
    const { email, phone, password } = req.body;
    try {
      const customer = await customerModel
        .findOne({ email })
        .select('+password');
      if (customer) {
        const match = await bcrypt.compare(password, customer.password);
        if (match) {
          const token = await createToken({
            id: customer.id,
            role: 'customer',
            name: customer.name,
            email: customer.email,
            phone: customer.phone,
            method: customer.method,
          });
          res.cookie('customerToken', token, {
            httpOnly: true,
            secure: true,
            sameSite: 'none',
            maxAge: process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000,
          });
          return responseReturn(res, 201, {
            token,
            message: 'Вхід виконано успішно',
          });
        } else {
          return responseReturn(res, 404, {
            error: 'Невірний пароль',
          });
        }
      } else {
        return responseReturn(res, 404, {
          error: 'Email не знайдено',
        });
      }
    } catch (error) {
      console.error(
        '💥 Error in customerAuthController: customer_login:',
        error,
      );
      return responseReturn(res, 500, {
        error: "Щось пішло не так",
      });
    }
  };

  async customer_logout(req, res) {
    res.cookie('customerToken', '', {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      expires: new Date(Date.now()),
    });

    return responseReturn(res, 200, {
      message: 'Ви успішно вийшли',
    });
  }
}

module.exports = new customerAuthController();
