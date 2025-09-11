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
}

module.exports = new chatController();
