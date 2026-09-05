const mongoose = require("mongoose");

const attachmentSchema = new mongoose.Schema(
    {
        filename: { type: String, default: "" },
        path: { type: String, default: "" },
        mimetype: { type: String, default: "" },
        size: { type: Number, default: 0 },
    },
    { _id: false },
);

const emailLogSchema = new mongoose.Schema(
    {
        companyId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Company",
            required: true,
            index: true,
        },
        enquiryId: { type: mongoose.Schema.Types.ObjectId, ref: "Enquiry", default: null, index: true },
        templateId: { type: mongoose.Schema.Types.ObjectId, ref: "EmailTemplate", default: null },

        to: { type: String, required: true, trim: true },
        subject: { type: String, default: "", trim: true },
        body: { type: String, default: "" }, // plain text
        bodyHtml: { type: String, default: "" },

        status: { type: String, enum: ["Queued", "Sent", "Failed"], default: "Queued", index: true },
        error: { type: String, default: "" },
        messageId: { type: String, default: "" },
        smtpResponse: { type: String, default: "" },
        acceptedRecipients: { type: [String], default: [] },
        rejectedRecipients: { type: [String], default: [] },

        attachments: { type: [attachmentSchema], default: [] },

        sentBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        sentAt: { type: Date, default: null, index: true },

        trackOpen: { type: Boolean, default: false },
        trackLinks: { type: Boolean, default: false },
        openedAt: { type: Date, default: null },
        openCount: { type: Number, default: 0 },
        clickedAt: { type: Date, default: null },
        clickCount: { type: Number, default: 0 },
    },
    { timestamps: true },
);

emailLogSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model("EmailLog", emailLogSchema);
