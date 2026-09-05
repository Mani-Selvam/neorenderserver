const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
const { ensureEnvLoaded } = require("./loadEnv");

ensureEnvLoaded();

// Initialize Firebase Admin SDK
// Ideally, set GOOGLE_APPLICATION_CREDENTIALS environment variable to point to your serviceAccountKey.json
// Or provide the path directly here if testing locally.

const buildCredential = () => {
    const hasServiceAccountJson = Boolean(
        process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
        process.env.FIREBASE_ADMIN_SA_JSON,
    );
    const hasGoogleApplicationCredentials = Boolean(
        process.env.GOOGLE_APPLICATION_CREDENTIALS,
    );
    const hasManualCredentials = Boolean(
        process.env.FIREBASE_PROJECT_ID &&
        process.env.FIREBASE_CLIENT_EMAIL &&
        process.env.FIREBASE_PRIVATE_KEY,
    );

    const configuredMethods = [];
    if (hasServiceAccountJson)
        configuredMethods.push("FIREBASE_SERVICE_ACCOUNT_JSON");
    if (hasGoogleApplicationCredentials)
        configuredMethods.push("GOOGLE_APPLICATION_CREDENTIALS");
    if (hasManualCredentials)
        configuredMethods.push(
            "FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY",
        );

    if (configuredMethods.length === 0) {
        throw new Error(
            "No Firebase Admin credential configured. Set exactly one of FIREBASE_SERVICE_ACCOUNT_JSON, GOOGLE_APPLICATION_CREDENTIALS, or FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY.",
        );
    }

    if (configuredMethods.length > 1) {
        throw new Error(
            `Multiple Firebase Admin credential methods configured: ${configuredMethods.join(", ")}. Use only one of FIREBASE_SERVICE_ACCOUNT_JSON, GOOGLE_APPLICATION_CREDENTIALS, or FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY.`,
        );
    }

    if (hasServiceAccountJson) {
        const rawJson =
            process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
            process.env.FIREBASE_ADMIN_SA_JSON;
        const parsed = JSON.parse(rawJson);
        if (parsed.private_key) {
            parsed.private_key = String(parsed.private_key).replace(
                /\\n/g,
                "\n",
            );
        }
        return admin.credential.cert(parsed);
    }

    if (hasGoogleApplicationCredentials) {
        const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
        const resolvedPath = path.resolve(serviceAccountPath);
        const serviceAccount = JSON.parse(
            fs.readFileSync(resolvedPath, "utf8"),
        );
        if (serviceAccount.private_key) {
            serviceAccount.private_key = String(
                serviceAccount.private_key,
            ).replace(/\\n/g, "\n");
        }
        return admin.credential.cert(serviceAccount);
    }

    return admin.credential.cert({
        project_id: process.env.FIREBASE_PROJECT_ID,
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        private_key: String(process.env.FIREBASE_PRIVATE_KEY).replace(
            /\\n/g,
            "\n",
        ),
    });
};

try {
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: buildCredential(),
        });
        console.log("[Firebase Admin] Initialized successfully.");
    }
} catch (error) {
    console.warn("[Firebase Admin] Initialization failed:", error.message);
    console.warn(
        "Set one of FIREBASE_SERVICE_ACCOUNT_JSON, GOOGLE_APPLICATION_CREDENTIALS, or FIREBASE_* credential vars.",
    );
}

module.exports = admin;
