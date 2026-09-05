const mongoose = require("mongoose");

const TargetSchema = new mongoose.Schema(
  {
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    year: { type: Number, required: true, min: 2000, max: 3000 },
    month: { type: Number, required: true, min: 1, max: 12 },

    leadsTarget: { type: Number, default: null, min: 0 },
    confirmedProjectsTarget: { type: Number, default: null, min: 0 },
    marketingBudget: { type: Number, default: null, min: 0 },
    incomeTarget: { type: Number, default: null, min: 0 },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

TargetSchema.index({ company_id: 1, year: 1, month: 1 }, { unique: true });

module.exports = mongoose.model("Target", TargetSchema);

