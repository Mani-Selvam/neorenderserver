/**
 * Notification Router - FIX #27
 * Single source of truth for notification delivery method
 * Routes to Firebase (production) or Expo (development) based on NODE_ENV
 */

const firebaseNotificationService = require("./firebaseNotificationService");
const BACKEND_NOTIFICATIONS = require("../BACKEND_NOTIFICATIONS");

/**
 * Select the appropriate notification service based on environment
 * @param {string} environment - "production" or "development"
 * @returns {object} Notification service (Firebase or Expo)
 */
const selectNotificationService = (environment) => {
    const env = String(
        environment || process.env.NODE_ENV || "development",
    ).toLowerCase();

    if (env === "production") {
        console.log("[NotifRouter] Selected: Firebase Cloud Messaging (FCM)");
        return firebaseNotificationService;
    } else {
        console.log("[NotifRouter] Selected: Expo Notifications");
        return BACKEND_NOTIFICATIONS;
    }
};

/**
 * Get the current notification mode (for logging and debugging)
 * @returns {string} "firebase" or "expo"
 */
const getNotificationMode = () => {
    const env = String(process.env.NODE_ENV || "development").toLowerCase();
    return env === "production" ? "firebase" : "expo";
};

/**
 * Send notification using the appropriate service
 * @param {object} payload - Notification payload
 * @param {string} userId - User ID to send notification to
 * @param {object} options - Additional options
 * @returns {Promise}
 */
const sendNotification = async (payload, userId, options = {}) => {
    const service = selectNotificationService();
    const mode = getNotificationMode();

    try {
        console.log(`[NotifRouter] Sending via ${mode}: ${userId}`);

        if (mode === "firebase") {
            // Firebase: requires fcmToken from user
            return await service.sendNotification(payload, userId, options);
        } else {
            // Expo: requires expoPushToken from user
            return await service.sendNotification(payload, userId, options);
        }
    } catch (error) {
        console.error(
            `[NotifRouter] Error sending ${mode} notification:`,
            error.message,
        );
        throw error;
    }
};

/**
 * Send batch notifications to multiple users
 * @param {object} payload - Notification payload
 * @param {array} userIds - Array of user IDs
 * @param {object} options - Additional options
 * @returns {Promise}
 */
const sendBatchNotifications = async (payload, userIds, options = {}) => {
    const service = selectNotificationService();
    const mode = getNotificationMode();

    try {
        console.log(
            `[NotifRouter] Batch sending via ${mode}: ${userIds.length} users`,
        );

        if (mode === "firebase") {
            return await service.sendToUsers(userIds, payload, options);
        } else {
            return await service.sendToMultipleUsers(userIds, payload, options);
        }
    } catch (error) {
        console.error(
            `[NotifRouter] Error batch sending ${mode} notifications:`,
            error.message,
        );
        throw error;
    }
};

/**
 * Send follow-up reminder notification
 * @param {object} followUp - Follow-up object
 * @param {object} options - Additional options
 * @returns {Promise}
 */
const sendFollowUpReminder = async (followUp, options = {}) => {
    const service = selectNotificationService();
    const mode = getNotificationMode();

    try {
        console.log(
            `[NotifRouter] Sending follow-up reminder via ${mode}: ${followUp._id}`,
        );

        if (mode === "firebase" && service.sendFollowUpReminder) {
            return await service.sendFollowUpReminder(followUp, options);
        } else if (mode === "expo" && service.sendFollowUpReminder) {
            return await service.sendFollowUpReminder(followUp, options);
        } else {
            console.warn(
                `[NotifRouter] Service does not have sendFollowUpReminder method`,
            );
            return null;
        }
    } catch (error) {
        console.error(
            `[NotifRouter] Error sending follow-up reminder via ${mode}:`,
            error.message,
        );
        throw error;
    }
};

module.exports = {
    selectNotificationService,
    getNotificationMode,
    sendNotification,
    sendBatchNotifications,
    sendFollowUpReminder,
};