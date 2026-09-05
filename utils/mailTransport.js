const nodemailer = require("nodemailer");

const parseBool = (value, fallback = false) => {
  if (typeof value === "boolean") return value;
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  return ["1", "true", "yes", "on"].includes(normalized);
};

const normalizeMailer = (value) => String(value || "").trim().toLowerCase();

const inferSecureFromEncryption = (value, fallback) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["ssl", "tls", "smtps"].includes(normalized)) return true;
  if (["starttls", "none", "false", "off"].includes(normalized)) return false;
  return fallback;
};

const getMailConfig = () => {
  const host = String(process.env.EMAIL_HOST || "").trim();
  const user = String(process.env.EMAIL_USER || "").trim();
  const pass = String(process.env.EMAIL_PASS || "").trim();
  const from = String(process.env.EMAIL_FROM || user).trim();
  const port = Number(process.env.EMAIL_PORT || (host ? 465 : 0));
  const mailer = normalizeMailer(process.env.EMAIL_MAILER || "smtp");
  const secure = (() => {
    const encryptionSecure = inferSecureFromEncryption(
      process.env.EMAIL_ENCRYPTION,
      port === 465,
    );
    if (String(process.env.EMAIL_SECURE || "").trim()) {
      return parseBool(process.env.EMAIL_SECURE, encryptionSecure);
    }
    return encryptionSecure;
  })();

  return {
    host,
    port,
    secure,
    user,
    pass,
    from,
    mailer,
  };
};

const hasRealCredentials = () => {
  const { host, port, user, pass, mailer } = getMailConfig();
  if (mailer && mailer !== "smtp") return false;
  if (!host || !port || !user || !pass) return false;
  if (user.startsWith("your_") || pass.startsWith("your_")) return false;
  return true;
};

const createTransporter = () => {
  const { host, port, secure, user, pass, mailer } = getMailConfig();
  if (mailer && mailer !== "smtp") {
    throw new Error(`Unsupported EMAIL_MAILER: ${mailer}`);
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user,
      pass,
    },
    tls: {
      rejectUnauthorized: false,
    },
  });
};

const verifyTransporter = async () => {
  const transporter = createTransporter();
  await transporter.verify();
  return true;
};

module.exports = {
  createTransporter,
  getMailConfig,
  hasRealCredentials,
  verifyTransporter,
};
