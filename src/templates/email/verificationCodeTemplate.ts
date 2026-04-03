import { config } from "../../config/env";

interface VerificationEmailTemplateParams {
	code: string;
	expiryMinutes: number;
	recipientEmail?: string;
}

interface VerificationEmailTemplateResult {
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

export function buildVerificationEmailTemplate(
	params: VerificationEmailTemplateParams,
): VerificationEmailTemplateResult {
	const { code, expiryMinutes, recipientEmail } =
		params;

	const subject = "Witzo Email Verification";
	const displayName = escapeHtml(
		getDisplayNameFromEmail(recipientEmail),
	);
	const supportUrl = `${config.FRONTEND_URL?.trim().replace(/\/+$/, "") || "https://witzo.ai"}/contact-us`;
	const currentYear = new Date().getFullYear();

	const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Witzo Email Verification</title>
    <link
      href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&display=swap"
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
              <td align="center" style="padding:0 0 40px 0;">
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
              <td style="padding:32px 28px 24px 28px; color:#0f172a; font-size:14px; line-height:1.6;">
                <p style="margin:0 0 18px 0; font-size:18px; font-weight:700; color:#000000;">
                  Hi ${displayName},
                </p>

                <p style="margin:0 0 18px 0; color:#111827; font-size:14px;">
                  Use the one-time code below to securely complete your Witzo AI sign-up. This code is valid for this session only.
                </p>

                <table
                  role="presentation"
                  border="0"
                  cellspacing="0"
                  cellpadding="0"
                  width="100%"
                  style="margin:0 0 20px 0;"
                >
                  <tr>
                    <td
                      align="center"
                      style="
                        background:#7a08fa; background:linear-gradient(102.39deg, #7a08fa -79.19%, #f4464b 130.72%);
                        color:#7916bb;
                        border:1px solid #8f22d74c;
                        font-size:24px;
                        font-weight:700;
                        letter-spacing:8px;
                        padding:14px 0;
                        border-radius:14px;
                      "
                    >
                      ${escapeHtml(code)}
                    </td>
                  </tr>
                </table>

                <p style="margin:0 0 18px 0; color:#111827; font-size:14px;">
                  This code expires in ${expiryMinutes} minutes and can only be used once.
                </p>

                <p style="margin:0; color:#111827; font-size:14px;">
                  If you did not request this, please ignore this email. Your account has not been accessed. Contact support if you
                  believe your account has been compromised.
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
		"Witzo Email Verification",
		"",
		`Hi ${getDisplayNameFromEmail(recipientEmail)},`,
		"Use the one-time code below to securely complete your Witzo AI sign-up.",
		"",
		`Verification code: ${code}`,
		`This code expires in ${expiryMinutes} minutes and can only be used once.`,
		"",
		"If you did not request this, please ignore this email.",
		`Need help? Contact support: ${supportUrl}`,
		"",
		"Best Regards,",
		"Team Witzo AI",
	].join("\n");

	return { subject, html, text };
}
