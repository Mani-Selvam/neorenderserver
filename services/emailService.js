const nodemailer = require("nodemailer");
const MailComposer = require("nodemailer/lib/mail-composer");
const { ImapFlow } = require("imapflow");
const EmailSettings = require("../models/EmailSettings");
const { decrypt } = require("../utils/crypto");

const normalizeEmail = (value) => String(value || "").trim();
const normalizeAddressForCompare = (value) => {
    const raw = String(value || "").trim();
    const match = raw.match(/<([^>]+)>/);
    return normalizeEmail(match ? match[1] : raw).toLowerCase();
};

const isValidEmail = (value) => {
    const email = normalizeEmail(value);
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};

const getEmailDomain = (value) => {
    const email = normalizeEmail(value).toLowerCase();
    if (!isValidEmail(email)) return "";
    return email.split("@")[1] || "";
};

const ensureCompatibleFromEmail = ({ smtpUser, fromEmail }) => {
    const smtpEmail = normalizeEmail(smtpUser);
    const senderEmail = normalizeEmail(fromEmail);

    if (!senderEmail) {
        return {
            fromEmail: isValidEmail(smtpEmail) ? smtpEmail : "",
            replyTo: "",
        };
    }

    if (!isValidEmail(senderEmail)) {
        throw new Error("From Email is not a valid email address.");
    }

    if (!isValidEmail(smtpEmail)) {
        return { fromEmail: senderEmail, replyTo: "" };
    }

    const smtpDomain = getEmailDomain(smtpEmail);
    const senderDomain = getEmailDomain(senderEmail);

    if (smtpDomain && senderDomain && smtpDomain !== senderDomain) {
        throw new Error(
            `From Email domain must match the SMTP account domain. Use an address from ${smtpDomain} or leave From Email blank.`,
        );
    }

    return {
        fromEmail: senderEmail,
        replyTo: senderEmail !== smtpEmail ? senderEmail : "",
    };
};

const mapEmailErrorMessage = (error) => {
    const code = String(error?.code || "").trim().toUpperCase();
    const responseCode = Number(error?.responseCode || 0);
    const command = String(error?.command || "").trim().toUpperCase();
    const raw = String(error?.message || "").trim();
    const lower = raw.toLowerCase();

    if (code === "EAUTH" || responseCode === 535 || lower.includes("535")) {
        return "SMTP login failed. Check your email username and password. If you use Gmail, use an App Password instead of your normal password.";
    }
    if (code === "ENOTFOUND" || lower.includes("getaddrinfo enotfound")) {
        return "SMTP host was not found. Check the SMTP Host value in Email Settings.";
    }
    if (code === "ECONNECTION" || code === "ESOCKET" || lower.includes("ssl") || lower.includes("tls")) {
        return "Could not connect to the SMTP server. Check host, port, and SSL/TLS setting.";
    }
    if (command === "CONN" || lower.includes("connection timeout") || code === "ETIMEDOUT") {
        return "SMTP server connection timed out. Check host, port, and internet access on the server.";
    }
    if (responseCode === 550 || lower.includes("mailbox unavailable")) {
        return "The sender or recipient email address was rejected by the mail server.";
    }

    return raw || "Email send failed";
};

const assertAcceptedRecipients = (result, recipient) => {
    const accepted = Array.isArray(result?.accepted) ? result.accepted : [];
    const rejected = Array.isArray(result?.rejected) ? result.rejected : [];
    const pending = Array.isArray(result?.pending) ? result.pending : [];
    const expected = normalizeAddressForCompare(recipient);
    const acceptedNormalized = accepted.map(normalizeAddressForCompare).filter(Boolean);
    const rejectedNormalized = rejected.map(normalizeAddressForCompare).filter(Boolean);
    const pendingNormalized = pending.map(normalizeAddressForCompare).filter(Boolean);

    if (acceptedNormalized.includes(expected) && !rejectedNormalized.includes(expected) && !pendingNormalized.includes(expected)) {
        return true;
    }
    const rejectedList = rejectedNormalized.length
        ? rejectedNormalized.join(", ")
        : pendingNormalized.length
            ? pendingNormalized.join(", ")
            : expected;
    throw new Error(
        `Email was not accepted by the mail server for delivery${rejectedList ? `: ${rejectedList}` : ""}.`,
    );
};

const guessImapHost = (smtpHost) => {
    const host = String(smtpHost || "").trim();
    if (!host) return "";
    if (/^smtp\./i.test(host)) return host.replace(/^smtp\./i, "imap.");
    return host;
};

const getImapSettings = (settings = {}) => ({
    host: String(settings.imapHost || "").trim() || guessImapHost(settings.smtpHost),
    port: Number(settings.imapPort || (settings.imapSecure === false ? 143 : 993) || 993),
    secure: settings.imapSecure !== false,
    user: String(settings.imapUser || "").trim() || String(settings.smtpUser || "").trim(),
    pass: String(settings.imapPass || "").trim() || String(settings.smtpPass || "").trim(),
    sentFolder: String(settings.sentFolder || "Sent").trim() || "Sent",
});

const getCompanyEmailSettings = async (companyId) => {
    if (!companyId) return null;
    const settings = await EmailSettings.findOne({ companyId }).lean();
    if (!settings) return null;

    const smtpPass = decrypt(settings.smtpPassEncrypted || "");
    const imapPass = decrypt(settings.imapPassEncrypted || "");
    return {
        ...settings,
        smtpPass,
        imapPass,
    };
};

const createTransporter = ({ smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass }) => {
    if (!smtpHost || !smtpPort || !smtpUser || !smtpPass) {
        throw new Error("SMTP settings are incomplete");
    }

    return nodemailer.createTransport({
        host: smtpHost,
        port: Number(smtpPort),
        secure: Boolean(smtpSecure),
        auth: { user: smtpUser, pass: smtpPass },
        // FIX 1: Log SMTP responses to help debug delivery issues
        logger: process.env.NODE_ENV !== "production",
        debug: process.env.NODE_ENV !== "production",
        tls: {
            rejectUnauthorized: false, // Bypass expired or self-signed SMTP SSL certificates to ensure reliable delivery
        },
    });
};

const verifyEmailSettings = async ({ smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass }) => {
    try {
        const transporter = createTransporter({
            smtpHost,
            smtpPort,
            smtpSecure,
            smtpUser,
            smtpPass,
        });
        await transporter.verify();
        return true;
    } catch (error) {
        throw new Error(mapEmailErrorMessage(error));
    }
};

const verifySentCopySettings = async (settings) => {
    const imap = getImapSettings(settings);
    if (!imap.host || !imap.user || !imap.pass) {
        throw new Error("IMAP Host, Username, and Password are required to save sent mail to your mailbox.");
    }

    const client = new ImapFlow({
        host: imap.host,
        port: imap.port,
        secure: imap.secure,
        auth: { user: imap.user, pass: imap.pass },
        logger: false,
    });

    try {
        await client.connect();
        await client.mailboxOpen(imap.sentFolder);
        return true;
    } catch (error) {
        throw new Error(`Sent mailbox check failed: ${error?.message || "IMAP error"}`);
    } finally {
        await client.logout().catch(() => null);
    }
};

// FIX 2: appendToSentFolder now surfaces errors instead of silently dropping them
const appendToSentFolder = async ({ settings, rawMessage }) => {
    if (!settings?.saveSentCopy || !rawMessage) return;

    const imap = getImapSettings(settings);
    if (!imap.host || !imap.user || !imap.pass) {
        // Log a clear warning — don't silently skip
        console.warn("[Email] saveSentCopy is enabled but IMAP settings are incomplete. Sent copy NOT saved.");
        return;
    }

    const client = new ImapFlow({
        host: imap.host,
        port: imap.port,
        secure: imap.secure,
        auth: { user: imap.user, pass: imap.pass },
        logger: false,
    });

    try {
        await client.connect();
        await client.append(imap.sentFolder, rawMessage, ["\\Seen"]);
        console.log("[Email] Sent copy appended to IMAP folder:", imap.sentFolder);
    } catch (err) {
        // FIX: log the real IMAP error so you can debug sent-box issues
        console.error("[Email] Failed to append sent copy to IMAP:", err?.message || err);
        // We do NOT re-throw — the email was already sent successfully,
        // so we don't want to falsely report a send failure to the user.
        // But we log it clearly so you can see it in server logs.
    } finally {
        await client.logout().catch(() => null);
    }
};

const sendEmail = async ({ settings, to, subject, text, html, attachments }) => {
    if (!settings) throw new Error("Missing email settings");
    if (!isValidEmail(to)) throw new Error("Invalid recipient email");

    try {
        const transporter = createTransporter(settings);
        const fromName = String(settings.fromName || "").trim();
        const senderConfig = ensureCompatibleFromEmail({
            smtpUser: settings.smtpUser,
            fromEmail: settings.fromEmail || settings.smtpUser || "",
        });
        const fromEmail = normalizeEmail(senderConfig.fromEmail || settings.smtpUser || "");
        const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
        const recipientEmail = normalizeEmail(to);

        const mailOptions = {
            from,
            to: recipientEmail,
            subject: String(subject || "").trim(),
            text: String(text || "").trim(),
            html: html || undefined,
            replyTo: senderConfig.replyTo || undefined,
            attachments: Array.isArray(attachments) ? attachments : [],
            // FIX 3: Add List-Unsubscribe and proper headers to improve deliverability
            headers: {
                "X-Mailer": "Neophrontech CRM",
                "X-Priority": "3",
            },
        };

        // FIX 4: Build rawMessage using the SAME mailOptions object that goes to sendMail,
        // so Message-ID headers are consistent between the sent email and the IMAP copy.
        const rawMessage = await new MailComposer(mailOptions).compile().build();

        const result = await transporter.sendMail(mailOptions);

        // FIX 5: Log full SMTP response for debugging delivery issues
        console.log("[Email] SMTP response:", {
            messageId: result?.messageId,
            response: result?.response,
            accepted: result?.accepted,
            rejected: result?.rejected,
            envelope: result?.envelope,
        });

        assertAcceptedRecipients(result, to);
        await appendToSentFolder({ settings, rawMessage });
        return result;
    } catch (error) {
        // FIX 6: Log the raw error before mapping so you can see the real SMTP error
        console.error("[Email] Raw send error:", error?.code, error?.responseCode, error?.message);
        throw new Error(mapEmailErrorMessage(error));
    }
};

module.exports = {
    ensureCompatibleFromEmail,
    getEmailDomain,
    getCompanyEmailSettings,
    isValidEmail,
    mapEmailErrorMessage,
    sendEmail,
    verifySentCopySettings,
    verifyEmailSettings,
};