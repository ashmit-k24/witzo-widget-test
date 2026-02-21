import cookieParser from "cookie-parser";
import cors from "cors";
import express, {
	Application,
	Request,
	Response,
} from "express";
import zlib from "zlib";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { Server } from "http";
import { config } from "./config/env";
import {
	AUTH_CLEANUP_INTERVAL_MS,
	RESPONSE_COMPRESSION_MIN_BYTES,
	SERVER_HEADERS_TIMEOUT_MS,
	SERVER_KEEP_ALIVE_TIMEOUT_MS,
	SERVER_REQUEST_TIMEOUT_MS,
	SHUTDOWN_FORCE_TIMEOUT_MS,
} from "./constants";
import passport, {
	configurePassport,
} from "./config/passport";
import {
	errorHandler,
	notFoundHandler,
} from "./middleware/errorHandler";
import { sanitizeRequestInput } from "./middleware/sanitizeInput";
import publicRoutes from "./routes/publicRoutes";
import authRoutes from "./routes/routes";
import healthRoutes from "./routes/healthRoutes";
import authService from "./services/authService";
import widgetService from "./services/widgetService";
import logger from "./utils/logger";
import { createScraperWorker } from "./workers/scraperWorker";
import { createMaintenanceWorker } from "./workers/maintenanceWorker";

// Start background workers
createScraperWorker();
createMaintenanceWorker();

const app: Application = express();
app.set("trust proxy", 1);

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
		crossOriginResourcePolicy: {
			policy: "cross-origin",
		},
	}),
);

// CORS configuration
const configuredOrigins = [
	config.CORS_ORIGIN,
	config.FRONTEND_URL,
]
	.filter((value): value is string =>
		Boolean(value),
	)
	.join(",");
const rawOrigins = configuredOrigins
	.split(",")
	.map((origin) => origin.trim())
	.filter(Boolean);
const allowAnyOrigin = rawOrigins.includes("*");
const allowedOriginSet = new Set(
	rawOrigins
		.filter((origin) => origin !== "*")
		.map((origin) => origin.toLowerCase()),
);

app.use(
	cors({
		origin: (origin, callback) => {
			if (!origin) {
				callback(null, true);
				return;
			}

			const normalizedOrigin =
				origin.toLowerCase();

			if (
				allowAnyOrigin ||
				allowedOriginSet.has(normalizedOrigin)
			) {
				callback(null, true);
				return;
			}

			callback(new Error("Not allowed by CORS"));
		},
		credentials: true,
	}),
);

// Cookie parser middleware
app.use(cookieParser(config.COOKIE_SECRET));

// Body parser
app.use(express.json({ limit: "10kb" }));
app.use(
	express.urlencoded({
		extended: true,
		limit: "10kb",
	}),
);
app.use(sanitizeRequestInput);

// Initialize Passport middleware
app.use(passport.initialize());

// Lightweight response compression for larger text/json payloads.
app.use((req: Request, res: Response, next) => {
	const acceptEncoding =
		(req.headers["accept-encoding"] as
			| string
			| undefined) ?? "";

	const originalSend = res.send.bind(res);
	(res as any).send = (body: any) => {
		if (
			res.getHeader("Content-Encoding") ||
			typeof body !== "string" ||
			body.length <
				RESPONSE_COMPRESSION_MIN_BYTES ||
			res.getHeader("Content-Type") ===
				"text/event-stream"
		) {
			return originalSend(body);
		}

		try {
			const raw = Buffer.from(body);
			let encoded: Buffer | null = null;

			if (acceptEncoding.includes("br")) {
				encoded =
					zlib.brotliCompressSync(raw);
				res.setHeader(
					"Content-Encoding",
					"br",
				);
			} else if (
				acceptEncoding.includes("gzip")
			) {
				encoded = zlib.gzipSync(raw);
				res.setHeader(
					"Content-Encoding",
					"gzip",
				);
			}

			if (!encoded) {
				return originalSend(body);
			}

			res.setHeader(
				"Vary",
				"Accept-Encoding",
			);
			res.setHeader(
				"Content-Length",
				String(encoded.length),
			);
			return res.end(encoded);
		} catch {
			return originalSend(body);
		}
	};

	next();
});

// Global rate limiting
const limiter = rateLimit({
	windowMs: config.RATE_LIMIT_WINDOW_MS,
	max: config.RATE_LIMIT_MAX_REQUESTS,
	message: {
		success: false,
		message:
			"Too many requests from this IP, please try again later.",
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
app.use(
	"/widget",
	express.static("public/widget"),
);

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

// Graceful shutdown
const gracefulShutdown = (server: Server) => {
	logger.info(
		"Received shutdown signal, closing server gracefully...",
	);

	server.close(() => {
		logger.info("Server closed");
		process.exit(0);
	});

	// Force shutdown after 10 seconds
	setTimeout(() => {
		logger.error("Forced shutdown after timeout");
		process.exit(1);
	}, SHUTDOWN_FORCE_TIMEOUT_MS);
};

// Start server
const server: Server = app.listen(
	config.PORT,
	() => {
		logger.info(
			`Server running in ${config.NODE_ENV} mode on port ${config.PORT}`,
		);
		console.log(
			`🚀 Server is running on http://localhost:${config.PORT}`,
		);
	},
);
server.keepAliveTimeout = SERVER_KEEP_ALIVE_TIMEOUT_MS;
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

export default app;
