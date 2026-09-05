const mongoose = require("mongoose");

const messageTemplateSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true },
    keyword: { type: String, required: true },
    content: { type: String, required: true },
    category: {
        type: String,
        enum: ["Sales", "Support", "Marketing", "General"],
        default: "General"
    },
    status: {
        type: String,
        enum: ["Active", "Inactive"],
        default: "Active"
    },
    createdAt: { type: Date, default: Date.now },
});

// Compound index for uniqueness of keyword per user
messageTemplateSchema.index({ userId: 1, keyword: 1 }, { unique: true });

module.exports = mongoose.model("MessageTemplate", messageTemplateSchema);
