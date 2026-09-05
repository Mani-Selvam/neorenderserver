const mongoose = require("mongoose");

const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, uppercase: true, unique: true },
    discountType: {
      type: String,
      enum: ["percentage", "fixed"],
      required: true,
    },
    discountValue: { type: Number, required: true, min: 0 },
    applicablePlans: [{ type: mongoose.Schema.Types.ObjectId, ref: "Plan" }],
    appliesToAllCompanies: { type: Boolean, default: true },
    applicableCompanies: [{ type: mongoose.Schema.Types.ObjectId, ref: "Company" }],
    expiryDate: { type: Date, required: true, index: true },
    // Legacy field kept for backward compatibility with old payloads
    usageLimit: { type: Number, min: 1, default: 1 },
    globalUsageLimit: { type: Number, min: 1, default: 1 },
    perCompanyUsageLimit: { type: Number, min: 1, default: 1 },
    usedCount: { type: Number, min: 0, default: 0 },
    companyUsageMap: { type: Map, of: Number, default: {} },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

couponSchema.methods.isValidNow = function isValidNow() {
  const endOfExpiryDay = this.expiryDate ? new Date(this.expiryDate) : null;
  if (endOfExpiryDay) endOfExpiryDay.setHours(23, 59, 59, 999);
  const globalLimit = this.globalUsageLimit || this.usageLimit || 1;
  return this.isActive && this.usedCount < globalLimit && (!endOfExpiryDay || endOfExpiryDay > new Date());
};

module.exports = mongoose.model("Coupon", couponSchema);
