const axios = require("axios");
const { SIM_GATEWAY_URLS } = require("../config/smsGatewayConfig");

const parseGatewayList = () => {
  const normalizeBaseUrl = (input) => {
    let u = String(input || "").trim();
    if (!u) return "";
    u = u.replace(/\/+$/, "");
    // Allow users to mistakenly paste an endpoint; normalize to base server URL.
    if (u.toLowerCase().endsWith("/send-otp")) u = u.slice(0, -"/send-otp".length);
    if (u.toLowerCase().endsWith("/send-sms")) u = u.slice(0, -"/send-sms".length);
    return u.replace(/\/+$/, "");
  };

  const urls = (Array.isArray(SIM_GATEWAY_URLS) ? SIM_GATEWAY_URLS : [])
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .map((u) => normalizeBaseUrl(u))
    .filter(Boolean);

  return urls.map((baseUrl, idx) => ({
    id: `${idx + 1}`,
    baseUrl,
    cooldownUntil: 0,
    failures: 0,
    successes: 0,
    lastError: null,
  }));
};

let gateways = parseGatewayList();
let rrIndex = 0;

const queue = [];
let activeWorkers = 0;
const recentResults = [];
const RECENT_RESULTS_MAX = 50;

const MAX_CONCURRENCY = (() => {
  const n = Number(process.env.SMS_QUEUE_CONCURRENCY || 2);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2;
})();

const JOB_TIMEOUT_MS = (() => {
  const n = Number(process.env.SMS_QUEUE_JOB_TIMEOUT_MS || 15000);
  return Number.isFinite(n) && n >= 2000 ? Math.floor(n) : 15000;
})();

const RETRY_ROUNDS = (() => {
  const n = Number(process.env.SMS_QUEUE_RETRY_ROUNDS || 2);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2;
})();

const COOLDOWN_MS = (() => {
  const n = Number(process.env.SMS_QUEUE_GATEWAY_COOLDOWN_MS || 30000);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 30000;
})();

const HEALTHCHECK_ENABLED = String(process.env.SMS_GATEWAY_HEALTHCHECK || "true")
  .toLowerCase()
  .trim() !== "false";

const HEALTHCHECK_TTL_MS = (() => {
  const n = Number(process.env.SMS_GATEWAY_HEALTHCHECK_TTL_MS || 10000);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 10000;
})();

const refreshConfig = () => {
  gateways = parseGatewayList();
  rrIndex = 0;
};

const pickGateway = () => {
  if (!gateways.length) return null;

  const now = Date.now();
  const available = gateways.filter((g) => g.cooldownUntil <= now);
  const list = available.length ? available : gateways;

  rrIndex = (rrIndex + 1) % list.length;
  return list[rrIndex];
};

const markFailure = (gateway, err) => {
  gateway.failures += 1;
  gateway.lastError = err?.response?.data || err?.message || String(err || "");
  gateway.cooldownUntil = Date.now() + COOLDOWN_MS;
};

const markSuccess = (gateway) => {
  gateway.successes += 1;
  gateway.lastError = null;
  gateway.cooldownUntil = 0;
};

const healthCache = new Map(); // baseUrl -> { ok, at, error }

const checkHealth = async (gateway) => {
  if (!HEALTHCHECK_ENABLED) return { ok: true };

  const key = gateway.baseUrl;
  const cached = healthCache.get(key);
  const now = Date.now();
  if (cached && (now - cached.at) < HEALTHCHECK_TTL_MS) return cached;

  try {
    const resp = await axios.get(`${gateway.baseUrl}/health`, {
      timeout: Math.min(JOB_TIMEOUT_MS, 5000),
      validateStatus: () => true,
    });
    const ok =
      resp.status === 200 &&
      String(resp?.data?.status || "").toLowerCase() === "ok";

    const entry = ok
      ? { ok: true, at: now, error: null }
      : {
        ok: false,
        at: now,
        error: `healthcheck_failed status=${resp.status}`,
      };
    healthCache.set(key, entry);
    return entry;
  } catch (err) {
    const entry = {
      ok: false,
      at: now,
      error: err?.message || "healthcheck_error",
    };
    healthCache.set(key, entry);
    return entry;
  }
};

const sendViaGateway = async ({ gateway, phoneNumber, message }) => {
  const health = await checkHealth(gateway);
  if (!health.ok) {
    const e = new Error(
      `gateway_health_failed (${gateway.baseUrl}) ${health.error || ""}`.trim(),
    );
    e._smsQueueKind = "health";
    throw e;
  }

  const headers = { "Content-Type": "application/json" };

  const resp = await axios.post(
    `${gateway.baseUrl}/send-otp`,
    { phone: phoneNumber, message },
    { headers, timeout: JOB_TIMEOUT_MS, validateStatus: () => true },
  );

  const status = String(resp?.data?.status || "").toLowerCase();
  if (resp.status !== 200 || status !== "sent") {
    const ct = String(resp.headers?.["content-type"] || "");
    const snippet =
      typeof resp.data === "string"
        ? resp.data.slice(0, 160)
        : JSON.stringify(resp.data || {}).slice(0, 160);
    const e = new Error(
      `gateway_returned_failed (${gateway.baseUrl}) status=${resp.status} content-type=${ct} body=${snippet}`,
    );
    e._smsQueueKind = "send";
    throw e;
  }

  return true;
};

const runJob = async (job) => {
  if (!gateways.length) {
    return { ok: false, error: "Android SIM SMS gateway is not configured" };
  }

  const maxAttempts = Math.max(1, gateways.length * RETRY_ROUNDS);
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const gateway = pickGateway();
    if (!gateway) break;

    try {
      const ok = await sendViaGateway({
        gateway,
        phoneNumber: job.phoneNumber,
        message: job.message,
      });
      if (ok) {
        markSuccess(gateway);
        return { ok: true };
      }
      const e = new Error("gateway_returned_failed");
      markFailure(gateway, e);
      lastErr = e;
    } catch (err) {
      markFailure(gateway, err);
      lastErr = err;
    }
  }

  return {
    ok: false,
    error:
      lastErr?.response?.data ||
      lastErr?.message ||
      "All SMS gateways failed",
  };
};

const pump = async () => {
  if (activeWorkers >= MAX_CONCURRENCY) return;
  if (queue.length === 0) return;

  activeWorkers += 1;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const job = queue.shift();
      if (!job) return;

      // refresh config on each job so adding/removing gateways is instant after restart
      refreshConfig();

      const result = await runJob(job);
      recentResults.push({
        at: Date.now(),
        phoneNumber: job.phoneNumber,
        ok: Boolean(result.ok),
        error: result.ok ? null : result.error,
      });
      if (recentResults.length > RECENT_RESULTS_MAX) recentResults.shift();

      job.resolve(result);
    }
  } finally {
    activeWorkers -= 1;
    if (queue.length > 0) {
      setImmediate(() => pump());
    }
  }
};

const enqueueSms = ({ phoneNumber, message }) => {
  return new Promise((resolve) => {
    queue.push({ phoneNumber, message, resolve, createdAt: Date.now() });
    setImmediate(() => pump());
  });
};

const getStats = () => {
  return {
    queued: queue.length,
    workers: activeWorkers,
    recentResults,
    gateways: gateways.map((g) => ({
      id: g.id,
      baseUrl: g.baseUrl,
      cooldownUntil: g.cooldownUntil,
      failures: g.failures,
      successes: g.successes,
      lastError: g.lastError,
    })),
  };
};

module.exports = { enqueueSms, getStats, refreshConfig };
