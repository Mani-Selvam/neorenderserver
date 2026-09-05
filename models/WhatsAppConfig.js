const mongoose = require("mongoose");

const WhatsAppConfigSchema = new mongoose.Schema(
    {
        provider: { type: String, default: "WATI" },
        apiUrl: { type: String, default: "" },
        // Token should be stored encrypted; use `apiTokenEncrypted` for storage.
        apiTokenEncrypted: { type: String, default: "" },
        // `apiToken` may be populated in-memory (decrypted) but is not persisted.
        apiToken: { type: String, select: false },
        watiBaseUrl: { type: String, default: "" },
        watiApiTokenEncrypted: { type: String, default: "" },
        metaWhatsappTokenEncrypted: { type: String, default: "" },
        metaPhoneNumberId: { type: String, default: "" },
        neoBaseUrl: { type: String, default: "" },
        neoAccountName: { type: String, default: "" },
        neoApiKeyEncrypted: { type: String, default: "" },
        neoPhoneNumber: { type: String, default: "" },
        neoBearerTokenEncrypted: { type: String, default: "" },
        twilioAccountSid: { type: String, default: "" },
        twilioAuthTokenEncrypted: { type: String, default: "" },
        twilioWhatsappNumber: { type: String, default: "" },
        verifyToken: { type: String, default: "" },
        appSecret: { type: String, default: "" },
        signatureHeader: { type: String, default: "X-Hub-Signature-256" },
        enableSignatureVerification: { type: Boolean, default: false },
        defaultCountry: { type: String, default: "91" },
        templateLanguage: { type: String, default: "en" },
        templateButtonIndex: { type: Number, default: 0 },
        enquiryAlertTemplateName: { type: String, default: "" },
        editOtpVerifiedAt: { type: Date, default: null },
        companyId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Company",
            default: null,
        },
        ownerUserId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },
    },
    { timestamps: true },
);

WhatsAppConfigSchema.index(
    { ownerUserId: 1 },
    { unique: true, partialFilterExpression: { ownerUserId: { $type: "objectId" } } },
);
WhatsAppConfigSchema.index(
    { companyId: 1 },
    { unique: true, partialFilterExpression: { companyId: { $type: "objectId" } } },
);

module.exports = mongoose.model("WhatsAppConfig", WhatsAppConfigSchema);
