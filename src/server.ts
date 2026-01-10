import cookieParser from "cookie-parser";
import cors from "cors";
import express, { Application, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { Server } from "http";
import { config } from "./config/env";
import passport, { configurePassport } from "./config/passport";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import publicRoutes from "./routes/publicRoutes";
import authRoutes from "./routes/routes";
import healthRoutes from "./routes/healthRoutes";
import authService from "./services/authService";
import widgetService from "./services/widgetService";
import logger from "./utils/logger";
import { createScraperWorker } from "./workers/scraperWorker";

// Start background workers
createScraperWorker();

const app: Application = express();

// Configure Passport
configurePassport();

// Security middleware with relaxed CSP for widget embedding
app.use(
     helmet({
          contentSecurityPolicy: {
               directives: {
                    defaultSrc: ["'self'"],
                    scriptSrc: ["'self'", "'unsafe-inline'"],
                    styleSrc: ["'self'", "'unsafe-inline'"],
                    imgSrc: ["'self'", "data:", "https:"],
                    connectSrc: ["'self'"],
                    fontSrc: ["'self'", "data:"],
                    objectSrc: ["'none'"],
                    mediaSrc: ["'self'"],
                    frameSrc: ["'self'"],
               },
          },
          crossOriginEmbedderPolicy: false,
          crossOriginOpenerPolicy: false,
          crossOriginResourcePolicy: { policy: "cross-origin" },
     })
);

// CORS configuration
app.use(
     cors({
          origin: config.CORS_ORIGIN || "*",
          credentials: true,
     })
);

// Cookie parser middleware
app.use(cookieParser(config.COOKIE_SECRET));

// Body parser
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));

// Initialize Passport middleware
app.use(passport.initialize());

// Global rate limiting
const limiter = rateLimit({
     windowMs: config.RATE_LIMIT_WINDOW_MS,
     max: config.RATE_LIMIT_MAX_REQUESTS,
     message: {
          success: false,
          message: "Too many requests from this IP, please try again later.",
     },
     standardHeaders: true,
     legacyHeaders: false,
});

app.use(limiter);

// Request logging middleware
app.use((req: Request, _res: Response, next) => {
     logger.debug("Incoming request", {
          method: req.method,
          path: req.path,
          ip: req.ip,
          userAgent: req.get("user-agent"),
     });
     next();
});

// Serve widget static files from public directory
app.use("/widget", express.static("public/widget"));

// Health check routes (no rate limiting for health checks)
app.use(healthRoutes);

// API routes
app.use("/api/auth", authRoutes);

// Public API routes (for widget embedding)
app.use("/api/v1", publicRoutes);

// 404 handler
app.use(notFoundHandler);

// Global error handler
app.use(errorHandler);

// Cleanup expired sessions and codes periodically
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
setInterval(() => {
     authService.cleanupExpired().catch((error: Error) => {
          logger.error("Scheduled cleanup failed", { error: error.message });
     });
}, CLEANUP_INTERVAL);

// Flush analytics buffer periodically (configurable for high-traffic scenarios)
setInterval(() => {
     widgetService.flushAnalytics().catch((error: Error) => {
          logger.error("Scheduled analytics flush failed", { error: error.message });
     });
}, config.ANALYTICS_FLUSH_INTERVAL_MS);

// Graceful shutdown
const gracefulShutdown = (server: Server) => {
     logger.info("Received shutdown signal, closing server gracefully...");

     server.close(() => {
          logger.info("Server closed");
          process.exit(0);
     });

     // Force shutdown after 10 seconds
     setTimeout(() => {
          logger.error("Forced shutdown after timeout");
          process.exit(1);
     }, 10000);
};

// Start server
const server: Server = app.listen(config.PORT, () => {
     logger.info(`Server running in ${config.NODE_ENV} mode on port ${config.PORT}`);
     console.log(`🚀 Server is running on http://localhost:${config.PORT}`);
});

// Handle graceful shutdown
process.on("SIGTERM", () => gracefulShutdown(server));
process.on("SIGINT", () => gracefulShutdown(server));

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason: Error, promise: Promise<any>) => {
     logger.error("Unhandled Rejection", { reason: reason.message, promise });
});

export default app;
