const productModel = require("../../models/productModel");
const categoryModel = require("../../models/categoryModel");
const customerModel = require("../../models/customerModel");
const customerOrderModel = require("../../models/customerOrderModel");
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
        error: error.message || "Щось пішло не так",
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
        error: error.message || "Щось пішло не так",
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
        error: error.message || "Щось пішло не так",
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
        error: error.message || "Щось пішло не так",
      });
    }
  };

  async get_product_details(req, res) {
    // console.log(req.params);

    const { slug } = req.params;

    if (!slug) {
      return responseReturn(res, 404, { error: "Некоректний slug товару" });
    }

    try {
      const product = await productModel.findOne({ slug });
      if (!product) {
        return responseReturn(res, 404, {
          error: "Товар не знайдено",
        });
      }

      const category = await categoryModel
        .findById(product.category)
        .select("name");

      if (!category) {
        return responseReturn(res, 404, { error: "Категорію не знайдено" });
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
        error: error.message || "Щось пішло не так",
      });
    }
  }

  // Recalculates a product's average rating from its APPROVED reviews only
  // (pending/rejected reviews never affect the public rating). Called only
  // when a review is approved, edited-while-approved, or un-approved.
  recalculateProductRating = async (productId) => {
    const approvedReviews = await reviewModel.find({
      productId,
      status: "approved",
    });

    let productRating = 0;
    if (approvedReviews.length !== 0) {
      const sum = approvedReviews.reduce((acc, r) => acc + r.rating, 0);
      productRating = (sum / approvedReviews.length).toFixed(1);
    }

    await productModel.findByIdAndUpdate(productId, {
      rating: productRating,
    });
  };

  async submit_review(req, res) {
    const { productId, rating, review } = req.body;
    const customerId = req.id; // set by customerAuthMiddleware — never trust a client-submitted customerId/name

    try {
      if (!productId || !rating || !review) {
        return responseReturn(res, 400, {
          error: "productId, rating та review є обов'язковими",
        });
      }

      // Verified purchase check: the customer must have an order for this
      // exact product that has actually been delivered — not just placed
      // or paid for. This is what lets us show a "Verified Purchase" badge
      // and is the whole point of gating who can review at all.
      const deliveredOrder = await customerOrderModel
        .findOne({
          customerId,
          delivery_status: "delivered",
          $or: [
            { "products._id": new ObjectId(productId) },
            { "products._id": productId },
            { "products.productInfo._id": productId },
          ],
        })
        .sort({ createdAt: -1 });

      if (!deliveredOrder) {
        return responseReturn(res, 403, {
          error:
            "Залишити відгук можна лише для товару з доставленого замовлення",
        });
      }

      const customer = await customerModel.findById(customerId);
      if (!customer) {
        return responseReturn(res, 404, { error: "Клієнта не знайдено" });
      }

      // Upsert on (productId, customerId): resubmitting edits the existing
      // review instead of creating a duplicate, and always sends it back
      // to "pending" so the edited content gets re-moderated.
      await reviewModel.findOneAndUpdate(
        { productId, customerId },
        {
          productId,
          customerId,
          orderId: deliveredOrder._id,
          name: customer.name,
          rating,
          review,
          date: moment(Date.now()).format("LL"),
          status: "pending",
          adminNote: "",
          moderatedAt: null,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      return responseReturn(res, 201, {
        message: "Відгук надіслано на модерацію",
      });
    } catch (error) {
      console.error("💥 Error in homeController: submit_review:", error);
      return responseReturn(res, 500, {
        error: error.message || "Щось пішло не так",
      });
    }
  }

  // Public: can this logged-in customer review this product right now?
  // Front-end uses this to decide whether to show the review form at all,
  // instead of letting anyone submit and finding out only after a 403.
  async can_review(req, res) {
    const { productId } = req.params;
    const customerId = req.id;

    try {
      const deliveredOrder = await customerOrderModel.findOne({
        customerId,
        delivery_status: "delivered",
        $or: [
          { "products._id": new ObjectId(productId) },
          { "products._id": productId },
          { "products.productInfo._id": productId },
        ],
      });

      const existingReview = await reviewModel.findOne({
        productId,
        customerId,
      });

      return responseReturn(res, 200, {
        canReview: !!deliveredOrder,
        existingReview,
      });
    } catch (error) {
      console.error("💥 Error in homeController: can_review:", error);
      return responseReturn(res, 500, {
        error: error.message || "Щось пішло не так",
      });
    }
  }

  // Public: only ever returns APPROVED reviews — pending/rejected reviews
  // stay invisible to everyone except the admin moderation queue.
  async get_reviews(req, res) {
    const { productId } = req.params;
    let { pageNo } = req.query;

    pageNo = parseInt(pageNo);
    const limit = parseInt(process.env.REVIEWS_PER_PAGE, 10) || 5; // 5
    const skipPage = limit * (pageNo - 1);

    try {
      let getRating = await reviewModel.aggregate([
        {
          $match: {
            productId: new ObjectId(productId),
            status: "approved",
          },
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

      const getAll = await reviewModel.find({ productId, status: "approved" });
      const reviews = await reviewModel
        .find({
          productId,
          status: "approved",
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
        error: error.message || "Щось пішло не так",
      });
    }
  }

  // Admin only: moderation queue. Defaults to "pending" so the dashboard
  // page opens straight to the reviews that actually need a decision;
  // pass ?status=approved or ?status=rejected to audit those instead.
  async admin_get_reviews(req, res) {
    let { pageNo, status } = req.query;
    pageNo = parseInt(pageNo) || 1;
    status = ["pending", "approved", "rejected"].includes(status)
      ? status
      : "pending";

    const limit = 10;
    const skipPage = limit * (pageNo - 1);

    try {
      const filter = { status };
      const totalReview = await reviewModel.countDocuments(filter);
      const reviews = await reviewModel
        .find(filter)
        .populate("productId", "name slug images")
        .skip(skipPage)
        .limit(limit)
        .sort({ createdAt: -1 });

      const pendingCount = await reviewModel.countDocuments({
        status: "pending",
      });

      return responseReturn(res, 200, {
        reviews,
        totalReview,
        pendingCount,
      });
    } catch (error) {
      console.error("💥 Error in homeController: admin_get_reviews:", error);
      return responseReturn(res, 500, {
        error: error.message || "Щось пішло не так",
      });
    }
  }

  // Admin only: approve or reject a pending (or previously-decided) review.
  // Approving/un-approving is the ONLY thing that ever changes a product's
  // publicly-shown rating — never the raw act of submitting a review.
  admin_review_status_update = async (req, res) => {
    const { reviewId } = req.params;
    const { status, adminNote } = req.body;

    if (!["approved", "rejected"].includes(status)) {
      return responseReturn(res, 400, {
        error: "status має бути 'approved' або 'rejected'",
      });
    }

    try {
      const review = await reviewModel.findById(reviewId);
      if (!review) {
        return responseReturn(res, 404, { error: "Відгук не знайдено" });
      }

      // Per FTC/consumer-protection guidance: never rewrite a reviewer's
      // own words — moderation can only accept/reject, not edit content.
      review.status = status;
      review.adminNote = adminNote || "";
      review.moderatedAt = new Date();
      await review.save();

      await this.recalculateProductRating(review.productId);

      return responseReturn(res, 200, {
        message:
          status === "approved" ? "Відгук опубліковано" : "Відгук відхилено",
      });
    } catch (error) {
      console.error(
        "💥 Error in homeController: admin_review_status_update:",
        error
      );
      return responseReturn(res, 500, {
        error: error.message || "Щось пішло не так",
      });
    }
  };
}

module.exports = new homeController();
