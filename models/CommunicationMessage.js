const mongoose = require("mongoose");

const CommunicationMessageSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    receiverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CommunicationGroup",
      default: null,
      index: true,
    },
    senderRole: {
      type: String,
      enum: ["Admin", "Staff"],
      required: true,
    },
    receiverRole: {
      type: String,
      enum: ["Admin", "Staff"],
      required: true,
    },
    message: {
      type: String,
      trim: true,
      default: "",
    },
    messageType: {
      type: String,
      enum: ["text", "image", "pdf", "document", "audio", "task", "call"],
      default: "text",
    },
    callStatus: {
      type: String,
      enum: ["incoming", "outgoing", "missed", "not_attended"],
      default: undefined,
    },
    callDuration: {
      type: Number,
      default: 0,
    },
    callTime: {
      type: Date,
      default: null,
    },
    attachmentUrl: {
      type: String,
      default: "",
    },
    attachmentName: {
      type: String,
      default: "",
    },
    attachmentMimeType: {
      type: String,
      default: "",
    },
    taskId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CommunicationTask",
      default: null,
    },
    replyTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CommunicationMessage",
      default: null,
    },
    readBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
  },
  {
    timestamps: true,
  },
);

CommunicationMessageSchema.index({ companyId: 1, createdAt: -1 });
CommunicationMessageSchema.index({ senderId: 1, receiverId: 1, createdAt: -1 });
CommunicationMessageSchema.index({ receiverId: 1, createdAt: -1 });

module.exports =
  mongoose.models.CommunicationMessage ||
  mongoose.model("CommunicationMessage", CommunicationMessageSchema);
