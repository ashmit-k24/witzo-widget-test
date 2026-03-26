import { config } from "../../config/env";

interface WelcomeEmailTemplateParams {
	recipientEmail: string;
}

interface WelcomeEmailTemplateResult {
	subject: string;
	html: string;
	text: string;
}

function getDisplayNameFromEmail(
	email: string,
): string {
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

export function buildWelcomeEmailTemplate(
	params: WelcomeEmailTemplateParams,
): WelcomeEmailTemplateResult {
	const { recipientEmail } = params;
	const displayName = escapeHtml(
		getDisplayNameFromEmail(recipientEmail),
	);
	const subject = "Welcome To Witzo AI";
	const frontendBase =
		config.FRONTEND_URL?.trim().replace(/\/+$/, "") ||
		"https://witzo.ai";
	const accountUrl = `${frontendBase}/dashboard?utm_source=welcome_email&utm_medium=email&utm_campaign=account_access`;
	const supportUrl = `${frontendBase}/contact-us`;
	const currentYear = new Date().getFullYear();

	const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Welcome To Witzo AI</title>
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
                  Welcome To Witzo AI
                </p>

                <p style="margin:0 0 16px 0; color:#111827; font-size:24px; line-height:1.25; font-weight:700;">
                  Your account is live
                </p>

                <p style="margin:0 0 16px 0; font-size:18px; font-weight:700; color:#000000;">
                  Hi ${displayName},
                </p>

                <p style="margin:0 0 20px 0; color:#111827; font-size:14px;">
                  Your Witzo AI account is live. You're ready to deploy an AI chatbot trained entirely on your own website content.
                </p>

                <table role="presentation" border="0" cellspacing="0" cellpadding="0" style="margin:20px auto 0 auto;">
                  <tr>
                    <td align="center" bgcolor="#7916bb" style="border-radius:12px;">
                      <a
                        href="${accountUrl}"
                        style="display:inline-block; padding:10px 24px; color:#ffffff; font-size:14px; font-weight:700; text-decoration:none;"
                      >
                        Access The Account
                      </a>
                    </td>
                  </tr>
                </table>
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
		"Welcome To Witzo AI",
		"",
		"Your account is live",
		"",
		`Hi ${getDisplayNameFromEmail(recipientEmail)},`,
		"Your Witzo AI account is live. You're ready to deploy an AI chatbot trained entirely on your own website content.",
		"",
		`Access the account: ${accountUrl}`,
		`Need help? Contact us: ${supportUrl}`,
		"",
		"Best Regards,",
		"Team Witzo AI",
	].join("\n");

	return { subject, html, text };
}
