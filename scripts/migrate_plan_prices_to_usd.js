const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

const connectDB = require("../config/db");
const Plan = require("../models/Plan");
const { getUsdInrRate } = require("../services/settingsService");

async function main() {
  await connectDB();

  const rate = await getUsdInrRate();

  const inrPlans = await Plan.find({ currency: "INR" }).select("_id basePrice").lean();
  let converted = 0;
  for (const p of inrPlans) {
    const usd = Number(p.basePrice || 0) / rate;
    await Plan.updateOne(
      { _id: p._id },
      { $set: { basePrice: Number(usd.toFixed(2)) }, $unset: { currency: "" } },
    );
    converted += 1;
  }

  const unsetUsd = await Plan.updateMany({ currency: "USD" }, { $unset: { currency: "" } });

  console.log("[migrate_plan_prices_to_usd] usd_inr_rate:", rate);
  console.log("[migrate_plan_prices_to_usd] converted INR->USD:", converted);
  console.log(
    "[migrate_plan_prices_to_usd] unset currency for USD plans:",
    unsetUsd.modifiedCount ?? unsetUsd.nModified ?? 0,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("[migrate_plan_prices_to_usd] failed:", e?.message || e);
  process.exit(1);
});

