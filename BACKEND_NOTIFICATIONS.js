// Backend Expo Notification Helper (Fallback for FCM)
// Sends notifications via Expo Push API if FCM fails

// ============================================
// HELPER FUNCTION: Send to Expo with Retry Logic
// ============================================

async function sendExpoNotification(
    pushToken,
    notification,
    priority = "default",
    maxRetries = 3,
    channelId = "followups_soon_en",
    sound = "default",
) {
    const { resolveAndroidChannelId } = require("./utils/notificationChannels");
    const resolvedChannelId = resolveAndroidChannelId(channelId);
    const MAX_RETRIES = maxRetries;
    const EXPONENTIAL_BACKOFF = [1000, 2000, 5000]; // ms delays between retries

    if (!pushToken || !String(pushToken).startsWith("ExponentPushToken[")) {
        console.warn(
            "[NotifSvc] ⚠ Invalid push token format:",
            pushToken?.substring?.(0, 30),
        );
        return null;
    }

    let lastError = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const message = {
                to: pushToken,
                sound: sound === "default" ? "default" : `${sound}.wav`,
                priority: priority,
                ...notification,
                channelId: resolvedChannelId || undefined,
            };

            console.log(
                `[NotifSvc] Sending notification (attempt ${attempt + 1}/${MAX_RETRIES + 1}):`,
                {
                    token: pushToken.substring(0, 30) + "...",
                    title: notification.title,
                    priority,
                },
            );

            const response = await fetch(
                "https://exp.host/--/api/v2/push/send",
                {
                    method: "POST",
                    headers: {
                        Accept: "application/json",
                        "Accept-encoding": "gzip, deflate",
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify(message),
                    timeout: 10000, // 10 second timeout
                },
            );

            const data = await response.json();

            if (data.errors) {
                const errorMsg = data.errors[0]?.message || "Unknown error";

                // Check for dead token errors
                if (
                    errorMsg.includes("InvalidCredentials") ||
                    errorMsg.includes("not a valid") ||
                    errorMsg.includes("Invalid")
                ) {
                    console.error(
                        `[NotifSvc] ✗ Dead/invalid token detected: ${pushToken.substring(0, 30)}...`,
                    );
                    console.error(`[NotifSvc] Error: ${errorMsg}`);
                    // Mark token as invalid in database
                    await markTokenAsDead(pushToken);
                    return null;
                }

                lastError = new Error(errorMsg);
                console.warn(
                    `[NotifSvc] ⚠ Expo API error (attempt ${attempt + 1}):`,
                    errorMsg,
                );

                // Retry on recoverable errors
                if (attempt < MAX_RETRIES) {
                    const delay = EXPONENTIAL_BACKOFF[attempt] || 5000;
                    console.log(`[NotifSvc] Retrying in ${delay}ms...`);
                    await new Promise((resolve) => setTimeout(resolve, delay));
                    continue;
                }

                throw lastError;
            }

            console.log(`[NotifSvc] ✓ Notification sent successfully:`, {
                id: data.data.id,
                token: pushToken.substring(0, 30) + "...",
                attempts: attempt + 1,
            });

            return data.data;
        } catch (error) {
            lastError = error;

            // Check for network errors (recoverable)
            if (
                error.code === "ECONNREFUSED" ||
                error.code === "ETIMEDOUT" ||
                error.code === "ENOTFOUND"
            ) {
                console.warn(
                    `[NotifSvc] ⚠ Network error (attempt ${attempt + 1}):`,
                    error.message,
                );

                if (attempt < MAX_RETRIES) {
                    const delay = EXPONENTIAL_BACKOFF[attempt] || 5000;
                    console.log(`[NotifSvc] Retrying in ${delay}ms...`);
                    await new Promise((resolve) => setTimeout(resolve, delay));
                    continue;
                }
            }

            console.error(
                `[NotifSvc] ✗ Error sending to Expo (attempt ${attempt + 1}):`,
                error?.message,
            );
        }
    }

    console.error(
        `[NotifSvc] ✗ Failed to send notification after ${MAX_RETRIES + 1} attempts:`,
        lastError?.message || "Unknown error",
        { token: pushToken.substring(0, 30) + "..." },
    );

    return null;
}

// Mark token as dead (invalid/expired)
async function markTokenAsDead(pushToken) {
    try {
        // Lazy load User model to avoid ES module conflicts
        const User = require("./models/User");

        // Find and update user with this token
        const user = await User.findOneAndUpdate(
            { pushToken },
            {
                pushToken: null,
                pushTokenUpdatedAt: new Date(),
            },
            { returnDocument: "after" },
        );
        if (user) {
            console.log(`[NotifSvc] ✓ Marked dead token for user ${user._id}`);
        }
    } catch (err) {
        console.error("[NotifSvc] Error marking token as dead:", err?.message);
    }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    sendExpoNotification,
};
