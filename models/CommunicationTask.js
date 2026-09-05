const mongoose = require("mongoose");

const CommunicationTaskSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    relatedEnquiryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Enquiry",
      default: null,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    taskType: {
      type: String,
      enum: ["Call", "WhatsApp", "Follow-up", "Meeting", "General"],
      default: "General",
    },
    priority: {
      type: String,
      enum: ["Low", "Medium", "High"],
      default: "Medium",
    },
    status: {
      type: String,
      enum: ["Pending", "In Progress", "Completed", "Cancelled"],
      default: "Pending",
      index: true,
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    assignedRole: {
      type: String,
      enum: ["Admin", "Staff", ""],
      default: "",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    dueDate: {
      type: String,
      required: true,
    },
    dueTime: {
      type: String,
      default: "",
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
    lastComment: {
      type: String,
      default: "",
    },
    statusHistory: [
      {
        status: {
          type: String,
          enum: ["Pending", "In Progress", "Completed", "Cancelled"],
          required: true,
        },
        remark: {
          type: String,
          default: "",
        },
        updatedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        updatedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    completedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

CommunicationTaskSchema.index({ companyId: 1, status: 1, dueDate: 1 });
CommunicationTaskSchema.index({ companyId: 1, assignedTo: 1, status: 1 });

module.exports =
  mongoose.models.CommunicationTask ||
  mongoose.model("CommunicationTask", CommunicationTaskSchema);
