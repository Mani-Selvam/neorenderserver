const mongoose = require("mongoose");

const websiteLeadSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, trim: true },
    phone: { type: String, required: true, trim: true },
    company: { type: String, required: true, trim: true },
    city: { type: String, trim: true, default: "" },
    status: {
      type: String,
      enum: ["New", "Contacted", "Converted", "Closed"],
      default: "New",
    },
    whatsappSent: { type: Boolean, default: false },
    ip: { type: String, trim: true },
    userAgent: { type: String, trim: true },
    notes: { type: String, trim: true },
  },
  { timestamps: true },
);

websiteLeadSchema.index({ status: 1, createdAt: -1 });
websiteLeadSchema.index({ phone: 1 });

module.exports = mongoose.model("WebsiteLead", websiteLeadSchema);
