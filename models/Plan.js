const mongoose = require("mongoose");

const planSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, uppercase: true, unique: true },
    name: { type: String, required: true, trim: true },
    basePrice: { type: Number, required: true, min: 0, default: 0 },
    extraAdminPrice: { type: Number, min: 0, default: 0 },
    extraStaffPrice: { type: Number, min: 0, default: 0 },
    trialDays: { type: Number, min: 0, default: 0 },
    maxAdmins: { type: Number, min: 0, default: 1 },
    maxStaff: { type: Number, min: 0, default: 0 },
    aiVoiceLimitYearly: { type: Number, min: 0, default: 3000 },
    aiVoiceExtraPrice: { type: Number, min: 0, default: 500 },
    aiVoiceExtraRequests: { type: Number, min: 0, default: 1000 },
    features: [{ type: String, trim: true }],
    isActive: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);

planSchema.index({ isActive: 1, sortOrder: 1 });

module.exports = mongoose.model("Plan", planSchema);
