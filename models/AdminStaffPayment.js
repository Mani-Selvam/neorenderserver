const mongoose = require("mongoose");

const AdminStaffPaymentSchema = new mongoose.Schema(
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
        type: {
            type: String,
            enum: ["Admin", "Staff"],
            required: true,
        },
        quantityAdded: {
            type: Number,
            required: true,
            min: 1,
        },
        amountPaid: {
            type: Number,
            required: true,
            min: 0,
        },
        status: {
            type: String,
            enum: ["Pending", "Completed", "Failed"],
            default: "Completed",
        },
        paymentMethod: {
            type: String,
            default: "Razorpay",
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

module.exports = mongoose.model("AdminStaffPayment", AdminStaffPaymentSchema);
