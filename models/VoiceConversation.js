const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema({
    role: { type: String, enum: ["user", "assistant"], required: true },
    text: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    widget: { type: mongoose.Schema.Types.Mixed, required: false }
}, { _id: false });

const VoiceConversationSchema = new mongoose.Schema({
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Company",
        required: false
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    },
    title: {
        type: String,
        default: "New Chat"
    },
    messages: [MessageSchema]
}, {
    timestamps: true
});

module.exports = mongoose.model("VoiceConversation", VoiceConversationSchema);
