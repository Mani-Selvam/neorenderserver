const mongoose = require("mongoose");

const connectDB = async () => {
    try {
        // Try MongoDB Atlas first
        const mongoURI = process.env.MONGODB_URI;

        const conn = await mongoose.connect(mongoURI, {
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
            maxPoolSize: 100, // Allow 100 concurrent requests to prevent bottleneck
            minPoolSize: 10, // Keep 10 connections always warm
            compressors: ["zlib"], // Compress data over network (huge for Atlas cloud)
        });

        console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
        return true;
    } catch (atlasError) {
        console.warn(
            `⚠️  MongoDB Atlas connection failed: ${atlasError.message}`,
        );

        // Fallback to local MongoDB
        try {
            console.log("Attempting to connect to local MongoDB...");
            const conn = await mongoose.connect("mongodb://127.0.0.1:27017/crm_db", {
                serverSelectionTimeoutMS: 5000,
            });
            console.log(`✅ Local MongoDB Connected: ${conn.connection.host}`);
            return true;
        } catch (localError) {
            console.error(`❌ Both MongoDB Atlas and Local MongoDB failed`);
            console.error(`Atlas Error: ${atlasError.message}`);
            console.error(`Local Error: ${localError.message}`);
            console.log("\n⚠️  Running without database connection. Please:");
            console.log("   1. Start local MongoDB: mongodb");
            console.log("   2. Or check MongoDB Atlas credentials");
            console.log("   3. Or set MONGODB_URI environment variable");
            return false;
        }
    }
};

module.exports = connectDB;
