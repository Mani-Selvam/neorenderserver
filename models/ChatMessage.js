const mongoose = require("mongoose");

const ChatMessageSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  }, // The company owner
  enquiryId: { type: mongoose.Schema.Types.ObjectId, ref: "Enquiry" }, // Linked contact
  sender: { type: String, enum: ["Admin", "Customer"], required: true },
  type: {
    type: String,
    enum: ["text", "image", "document", "audio", "video", "ptt", "template"],
    default: "text",
  },
  content: { type: String }, // Text message or File URL
  fileName: { type: String }, // For documents
  mimeType: { type: String },
  phoneNumber: { type: String, required: true }, // Receiver or Sender phone
  timestamp: { type: Date, default: Date.now },
  status: {
    type: String,
    enum: ["sent", "delivered", "read", "received", "not_attended", "failed"],
    default: "sent",
  },
  externalId: { type: String }, // WhatsApp Message ID from provider
  providerTicketId: { type: String },
  providerResponse: { type: String },
  providerError: { type: String },
});

// ⚡ Performance Indexes — critical for fast chat loading
ChatMessageSchema.index({ userId: 1, phoneNumber: 1, timestamp: -1 }); // Main query pattern
ChatMessageSchema.index({ phoneNumber: 1, timestamp: -1 }); // Phone number lookup
ChatMessageSchema.index({ userId: 1, timestamp: -1 }); // User's messages sorted by time
ChatMessageSchema.index({ externalId: 1 }, { sparse: true }); // WhatsApp message ID dedup
ChatMessageSchema.index({ providerTicketId: 1 }, { sparse: true });

module.exports =
  mongoose.models.ChatMessage ||
  mongoose.model("ChatMessage", ChatMessageSchema);
