import nodemailer, {
	Transporter,
} from "nodemailer";
import { config } from "../config/env";
import { buildVerificationEmailTemplate } from "../templates/email/verificationCodeTemplate";
import { buildWelcomeEmailTemplate } from "../templates/email/welcomeTemplate";
import { EmailResult } from "../types";
import logger from "../utils/logger";

class EmailService {
	private transporter: Transporter;

	constructor() {
		this.transporter = nodemailer.createTransport(
			{
				host: config.EMAIL_HOST,
				port: config.EMAIL_PORT,
				secure: config.EMAIL_SECURE,

				auth: {
					user: config.EMAIL_USER,
					pass: config.EMAIL_PASSWORD,
				},
			},
		);

		// Verify transporter configuration
		this.transporter.verify((error) => {
			if (error) {
				logger.error(
					"Email transporter verification failed",
					{
						error: error.message,
					},
				);
			} else {
				logger.info(
					"Email service is ready to send messages",
				);
			}
		});
	}

	async sendVerificationCode(
		email: string,
		code: string,
	): Promise<EmailResult> {
		const emailTemplate =
			buildVerificationEmailTemplate({
				code,
				expiryMinutes:
					config.VERIFICATION_CODE_EXPIRY_MINUTES,
			});

		const mailOptions = {
			from: config.EMAIL_FROM,
			to: email,
			subject: emailTemplate.subject,
			html: emailTemplate.html,
			text: emailTemplate.text,
		};

		try {
			const info =
				await this.transporter.sendMail(
					mailOptions,
				);
			logger.info("Verification email sent", {
				email,
				from: config.EMAIL_FROM,
				messageId: info.messageId,
				accepted: info.accepted,
				rejected: info.rejected,
				response: info.response,
			});
			return {
				success: true,
				messageId: info.messageId,
			};
		} catch (error) {
			const err = error as Error;
			logger.error(
				"Failed to send verification email",
				{
					email,
					error: err.message,
				},
			);
			throw new Error(
				"Failed to send verification email",
			);
		}
	}

	async sendWelcomeEmail(
		email: string,
	): Promise<EmailResult> {
		const emailTemplate =
			buildWelcomeEmailTemplate({
				recipientEmail: email,
			});

		const mailOptions = {
			from: config.EMAIL_FROM,
			to: email,
			subject: emailTemplate.subject,
			html: emailTemplate.html,
			text: emailTemplate.text,
		};

		try {
			const info =
				await this.transporter.sendMail(
					mailOptions,
				);
			logger.info("Welcome email sent", {
				email,
				from: config.EMAIL_FROM,
				messageId: info.messageId,
				accepted: info.accepted,
				rejected: info.rejected,
				response: info.response,
			});
			return {
				success: true,
				messageId: info.messageId,
			};
		} catch (error) {
			const err = error as Error;
			logger.error("Failed to send welcome email", {
				email,
				error: err.message,
			});
			throw new Error("Failed to send welcome email");
		}
	}
}

export default new EmailService();
