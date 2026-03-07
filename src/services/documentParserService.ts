import ExcelJS from "exceljs";
import * as fs from "fs";
import mammoth from "mammoth";
import * as Papa from "papaparse";
import { ParsedDocument } from "../types";
import logger from "../utils/logger";
import { pineconeService } from "./pineconeService";

// Import pdf-parse v2 - uses PDFParse class
const { PDFParse } = require("pdf-parse");

class DocumentParserService {
	async parseDocument(
		filePath: string,
		filename: string,
		fileSize: number,
	): Promise<ParsedDocument> {
		const fileExtension = filename
			.split(".")
			.pop()
			?.toLowerCase();

		let content = "";
		const metadata: any = {
			fileType: fileExtension || "unknown",
			size: fileSize,
			uploadedAt: new Date().toISOString(),
		};

		try {
			switch (fileExtension) {
				case "pdf":
					content = await this.parsePDF(filePath);
					break;
				case "doc":
				case "docx":
					content =
						await this.parseWord(filePath);
					break;
				case "csv":
					content = await this.parseCSV(filePath);
					break;
				case "xlsx":
				case "xls":
					content =
						await this.parseExcel(filePath);
					break;
				case "txt":
					content =
						await this.parseText(filePath);
					break;
				default:
					throw new Error(
						`Unsupported file type: ${fileExtension}`,
					);
			}

			return {
				filename,
				content,
				metadata,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error
					? error.message
					: String(error);
			logger.error("Error parsing document", {
				error: errorMessage,
				errorStack:
					error instanceof Error
						? error.stack
						: undefined,
				filename,
				fileExtension,
				filePath,
			});
			throw error;
		}
	}

	private async parsePDF(
		filePath: string,
	): Promise<string> {
		try {
			const dataBuffer =
				fs.readFileSync(filePath);

			logger.info(
				"PDF buffer read successfully",
				{
					bufferSize: dataBuffer.length,
					filePath,
				},
			);

			// Use pdf-parse v2 API
			const parser = new PDFParse({
				data: dataBuffer,
			});
			const result = await parser.getText();

			logger.info("PDF parsed successfully", {
				numPages: result.numPages,
				textLength: result.text?.length || 0,
			});

			if (
				!result.text ||
				result.text.trim().length === 0
			) {
				throw new Error(
					"PDF parsing succeeded but no text was extracted. The PDF might be scanned images or password-protected.",
				);
			}

			return result.text;
		} catch (error) {
			const errorMessage =
				error instanceof Error
					? error.message
					: String(error);
			const errorStack =
				error instanceof Error
					? error.stack
					: undefined;

			logger.error("Error parsing PDF", {
				error: errorMessage,
				errorStack,
				errorType: error?.constructor?.name,
				filePath,
			});

			throw new Error(
				`Failed to parse PDF file: ${errorMessage}`,
			);
		}
	}

	private async parseWord(
		filePath: string,
	): Promise<string> {
		try {
			const result = await mammoth.extractRawText(
				{ path: filePath },
			);

			if (
				!result.value ||
				result.value.trim().length === 0
			) {
				throw new Error(
					"Word document parsing succeeded but no text was extracted",
				);
			}

			return result.value;
		} catch (error) {
			const errorMessage =
				error instanceof Error
					? error.message
					: String(error);
			logger.error(
				"Error parsing Word document",
				{
					error: errorMessage,
					filePath,
				},
			);
			throw new Error(
				`Failed to parse Word document: ${errorMessage}`,
			);
		}
	}

	private async parseCSV(
		filePath: string,
	): Promise<string> {
		try {
			const fileContent = fs.readFileSync(
				filePath,
				"utf8",
			);
			const parsed = Papa.parse(fileContent, {
				header: true,
				skipEmptyLines: true,
			});

			if (
				!parsed.data ||
				parsed.data.length === 0
			) {
				throw new Error(
					"CSV file is empty or has no valid data",
				);
			}

			const rows = parsed.data.map((row: any) => {
				return Object.entries(row)
					.map(
						([key, value]) => `${key}: ${value}`,
					)
					.join(", ");
			});

			return rows.join("\n");
		} catch (error) {
			const errorMessage =
				error instanceof Error
					? error.message
					: String(error);
			logger.error("Error parsing CSV", {
				error: errorMessage,
				filePath,
			});
			throw new Error(
				`Failed to parse CSV file: ${errorMessage}`,
			);
		}
	}

	private async parseExcel(
		filePath: string,
	): Promise<string> {
		try {
			const workbook = new ExcelJS.Workbook();
			await workbook.xlsx.readFile(filePath);

			if (
				!workbook.worksheets ||
				workbook.worksheets.length === 0
			) {
				throw new Error(
					"Excel file has no sheets",
				);
			}

			let content = "";

			workbook.worksheets.forEach((sheet) => {
				content += `\n\n=== Sheet: ${sheet.name} ===\n`;

				sheet.eachRow((row) => {
					const rowValues = (
						row.values as ExcelJS.CellValue[]
					)
						.slice(1) // ExcelJS row.values is 1-indexed, index 0 is always null
						.map((cell) => {
							if (
								cell === null ||
								cell === undefined
							)
								return "";
							if (
								typeof cell === "object" &&
								cell !== null &&
								"richText" in cell
							) {
								// RichText cell
								return (
									cell as ExcelJS.CellRichTextValue
								).richText
									.map((r) => r.text)
									.join("");
							}
							return String(cell);
						});

					content += rowValues.join(" | ") + "\n";
				});
			});

			if (
				!content ||
				content.trim().length === 0
			) {
				throw new Error(
					"Excel file parsing succeeded but no content extracted",
				);
			}

			return content;
		} catch (error) {
			const errorMessage =
				error instanceof Error
					? error.message
					: String(error);
			logger.error("Error parsing Excel", {
				error: errorMessage,
				filePath,
			});
			throw new Error(
				`Failed to parse Excel file: ${errorMessage}`,
			);
		}
	}

	private async parseText(
		filePath: string,
	): Promise<string> {
		try {
			const content = fs.readFileSync(
				filePath,
				"utf8",
			);

			if (
				!content ||
				content.trim().length === 0
			) {
				throw new Error("Text file is empty");
			}

			return content;
		} catch (error) {
			const errorMessage =
				error instanceof Error
					? error.message
					: String(error);
			logger.error("Error parsing text file", {
				error: errorMessage,
				filePath,
			});
			throw new Error(
				`Failed to parse text file: ${errorMessage}`,
			);
		}
	}

	async processAndStoreDocument(
		userId: string,
		filePath: string,
		filename: string,
		fileSize: number,
	): Promise<{
		success: boolean;
		chunks: number;
		message: string;
	}> {
		try {
			logger.info(
				`Processing document: ${filename} for user: ${userId}`,
			);

			const parsedDoc = await this.parseDocument(
				filePath,
				filename,
				fileSize,
			);

			if (
				!parsedDoc.content ||
				parsedDoc.content.trim().length === 0
			) {
				throw new Error(
					"No content extracted from document",
				);
			}

			const documentUrl = `document://${filename}`;
			await pineconeService.upsertDocument(
				userId,
				documentUrl,
				filename,
				parsedDoc.content,
				parsedDoc.metadata,
			);

			const estimatedChunks = Math.ceil(
				parsedDoc.content.length / 8000,
			);

			logger.info(
				`Document processed successfully: ${filename} (${estimatedChunks} chunks)`,
			);

			return {
				success: true,
				chunks: estimatedChunks,
				message: `Document processed and stored successfully`,
			};
		} catch (error) {
			logger.error("Error processing document", {
				error,
				filename,
				userId,
			});
			throw error;
		} finally {
			if (fs.existsSync(filePath)) {
				fs.unlinkSync(filePath);
				logger.info(
					`Cleaned up temporary file: ${filePath}`,
				);
			}
		}
	}
}

export const documentParserService =
	new DocumentParserService();
