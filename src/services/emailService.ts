import nodemailer, {
	Transporter,
} from "nodemailer";
import { config } from "../config/env";
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
		const mailOptions = {
			from: config.EMAIL_FROM,
			to: email,
			subject: "Your Verification Code",
			html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body {
              font-family: Arial, sans-serif;
              line-height: 1.6;
              color: #333;
            }
            .container {
              max-width: 600px;
              margin: 0 auto;
              padding: 20px;
            }
            .code-box {
              background-color: #f4f4f4;
              border: 2px solid #007bff;
              border-radius: 5px;
              padding: 20px;
              text-align: center;
              margin: 20px 0;
            }
            .code {
              font-size: 32px;
              font-weight: bold;
              color: #007bff;
              letter-spacing: 5px;
            }
            .footer {
              margin-top: 20px;
              font-size: 12px;
              color: #666;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h2>Verification Code</h2>
            <p>Hello,</p>
            <p>Thank you for signing up! Use the verification code below to complete your login:</p>
            <div class="code-box">
              <div class="code">${code}</div>
            </div>
            <p>This code will expire in ${config.VERIFICATION_CODE_EXPIRY_MINUTES} minutes.</p>
            <p>If you didn't request this code, please ignore this email.</p>
            <div class="footer">
              <p>This is an automated message, please do not reply.</p>
            </div>
          </div>
        </body>
        </html>
      `,
			text: `Your verification code is: ${code}. This code will expire in ${config.VERIFICATION_CODE_EXPIRY_MINUTES} minutes.`,
		};

		try {
			const info =
				await this.transporter.sendMail(
					mailOptions,
				);
			logger.info("Verification email sent", {
				email,
				messageId: info.messageId,
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
}

export default new EmailService();
