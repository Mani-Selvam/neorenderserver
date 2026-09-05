const crypto = require("crypto");
const mongoose = require("mongoose");

const slugifyCompanyName = (value) =>
  String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

const CompanySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // human-readable ordered code like CRM-001, CRM-002
    code: { type: String, trim: true, uppercase: true },
    domain: { type: String, trim: true, lowercase: true },
    status: {
      type: String,
      enum: ["Active", "Suspended", "Cancelled"],
      default: "Active",
    },
    plan: {
      type: {
        type: String,
        enum: ["Starter", "Growth", "Business"],
        default: "Starter",
      },
      staffLimit: { type: Number, default: 5 },
      billingCustomerId: { type: String },
      nextBillingDate: { type: Date },
    },
    publicForm: {
      enabled: { type: Boolean, default: true },
      slug: { type: String, trim: true, lowercase: true },
      token: { type: String, trim: true },
      title: { type: String, trim: true },
      description: { type: String, trim: true },
      defaultSource: { type: String, trim: true, default: "Public Form" },
      successMessage: {
        type: String,
        trim: true,
        default: "Thanks for your enquiry. Our team will contact you soon.",
      },
    },
    whatsappTemplate: {
      enabled: { type: Boolean, default: false },
      url: { type: String, trim: true },
      token: { type: String, trim: true },
      name: { type: String, trim: true },
      language: { type: String, trim: true, default: "en" },
      buttonIndex: { type: Number, default: 0},
      disableEnvFallback: { type: Boolean, default: false },
    },
    assistantUsage: {
      yearlyUsed: { type: Number, default: 0 },
      extraPurchased: { type: Number, default: 0 }
    },
    settings: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

CompanySchema.index(
  { name: 1 },
  { unique: true, partialFilterExpression: { name: { $exists: true } } },
);
CompanySchema.index({ code: 1 }, { unique: true, sparse: true });
CompanySchema.index({ "publicForm.slug": 1 }, { unique: true, sparse: true });

// Auto-generate an ordered code like CRM-001 when creating a new company if not supplied.
CompanySchema.pre("validate", async function () {
  if (this.code) return;

  const Company = this.constructor;
  // Find last company with CRM-### pattern and increment the numeric part
  const last = await Company.find({ code: { $regex: "^CRM-\\d{3}$" } })
    .sort({ code: -1 })
    .limit(1)
    .lean();
  let nextNum = 1;
  if (last && last.length > 0 && last[0].code) {
    const m = last[0].code.match(/CRM-(\d{3})/);
    if (m && m[1]) {
      nextNum = parseInt(m[1], 10) + 1;
    }
  }
  const padded = String(nextNum).padStart(3, "0");
  this.code = `CRM-${padded}`;
});

CompanySchema.pre("validate", async function ensurePublicFormIdentity() {
  if (!this.publicForm) this.publicForm = {};

  if (!this.publicForm.token) {
    this.publicForm.token = crypto.randomBytes(18).toString("hex");
  }

  if (!this.publicForm.title) {
    this.publicForm.title = `${this.name || "Company"} Enquiry Form`;
  }

  if (!this.publicForm.description) {
    this.publicForm.description =
      "Fill out this form and our team will contact you shortly.";
  }

  if (this.publicForm.slug) return;

  const Company = this.constructor;
  const baseSlug =
    slugifyCompanyName(this.name) ||
    slugifyCompanyName(this.domain) ||
    slugifyCompanyName(this.code) ||
    `company-${String(this._id || "").slice(-6)}`;

  let candidate = baseSlug || `company-${crypto.randomBytes(3).toString("hex")}`;
  let attempt = 0;

  while (attempt < 10) {
    const existing = await Company.findOne({
      _id: { $ne: this._id },
      "publicForm.slug": candidate,
    })
      .select("_id")
      .lean();
    if (!existing?._id) {
      this.publicForm.slug = candidate;
      return;
    }
    attempt += 1;
    candidate = `${baseSlug}-${attempt + 1}`;
  }

  this.publicForm.slug = `${baseSlug}-${crypto.randomBytes(2).toString("hex")}`;
});

module.exports = mongoose.model("Company", CompanySchema);
