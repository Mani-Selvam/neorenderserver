const BASE_CHANNEL_IDS = {
    default: "default_v5",
    followups: "followups_v4",
    followups_soon_en: "followups_soon_en_v2",
    followups_due_en: "followups_due_en_v2",
    followups_missed_en: "followups_missed_en_v2",
    followups_soon_ta: "followups_soon_ta_v2",
    followups_due_ta: "followups_due_ta_v2",
    followups_missed_ta: "followups_missed_ta_v2",
    enquiries: "enquiries_v4",
    coupons: "coupons_v4",
    team_chat: "team_chat_v1",
    billing: "billing_v4",
    reports: "reports_v1",
};

const resolveAndroidChannelId = (channelKey = "default") => {
    const raw = String(channelKey || "").trim();
    if (!raw) return BASE_CHANNEL_IDS.default;

    // Already resolved (native channel id)
    if (/_v\d+$/i.test(raw)) return raw;

    // Explicit base mappings
    if (BASE_CHANNEL_IDS[raw]) return BASE_CHANNEL_IDS[raw];

    // ✅ FIX: Minute + due/missed channels — NO _v2 suffix
    // These match exactly what's defined in app.config.js notificationChannels
    const minute = raw.match(
        /^(followups|phone|meeting|email|whatsapp)_(60|5|4|3|2|1)min_(en|ta)$/i,
    );
    if (minute) {
        const t = minute[1].toLowerCase();
        const m = minute[2];
        const l = minute[3].toLowerCase();
        return `${t}_${m}min_${l}`;
    }

    const dueMissed = raw.match(
        /^(followups|phone|meeting|email|whatsapp)_(due|missed)_(en|ta)$/i,
    );
    if (dueMissed) {
        const t = dueMissed[1].toLowerCase();
        const s = dueMissed[2].toLowerCase();
        const l = dueMissed[3].toLowerCase();
        return `${t}_${s}_${l}`;
    }

    // Fallback: use the provided value (may still be a valid channel id)
    return raw;
};

module.exports = { resolveAndroidChannelId };