const buildNotificationTitle = (title, actorName) => {
    const actor = String(actorName || "").trim();
    return actor ? `${actor} • ${title}` : title;
};

const _prefix = (name, actorName) => {
    const n = String(name || "Client").trim();
    const a = String(actorName || "").trim();
    // If we have an actor (Admin/Staff), show "Actor • Client"
    if (a) return `${a} • ${n}`;
    return n;
};

const soonTitle = (lang) => (lang === "ta" ? "விரைவில் பின்தொடரவும்" : "Follow-up soon");
const dueTitle = (lang) => (lang === "ta" ? "பின்தொடர்தல் நேரம்" : "Follow-up reminder");
const missedTitle = (lang) => (lang === "ta" ? "தவறிய பின்தொடர்தல்" : "Missed follow-up");

const getActivityLabel = (lang, type) => {
    const t = String(type || "").toLowerCase();
    if (lang === "ta") {
        if (t.includes("phone") || t.includes("call")) return "அழைப்பு";
        if (t.includes("whatsapp")) return "வாட்ஸ்அப்";
        if (t.includes("email") || t.includes("mail")) return "மின்னஞ்சல்";
        if (t.includes("meeting")) return "சந்திப்பு";
        return "பின்தொடர்பு";
    }
    return type || "Follow-up";
};

const soonBody = ({ lang, name, actorName, activityType, minutesLeft }) => {
    const prefix = _prefix(name, actorName);
    const activity = getActivityLabel(lang, activityType);
    const minTxt = minutesLeft === 1 ? (lang === "ta" ? "1 நிமிடம்" : "1 minute") : (lang === "ta" ? `${minutesLeft} நிமிடங்கள்` : `${minutesLeft} minutes`);
    
    if (lang === "ta") {
        return `${prefix} • ${activity} இன்னும் ${minTxt}ல். உங்கள் வாடிக்கையாளர் காத்திருக்கிறார். தயவுசெய்து அழைக்கவும்.`;
    }
    const waitingHint = minutesLeft <= 3 ? " Your customer is waiting. Please call now." : "";
    return `${prefix} • ${activity} in ${minTxt}.${waitingHint}`;
};

const dueBody = ({ lang, name, actorName, activityType, timeLabel }) => {
    const prefix = _prefix(name, actorName);
    const activity = getActivityLabel(lang, activityType);
    const timeBit = timeLabel ? (lang === "ta" ? `${timeLabel} மணிக்கு` : `at ${timeLabel}`) : "";
    
    if (lang === "ta") {
        return `${prefix} • ${activity} ${timeBit} இப்போது செய்யப்பட வேண்டும். உங்கள் வாடிக்கையாளர் காத்திருக்கிறார்.`;
    }
    return `${prefix} • ${activity} ${timeBit} is due now. Your customer is waiting. Please call ${name} now.`;
};

const missedBody = ({ lang, name, actorName, activityType, timeLabel }) => {
    const prefix = _prefix(name, actorName);
    const activity = getActivityLabel(lang, activityType);
    const timeBit = timeLabel ? (lang === "ta" ? `${timeLabel} மணிக்கு` : `at ${timeLabel}`) : "";
    
    if (lang === "ta") {
        return `${prefix} • ${activity} ${timeBit} தவறிவிட்டது. உங்கள் வாடிக்கையாளர் காத்திருக்கிறார். தயவுசெய்து இப்போது அழைக்கவும்.`;
    }
    return `${prefix} • ${activity} ${timeBit} was missed. You might have missed this. Your customer is waiting. Please call ${name} now.`;
};

module.exports = {
    getFollowUpSoonTexts: ({ lang, minutesLeft, name, actorName, activityType }) => ({
        title: buildNotificationTitle(soonTitle(lang), actorName),
        body: soonBody({ lang, name, actorName, activityType, minutesLeft }),
    }),
    getFollowUpDueTexts: ({ lang, name, actorName, activityType, timeLabel }) => ({
        title: buildNotificationTitle(dueTitle(lang), actorName),
        body: dueBody({ lang, name, actorName, activityType, timeLabel }),
    }),
    getFollowUpMissedTexts: ({ lang, name, actorName, activityType, timeLabel }) => ({
        title: buildNotificationTitle(missedTitle(lang), actorName),
        body: missedBody({ lang, name, actorName, activityType, timeLabel }),
    })
};
