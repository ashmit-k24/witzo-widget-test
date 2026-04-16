import compression from "compression";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, {
	Application,
	Request,
	Response,
} from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { Server } from "http";
import { config } from "./config/env";
import passport, {
	configurePassport,
} from "./config/passport";
import {
	AUTH_CLEANUP_INTERVAL_MS,
	HUBSPOT_SYNC_PROCESS_INTERVAL_MS,
	RESPONSE_COMPRESSION_MIN_BYTES,
	SALESFORCE_SYNC_PROCESS_INTERVAL_MS,
	SERVER_HEADERS_TIMEOUT_MS,
	SERVER_KEEP_ALIVE_TIMEOUT_MS,
	SERVER_REQUEST_TIMEOUT_MS,
	SHUTDOWN_FORCE_TIMEOUT_MS,
	WEBHOOK_PROCESS_INTERVAL_MS,
	ZOHO_SYNC_PROCESS_INTERVAL_MS,
} from "./constants";
import { redisCache } from "./config/redis";
import {
	errorHandler,
	notFoundHandler,
} from "./middleware/errorHandler";
import { sanitizeRequestInput } from "./middleware/sanitizeInput";
import adminRoutes from "./routes/adminRoutes";
import healthRoutes from "./routes/healthRoutes";
import publicRoutes from "./routes/publicRoutes";
import authRoutes from "./routes/routes";
import adminAuthService from "./services/adminAuthService";
import authService from "./services/authService";
import { leadWebhookService } from "./services/leadWebhookService";
import { hubspotIntegrationService } from "./services/hubspotIntegrationService";
import { salesforceIntegrationService } from "./services/salesforceIntegrationService";
import { zohoIntegrationService } from "./services/zohoIntegrationService";
import widgetService from "./services/widgetService";
import logger from "./utils/logger";
import { createMaintenanceWorker } from "./workers/maintenanceWorker";
import { createScraperWorker } from "./workers/scraperWorker";

const isRateLimitExemptPath = (path: string): boolean => {
	const normalized = path.toLowerCase();
	return (
		normalized === "/api/auth/scraper/progress" ||
		/^\/api\/auth\/scraper\/progress\/[^/]+$/.test(
			normalized,
		)
	);
};

// Start background workers and keep references for graceful shutdown
const scraperWorker = createScraperWorker();
const maintenanceWorker = createMaintenanceWorker();

const app: Application = express();
// Trust the known proxy chain length; keeps IP-based rate limiting safe
// If you add more proxy hops (e.g., Cloudflare + Nginx), set RATE_LIMIT_TRUST_PROXY_HOPS accordingly.
const TRUSTED_PROXY_HOPS = config.RATE_LIMIT_TRUST_PROXY_HOPS ?? 1;
app.set("trust proxy", TRUSTED_PROXY_HOPS);

// Configure Passport
configurePassport();

// Security middleware with relaxed CSP for widget embedding
app.use(
	helmet({
		contentSecurityPolicy: {
			directives: {
				defaultSrc: ["'self'"],
				scriptSrc: ["'self'", "'unsafe-inline'", "https://assets.calendly.com"],
				styleSrc: [
					"'self'",
					"'unsafe-inline'",
					"https://fonts.googleapis.com",
					"https://assets.calendly.com",
				],
				imgSrc: ["'self'", "data:", "https:"],
				connectSrc: ["'self'", "https://calendly.com", "https://assets.calendly.com"],
				fontSrc: [
					"'self'",
					"data:",
					"https://fonts.gstatic.com",
				],
				objectSrc: ["'none'"],
				mediaSrc: ["'self'"],
				frameSrc: ["'self'", "https://calendly.com", "https://*.calendly.com"],
				frameAncestors: [
					"'self'",
					"http://localhost:*",
					"https://witzo.ai",
					"https://*.witzo.ai",
				],
			},
		},
		crossOriginEmbedderPolicy: false,
		crossOriginOpenerPolicy: false,
		crossOriginResourcePolicy: {
			policy: "cross-origin",
		},
	}),
);

// CORS configuration
const configuredOrigins = [
	config.CORS_ORIGIN,
	config.FRONTEND_URL,
	config.ADMIN_FRONTEND_URL,
]
	.filter((value): value is string =>
		Boolean(value),
	)
	.join(",");
const rawOrigins = configuredOrigins
	.split(",")
	.map((origin) => origin.trim())
	.filter(Boolean);
const hasWildcardOrigin =
	rawOrigins.includes("*");
const allowedOriginSet = new Set(
	rawOrigins
		.filter((origin) => origin !== "*")
		.map((origin) => origin.toLowerCase()),
);

if (hasWildcardOrigin) {
	logger.warn(
		'Ignoring CORS wildcard origin "*" because credentialed requests require explicit origins. Configure CORS_ORIGIN with a comma-separated allowlist instead.',
	);
}

app.use(
	cors((req: Request, callback) => {
		const requestPath = req.path.toLowerCase();
		const isPublicWidgetRoute =
			requestPath === "/api/v1" ||
			requestPath.startsWith("/api/v1/");

		if (isPublicWidgetRoute) {
			callback(null, {
				origin: true,
				credentials: false,
			});
			return;
		}

		callback(null, {
			origin: (origin, originCallback) => {
				if (!origin) {
					originCallback(null, true);
					return;
				}

				const normalizedOrigin =
					origin.toLowerCase();

				if (
					allowedOriginSet.has(normalizedOrigin)
				) {
					originCallback(null, true);
					return;
				}

				originCallback(
					new Error("Not allowed by CORS"),
				);
			},
			credentials: true,
		});
	}),
);

// Cookie parser middleware
app.use(cookieParser(config.COOKIE_SECRET));

// Body parser
app.use(
	express.json({
		limit: "10kb",
		verify: (
			req: Request & { rawBody?: string },
			_res,
			buffer,
		) => {
			req.rawBody = buffer.toString("utf-8");
		},
	}),
);
app.use(
	express.urlencoded({
		extended: true,
		limit: "10kb",
	}),
);
app.use(sanitizeRequestInput);

// Initialize Passport middleware
app.use(passport.initialize());

// Response compression — handles gzip/deflate, skips SSE streams automatically
app.use(
	compression({
		filter: (req, res) => {
			// Don't compress SSE streams
			if (
				res.getHeader("Content-Type") ===
				"text/event-stream"
			) {
				return false;
			}
			return compression.filter(req, res);
		},
		threshold: RESPONSE_COMPRESSION_MIN_BYTES,
	}),
);

// Global rate limiting — IP-based safety net for DDoS; applies only to /api routes.
// Limit is intentionally high (5x) since per-user limits on auth routes provide real throttling.
const limiter = rateLimit({
	windowMs: config.RATE_LIMIT_WINDOW_MS,
	max: config.RATE_LIMIT_MAX_REQUESTS * 5,
	message: {
		success: false,
		message:
			"Too many requests from this IP, please try again later.",
	},
	standardHeaders: true,
	legacyHeaders: false,
	skip: (req: Request) =>
		!req.path.startsWith("/api") ||
		isRateLimitExemptPath(req.path),
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

app.use(
	"/widget",
	express.static("public/widget", {
		setHeaders: (res, filePath) => {
			if (filePath.endsWith("witzo-chat.js")) {
				res.setHeader(
					"Cache-Control",
					"no-store, must-revalidate",
				);
				res.setHeader("Pragma", "no-cache");
				res.setHeader("Expires", "0");
			}
		},
	}),
);

// Serve shared assets (images, etc.)
app.use(
	"/assets",
	express.static("public/assets"),
);

// Health check routes (no rate limiting for health checks)
app.use(healthRoutes);

// API routes
app.use("/api/auth", authRoutes);

// Admin API routes
app.use("/api/admin", adminRoutes);

// Public API routes (for widget embedding)
app.use("/api/v1", publicRoutes);

// 404 handler
app.use(notFoundHandler);

// Global error handler
app.use(errorHandler);

// Cleanup expired sessions and codes periodically
setInterval(() => {
	authService
		.cleanupExpired()
		.catch((error: Error) => {
			logger.error("Scheduled cleanup failed", {
				error: error.message,
			});
		});
}, AUTH_CLEANUP_INTERVAL_MS);

// Flush analytics buffer periodically (configurable for high-traffic scenarios)
setInterval(() => {
	widgetService
		.flushAnalytics()
		.catch((error: Error) => {
			logger.error(
				"Scheduled analytics flush failed",
				{ error: error.message },
			);
		});
}, config.ANALYTICS_FLUSH_INTERVAL_MS);

// Process pending enterprise lead webhook deliveries
setInterval(() => {
	leadWebhookService
		.processPendingEvents()
		.catch((error: Error) => {
			logger.error(
				"Scheduled lead webhook processing failed",
				{ error: error.message },
			);
		});
}, WEBHOOK_PROCESS_INTERVAL_MS);

// Process pending HubSpot sync deliveries
setInterval(() => {
	hubspotIntegrationService
		.processPendingEvents()
		.catch((error: Error) => {
			logger.error(
				"Scheduled HubSpot sync processing failed",
				{ error: error.message },
			);
		});
}, HUBSPOT_SYNC_PROCESS_INTERVAL_MS);

// Process pending Zoho sync deliveries
setInterval(() => {
	zohoIntegrationService
		.processPendingEvents()
		.catch((error: Error) => {
			logger.error(
				"Scheduled Zoho sync processing failed",
				{ error: error.message },
			);
		});
}, ZOHO_SYNC_PROCESS_INTERVAL_MS);

// Process pending Salesforce sync deliveries
setInterval(() => {
	salesforceIntegrationService
		.processPendingEvents()
		.catch((error: Error) => {
			logger.error(
				"Scheduled Salesforce sync processing failed",
				{ error: error.message },
			);
		});
}, SALESFORCE_SYNC_PROCESS_INTERVAL_MS);

// Graceful shutdown
const gracefulShutdown = (server: Server) => {
	logger.info(
		"Received shutdown signal, closing server gracefully...",
	);

	// Force shutdown after timeout if clean shutdown stalls
	const forceTimer = setTimeout(() => {
		logger.error("Forced shutdown after timeout");
		process.exit(1);
	}, SHUTDOWN_FORCE_TIMEOUT_MS);
	forceTimer.unref(); // Don't keep the process alive just for this timer

	server.close(async () => {
		logger.info(
			"HTTP server closed, draining workers...",
		);
		try {
			await Promise.all([
				scraperWorker.close(),
				maintenanceWorker.close(),
			]);
			logger.info("BullMQ workers closed");
		} catch (err) {
			logger.error("Error closing workers", {
				error: (err as Error).message,
			});
		}
		logger.info("Shutdown complete");
		clearTimeout(forceTimer);
		process.exit(0);
	});
};

const flushChatCacheOnStartup = async (): Promise<void> => {
	const patterns = ["chat:semantic-answer:*", "chat:retrieval:*"];
	let total = 0;
	for (const pattern of patterns) {
		let cursor = "0";
		do {
			const [nextCursor, keys] = await redisCache.scan(cursor, "MATCH", pattern, "COUNT", 500);
			cursor = nextCursor;
			if (keys.length > 0) {
				await redisCache.del(...keys);
				total += keys.length;
			}
		} while (cursor !== "0");
	}
	if (total === 0) {
		logger.info("startup: chat cache was already empty — nothing cleared");
	} else {
		logger.info(`startup: chat cache cleared — ${total} key(s) deleted`);
	}
};

// Start server
const server: Server = app.listen(
	config.PORT,
	() => {
		logger.info(
			`Server running in ${config.NODE_ENV} mode on port ${config.PORT}`,
		);
		logger.info(
			`🚀 Server is running on http://localhost:${config.PORT}`,
		);
		void adminAuthService.initializeAdminAuth();
		void flushChatCacheOnStartup();
	},
);
server.keepAliveTimeout =
	SERVER_KEEP_ALIVE_TIMEOUT_MS;
server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;

// Handle graceful shutdown
process.on("SIGTERM", () =>
	gracefulShutdown(server),
);
process.on("SIGINT", () =>
	gracefulShutdown(server),
);

// Handle unhandled promise rejections
process.on(
	"unhandledRejection",
	(reason: Error, promise: Promise<any>) => {
		logger.error("Unhandled Rejection", {
			reason: reason.message,
			promise,
		});
	},
);

// Handle synchronous uncaught exceptions — log then exit so PM2 can restart
process.on(
	"uncaughtException",
	(error: Error) => {
		logger.error(
			"Uncaught Exception — process will exit",
			{
				error: error.message,
				stack: error.stack,
			},
		);
		process.exit(1);
	},
);

export default app;
