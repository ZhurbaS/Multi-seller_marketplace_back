const productModel = require("../../models/productModel");
const categoryModel = require("../../models/categoryModel");
const { responseReturn } = require("../../utiles/response");
const queryProducts = require("../../utiles/queryProducts");
const reviewModel = require("../../models/reviewModel");
const moment = require("moment");

const mongoose = require("mongoose");
const ObjectId = mongoose.Types.ObjectId;

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

  async get_product_details(req, res) {
    // console.log(req.params);

    const { slug } = req.params;

    if (!slug) {
      return responseReturn(res, 404, { error: "Invalid product slug" });
    }

    try {
      const product = await productModel.findOne({ slug });
      if (!product) {
        return responseReturn(res, 404, {
          error: "Product with such slug was not found",
        });
      }

      const category = await categoryModel
        .findById(product.category)
        .select("name");

      if (!category) {
        return responseReturn(res, 404, { error: "Category not found" });
      }
      // console.log(category);

      const relatedProducts = await productModel
        .find({
          $and: [
            {
              _id: {
                $ne: product.id,
              },
            },
            {
              category: {
                $eq: product.category,
              },
            },
          ],
        })
        .limit(12);

      const moreProducts = await productModel
        .find({
          $and: [
            {
              _id: {
                $ne: product._id,
              },
            },
            {
              sellerId: {
                $eq: product.sellerId,
              },
            },
          ],
        })
        .limit(3);

      return responseReturn(res, 200, {
        product,
        relatedProducts,
        moreProducts,
        category,
      });

      // console.log(product);
    } catch (error) {
      console.error("💥 Error in homeController: get_product_details:", error);
      return responseReturn(res, 500, {
        error: error.message || "Something went wrong",
      });
    }
  }

  async submit_review(req, res) {
    // console.log(req.body);

    const { productId, rating, review, name } = req.body;

    try {
      await reviewModel.create({
        productId,
        name,
        rating,
        review,
        date: moment(Date.now()).format("LL"),
      });

      let rat = 0;
      const reviews = await reviewModel.find({
        productId,
      });

      for (let i = 0; i < reviews.length; i++) {
        rat = rat + reviews[i].rating;
      }

      let productRating = 0;
      if (reviews.length !== 0) {
        productRating = (rat / reviews.length).toFixed(1);
      }

      await productModel.findByIdAndUpdate(productId, {
        rating: productRating,
      });

      return responseReturn(res, 201, {
        message: "Review added successfully",
      });
    } catch (error) {
      console.error("💥 Error in homeController: submit_review:", error);
      return responseReturn(res, 500, {
        error: error.message || "Something went wrong",
      });
    }
  }

  async get_reviews(req, res) {
    // console.log(req.params);
    const { productId } = req.params;
    let { pageNo } = req.query;
    // console.log(productId, pageNo);

    pageNo = parseInt(pageNo);
    const limit = parseInt(process.env.REVIEWS_PER_PAGE, 10) || 5; // 5
    const skipPage = limit * (pageNo - 1);

    try {
      let getRating = await reviewModel.aggregate([
        {
          $match: {
            productId: {
              $eq: new ObjectId(productId),
            },
            rating: {
              $not: {
                $size: 0,
              },
            },
          },
        },
        {
          $unwind: "$rating",
        },
        {
          $group: {
            _id: "$rating",
            count: {
              $sum: 1,
            },
          },
        },
      ]);

      let rating_review = [
        { rating: 5, sum: 0 },
        { rating: 4, sum: 0 },
        { rating: 3, sum: 0 },
        { rating: 2, sum: 0 },
        { rating: 1, sum: 0 },
      ];

      for (let i = 0; i < rating_review.length; i++) {
        for (let j = 0; j < getRating.length; j++) {
          if (rating_review[i].rating === getRating[j]._id) {
            rating_review[i].sum = getRating[j].count;
            break;
          }
        }
      }

      const getAll = await reviewModel.find({ productId });
      const reviews = await reviewModel
        .find({
          productId,
        })
        .skip(skipPage)
        .limit(limit)
        .sort({ createdAt: -1 });

      return responseReturn(res, 200, {
        reviews,
        totalReview: getAll.length,
        rating_review,
      });
    } catch (error) {
      console.error("💥 Error in homeController: get_reviews:", error);
      return responseReturn(res, 500, {
        error: error.message || "Something went wrong",
      });
    }
  }
}

module.exports = new homeController();
