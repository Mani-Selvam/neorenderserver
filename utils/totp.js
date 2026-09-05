const crypto = require("crypto");

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const base32ToBuffer = (input) => {
  const raw = String(input || "").toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  if (!raw) return Buffer.alloc(0);

  let bits = 0;
  let value = 0;
  const out = [];

  for (const ch of raw) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(out);
};

const bufferToBase32 = (buf) => {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (!bytes.length) return "";

  let bits = 0;
  let value = 0;
  let output = "";

  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
};

const generateSecretBase32 = (bytes = 20) => bufferToBase32(crypto.randomBytes(bytes));

const hotp = ({ secretBase32, counter, digits = 6 }) => {
  const key = base32ToBuffer(secretBase32);
  const ctr = Buffer.alloc(8);
  ctr.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(ctr).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const mod = 10 ** digits;
  return String(code % mod).padStart(digits, "0");
};

const totp = ({ secretBase32, time = Date.now(), stepSeconds = 30, digits = 6 }) => {
  const counter = Math.floor(Number(time) / 1000 / stepSeconds);
  return hotp({ secretBase32, counter, digits });
};

const verifyTotp = ({
  secretBase32,
  token,
  window = 1,
  stepSeconds = 30,
  digits = 6,
  time = Date.now(),
} = {}) => {
  const normalized = String(token || "").replace(/\s+/g, "");
  if (!/^\d{6,8}$/.test(normalized)) return false;
  const counter = Math.floor(Number(time) / 1000 / stepSeconds);
  for (let i = -Math.abs(window); i <= Math.abs(window); i += 1) {
    const expected = hotp({ secretBase32, counter: counter + i, digits });
    if (expected === normalized) return true;
  }
  return false;
};

const buildTotpOtpAuthUrl = ({ issuer, label, secretBase32, digits = 6, stepSeconds = 30 } = {}) => {
  const safeIssuer = encodeURIComponent(String(issuer || "NeoApp"));
  const safeLabel = encodeURIComponent(String(label || "NeoApp"));
  const safeSecret = encodeURIComponent(String(secretBase32 || ""));
  return `otpauth://totp/${safeIssuer}:${safeLabel}?secret=${safeSecret}&issuer=${safeIssuer}&algorithm=SHA1&digits=${digits}&period=${stepSeconds}`;
};

module.exports = {
  generateSecretBase32,
  verifyTotp,
  buildTotpOtpAuthUrl,
};

