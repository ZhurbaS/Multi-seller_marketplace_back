const productModel = require("../../models/productModel");
const categoryModel = require("../../models/categoryModel");
const { responseReturn } = require("../../utiles/response");
const queryProducts = require("../../utiles/queryProducts");

class homeController {
  formateProduct = (products) => {
    const productsArray = [];
    let i = 0;
    while (i < products.length) {
      let temp = [];
      let j = i;
      while (j < i + 3) {
        if (products[j]) {
          temp.push(products[j]);
        }
        j++;
      }
      productsArray.push([...temp]);
      i = j;
    }
    return productsArray;
  };

  get_categories = async (req, res) => {
    try {
      const categories = await categoryModel.find({});
      return responseReturn(res, 200, categories);
    } catch (error) {
      console.error("💥 Error in homeController: get_categories:", error);
      return responseReturn(res, 500, {
        error: error.message || "Something went wrong",
      });
    }
  };

  get_products = async (req, res) => {
    try {
      const products = await productModel.find({}).limit(12).sort({
        createdAt: -1,
      });
      const allProducts1 = await productModel.find({}).limit(9).sort({
        createdAt: -1,
      });
      const latest_product = this.formateProduct(allProducts1);
      const allProducts2 = await productModel.find({}).limit(9).sort({
        rating: -1,
      });
      const topRated_product = this.formateProduct(allProducts2);
      const allProducts3 = await productModel.find({}).limit(9).sort({
        discount: -1,
      });
      const discount_product = this.formateProduct(allProducts3);
      return responseReturn(res, 200, {
        products,
        latest_product,
        topRated_product,
        discount_product,
      });
    } catch (error) {
      console.error("💥 Error in homeController: get_products:", error);
      return responseReturn(res, 500, {
        error: error.message || "Something went wrong",
      });
    }
  };

  price_range_product = async (req, res) => {
    try {
      const priceRange = {
        low: 0,
        high: 0,
      };
      const products = await productModel.find({}).limit(9).sort({
        createdAt: -1,
      });
      const latest_product = this.formateProduct(products);
      const getForPrice = await productModel.find({}).sort({
        price: 1,
      });
      if (getForPrice.length > 0) {
        priceRange.high = getForPrice[getForPrice.length - 1].price;
        priceRange.low = getForPrice[0].price;
      }
      return responseReturn(res, 200, {
        latest_product,
        priceRange,
      });
    } catch (error) {
      console.error("💥 Error in homeController: price_range_product:", error);
      return responseReturn(res, 500, {
        error: error.message || "Something went wrong",
      });
    }
  };

  query_products = async (req, res) => {
    const perPage = 12;

    const queryParams = {
      ...req.query,
      perPage,
      lowPrice: parseInt(req.query.lowPrice),
      highPrice: parseInt(req.query.highPrice),
    };

    // console.log(queryParams);
    try {
      // console.log("Received category:", queryParams.category);
      let category = "";
      let categoryId = "";
      if (queryParams.category) {
        category = await categoryModel.findOne({
          name: queryParams.category,
        });
        // console.log("Found category:", category);
        categoryId = category._id.toString();
      }

      const products = await productModel.find({}).sort({
        createdAt: -1,
      });
      const totalProduct = new queryProducts(products, queryParams)
        .categoryQuery(categoryId)
        .ratingQuery()
        .priceQuery()
        .searchQuery()
        .sortByPrice()
        .countProducts();

      const result = new queryProducts(products, queryParams)
        .categoryQuery(categoryId)
        .ratingQuery()
        .priceQuery()
        .searchQuery()
        .sortByPrice()
        .skip()
        .limit()
        .getProducts();

      // console.log(result);

      return responseReturn(res, 200, {
        products: result,
        totalProduct,
        perPage,
      });
    } catch (error) {
      console.error("💥 Error in homeController: query_products:", error);
      return responseReturn(res, 500, {
        error: error.message || "Something went wrong",
      });
    }
  };
}

module.exports = new homeController();
