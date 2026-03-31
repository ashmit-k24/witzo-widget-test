import { config } from "../../config/env";

interface FollowUpEmailTemplateParams {
	visitorName?: string | null;
	widgetOwnerName?: string | null;
}

interface FollowUpEmailTemplateResult {
	subject: string;
	html: string;
	text: string;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function normalizeDisplayName(
	value?: string | null,
	fallback = "there",
): string {
	if (!value) {
		return fallback;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : fallback;
}

export function buildFollowUpEmailTemplate(
	params: FollowUpEmailTemplateParams,
): FollowUpEmailTemplateResult {
	const { visitorName, widgetOwnerName } = params;
	const safeVisitorName = escapeHtml(
		normalizeDisplayName(visitorName),
	);
	const safeWidgetOwnerName = escapeHtml(
		normalizeDisplayName(
			widgetOwnerName,
			"Witzo",
		),
	);
	const subject = `Thanks for chatting with ${safeWidgetOwnerName}!`;
	const supportUrl = `${config.FRONTEND_URL?.trim().replace(/\/+$/, "") || "https://witzo.ai"}/contact-us`;
	const currentYear = new Date().getFullYear();

	const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${subject}</title>
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
              <td style="padding:0 28px;">
                <table
                  role="presentation"
                  width="100%"
                  border="0"
                  cellspacing="0"
                  cellpadding="0"
                  style="margin:28px 0 0 0; border-radius:18px; overflow:hidden;"
                >
                  <tr>
                    <td
                      style="padding:28px; background:#7a08fa; background:linear-gradient(102.39deg, #7a08fa -79.19%, #f4464b 130.72%);"
                    >
                      <p style="margin:0; font-size:12px; line-height:1.4; letter-spacing:1.8px; text-transform:uppercase; color:#f8e8ff; font-weight:700;">
                        Conversation Follow-Up
                      </p>
                      <h1 style="margin:10px 0 0 0; font-size:28px; line-height:1.2; color:#ffffff; font-weight:800;">
                        Thanks for chatting with ${safeWidgetOwnerName}
                      </h1>
                      <p style="margin:12px 0 0 0; color:#fce7f3; font-size:14px; line-height:1.7;">
                        We appreciate you reaching out and taking the time to connect with us.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:28px 28px 16px 28px; color:#0f172a; font-size:14px; line-height:1.7;">
                <p style="margin:0 0 16px 0; font-size:18px; font-weight:700; color:#000000;">
                  Hi ${safeVisitorName},
                </p>

                <p style="margin:0 0 16px 0; color:#111827; font-size:14px;">
                  Thank you for reaching out and chatting with us today. We hope we were able to help answer your questions and point you in the right direction.
                </p>

                <p style="margin:0 0 18px 0; color:#111827; font-size:14px;">
                  If anything else comes up, just reply or get back in touch. We are always happy to help.
                </p>

                <table
                  role="presentation"
                  width="100%"
                  border="0"
                  cellspacing="0"
                  cellpadding="0"
                  style="margin:0 0 20px 0;"
                >
                  <tr>
                    <td style="border-radius:14px; background:#faf5ff; border:1px solid #ead7fb; padding:16px 18px;">
                      <p style="margin:0; color:#5b5167; font-size:13px; line-height:1.7;">
                        This email was sent because you recently chatted with <strong>${safeWidgetOwnerName}</strong>. If you did not start this conversation, you can safely ignore this email.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:0 28px 20px 28px; color:#111827; font-size:14px; line-height:1.7;">
                <p style="margin:0;">Best Regards,</p>
                <p style="margin:0; font-weight:700;">Team ${safeWidgetOwnerName}</p>
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
                  Need help? <a href="${supportUrl}" style="color:#374151; text-decoration:underline;">Contact</a> the Witzo support team for onboarding guidance and follow-up assistance.
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
		subject,
		"",
		`Hi ${normalizeDisplayName(visitorName)},`,
		"",
		"Thank you for reaching out and chatting with us today. We hope we were able to help answer your questions and point you in the right direction.",
		"",
		"If anything else comes up, just reply or get back in touch. We are always happy to help.",
		"",
		`This email was sent because you recently chatted with ${normalizeDisplayName(widgetOwnerName, "Witzo")}. If you did not start this conversation, you can safely ignore it.`,
		"",
		`Need help? Contact us: ${supportUrl}`,
		"",
		"Best Regards,",
		`Team ${normalizeDisplayName(widgetOwnerName, "Witzo")}`,
	].join("\n");

	return { subject, html, text };
}
