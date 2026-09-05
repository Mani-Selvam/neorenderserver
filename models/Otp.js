const mongoose = require("mongoose");

const otpSchema = new mongoose.Schema({
    identifier: { 
        type: String, 
        required: true, 
        index: true,
        trim: true,
        lowercase: true 
    }, // Can be email or mobile number
    otp: { 
        type: String, 
        required: true 
    },
    expiresAt: { 
        type: Date, 
        required: true, 
        index: { expires: 0 } // Automatically delete when document expires
    },
    createdAt: { 
        type: Date, 
        default: Date.now 
    }
});

const Otp = mongoose.models.Otp || mongoose.model("Otp", otpSchema);

module.exports = Otp;
