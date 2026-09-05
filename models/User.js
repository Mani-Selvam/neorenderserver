const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    password: { type: String, required: true },
    passwordChangedAt: { type: Date },
    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorSecret: { type: String },
    mobile: { type: String },
    privacyPolicyAccepted: { type: Boolean, default: false },
    privacyPolicyAcceptedAt: { type: Date },
    privacyPolicyUrl: { type: String, trim: true },
    visiblePassword: { type: String },
    logo: { type: String }, // User profile picture or company logo
    googleId: { type: String, sparse: true, index: true },
    appleId: { type: String, sparse: true, index: true },
    status: {
        type: String,
        enum: ["Active", "Inactive"],
        default: "Active",
    },
    role: {
        type: String,
        enum: ["superadmin", "admin", "staff", "Admin", "Staff"],
        default: "Staff",
    },
    company_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Company",
        required: function requiredCompany() {
            const role = (this.role || "").toString().toLowerCase();
            return role !== "superadmin";
        },
    },
    lastLogin: { type: Date },
    // Single-device session control. Any new login rotates this value.
    activeSessionId: { type: String, default: "" },
    // Firebase Cloud Messaging token for push notifications
    fcmToken: {
        type: String,
        trim: true,
        sparse: true, // Allow multiple users to not have token
        index: true, // Index for quick lookups
    },
    // Per-login notification session id (rotated on every app login)
    // Used to prevent stale notifications after logout/login cycles.
    fcmSessionId: { type: String, default: "" },
    fcmSessionUpdatedAt: { type: Date },
    // When FCM token was last updated/validated
    fcmTokenUpdatedAt: { type: Date },
    // Legacy Expo push token (kept for backward compatibility / fallback delivery)
    pushToken: {
        type: String,
        trim: true,
        sparse: true,
        index: true,
    },
    lastTokenUpdate: { type: Date },
    // Notification preferences per user
    notificationPreferences: {
        dailyReminder: { type: Boolean, default: true },
        followUpReminders: { type: Boolean, default: true },
        voiceNotifications: { type: Boolean, default: true },
        voiceLang: { type: String, enum: ["en", "ta"], default: "en" },
        audioType: {
            type: String,
            enum: ["pre_recorded", "tts"],
            default: "pre_recorded",
        },
        updatedAt: { type: Date, default: Date.now },
    },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

userSchema.index({ role: 1 });

// Ensure email uniqueness within a company (multi-tenant)
userSchema.index(
    { company_id: 1, email: 1 },
    {
        unique: true,
        partialFilterExpression: {
            company_id: { $exists: true },
            email: { $exists: true },
        },
    },
);

// Ensure superadmin email is unique globally
userSchema.index(
    { email: 1, role: 1 },
    { unique: true, partialFilterExpression: { role: "superadmin" } },
);

// Frequent tenant lookup
userSchema.index({ company_id: 1 });
// Fast active-staff listing (used by every communication/team query)
userSchema.index({ company_id: 1, status: 1 });
userSchema.index({ company_id: 1, role: 1, status: 1 });

userSchema.pre("save", async function () {
    this.updatedAt = new Date();

    if (!this.isModified("password")) return;

    const raw = String(this.password || "");
    const looksHashed = /^\$2[aby]\$\d{2}\$/.test(raw);
    if (!looksHashed) {
        this.password = await bcrypt.hash(raw, 10);
    }
    this.passwordChangedAt = new Date();
});

const User = mongoose.models.User || mongoose.model("User", userSchema);

const ensureScopedUserIndexes = async () => {
    try {
        if (mongoose.connection.readyState !== 1) return;
        const indexes = await User.collection.indexes();

        if (indexes.some((idx) => idx.name === "email_1")) {
            await User.collection.dropIndex("email_1").catch(() => {});
        }

        await User.syncIndexes().catch(() => {});
    } catch (_error) {
        // ignore startup index migration issues
    }
};

if (mongoose.connection.readyState === 1) {
    ensureScopedUserIndexes();
} else {
    mongoose.connection.once("connected", ensureScopedUserIndexes);
}

module.exports = User;
