const { responseReturn } = require("../../utiles/response");
const cardModel = require("../../models/cardModel");

const mongoose = require("mongoose");
const sellerModel = require("../../models/sellerModel");
const customerModel = require("../../models/customerModel");
const sellerCustomerModel = require("../../models/chat/sellerCustomerModel");
const sellerCustomerMessage = require("../../models/chat/sellerCustomerMessage");
const ObjectId = mongoose.Types.ObjectId;

class chatController {
  async add_customer_friend(req, res) {
    const { sellerId, userId } = req.body;

    try {
      if (sellerId !== "") {
        const seller = await sellerModel.findById(sellerId);
        const user = await customerModel.findById(userId);
        const checkSeller = await sellerCustomerModel.findOne({
          $and: [
            {
              myId: {
                $eq: userId,
              },
            },
            {
              myFriends: {
                $elemMatch: {
                  fdId: sellerId,
                },
              },
            },
          ],
        });

        if (!checkSeller) {
          await sellerCustomerModel.updateOne(
            {
              myId: userId,
            },
            {
              $push: {
                myFriends: {
                  fdId: sellerId,
                  name: seller.shopInfo?.shopName,
                  image: seller.image,
                },
              },
            }
          );
        }

        const checkCustomer = await sellerCustomerModel.findOne({
          $and: [
            {
              myId: {
                $eq: sellerId,
              },
            },
            {
              myFriends: {
                $elemMatch: {
                  fdId: userId,
                },
              },
            },
          ],
        });

        if (!checkCustomer) {
          await sellerCustomerModel.updateOne(
            {
              myId: sellerId,
            },
            {
              $push: {
                myFriends: {
                  fdId: userId,
                  name: user.name,
                  image: "",
                },
              },
            }
          );
        }

        const messages = await sellerCustomerMessage.find({
          $or: [
            {
              $and: [
                { receiverId: { $eq: sellerId } },
                { senderId: { $eq: userId } },
              ],
            },
            {
              $and: [
                { receiverId: { $eq: userId } },
                { senderId: { $eq: sellerId } },
              ],
            },
          ],
        });

        const MyFriends = await sellerCustomerModel.findOne({
          myId: userId,
        });

        const currentFd = MyFriends.myFriends.find((s) => s.fdId === sellerId);

        return responseReturn(res, 200, {
          MyFriends: MyFriends.myFriends,
          currentFd,
          messages,
        });

        // console.log(checkSeller);
      } else {
        const MyFriends = await sellerCustomerModel.findOne({
          myId: userId,
        });
        return responseReturn(res, 200, {
          MyFriends: MyFriends.myFriends,
        });
      }
    } catch (error) {
      console.error(
        "💥 Error in chatController: add_customer_friend:",
        error.message
      );
      return responseReturn(res, 500, {
        error: error.message || "Something went wrong",
      });
    }
  }

  async customer_message_add(req, res) {
    // console.log(req.body);

    const { userId, sellerId, text, name } = req.body;

    try {
      const message = await sellerCustomerMessage.create({
        senderId: userId,
        senderName: name,
        receiverId: sellerId,
        message: text,
      });

      // for User
      const data = await sellerCustomerModel.findOne({
        myId: userId,
      });
      let myFriends = data.myFriends;
      let index = myFriends.findIndex((f) => f.fdId === sellerId);
      while (index > 0) {
        let temp = myFriends[index];
        myFriends[index] = myFriends[index - 1];
        myFriends[index - 1] = temp;
        index--;
      }
      await sellerCustomerModel.updateOne({ myId: userId }, { myFriends });

      // for Seller
      const dataForSeller = await sellerCustomerModel.findOne({
        myId: sellerId,
      });
      let myFriendsForSeller = dataForSeller.myFriends;
      let indexForSeller = myFriendsForSeller.findIndex(
        (f) => f.fdId === userId
      );
      while (indexForSeller > 0) {
        let tempForSeller = myFriendsForSeller[indexForSeller];
        myFriendsForSeller[indexForSeller] =
          myFriendsForSeller[indexForSeller - 1];
        myFriendsForSeller[indexForSeller - 1] = tempForSeller;
        indexForSeller--;
      }
      await sellerCustomerModel.updateOne(
        { myId: sellerId },
        { myFriendsForSeller }
      );

      return responseReturn(res, 201, { message });
    } catch (error) {
      console.error(
        "💥 Error in chatController: customer_message_add:",
        error.message
      );
      return responseReturn(res, 500, {
        error: error.message || "Something went wrong",
      });
    }
  }

  async get_customers(req, res) {
    // console.log(req.params);

    const { sellerId } = req.params;
    try {
      const data = await sellerCustomerModel.findOne({ myId: sellerId });

      return responseReturn(res, 200, { customers: data.myFriends });
    } catch (error) {
      console.error(
        "💥 Error in chatController: get_customers:",
        error.message
      );
      return responseReturn(res, 500, {
        error: error.message || "Something went wrong",
      });
    }
  }

  async get_customers_seller_message(req, res) {
    // console.log(req.params);
    const { customerId } = req.params;
    const { id } = req; // sellerId
    // console.log(id);

    try {
      const messages = await sellerCustomerMessage.find({
        $or: [
          {
            $and: [
              { receiverId: { $eq: customerId } },
              { senderId: { $eq: id } },
            ],
          },
          {
            $and: [
              { receiverId: { $eq: id } },
              { senderId: { $eq: customerId } },
            ],
          },
        ],
      });

      const currentCustomer = await customerModel.findById(customerId);

      return responseReturn(res, 200, { currentCustomer, messages });
    } catch (error) {
      console.error(
        "💥 Error in chatController: get_customers_seller_message:",
        error.message
      );
      return responseReturn(res, 500, {
        error: error.message || "Something went wrong",
      });
    }
  }

  async seller_message_add(req, res) {
    // console.log(req.body);

    const { senderId, receiverId, text, name } = req.body;

    try {
      const message = await sellerCustomerMessage.create({
        senderId: senderId,
        senderName: name,
        receiverId: receiverId,
        message: text,
      });

      // for Seller
      const data = await sellerCustomerModel.findOne({
        myId: senderId,
      });
      let myFriends = data.myFriends;
      let index = myFriends.findIndex((f) => f.fdId === receiverId);
      while (index > 0) {
        let temp = myFriends[index];
        myFriends[index] = myFriends[index - 1];
        myFriends[index - 1] = temp;
        index--;
      }
      await sellerCustomerModel.updateOne({ myId: senderId }, { myFriends });

      // for Customer
      const dataForCustomer = await sellerCustomerModel.findOne({
        myId: receiverId,
      });
      let myFriendsForCustomer = dataForCustomer.myFriends;
      let indexForCustomer = myFriendsForCustomer.findIndex(
        (f) => f.fdId === senderId
      );
      while (indexForCustomer > 0) {
        let tempForCustomer = myFriendsForCustomer[indexForCustomer];
        myFriendsForCustomer[indexForCustomer] =
          myFriendsForCustomer[indexForCustomer - 1];
        myFriendsForCustomer[indexForCustomer - 1] = tempForCustomer;
        indexForCustomer--;
      }
      await sellerCustomerModel.updateOne(
        { myId: receiverId },
        { myFriendsForCustomer }
      );

      return responseReturn(res, 201, { message });
    } catch (error) {
      console.error(
        "💥 Error in chatController: customer_message_add:",
        error.message
      );
      return responseReturn(res, 500, {
        error: error.message || "Something went wrong",
      });
    }
  }

  async get_sellers(req, res) {
    try {
      const sellers = await sellerModel.find({});
      return responseReturn(res, 200, { sellers });
    } catch (error) {
      console.error("💥 Error in chatController: get_sellers:", error.message);
      return responseReturn(res, 500, {
        error: error.message || "Something went wrong",
      });
    }
  }

  async seller_admin_message_insert(req, res) {
    console.log(req.body);
  }
}

module.exports = new chatController();
