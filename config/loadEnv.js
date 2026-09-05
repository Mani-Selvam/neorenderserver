const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

let loaded = false;

const candidateEnvPaths = () => {
    const rootEnv = path.resolve(__dirname, "../../.env");
    const serverEnv = path.resolve(__dirname, "../.env");
    const cwdEnv = path.resolve(process.cwd(), ".env");

    return [...new Set([rootEnv, serverEnv, cwdEnv])];
};

const ensureEnvLoaded = () => {
    if (loaded) return;

    for (const envPath of candidateEnvPaths()) {
        if (!fs.existsSync(envPath)) continue;
        dotenv.config({ path: envPath });
        loaded = true;

        if (process.env.JWT_SECRET) return;
    }
};

// FIX #27: Detect NODE_ENV from .env or EAS build profile
const detectNodeEnv = () => {
    // First check explicit NODE_ENV in .env
    if (process.env.NODE_ENV) {
        return String(process.env.NODE_ENV).toLowerCase();
    }

    // Fallback: detect from EAS_BUILD_PROFILE
    const easProfile = String(
        process.env.EAS_BUILD_PROFILE || "",
    ).toLowerCase();
    if (easProfile === "production") {
        return "production";
    }
    if (easProfile === "preview" || easProfile === "development") {
        return "development";
    }

    // Default to development if nothing specified
    return "development";
};

const setNodeEnv = () => {
    if (!process.env.NODE_ENV) {
        process.env.NODE_ENV = detectNodeEnv();
    }
};

module.exports = { ensureEnvLoaded, detectNodeEnv, setNodeEnv };
