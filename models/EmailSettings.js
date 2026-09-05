const mongoose = require("mongoose");

const emailSettingsSchema = new mongoose.Schema(
    {
        companyId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Company",
            required: true,
            index: true,
            unique: true,
        },
        smtpHost: { type: String, default: "", trim: true },
        smtpPort: { type: Number, default: 587 },
        smtpSecure: { type: Boolean, default: false }, // true for 465, false for 587/STARTTLS
        smtpUser: { type: String, default: "", trim: true },
        smtpPassEncrypted: { type: String, default: "" },
        saveSentCopy: { type: Boolean, default: false },
        imapHost: { type: String, default: "", trim: true },
        imapPort: { type: Number, default: 993 },
        imapSecure: { type: Boolean, default: true },
        imapUser: { type: String, default: "", trim: true },
        imapPassEncrypted: { type: String, default: "" },
        sentFolder: { type: String, default: "Sent", trim: true },
        fromName: { type: String, default: "", trim: true },
        fromEmail: { type: String, default: "", trim: true },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    },
    { timestamps: true },
);

module.exports = mongoose.model("EmailSettings", emailSettingsSchema);
