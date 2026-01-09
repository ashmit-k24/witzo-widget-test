require('dotenv').config();
const Redis = require("ioredis");

// Read config from env if possible, otherwise default locally
const host = process.env.REDIS_HOST || "localhost";
const port = process.env.REDIS_PORT || 6379;
const password = process.env.REDIS_PASSWORD || undefined;

console.log(`Connecting to Redis at ${host}:${port}...`);

const redis = new Redis({
    host,
    port,
    password
});

redis.on("error", (err) => {
    console.error("Redis connection error details:", err);
    // Don't exit immediately, let retries happen or timeout
});

async function fixRedisPolicy() {
    try {
        const currentPolicy = await redis.config("GET", "maxmemory-policy");
        console.log("Current Policy:", currentPolicy);
        
        console.log("Setting maxmemory-policy to noeviction...");
        await redis.config("SET", "maxmemory-policy", "noeviction");
        
        const newPolicy = await redis.config("GET", "maxmemory-policy");
        console.log("New Policy:", newPolicy);
        console.log("Successfully updated Redis eviction policy!");
        process.exit(0);
    } catch (error) {
        console.error("Failed to configure Redis:", error);
        process.exit(1);
    }
}

// Wait for connection
redis.on('connect', () => {
    console.log('Connected to Redis!');
    fixRedisPolicy();
});
