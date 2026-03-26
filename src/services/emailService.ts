import nodemailer, {
	Transporter,
} from "nodemailer";
import { config } from "../config/env";
import { buildVerificationEmailTemplate } from "../templates/email/verificationCodeTemplate";
import { buildPasswordResetEmailTemplate } from "../templates/email/passwordResetTemplate";
import { buildPasswordChangedEmailTemplate } from "../templates/email/passwordChangedTemplate";
import { buildPlanLimitReachedEmailTemplate } from "../templates/email/planLimitReachedTemplate";
import { buildSubscriptionUpgradedEmailTemplate } from "../templates/email/subscriptionUpgradedTemplate";
import { buildSubscriptionCancelledEmailTemplate } from "../templates/email/subscriptionCancelledTemplate";
import { buildWelcomeEmailTemplate } from "../templates/email/welcomeTemplate";
import { buildFollowUpEmailTemplate } from "../templates/email/followUpTemplate";
import { EmailResult } from "../types";
import { PlanType } from "../config/planConfig";
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
				recipientEmail: email,
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

	async sendFollowUpEmail(
		visitorEmail: string,
		visitorName?: string | null,
		widgetOwnerName?: string | null,
	): Promise<EmailResult> {
		const emailTemplate = buildFollowUpEmailTemplate({
			visitorName: visitorName ?? null,
			widgetOwnerName: widgetOwnerName ?? null,
		});

		const mailOptions = {
			from: config.EMAIL_FROM,
			to: visitorEmail,
			subject: emailTemplate.subject,
			html: emailTemplate.html,
			text: emailTemplate.text,
		};

		try {
			const info =
				await this.transporter.sendMail(
					mailOptions,
				);
			logger.info("Follow-up email sent", {
				visitorEmail,
				messageId: info.messageId,
			});
			return {
				success: true,
				messageId: info.messageId,
			};
		} catch (error) {
			const err = error as Error;
			logger.error(
				"Failed to send follow-up email",
				{
					visitorEmail,
					error: err.message,
				},
			);
			throw new Error(
				"Failed to send follow-up email",
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

	async sendPasswordResetEmail(
		email: string,
		resetUrl: string,
		expiryMinutes: number,
	): Promise<EmailResult> {
		const emailTemplate =
			buildPasswordResetEmailTemplate({
				resetUrl,
				expiryMinutes,
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
			logger.info("Password reset email sent", {
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
				"Failed to send password reset email",
				{
					email,
					error: err.message,
				},
			);
			throw new Error(
				"Failed to send password reset email",
			);
		}
	}

	async sendPasswordChangedEmail(
		email: string,
		changedAt: Date,
	): Promise<EmailResult> {
		const emailTemplate =
			buildPasswordChangedEmailTemplate({
				recipientEmail: email,
				changedAt,
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
			logger.info("Password changed email sent", {
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
				"Failed to send password changed email",
				{
					email,
					error: err.message,
				},
			);
			throw new Error(
				"Failed to send password changed email",
			);
		}
	}

	async sendSubscriptionUpgradedEmail(
		email: string,
		planName: string,
	): Promise<EmailResult> {
		const emailTemplate =
			buildSubscriptionUpgradedEmailTemplate({
				recipientEmail: email,
				planName,
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
			logger.info("Subscription upgraded email sent", {
				email,
				planName,
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
				"Failed to send subscription upgraded email",
				{
					email,
					planName,
					error: err.message,
				},
			);
			throw new Error(
				"Failed to send subscription upgraded email",
			);
		}
	}

	async sendSubscriptionCancelledEmail(
		email: string,
		planName: string,
	): Promise<EmailResult> {
		const emailTemplate =
			buildSubscriptionCancelledEmailTemplate({
				recipientEmail: email,
				planName,
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
			logger.info("Subscription cancelled email sent", {
				email,
				planName,
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
				"Failed to send subscription cancelled email",
				{
					email,
					planName,
					error: err.message,
				},
			);
			throw new Error(
				"Failed to send subscription cancelled email",
			);
		}
	}

	async sendPlanLimitReachedEmail(
		email: string,
		input: {
			planType: PlanType;
			conversationsUsed: number;
			conversationsLimit: number;
			resetDate: Date;
		},
	): Promise<EmailResult> {
		const emailTemplate =
			buildPlanLimitReachedEmailTemplate({
				recipientEmail: email,
				planType: input.planType,
				conversationsUsed:
					input.conversationsUsed,
				conversationsLimit:
					input.conversationsLimit,
				resetDate: input.resetDate,
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
			logger.info("Plan limit reached email sent", {
				email,
				planType: input.planType,
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
				"Failed to send plan limit reached email",
				{
					email,
					planType: input.planType,
					error: err.message,
				},
			);
			throw new Error(
				"Failed to send plan limit reached email",
			);
		}
	}
}

export default new EmailService();
