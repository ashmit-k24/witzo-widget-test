import crypto from "crypto";
import https from "https";
import { URL } from "url";
import { config } from "../config/env";

interface UploadWidgetIconParams {
	userId: string;
	buffer: Buffer;
	contentType: string;
}

interface UploadWidgetIconResult {
	key: string;
	url: string;
}

const S3_SERVICE_NAME = "s3";

const hashSha256Hex = (value: Buffer | string): string =>
	crypto.createHash("sha256").update(value).digest("hex");

const hmacSha256 = (key: Buffer | string, value: string): Buffer =>
	crypto.createHmac("sha256", key).update(value).digest();

const encodeS3Path = (key: string): string =>
	`/${key
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/")}`;

const formatAmzDate = (date: Date): { amzDate: string; dateStamp: string } => {
	const isoValue = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
	return {
		amzDate: isoValue,
		dateStamp: isoValue.slice(0, 8),
	};
};

const sanitizeKeySegment = (value: string): string =>
	value.replace(/[^a-zA-Z0-9_-]/g, "-");

const requestAsync = (
	url: URL,
	method: string,
	headers: Record<string, string>,
	body: Buffer,
): Promise<{ statusCode: number; body: string }> =>
	new Promise((resolve, reject) => {
		const request = https.request(
			{
				method,
				hostname: url.hostname,
				port: url.port || 443,
				path: `${url.pathname}${url.search}`,
				headers,
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk) => {
					chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				});
				response.on("end", () => {
					resolve({
						statusCode: response.statusCode || 500,
						body: Buffer.concat(chunks).toString("utf-8"),
					});
				});
			},
		);

		request.on("error", reject);
		request.write(body);
		request.end();
	});

class WidgetIconStorageService {
	private getSettings() {
		if (
			!config.S3_WIDGET_ICON_BUCKET ||
			!config.S3_WIDGET_ICON_REGION ||
			!config.AWS_ACCESS_KEY_ID ||
			!config.AWS_SECRET_ACCESS_KEY
		) {
			throw new Error(
				"Widget icon storage is not configured. Set S3_WIDGET_ICON_BUCKET, S3_WIDGET_ICON_REGION, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY.",
			);
		}

		return {
			bucket: config.S3_WIDGET_ICON_BUCKET,
			region: config.S3_WIDGET_ICON_REGION,
			accessKeyId: config.AWS_ACCESS_KEY_ID,
			secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
			sessionToken: config.AWS_SESSION_TOKEN,
			publicBaseUrl: config.S3_WIDGET_ICON_PUBLIC_BASE_URL,
		};
	}

	private getObjectKey(userId: string): string {
		return [
			"widget-icons",
			sanitizeKeySegment(userId),
			`${Date.now()}-${crypto.randomUUID()}.png`,
		].join("/");
	}

	async uploadWidgetIcon({
		userId,
		buffer,
		contentType,
	}: UploadWidgetIconParams): Promise<UploadWidgetIconResult> {
		const settings = this.getSettings();
		const key = this.getObjectKey(userId);
		const canonicalUri = encodeS3Path(key);
		const endpointUrl = new URL(
			`https://${settings.bucket}.s3.${settings.region}.amazonaws.com${canonicalUri}`,
		);
		const payloadHash = hashSha256Hex(buffer);
		const now = new Date();
		const { amzDate, dateStamp } = formatAmzDate(now);
		const credentialScope = `${dateStamp}/${settings.region}/${S3_SERVICE_NAME}/aws4_request`;
		const canonicalHeadersParts = [
			`host:${endpointUrl.host}`,
			`x-amz-content-sha256:${payloadHash}`,
			`x-amz-date:${amzDate}`,
		];
		const signedHeadersParts = [
			"host",
			"x-amz-content-sha256",
			"x-amz-date",
		];

		if (settings.sessionToken) {
			canonicalHeadersParts.push(`x-amz-security-token:${settings.sessionToken}`);
			signedHeadersParts.push("x-amz-security-token");
		}

		const canonicalHeaders = `${canonicalHeadersParts.join("\n")}\n`;
		const signedHeaders = signedHeadersParts.join(";");
		const canonicalRequest = [
			"PUT",
			canonicalUri,
			"",
			canonicalHeaders,
			signedHeaders,
			payloadHash,
		].join("\n");
		const stringToSign = [
			"AWS4-HMAC-SHA256",
			amzDate,
			credentialScope,
			hashSha256Hex(canonicalRequest),
		].join("\n");
		const dateKey = hmacSha256(`AWS4${settings.secretAccessKey}`, dateStamp);
		const regionKey = hmacSha256(dateKey, settings.region);
		const serviceKey = hmacSha256(regionKey, S3_SERVICE_NAME);
		const signingKey = hmacSha256(serviceKey, "aws4_request");
		const signature = hmacSha256(signingKey, stringToSign).toString("hex");
		const authorizationHeader =
			`AWS4-HMAC-SHA256 Credential=${settings.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

		const headers: Record<string, string> = {
			Authorization: authorizationHeader,
			"Content-Length": String(buffer.length),
			"Content-Type": contentType,
			host: endpointUrl.host,
			"x-amz-content-sha256": payloadHash,
			"x-amz-date": amzDate,
		};

		if (settings.sessionToken) {
			headers["x-amz-security-token"] = settings.sessionToken;
		}

		const response = await requestAsync(endpointUrl, "PUT", headers, buffer);

		if (response.statusCode < 200 || response.statusCode >= 300) {
			throw new Error(
				`S3 upload failed with status ${response.statusCode}: ${response.body || "Unknown error"}`,
			);
		}

		const publicUrl = settings.publicBaseUrl
			? `${settings.publicBaseUrl.replace(/\/+$/, "")}/${key}`
			: endpointUrl.toString();

		return {
			key,
			url: publicUrl,
		};
	}
}

export const widgetIconStorageService = new WidgetIconStorageService();
