import { Request, Response } from "express";
import {
	coercePlanType,
	isUnlimited,
} from "../config/planConfig";
import { documentParserService } from "../services/documentParserService";
import { pineconeService } from "../services/pineconeService";
import logger from "../utils/logger";

export const uploadDocument = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const userId = (req as any).user?.id;
		const planType = coercePlanType(
			(req as any).user?.plan_type,
		);

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

		// Enforce plan-based document limit for new uploads
		const documentUsage =
			await pineconeService.getDocumentUsageStats(
				userId,
				planType,
			);
		if (documentUsage.isAtLimit) {
			logger.warn(
				"User has reached document training limit",
				{
					userId,
					planType,
					documentsUsed:
						documentUsage.documentsUsed,
					documentsLimit:
						documentUsage.documentsLimit,
				},
			);
			res.status(403).json({
				success: false,
				message: `You've reached your document training limit. ${planType} plan allows ${documentUsage.documentsLimit ?? "unlimited"} documents.`,
				data: {
					planType:
						documentUsage.planType,
					documentsUsed:
						documentUsage.documentsUsed,
					documentsLimit:
						documentUsage.documentsLimit,
					documentsRemaining:
						documentUsage.documentsRemaining,
					upgradeUrl:
						planType === "free"
							? "/api/auth/upgrade"
							: undefined,
					upgradeMessage:
						planType === "free"
							? "Upgrade to Basic plan for 10 document uploads"
							: "You have reached the maximum limit for Basic plan",
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
		const updatedUsage =
			await pineconeService.getDocumentUsageStats(
				userId,
				planType,
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
				usage: {
					documentsUsed:
						updatedUsage.documentsUsed,
					documentsLimit:
						updatedUsage.documentsLimit,
					documentsRemaining:
						updatedUsage.documentsRemaining,
				},
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
		const planType =
			coercePlanType(
				(req as any).user?.plan_type,
			);

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

		const initialUsage =
			await pineconeService.getDocumentUsageStats(
				userId,
				planType,
			);
		let documentsUsed =
			initialUsage.documentsUsed;
		const documentsLimit =
			initialUsage.documentsLimit;
		const results: Array<{
			filename: string;
			success: boolean;
			chunks?: number;
			error?: string;
			alreadyUploaded?: boolean;
			existingChunks?: number;
			limitExceeded?: boolean;
			upgradeRequired?: boolean;
		}> = [];

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

					if (
						documentsLimit !== null &&
						documentsUsed >= documentsLimit
					) {
					results.push({
						filename: file.originalname,
						success: false,
						error: `Document limit reached (${documentsLimit} max for ${planType} plan)`,
						limitExceeded: true,
						upgradeRequired:
							planType === "free",
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
				documentsUsed += 1;

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
		const limitExceededCount = results.filter(
			(r) => r.limitExceeded,
		).length;
			const finalDocumentsRemaining = isUnlimited(
				documentsLimit,
			)
				? null
				: Math.max(
						0,
						(documentsLimit ?? 0) -
							documentsUsed,
				  );
		const limitExceededMessage =
				limitExceededCount > 0
					? ` ${limitExceededCount} file(s) were skipped because your ${planType} plan allows only ${documentsLimit ?? "unlimited"} documents.`
					: "";

		res.status(200).json({
			success: true,
			message: `Processed ${successCount} out of ${files.length} files successfully.${limitExceededMessage}`,
			data: {
				totalFiles: files.length,
				successCount,
				failedCount: files.length - successCount,
				documentUsage: {
					planType,
					documentsUsed,
					documentsLimit,
					documentsRemaining:
						finalDocumentsRemaining,
						isAtLimit:
							isUnlimited(documentsLimit)
								? false
								: documentsUsed >=
								  (documentsLimit ?? 0),
				},
				upgradeUrl:
					planType === "free" &&
					limitExceededCount > 0
						? "/api/auth/upgrade"
						: undefined,
				upgradeMessage:
					planType === "free" &&
					limitExceededCount > 0
						? "Upgrade to Basic plan for up to 10 document uploads"
						: undefined,
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
