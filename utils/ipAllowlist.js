const normalizeIp = (raw) => {
  const ip = String(raw || "").trim();
  if (!ip) return "";
  if (ip === "::1") return "127.0.0.1";
  if (ip.startsWith("::ffff:")) return ip.slice("::ffff:".length);
  return ip;
};

const getClientIp = (req) => {
  const trustProxy = String(process.env.TRUST_PROXY || "").toLowerCase() === "true";
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const raw =
      typeof forwarded === "string" ? forwarded.split(",")[0] : Array.isArray(forwarded) ? forwarded[0] : "";
    const ip = normalizeIp(raw);
    if (ip) return ip;
  }

  return normalizeIp(req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress);
};

const isValidIpv4 = (ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);

const ipv4ToInt = (ip) => {
  if (!isValidIpv4(ip)) return null;
  const parts = ip.split(".").map((x) => Number(x));
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return (
    ((parts[0] << 24) >>> 0) +
    ((parts[1] << 16) >>> 0) +
    ((parts[2] << 8) >>> 0) +
    (parts[3] >>> 0)
  ) >>> 0;
};

const cidrMatchIpv4 = (ip, cidr) => {
  const [base, maskRaw] = String(cidr || "").split("/");
  const maskBits = Number(maskRaw);
  if (!Number.isInteger(maskBits) || maskBits < 0 || maskBits > 32) return false;
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null) return false;
  const mask = maskBits === 0 ? 0 : ((0xffffffff << (32 - maskBits)) >>> 0);
  return (ipInt & mask) === (baseInt & mask);
};

const parseAllowlist = (raw) =>
  String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const isIpAllowed = (ip, allowlistRaw) => {
  const candidate = normalizeIp(ip);
  if (!candidate) return false;
  const rules = Array.isArray(allowlistRaw) ? allowlistRaw : parseAllowlist(allowlistRaw);
  if (!rules.length) return true;

  for (const rule of rules) {
    if (!rule) continue;
    if (rule.includes("/")) {
      if (cidrMatchIpv4(candidate, rule)) return true;
      continue;
    }
    if (normalizeIp(rule) === candidate) return true;
  }

  return false;
};

module.exports = {
  getClientIp,
  isIpAllowed,
  parseAllowlist,
};

