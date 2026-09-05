const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    provider: { type: String, enum: ["razorpay"], required: true, index: true },
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: "Plan", required: true, index: true },
    couponCode: { type: String, trim: true, default: "" },

    amountUsd: { type: Number, min: 0, required: true },
    amountInr: { type: Number, min: 0, required: true },
    amountInrPaise: { type: Number, min: 0, required: true },
    usdInrRate: { type: Number, min: 0, required: true },

    razorpayOrderId: { type: String, trim: true, index: true },
    razorpayPaymentId: { type: String, trim: true, index: true, default: null },
    razorpaySignature: { type: String, trim: true, default: null },

    status: {
      type: String,
      enum: ["created", "verified", "failed"],
      default: "created",
      index: true,
    },
    notes: { type: String, trim: true, default: "" },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

paymentSchema.index({ provider: 1, razorpayOrderId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("Payment", paymentSchema);

