const mongoose = require("mongoose");

const supportTicketSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    mobile: { type: String, trim: true },
    message: { type: String, required: true, trim: true },
    source: { type: String, default: "mobile", trim: true },
    status: {
      type: String,
      enum: ["Open", "Responded", "Closed"],
      default: "Open",
    },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company" },
    companyStatusAtSubmit: { type: String, trim: true },
    ip: { type: String, trim: true },
    userAgent: { type: String, trim: true },
    responseMessage: { type: String, trim: true },
    respondedAt: { type: Date },
    respondedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

supportTicketSchema.index({ status: 1, createdAt: -1 });
supportTicketSchema.index({ email: 1, createdAt: -1 });
supportTicketSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model("SupportTicket", supportTicketSchema);

