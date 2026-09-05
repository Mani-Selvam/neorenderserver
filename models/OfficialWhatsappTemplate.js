const mongoose = require("mongoose");

const OfficialWhatsappTemplateSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        language: { type: String, default: "en", trim: true },
        category: { type: String, default: "General", trim: true },
        contentPreview: { type: String, trim: true, default: "" },
        buttonIndex: { type: Number, default: 0 },
        status: { type: String, enum: ["Active", "Inactive"], default: "Active" },
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

OfficialWhatsappTemplateSchema.index({ ownerUserId: 1 });
OfficialWhatsappTemplateSchema.index({ companyId: 1 });
// Name should be unique per company/user to avoid confusion
OfficialWhatsappTemplateSchema.index(
    { companyId: 1, name: 1 },
    { unique: true, partialFilterExpression: { companyId: { $type: "objectId" } } }
);

module.exports = mongoose.model("OfficialWhatsappTemplate", OfficialWhatsappTemplateSchema);
