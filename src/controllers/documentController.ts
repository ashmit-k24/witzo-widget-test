import { Request, Response } from "express";
import { documentParserService } from "../services/documentParserService";
import { pineconeService } from "../services/pineconeService";
import logger from "../utils/logger";

export const uploadDocument = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const userId = (req as any).user?.id;

		if (!userId) {
			res.status(401).json({
				success: false,
				message: "User not authenticated",
			});
			return;
		}

		if (!req.file) {
			res.status(400).json({
				success: false,
				message: "No file uploaded",
			});
			return;
		}

		const {
			path: filePath,
			originalname,
			size,
		} = req.file;

		// Check if document has already been uploaded for this user
		const documentUrl = `document://${originalname}`;
		const existingSource =
			await pineconeService.checkSourceExists(
				userId,
				documentUrl,
			);
		if (existingSource.exists) {
			logger.info(
				`Document already uploaded for user: ${userId}`,
				{
					filename: originalname,
					chunks: existingSource.chunks,
				},
			);
			res.status(409).json({
				success: false,
				message: `This document "${originalname}" has already been uploaded. We found ${existingSource.chunks} existing chunks from this file.`,
				data: {
					alreadyUploaded: true,
					filename: originalname,
					existingChunks: existingSource.chunks,
					uploadedAt: existingSource.scrapedAt,
				},
			});
			return;
		}

		logger.info(`Document upload started`, {
			userId,
			filename: originalname,
			size,
		});

		const result =
			await documentParserService.processAndStoreDocument(
				userId,
				filePath,
				originalname,
				size,
			);

		res.status(200).json({
			success: true,
			message: result.message,
			data: {
				filename: originalname,
				fileType:
					originalname.split(".").pop() ||
					"unknown",
				size,
				chunks: result.chunks,
				processedAt: new Date().toISOString(),
			},
		});
	} catch (error) {
		logger.error(
			"Error in uploadDocument controller",
			{ error },
		);
		res.status(500).json({
			success: false,
			message:
				"Internal server error while processing document",
			error:
				error instanceof Error
					? error.message
					: "Unknown error",
		});
	}
};

export const uploadMultipleDocuments = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const userId = (req as any).user?.id;

		if (!userId) {
			res.status(401).json({
				success: false,
				message: "User not authenticated",
			});
			return;
		}

		const files =
			req.files as Express.Multer.File[];

		if (!files || files.length === 0) {
			res.status(400).json({
				success: false,
				message: "No files uploaded",
			});
			return;
		}

		logger.info(
			`Multiple document upload started`,
			{
				userId,
				fileCount: files.length,
			},
		);

		const results = [];

		for (const file of files) {
			try {
				// Check if document has already been uploaded for this user
				const documentUrl = `document://${file.originalname}`;
				const existingSource =
					await pineconeService.checkSourceExists(
						userId,
						documentUrl,
					);
				if (existingSource.exists) {
					logger.info(
						`Document already uploaded for user: ${userId}`,
						{
							filename: file.originalname,
							chunks: existingSource.chunks,
						},
					);
					results.push({
						filename: file.originalname,
						success: false,
						error: `Document already uploaded (${existingSource.chunks} chunks exist)`,
						alreadyUploaded: true,
						existingChunks: existingSource.chunks,
					});
					continue;
				}

				const result =
					await documentParserService.processAndStoreDocument(
						userId,
						file.path,
						file.originalname,
						file.size,
					);

				results.push({
					filename: file.originalname,
					success: true,
					chunks: result.chunks,
				});
			} catch (error) {
				results.push({
					filename: file.originalname,
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Unknown error",
				});
			}
		}

		const successCount = results.filter(
			(r) => r.success,
		).length;

		res.status(200).json({
			success: true,
			message: `Processed ${successCount} out of ${files.length} files successfully`,
			data: {
				totalFiles: files.length,
				successCount,
				failedCount: files.length - successCount,
				results,
			},
		});
	} catch (error) {
		logger.error(
			"Error in uploadMultipleDocuments controller",
			{ error },
		);
		res.status(500).json({
			success: false,
			message:
				"Internal server error while processing documents",
			error:
				error instanceof Error
					? error.message
					: "Unknown error",
		});
	}
};
