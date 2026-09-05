/**
 * Security Alert Service
 * Sends notifications to old devices when account is accessed from new device
 */

const firebaseAdmin = require("../config/firebaseAdmin");
const User = require("../models/User");

/**
 * Send login alert to other devices
 * When user logs in from new device, notify old device(s)
 */
const sendLoginAlertToOtherDevices = async (userId, loginInfo = {}) => {
    try {
        if (!userId) {
            console.log("[SecurityAlert] No userId provided");
            return;
        }

        const {
            location = "Unknown location",
            deviceModel = "Unknown device",
            deviceName = "Unknown device",
            mobileNumber = "Unknown",
            currentSessionId = "",
            previousSessionId = "",
        } = loginInfo;

        const user = await User.findById(userId)
            .select("fcmToken fcmSessionId activeSessionId")
            .lean();

        if (!user) {
            console.log(`[SecurityAlert] User ${userId} not found`);
            return;
        }

        console.log(`[SecurityAlert] Checking alert for user ${userId}:`, {
            hasFcmToken: !!user.fcmToken,
            fcmSessionId: user.fcmSessionId?.substring(0, 8),
            activeSessionId: user.activeSessionId?.substring(0, 8),
            previousSessionId: String(previousSessionId || "").substring(0, 8),
            currentSessionId: String(currentSessionId || "").substring(0, 8),
        });

        // For single-device login, we only alert if the server rotated the session id.
        const prevSid = String(previousSessionId || "").trim();
        const nextSid = String(currentSessionId || "").trim();
        const isNewLogin = Boolean(prevSid) && Boolean(nextSid) && prevSid !== nextSid;

        // The token stored at login time belongs to the *previous* device because
        // the new device registers its FCM token only after login.
        const previousFcmToken = user.fcmToken;

        if (!isNewLogin) {
            console.log(
                `[SecurityAlert] No session rotation for user ${userId} - skipping alert`,
            );
            return;
        }

        if (!previousFcmToken) {
            console.log(
                `[SecurityAlert] No FCM token for user ${userId} - skipping`,
            );
            return;
        }

        // Format device info for the alert
        const deviceDisplay =
            deviceModel !== "Unknown device" ? deviceModel : deviceName;
        const fullDeviceInfo = `${deviceDisplay}${
            mobileNumber && mobileNumber !== "Unknown"
                ? ` (${mobileNumber})`
                : ""
        }`;

        const alertMessage = {
            token: previousFcmToken,
            notification: {
                title: "🔒 New Login Detected",
                body: `Your account was accessed from ${location} on ${fullDeviceInfo}`,
            },
            data: {
                type: "security_alert",
                alertType: "new_login",
                location: location,
                device: deviceDisplay,
                mobile: mobileNumber,
                newSessionId: nextSid,
                timestamp: String(Date.now()),
                persistent: "true", // ← App should keep this notification permanent
                dontAutoCancel: "true", // ← Don't auto-dismiss
                ongoing: "true", // ← Ongoing/sticky notification
            },
            android: {
                priority: "high",
                ttl: 604800, // ← 7 days (maximum persistence)
                notification: {
                    channelId: "security_alerts_v1",
                    sound: "default",
                    color: "#FF0000",
                    visibility: "public",
                    tag: `security_alert_${userId}`,
                },
            },
            apns: {
                headers: {
                    "apns-priority": "10",
                    "apns-expiration": String(
                        Math.floor(Date.now() / 1000) + 86400,
                    ),
                },
                payload: {
                    aps: {
                        sound: "default",
                        badge: 1,
                        mutableContent: true,
                        alert: {
                            title: "🔒 New Login Detected",
                            body: `Your account accessed from ${location}`,
                        },
                    },
                },
            },
        };

        // Send the alert
        await firebaseAdmin.messaging().send(alertMessage);

        console.log(
            `[SecurityAlert] ✅ Login alert sent to old device for user ${userId}:`,
            `Location: ${location}, Device: ${fullDeviceInfo}`,
        );

        return { success: true, alerted: true };
    } catch (error) {
        console.error(
            "[SecurityAlert] ❌ Failed to send login alert:",
            error?.code || error?.message || JSON.stringify(error),
        );
        if (error?.message) {
            console.error("[SecurityAlert] Full error:", error.message);
        }
        return { success: false, error: error?.message };
    }
};

/**
 * Get device info from request headers
 * Extracts location, device model, mobile info from user-agent and headers
 */
const extractDeviceInfo = (req) => {
    try {
        const userAgent = req.headers["user-agent"] || "";
        const deviceModel =
            String(req.headers["x-device-model"] || "").trim() ||
            String(req.headers["x-phone-model"] || "").trim() ||
            String(req.body?.deviceModel || "").trim() ||
            extractDeviceModel(userAgent);

        const deviceName =
            String(req.headers["x-device-name"] || "").trim() ||
            String(req.body?.deviceName || "").trim() ||
            extractDeviceName(userAgent);

        const location =
            String(req.headers["x-login-location"] || "").trim() ||
            String(req.body?.location || "").trim() ||
            extractLocationFromIP(req);

        const mobileNumber = extractMobileFromHeaders(req);

        return {
            location,
            deviceModel,
            deviceName,
            mobileNumber,
        };
    } catch (error) {
        console.error(
            "[SecurityAlert] Error extracting device info:",
            error?.message,
        );
        return {
            location: "Unknown location",
            deviceModel: "Unknown device",
            deviceName: "Unknown device",
            mobileNumber: "Unknown",
        };
    }
};

/**
 * Extract device model from user-agent
 */
const extractDeviceModel = (userAgent) => {
    // iPhone
    if (userAgent.includes("iPhone")) {
        const match = userAgent.match(/iPhone\s*OS\s*([0-9_]+)/);
        return match ? `iPhone (iOS ${match[1].replace(/_/g, ".")})` : "iPhone";
    }

    // iPad
    if (userAgent.includes("iPad")) {
        return "iPad";
    }

    // Android
    if (userAgent.includes("Android")) {
        const match = userAgent.match(/Android\s*([0-9.]+)/);
        return match ? `Android ${match[1]}` : "Android device";
    }

    // Samsung
    if (userAgent.includes("SM-")) {
        const match = userAgent.match(/SM-[A-Z0-9]+/);
        return match ? `Samsung ${match[0]}` : "Samsung device";
    }

    // Generic mobile
    if (userAgent.includes("Mobile")) {
        return "Mobile device";
    }

    // Desktop
    if (userAgent.includes("Windows")) {
        return "Windows PC";
    }
    if (userAgent.includes("Mac")) {
        return "Mac";
    }
    if (userAgent.includes("Linux")) {
        return "Linux";
    }

    return "Unknown device";
};

/**
 * Extract device name from user-agent
 */
const extractDeviceName = (userAgent) => {
    if (userAgent.includes("Chrome")) return "Chrome";
    if (userAgent.includes("Safari")) return "Safari";
    if (userAgent.includes("Firefox")) return "Firefox";
    if (userAgent.includes("Edge")) return "Edge";
    if (userAgent.includes("OPR")) return "Opera";
    return "Unknown app";
};

/**
 * Extract location from IP (basic - returns location if reverse DNS available)
 */
const extractLocationFromIP = (req) => {
    try {
        // Get IP
        let ip =
            req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
            req.ip ||
            req.connection.remoteAddress ||
            "Unknown";

        // Remove IPv6 prefix if present
        if (ip.includes("::ffff:")) {
            ip = ip.replace("::ffff:", "");
        }

        // For now, return IP. In production, use GeoIP service (MaxMind, etc)
        // to convert IP to city/country
        if (ip && ip !== "Unknown" && ip !== "::1") {
            return ip; // e.g., "203.0.113.45"
        }

        return "Unknown location";
    } catch (error) {
        return "Unknown location";
    }
};

/**
 * Extract mobile number from headers (client can send it)
 */
const extractMobileFromHeaders = (req) => {
    const mobile = req.headers["x-user-mobile"] || req.body?.mobile || "";
    return String(mobile).trim() || "Unknown";
};

module.exports = {
    sendLoginAlertToOtherDevices,
    extractDeviceInfo,
};
