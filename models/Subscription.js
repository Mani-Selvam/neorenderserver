const mongoose = require("mongoose");

const subscriptionSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    plan: {
      type: String,
      enum: ["Starter", "Growth", "Business"],
      default: "Starter",
    },
    status: {
      type: String,
      enum: ["Trial", "Active", "Cancelled", "Expired"],
      default: "Trial",
      index: true,
    },
    startDate: { type: Date, default: Date.now, index: true },
    endDate: { type: Date },
    amount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

subscriptionSchema.index({ companyId: 1, status: 1 });

module.exports = mongoose.model("Subscription", subscriptionSchema);
