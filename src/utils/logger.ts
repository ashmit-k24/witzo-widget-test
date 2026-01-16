import path from "path";
import winston from "winston";
import { config } from "../config/env";
import { LoggerMeta } from "../types";

const logFormat = winston.format.combine(
	winston.format.timestamp({
		format: "YYYY-MM-DD HH:mm:ss",
	}),
	winston.format.errors({ stack: true }),
	winston.format.splat(),
	winston.format.json(),
);

const logger = winston.createLogger({
	level:
		config.NODE_ENV === "production"
			? "info"
			: "debug",
	format: logFormat,
	defaultMeta: { service: "witzo-ai" },
	transports: [
		// Console transport
		new winston.transports.Console({
			format: winston.format.combine(
				winston.format.colorize(),
				winston.format.simple(),
			),
		}),
		// Error log file
		new winston.transports.File({
			filename: path.join(
				__dirname,
				"../../logs/error.log",
			),
			level: "error",
		}),
		// Combined log file
		new winston.transports.File({
			filename: path.join(
				__dirname,
				"../../logs/combined.log",
			),
		}),
	],
});

// Create a typed logger interface
export interface Logger {
	error(message: string, meta?: LoggerMeta): void;
	warn(message: string, meta?: LoggerMeta): void;
	info(message: string, meta?: LoggerMeta): void;
	debug(message: string, meta?: LoggerMeta): void;
}

export default logger as Logger;
