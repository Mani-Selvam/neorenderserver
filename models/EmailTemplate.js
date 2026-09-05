const mongoose = require("mongoose");

const emailTemplateSchema = new mongoose.Schema(
    {
        companyId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Company",
            required: true,
            index: true,
        },
        name: { type: String, required: true, trim: true },
        subject: { type: String, default: "", trim: true },
        body: { type: String, default: "" },
        status: {
            type: String,
            enum: ["Active", "Inactive"],
            default: "Active",
        },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    },
    { timestamps: true },
);

emailTemplateSchema.index({ companyId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("EmailTemplate", emailTemplateSchema);

