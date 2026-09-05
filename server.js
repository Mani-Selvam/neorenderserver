const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const { setNodeEnv } = require("./config/loadEnv");
setNodeEnv(); // FIX #27: Set NODE_ENV from environment
const express = require("express");
const compression = require("compression");
const cors = require("cors");
const http = require("http");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const User = require("./models/User");

const connectDB = require("./config/db");
const { verifyToken } = require("./middleware/auth");
const { requireActivePlan, requireFeature } = require("./middleware/planGuard");

const corsOriginHandler = (origin, callback) => {
    return callback(null, true);
};

// Init App
const app = express();
if (String(process.env.TRUST_PROXY || "").toLowerCase() === "true") {
    app.set("trust proxy", true);
}
app.use(compression()); // Compress all responses
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: corsOriginHandler,
        methods: ["GET", "POST"],
        credentials: true,
    },
});

app.set("io", io);

app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=()",
    );
    if (String(process.env.ENABLE_HSTS || "").toLowerCase() === "true") {
        res.setHeader(
            "Strict-Transport-Security",
            "max-age=15552000; includeSubDomains",
        );
    }
    next();
});

app.use(
    cors({
        origin: corsOriginHandler,
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: [
            "Content-Type",
            "Authorization",
            "x-device-model",
            "x-device-name",
        ],
        credentials: true,
    }),
);

// Sockets Connection
io.use(async (socket, next) => {
    try {
        const rawToken =
            socket.handshake?.auth?.token ||
            socket.handshake?.headers?.authorization ||
            "";
        const token = String(rawToken)
            .replace(/^Bearer\s+/i, "")
            .trim();
        if (!token) {
            return next(new Error("Socket authentication required"));
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET, {
            algorithms: ["HS256"],
        });
        socket.data.userId = String(decoded.userId || "");
        socket.data.sessionId = String(decoded.sessionId || "");
        if (!socket.data.userId) {
            return next(new Error("Invalid socket token"));
        }
        if (!socket.data.sessionId) {
            return next(new Error("Invalid socket token"));
        }

        const user = await User.findById(socket.data.userId)
            .select("activeSessionId status")
            .lean();
        if (!user?._id) {
            return next(new Error("Invalid socket token"));
        }
        if (String(user.status || "") === "Inactive") {
            return next(new Error("Account inactive"));
        }
        if (
            !String(user.activeSessionId || "").trim() ||
            String(user.activeSessionId) !== socket.data.sessionId
        ) {
            console.log(
                `Session revoked for user ${socket.data.userId}: activeSessionId=${user.activeSessionId}, socketSessionId=${socket.data.sessionId}`,
            );
            return next(new Error("Session revoked"));
        }

        return next();
    } catch (_error) {
        return next(new Error("Invalid socket token"));
    }
});

io.on("connection", (socket) => {
    const userId = String(socket.data?.userId || "");

    if (userId) {
        const room = `user:${userId}`;
        socket.join(room);
        console.log(`Client connected: ${socket.id} joined ${room}`);
    } else {
        console.log("Client connected to socket without userId:", socket.id);
    }

    socket.on("join_user_room", (nextUserId) => {
        if (!nextUserId || String(nextUserId) !== userId) return;
        const room = `user:${userId}`;
        socket.join(room);
        console.log(`Socket ${socket.id} joined room ${room}`);
    });

    socket.on("disconnect", () => {
        console.log("Client disconnected");
    });
});

// Increase JSON body size limit for base64 images
// Razorpay webhooks require raw body for signature verification.
app.use(
    "/api/users/billing/razorpay/webhook",
    express.raw({ type: "application/json" }),
);
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

const withPlan = (featureName, bypassPrefixes = []) => {
    const bypass = Array.isArray(bypassPrefixes) ? bypassPrefixes : [];
    const feature = String(featureName || "").trim();

    return (req, res, next) => {
        const p = String(req.path || "");
        if (bypass.some((prefix) => p === prefix || p.startsWith(prefix))) {
            return next();
        }

        return verifyToken(req, res, () =>
            requireActivePlan(req, res, () =>
                requireFeature(feature)(req, res, next),
            ),
        );
    };
};

// Serve static files from uploads directory with tighter defaults.
app.use(
    "/uploads",
    express.static(path.join(__dirname, "uploads"), {
        dotfiles: "deny",
        index: false,
        fallthrough: false,
        setHeaders: (res) => {
            res.setHeader("Cache-Control", "public, max-age=3600");
            res.setHeader("X-Content-Type-Options", "nosniff");
            res.setHeader("Content-Disposition", "inline");
        },
    }),
);

// Routes
app.use("/api/auth", require("./routes/authRoutes"));
app.use("/api/support", require("./routes/supportRoutes"));
app.use("/public/forms", require("./routes/publicFormRoutes"));
app.use(
    "/api/enquiries",
    withPlan("enquiries"),
    require("./routes/enquiryRoutes"),
);
app.use(
    "/api/followups",
    withPlan("followups"),
    require("./routes/followupRoutes"),
);
app.use(
    "/api/dashboard",
    withPlan("enquiries"),
    require("./routes/dashboardRoutes"),
);
app.use("/api/reports", withPlan("reports"), require("./routes/reportRoutes"));
app.use(
    "/api/leadsources",
    withPlan("lead_sources"),
    require("./routes/leadSourceRoutes"),
);
app.use(
    "/api/products",
    withPlan("products"),
    require("./routes/productRoutes"),
);
app.use("/api/targets", withPlan("targets"), require("./routes/targetRoutes"));
app.use(
    "/api/communication",
    withPlan("team_chat"),
    require("./routes/communicationRoutes"),
);
app.use("/api/sms", require("./routes/smsQueueRoutes"));
app.use(
    "/api/staff",
    withPlan("staff_management"),
    require("./routes/staffRoutes"),
);
app.use(
    "/api/whatsapp",
    withPlan("whatsapp", ["/webhook", "/media"]),
    require("./routes/whatsappRoutes"),
);
app.use(
    "/api/messagetemplates",
    withPlan("whatsapp"),
    require("./routes/messageTemplateRoutes"),
);
app.use(
    "/api/official-templates",
    withPlan("whatsapp"),
    require("./routes/whatsappTemplateRoutes"),
);
app.use(
    "/api/email",
    withPlan("email", ["/track"]),
    require("./routes/emailRoutes"),
);
app.use("/api/users", require("./routes/userRoutes"));
app.use("/api/company", require("./routes/companyRoutes"));
app.use("/api/superadmin", require("./routes/superadmin.routes"));

app.use("/api/assistant", require("./routes/assistantRoutes"));
app.use("/api/lead", require("./routes/leadRoutes"));
app.use("/api/ai-payments", require("./routes/aiPaymentRoutes"));
app.use("/api/admin-staff-payment", require("./routes/adminStaffPaymentRoutes"));

app.get("/api/config", (req, res) => {
    res.json({
        playStoreSafeMode: String(process.env.EXPO_PUBLIC_PLAY_STORE_SAFE_MODE ?? "false").trim().toLowerCase() === "true"
    });
});

// Basic Route
app.get("/", (req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.send("CRM API with Socket.io is running...");
});

app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
});

const startServer = async () => {
    const PORT = process.env.PORT || process.env.API_PORT || 5000;

    try {
        const isConnected = await connectDB();

        if (isConnected) {
            const mongoose = require("mongoose");
            const warmStart = Date.now();
            await mongoose.connection.db.admin().ping();
            console.log(`⚡ MongoDB warm-up ping: ${Date.now() - warmStart}ms`);
        }

        // Initialize reminder scheduler for background notifications
        try {
            const reminderScheduler = require("./services/reminderScheduler");
            reminderScheduler.initializeReminderScheduler();
        } catch (schedulerErr) {
            console.warn(
                "[Server] Reminder scheduler initialization failed:",
                schedulerErr.message,
            );
        }
    } catch (e) {
        console.error("DB Connection failed:", e.message);
    }

    if (!server.listening) {
        server.listen(PORT, () => {
            // FIX #27: Log environment mode on startup
            const nodeEnv = String(
                process.env.NODE_ENV || "development",
            ).toLowerCase();
            const envLabel =
                nodeEnv === "production" ? "🚀 PRODUCTION" : "🔧 DEVELOPMENT";
            console.log(
                `${envLabel} - Server + Real-time engine started on port ${PORT}`,
            );
            console.log(
                `[Server] Using notification mode: ${nodeEnv === "production" ? "Firebase FCM" : "Expo Notifications"}`,
            );
        });
    }
};

startServer();
