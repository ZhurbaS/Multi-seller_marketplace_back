const jwt = require("jsonwebtoken");

module.exports.createToken = async (data) => {
  const token = await jwt.sign(data, process.env.SECRET, {
    expiresIn: `${process.env.JWT_COOKIE_EXPIRES_IN}d`,
  });
  return token;
};
