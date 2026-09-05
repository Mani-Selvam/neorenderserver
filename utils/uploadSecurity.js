const path = require("path");

const sanitizeFilename = (value, fallback = "file") => {
  const base = String(value || fallback)
    .replace(/[^\w.\-() ]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return base || fallback;
};

const buildSafeUploadName = ({ prefix = "file", originalname = "", fallbackExt = "" }) => {
  const safeOriginal = sanitizeFilename(originalname, prefix);
  const ext = path.extname(safeOriginal).toLowerCase() || fallbackExt;
  const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  return `${prefix}-${uniqueSuffix}${ext}`;
};

const mimeMatches = (mimetype, allowedMimePatterns = []) =>
  allowedMimePatterns.some((pattern) =>
    pattern instanceof RegExp ? pattern.test(String(mimetype || "")) : pattern === mimetype,
  );

const extMatches = (originalname, allowedExtensions = []) => {
  const ext = path.extname(String(originalname || "")).toLowerCase();
  return allowedExtensions.includes(ext);
};

const createFileFilter = ({
  allowedMimePatterns = [],
  allowedExtensions = [],
  message = "Unsupported file type",
}) => {
  return (_req, file, cb) => {
    const safeMime = mimeMatches(file?.mimetype, allowedMimePatterns);
    const safeExt = extMatches(file?.originalname, allowedExtensions);
    if (safeMime && safeExt) return cb(null, true);
    return cb(new Error(message));
  };
};

module.exports = {
  sanitizeFilename,
  buildSafeUploadName,
  createFileFilter,
};
