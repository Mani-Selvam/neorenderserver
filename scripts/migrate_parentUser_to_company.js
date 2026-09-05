// Migrate parentUserId -> company_id
// Usage: from server/ run `node scripts/migrate_parentUser_to_company.js`
const mongoose = require("mongoose");
const path = require("path");
// Load project's root .env (script runs from server/ or workspace root)
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

// Prefer the same env var used by the server (`MONGODB_URI`) and fall back to older names
const MONGO_URI =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  process.env.DB_URI ||
  "mongodb://127.0.0.1:27017/mobile01";

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log("Connected to", MONGO_URI);

  const User = require("../models/User");
  const Company = require("../models/Company");

  // 1) Create companies for Admins that are missing company_id
  const admins = await User.find({ role: "Admin" }).lean();
  let created = 0;
  for (const admin of admins) {
    if (admin.company_id) continue;

    const domain =
      (admin.email || "").split("@")[1] ||
      `company-${admin._id.toString().slice(0, 6)}`;
    const name = admin.name || domain;

    // Try to find or create a company using domain (idempotent)
    let company = await Company.findOne({ domain });
    if (!company) {
      try {
        company = await Company.create({
          name,
          domain,
          plan: { type: "Starter", staffLimit: 5 },
        });
        created++;
        console.log(
          "Created company",
          company._id.toString(),
          "for admin",
          admin._id.toString(),
        );
      } catch (err) {
        console.error(
          "Failed creating company for admin",
          admin._id.toString(),
          err.message,
        );
        // try to lookup again in case of race/unique index
        company = await Company.findOne({ domain });
        if (!company) continue;
      }
    }

    // update admin to reference the new company
    await User.updateOne(
      { _id: admin._id },
      { $set: { company_id: company._id } },
    );
  }
  console.log("Companies created for admins:", created);

  // 2) Assign staff company_id based on parentUserId
  const staffs = await User.find({
    parentUserId: { $exists: true, $ne: null },
  }).lean();
  let assigned = 0,
    unresolved = 0;
  for (const s of staffs) {
    if (s.company_id) continue; // already set
    if (!s.parentUserId) {
      unresolved++;
      console.warn("Staff missing parentUserId", s._id.toString());
      continue;
    }

    const parent = await User.findById(s.parentUserId).lean();
    if (parent && parent.company_id) {
      await User.updateOne(
        { _id: s._id },
        { $set: { company_id: parent.company_id } },
      );
      assigned++;
    } else {
      // Parent missing or has no company_id — log for manual review
      unresolved++;
      console.warn(
        "Unresolved staff (parent missing or no company):",
        s._id.toString(),
      );
    }
  }
  console.log(
    "Staff assigned company_id:",
    assigned,
    "unresolved:",
    unresolved,
  );

  // Ensure all companies have a `code` assigned (CRM-001 style)
  const companiesWithoutCode = await Company.find({
    $or: [{ code: { $exists: false } }, { code: null }],
  }).lean();
  let codeAssigned = 0;
  for (const c of companiesWithoutCode) {
    try {
      const companyDoc = await Company.findById(c._id);
      if (companyDoc) {
        await companyDoc.validate(); // triggers pre-validate which sets code
        await companyDoc.save();
        codeAssigned++;
        console.log(
          "Assigned code to company",
          companyDoc._id.toString(),
          companyDoc.code,
        );
      }
    } catch (err) {
      console.warn(
        "Failed to assign code to company",
        c._id.toString(),
        err.message,
      );
    }
  }
  if (codeAssigned) console.log("Company codes assigned:", codeAssigned);

  // Optional: remove parentUserId field from documents (commented out — manual step)
  // await User.updateMany({ parentUserId: { $exists: true } }, { $unset: { parentUserId: '' } });

  await mongoose.disconnect();
  console.log("Migration complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
