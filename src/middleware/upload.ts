import multer from "multer";
import path from "path";
import fs from "fs";
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

const fileFilter = (
	_req: any,
	file: Express.Multer.File,
	cb: multer.FileFilterCallback,
) => {
	const allowedTypes = [
		"application/pdf",
		"application/msword",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"text/csv",
		"application/vnd.ms-excel",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		"text/plain",
	];

	const allowedExtensions = [
		".pdf",
		".doc",
		".docx",
		".csv",
		".xls",
		".xlsx",
		".txt",
	];

	const ext = path
		.extname(file.originalname)
		.toLowerCase();

	if (
		allowedTypes.includes(file.mimetype) ||
		allowedExtensions.includes(ext)
	) {
		cb(null, true);
	} else {
		cb(
			new Error(
				`Invalid file type. Allowed types: PDF, Word (doc/docx), Excel (xls/xlsx), CSV, TXT. Received: ${file.mimetype}`,
			),
		);
	}
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
