import { NextFunction, Request, Response } from "express";
import fs from "fs";
import multer from "multer";
import path from "path";
import logger from "../utils/logger";

const uploadDir = path.join(
	__dirname,
	"../../uploads",
);

if (!fs.existsSync(uploadDir)) {
	fs.mkdirSync(uploadDir, { recursive: true });
	logger.info(
		`Created uploads directory: ${uploadDir}`,
	);
}

const storage = multer.diskStorage({
	destination: (_req, _file, cb) => {
		cb(null, uploadDir);
	},
	filename: (_req, file, cb) => {
		const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
		const ext = path.extname(file.originalname);
		const baseName = path.basename(
			file.originalname,
			ext,
		);
		cb(null, `${baseName}-${uniqueSuffix}${ext}`);
	},
});

export const UNSUPPORTED_DOCUMENT_FILE_MESSAGE =
	"Unsupported file type. Only PDF, DOC, DOCX, XLS, XLSX, CSV, and TXT files are allowed.";

type SupportedDocumentExtension =
	| ".pdf"
	| ".doc"
	| ".docx"
	| ".xls"
	| ".xlsx"
	| ".csv"
	| ".txt";

const ALLOWED_DOCUMENT_MIME_BY_EXTENSION: Record<SupportedDocumentExtension, string[]> = {
	".pdf": ["application/pdf"],
	".doc": ["application/msword"],
	".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
	".xls": ["application/vnd.ms-excel"],
	".xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
	".csv": ["text/csv"],
	".txt": ["text/plain"],
};

const isAllowedDocumentFile = (file: Express.Multer.File): boolean => {
	const extension = path.extname(file.originalname).toLowerCase() as SupportedDocumentExtension;
	const allowedMimeTypes = ALLOWED_DOCUMENT_MIME_BY_EXTENSION[extension];
	if (!allowedMimeTypes) return false;
	return allowedMimeTypes.includes(file.mimetype);
};

const fileFilter = (
	req: Request,
	file: Express.Multer.File,
	cb: multer.FileFilterCallback,
) => {
	if (isAllowedDocumentFile(file)) {
		cb(null, true);
	} else {
		logger.warn("Invalid document upload attempt", {
			userId: (req as any).user?.id,
			filename: file.originalname,
			mimetype: file.mimetype,
			fieldName: file.fieldname,
			ipAddress: req.ip,
		});
		const error = new Error(UNSUPPORTED_DOCUMENT_FILE_MESSAGE) as Error & {
			statusCode?: number;
			code?: string;
		};
		error.statusCode = 400;
		error.code = "UNSUPPORTED_FILE_TYPE";
		cb(error);
	}
};

const imageFileFilter = (
	_req: Request,
	file: Express.Multer.File,
	cb: multer.FileFilterCallback,
) => {
	const allowedTypes = [
		"image/png",
		"image/jpeg",
		"image/webp",
	];

	if (allowedTypes.includes(file.mimetype)) {
		cb(null, true);
		return;
	}

	cb(
		new Error(
			`Invalid image type. Allowed types: PNG, JPG, WEBP. Received: ${file.mimetype}`,
		),
	);
};

export const upload = multer({
	storage,
	fileFilter,
	limits: {
		fileSize: 10 * 1024 * 1024, // 10MB per file
		files: 10, // Maximum 10 files at once
		fields: 20, // Maximum 20 non-file fields
		fieldSize: 1 * 1024 * 1024, // 1MB per field value
		fieldNameSize: 100, // 100 bytes max field name
		headerPairs: 2000, // Max header key-value pairs
	},
});

const toUploadErrorResponse = (error: unknown): { statusCode: number; message: string } => {
	if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "UNSUPPORTED_FILE_TYPE") {
		return {
			statusCode: 400,
			message: UNSUPPORTED_DOCUMENT_FILE_MESSAGE,
		};
	}

	if (error instanceof multer.MulterError) {
		switch (error.code) {
			case "LIMIT_FILE_SIZE":
				return { statusCode: 400, message: "File size exceeds 10MB limit." };
			case "LIMIT_FILE_COUNT":
				return { statusCode: 400, message: "Too many files uploaded. Maximum 10 files are allowed." };
			case "LIMIT_UNEXPECTED_FILE":
				return { statusCode: 400, message: "Unexpected file field in upload request." };
			default:
				return { statusCode: 400, message: error.message || "Invalid upload request." };
		}
	}

	if (error instanceof Error) {
		return {
			statusCode: 400,
			message: error.message || "Invalid upload request.",
		};
	}

	return {
		statusCode: 500,
		message: "Failed to process upload request.",
	};
};

const runUploadMiddleware =
	(
		handler: (req: Request, res: Response, cb: (error?: unknown) => void) => void,
	) =>
	(req: Request, res: Response, next: NextFunction): void => {
		handler(req, res, (error?: unknown) => {
			if (!error) {
				next();
				return;
			}

			const maybeFiles = req.files;
			const filesToCleanup: Express.Multer.File[] = [];
			if (Array.isArray(maybeFiles)) {
				filesToCleanup.push(...maybeFiles);
			} else if (maybeFiles && typeof maybeFiles === "object") {
				Object.values(maybeFiles).forEach((entry) => {
					if (Array.isArray(entry)) {
						filesToCleanup.push(...entry);
					}
				});
			}
			if (req.file) {
				filesToCleanup.push(req.file);
			}
			filesToCleanup.forEach((file) => {
				if (!file?.path || !fs.existsSync(file.path)) {
					return;
				}
				try {
					fs.unlinkSync(file.path);
				} catch (cleanupError) {
					logger.warn("Failed to cleanup rejected upload file", {
						filePath: file.path,
						error: cleanupError,
					});
				}
			});

			const { statusCode, message } = toUploadErrorResponse(error);
			res.status(statusCode).json({
				success: false,
				error: message,
			});
		});
	};

export const uploadSingleDocument = runUploadMiddleware(upload.single("document"));
export const uploadMultipleDocuments = runUploadMiddleware(upload.array("documents", 10));

export const imageUpload = multer({
	storage: multer.memoryStorage(),
	fileFilter: imageFileFilter,
	limits: {
		fileSize: 5 * 1024 * 1024,
		files: 1,
		fields: 10,
		fieldSize: 1 * 1024 * 1024,
		fieldNameSize: 100,
		headerPairs: 2000,
	},
});
