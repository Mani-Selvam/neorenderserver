const mongoose = require("mongoose");

const AIPaymentSchema = new mongoose.Schema(
    {
        companyId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Company",
            required: true,
            index: true,
        },
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
        amountPaid: {
            type: Number,
            required: true,
            min: 0,
        },
        requestsAdded: {
            type: Number,
            required: true,
            min: 1,
        },
        status: {
            type: String,
            enum: ["Pending", "Completed", "Failed"],
            default: "Completed",
        },
        paymentMethod: {
            type: String,
            default: "Stripe", // or Razorpay, Manual, etc.
        },
        transactionId: {
            type: String,
        },
        receiptEmailSent: {
            type: Boolean,
            default: false,
        },
        whatsappSent: {
            type: Boolean,
            default: false,
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model("AIPayment", AIPaymentSchema);
