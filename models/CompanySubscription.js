const mongoose = require("mongoose");

const companySubscriptionSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Plan",
      required: true,
      index: true,
    },
    couponId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Coupon",
      default: null,
    },
    status: {
      type: String,
      enum: ["Trial", "Active", "Expired", "Cancelled"],
      default: "Trial",
      index: true,
    },
    startDate: { type: Date, required: true, default: Date.now },
    endDate: { type: Date, required: true, index: true },
    trialUsed: { type: Boolean, default: false },
    manualOverrideExpiry: { type: Date, default: null },
    finalPrice: { type: Number, min: 0, default: 0 },
    allocatedAdmins: { type: Number, min: 0, default: 1 },
    allocatedStaff: { type: Number, min: 0, default: 0 },
    extraAdminsPurchased: { type: Number, min: 0, default: 0 },
    extraStaffPurchased: { type: Number, min: 0, default: 0 },
    extraAdminPrice: { type: Number, min: 0, default: 0 },
    extraStaffPrice: { type: Number, min: 0, default: 0 },
    notes: { type: String, trim: true },
  },
  { timestamps: true },
);

companySubscriptionSchema.index({ companyId: 1, status: 1 });
companySubscriptionSchema.index({ companyId: 1, endDate: -1 });

module.exports = mongoose.model("CompanySubscription", companySubscriptionSchema);
