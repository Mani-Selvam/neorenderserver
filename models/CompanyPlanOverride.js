const mongoose = require("mongoose");

const companyPlanOverrideSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      unique: true,
      index: true,
    },
    targetPlanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Plan",
      default: null,
      index: true,
    },
    customPrice: { type: Number, min: 0, default: null },
    customMaxStaff: { type: Number, min: 0, default: null },
    customTrialDays: { type: Number, min: 0, default: null },
    customExpiry: { type: Date, default: null },
    isActive: { type: Boolean, default: true, index: true },
    notes: { type: String, trim: true, default: "" },
  },
  { timestamps: true },
);

module.exports = mongoose.model("CompanyPlanOverride", companyPlanOverrideSchema);
