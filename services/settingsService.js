const Setting = require("../models/Setting");
const fs = require("fs");
const path = require("path");

const DEFAULT_USD_INR = 83;

const razorpayCache = {
  value: null,
  ts: 0,
  ttl: 60 * 1000,
};

const securityPolicyCache = {
  value: null,
  ts: 0,
  ttl: 60 * 1000,
};

const getUsdInrRate = async () => {
	  const doc = await Setting.findOneAndUpdate(
	    { key: "exchange_rates" },
	    {
	      $setOnInsert: {
	        key: "exchange_rates",
	        value: { USD_INR: DEFAULT_USD_INR },
	      },
	    },
	    { upsert: true, returnDocument: "after" },
	  ).lean();

  const rate = Number(doc?.value?.USD_INR);
  if (!Number.isFinite(rate) || rate <= 0) return DEFAULT_USD_INR;
  return rate;
};

const setUsdInrRate = async (rate) => {
  const next = Number(rate);
  if (!Number.isFinite(next) || next <= 0) {
    throw new Error("USD_INR rate must be a positive number");
  }

	  const doc = await Setting.findOneAndUpdate(
	    { key: "exchange_rates" },
	    { $set: { value: { USD_INR: next } } },
	    { upsert: true, returnDocument: "after", runValidators: true },
	  ).lean();

  return Number(doc?.value?.USD_INR);
};

const clearRazorpayCache = () => {
  razorpayCache.value = null;
  razorpayCache.ts = 0;
};

const readRazorpayFromDb = async () => {
  const doc = await Setting.findOne({ key: "razorpay" }).lean();
  const value = doc?.value || {};
  return {
    keyId: value.keyId || "",
    keySecret: value.keySecret || "",
    webhookSecret: value.webhookSecret || "",
    source: "db",
  };
};

const readRazorpayFromEnv = () => ({
  keyId: process.env.RAZORPAY_KEY_ID || "",
  keySecret: process.env.RAZORPAY_KEY_SECRET || "",
  webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || "",
  source: "env",
});

const mergeRazorpayConfig = ({ db, env }) => {
  const dbHasPair = Boolean(db?.keyId && db?.keySecret);
  const envHasPair = Boolean(env?.keyId && env?.keySecret);

  const pairSource = dbHasPair ? "db" : envHasPair ? "env" : "none";
  const merged = {
    keyId: pairSource === "db" ? db.keyId : pairSource === "env" ? env.keyId : "",
    keySecret: pairSource === "db" ? db.keySecret : pairSource === "env" ? env.keySecret : "",
    webhookSecret: db?.webhookSecret || env?.webhookSecret || "",
  };

  const sources = {
    keyPair: pairSource,
    keyId: pairSource,
    keySecret: pairSource,
    webhookSecret: db?.webhookSecret ? "db" : env?.webhookSecret ? "env" : "none",
  };

  const used = new Set(
    [pairSource, sources.webhookSecret].filter((source) => source && source !== "none"),
  );
  const source = used.size === 1 ? [...used][0] : used.size === 0 ? "none" : "mixed";

  return { ...merged, source, sources };
};

const getRazorpayConfig = async () => {
  const now = Date.now();
  if (razorpayCache.value && now - razorpayCache.ts < razorpayCache.ttl) {
    return razorpayCache.value;
  }

  const db = await readRazorpayFromDb();
  const env = readRazorpayFromEnv();

  // Priority: DB (settings form) per-field, fallback to env.
  const cfg = mergeRazorpayConfig({ db, env });
  razorpayCache.value = cfg;
  razorpayCache.ts = now;
  return cfg;
};

const setRazorpayConfig = async ({ keyId, keySecret, webhookSecret } = {}) => {
  const current = await readRazorpayFromDb();
  const next = {
    keyId: typeof keyId === "string" && keyId.trim() ? keyId.trim() : current.keyId,
    keySecret:
      typeof keySecret === "string" && keySecret.trim() ? keySecret.trim() : current.keySecret,
    webhookSecret:
      typeof webhookSecret === "string" && webhookSecret.trim()
        ? webhookSecret.trim()
        : current.webhookSecret,
  };

  await Setting.findOneAndUpdate(
    { key: "razorpay" },
    { $set: { key: "razorpay", value: next } },
    { upsert: true, returnDocument: "after", runValidators: true },
  ).lean();

  clearRazorpayCache();
  return next;
};

const setEnvFileValues = async (pairs) => {
  const envPath = path.join(__dirname, "../../.env");
  if (!fs.existsSync(envPath)) return { envWritten: false };

  const raw = fs.readFileSync(envPath, "utf8");
  const lines = raw.split(/\r?\n/);
  const keys = Object.keys(pairs || {});
  const present = new Set();

  const nextLines = lines.map((line) => {
    const trimmed = String(line || "").trim();
    const key = keys.find((k) => trimmed.startsWith(`${k}=`) || trimmed.startsWith(`${k} =`));
    if (!key) return line;
    present.add(key);
    return `${key}=${pairs[key]}`;
  });

  keys.forEach((key) => {
    if (present.has(key)) return;
    nextLines.push(`${key}=${pairs[key]}`);
  });

  fs.writeFileSync(envPath, nextLines.join("\n"), "utf8");
  return { envWritten: true };
};

const DEFAULT_SECURITY_POLICY = {
  enforceSuperadmin2fa: false,
  superadminSessionTimeoutMinutes: 30,
  restrictSuperadminLoginsByIp: false,
  superadminIpAllowlist: "",
  passwordMinLength: 8,
  passwordRotationDays: 90,
};

const DEFAULT_WORKSPACE = {
  name: "NeoApp Platform",
  supportEmail: "support@neoapp.com",
  defaultTimezone: "Asia/Kolkata",
};

const normalizeWorkspace = (value) => {
  const raw = value && typeof value === "object" ? value : {};
  return {
    name: String(raw.name || DEFAULT_WORKSPACE.name).trim() || DEFAULT_WORKSPACE.name,
    supportEmail: String(raw.supportEmail || DEFAULT_WORKSPACE.supportEmail).trim(),
    defaultTimezone: String(raw.defaultTimezone || DEFAULT_WORKSPACE.defaultTimezone).trim() || DEFAULT_WORKSPACE.defaultTimezone,
  };
};

const getWorkspaceSettings = async () => {
  const doc = await Setting.findOneAndUpdate(
    { key: "workspace" },
    { $setOnInsert: { key: "workspace", value: DEFAULT_WORKSPACE } },
    { upsert: true, returnDocument: "after" },
  ).lean();

  return normalizeWorkspace(doc?.value || DEFAULT_WORKSPACE);
};

const setWorkspaceSettings = async (updates = {}) => {
  const current = await getWorkspaceSettings();
  const next = normalizeWorkspace({ ...current, ...(updates || {}) });

  await Setting.findOneAndUpdate(
    { key: "workspace" },
    { $set: { key: "workspace", value: next } },
    { upsert: true, returnDocument: "after", runValidators: true },
  ).lean();

  return next;
};

const normalizeSecurityPolicy = (value) => {
  const raw = value && typeof value === "object" ? value : {};

  const enforceSuperadmin2fa = Boolean(raw.enforceSuperadmin2fa);
  const restrictSuperadminLoginsByIp = Boolean(raw.restrictSuperadminLoginsByIp);

  const stm = Number(raw.superadminSessionTimeoutMinutes);
  const superadminSessionTimeoutMinutes =
    Number.isFinite(stm) && stm >= 5 && stm <= 24 * 60 ? Math.floor(stm) : DEFAULT_SECURITY_POLICY.superadminSessionTimeoutMinutes;

  const minLen = Number(raw.passwordMinLength);
  const passwordMinLength =
    Number.isFinite(minLen) && minLen >= 8 && minLen <= 128 ? Math.floor(minLen) : DEFAULT_SECURITY_POLICY.passwordMinLength;

  const rot = Number(raw.passwordRotationDays);
  const passwordRotationDays =
    Number.isFinite(rot) && rot >= 0 && rot <= 3650 ? Math.floor(rot) : DEFAULT_SECURITY_POLICY.passwordRotationDays;

  const superadminIpAllowlist = String(raw.superadminIpAllowlist || "").trim();

  return {
    enforceSuperadmin2fa,
    superadminSessionTimeoutMinutes,
    restrictSuperadminLoginsByIp,
    superadminIpAllowlist,
    passwordMinLength,
    passwordRotationDays,
  };
};

const clearSecurityPolicyCache = () => {
  securityPolicyCache.value = null;
  securityPolicyCache.ts = 0;
};

const getSecurityPolicy = async () => {
  const now = Date.now();
  if (securityPolicyCache.value && now - securityPolicyCache.ts < securityPolicyCache.ttl) {
    return securityPolicyCache.value;
  }

  const doc = await Setting.findOneAndUpdate(
    { key: "security_policy" },
    { $setOnInsert: { key: "security_policy", value: DEFAULT_SECURITY_POLICY } },
    { upsert: true, returnDocument: "after" },
  ).lean();

  const policy = normalizeSecurityPolicy(doc?.value || DEFAULT_SECURITY_POLICY);
  securityPolicyCache.value = policy;
  securityPolicyCache.ts = now;
  return policy;
};

const setSecurityPolicy = async (updates = {}) => {
  const current = await getSecurityPolicy();
  const next = normalizeSecurityPolicy({ ...current, ...(updates || {}) });

  await Setting.findOneAndUpdate(
    { key: "security_policy" },
    { $set: { key: "security_policy", value: next } },
    { upsert: true, returnDocument: "after", runValidators: true },
  ).lean();

  clearSecurityPolicyCache();
  return next;
};

module.exports = {
  getUsdInrRate,
  setUsdInrRate,
  getWorkspaceSettings,
  setWorkspaceSettings,
  getSecurityPolicy,
  setSecurityPolicy,
  clearSecurityPolicyCache,
  getRazorpayConfig,
  setRazorpayConfig,
  clearRazorpayCache,
  setEnvFileValues,
};
