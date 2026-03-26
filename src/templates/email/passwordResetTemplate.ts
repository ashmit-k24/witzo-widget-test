import { config } from "../../config/env";

interface PasswordResetEmailTemplateParams {
	resetUrl: string;
	expiryMinutes: number;
	recipientEmail?: string;
}

interface PasswordResetEmailTemplateResult {
	subject: string;
	html: string;
	text: string;
}

function getDisplayNameFromEmail(
	email?: string,
): string {
	if (!email) {
		return "there";
	}

	const localPart = email.split("@")[0] || "";
	const cleaned = localPart
		.replace(/[._-]+/g, " ")
		.trim();

	if (!cleaned) {
		return "there";
	}

	return cleaned
		.split(" ")
		.filter(Boolean)
		.map(
			(word) =>
				word.charAt(0).toUpperCase() +
				word.slice(1).toLowerCase(),
		)
		.join(" ");
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function buildPasswordResetEmailTemplate(
	params: PasswordResetEmailTemplateParams,
): PasswordResetEmailTemplateResult {
	const {
		resetUrl,
		expiryMinutes,
		recipientEmail,
	} = params;

	const subject = "Witzo Reset Password";
	const displayName = escapeHtml(
		getDisplayNameFromEmail(recipientEmail),
	);
	const supportUrl =
		`${config.FRONTEND_URL?.trim().replace(/\/+$/, "") || "https://witzo.ai"}/contact-us`;
	const currentYear = new Date().getFullYear();

	const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Witzo Reset Password</title>
    <link
      href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
      rel="stylesheet"
    />
  </head>
  <body style="margin:0; padding:0; background-color:#ffffff; font-family:'Inter', Arial, Helvetica, sans-serif;">
    <table
      role="presentation"
      width="100%"
      border="0"
      cellspacing="0"
      cellpadding="0"
      style="background-color:#7916bb16; margin:0; padding:0;"
    >
      <tr>
        <td align="center" style="padding:20px 10px 40px 10px;">
          <table role="presentation" border="0" cellspacing="0" cellpadding="0" width="100%" style="max-width:600px;">
            <tr>
              <td align="center" style="padding:0 0 28px 0;">
                <img
                  src="https://weboclient.co.in/witzo-email-template/assets/witzo-logo.png"
                  alt="Witzo"
                  width="180"
                  style="display:block; border:0; outline:none; text-decoration:none; width:180px; max-width:100%; height:auto;"
                />
              </td>
            </tr>
          </table>

          <table
            role="presentation"
            border="0"
            cellspacing="0"
            cellpadding="0"
            width="100%"
            style="max-width:600px; background-color:#ffffff;"
          >
            <tr>
              <td style="padding:30px 28px 24px 28px; color:#0f172a; font-size:14px; line-height:1.7;">
                <p style="margin:0 0 8px 0; color:#6b21a8; font-size:12px; font-weight:700; letter-spacing:0.8px; text-transform:uppercase;">
                  Reset Your Password
                </p>

                <p style="margin:0 0 16px 0; color:#111827; font-size:24px; line-height:1.25; font-weight:700;">
                  Password reset request
                </p>

                <p style="margin:0 0 16px 0; font-size:18px; font-weight:700; color:#000000;">
                  Hi ${displayName}
                </p>

                <p style="margin:0 0 20px 0; color:#111827; font-size:14px;">
                  We received a request to reset your password. Click the button below to reset your password.
                </p>

                <table role="presentation" border="0" cellspacing="0" cellpadding="0" style="margin:0 auto 18px auto;">
                  <tr>
                    <td align="center" bgcolor="#7916bb" style="border-radius:12px;">
                      <a
                        href="${resetUrl}"
                        style="display:inline-block; padding:10px 24px; color:#ffffff; font-size:14px; font-weight:700; text-decoration:none;"
                      >
                        Reset Password
                      </a>
                    </td>
                  </tr>
                </table>

                <p style="margin:0 0 18px 0; color:#111827; font-size:14px;">
                  This link expires in ${expiryMinutes} minutes.
                </p>

                <p style="margin:0; color:#111827; font-size:14px;">
                  If you did not try to reset your password, you can ignore this email.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 28px 20px 28px; color:#111827; font-size:14px; line-height:1.7;">
                <p style="margin:0;">Best Regards,</p>
                <p style="margin:0; font-weight:700;">Team Witzo AI</p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 28px;">
                <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="border-top:1px solid #e5e7eb; font-size:0; line-height:0;">&nbsp;</td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:24px 28px 36px 28px; color:#374151; font-size:13px; line-height:1.7;">
                <p style="margin:0;">
                  Need help? <a href="${supportUrl}" style="color:#374151; text-decoration:underline;">Contact</a> the Witzo support team for onboarding guidance and best practices.
                </p>
              </td>
            </tr>
          </table>

          <table role="presentation" border="0" cellspacing="0" cellpadding="0" width="100%" style="max-width:600px;">
            <tr>
              <td align="center" style="padding:40px 0 10px 0;">
                <img
                  src="https://weboclient.co.in/witzo-email-template/assets/witzo-small-logo.svg"
                  alt="Witzo"
                  width="44"
                  style="display:block; border:0; outline:none; text-decoration:none; width:44px; max-width:100%; height:auto;"
                />
              </td>
            </tr>
            <tr>
              <td align="center" style="font-size:13px; font-weight:500; color:#5f4b63; padding-top:8px;">
                &copy; ${currentYear} Witzo AI. All rights reserved.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

	const text = [
		"Witzo Reset Password",
		"",
		`Hi ${getDisplayNameFromEmail(recipientEmail)},`,
		"We received a request to reset your password.",
		`Reset password: ${resetUrl}`,
		`This link expires in ${expiryMinutes} minutes.`,
		"",
		"If you did not try to reset your password, you can ignore this email.",
		`Need help? Contact support: ${supportUrl}`,
		"",
		"Best Regards,",
		"Team Witzo AI",
	].join("\n");

	return { subject, html, text };
}
