import { config } from "../../config/env";

interface PasswordChangedEmailTemplateParams {
	recipientEmail: string;
	changedAt: Date;
}

interface PasswordChangedEmailTemplateResult {
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

function formatUtcDateTime(date: Date) {
	const formatted = new Intl.DateTimeFormat("en-GB", {
		day: "2-digit",
		month: "short",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
		timeZone: "UTC",
	}).formatToParts(date);

	const getPart = (type: string) =>
		formatted.find((part) => part.type === type)?.value || "";

	return {
		date: `${getPart("day")} ${getPart("month")} ${getPart("year")}`.trim(),
		time: `${getPart("hour")}:${getPart("minute")}:${getPart("second")}`.replace(/:$/, ""),
	};
}

export function buildPasswordChangedEmailTemplate(
	params: PasswordChangedEmailTemplateParams,
): PasswordChangedEmailTemplateResult {
	const { recipientEmail, changedAt } = params;
	const displayName = escapeHtml(
		getDisplayNameFromEmail(recipientEmail),
	);
	const frontendBase =
		config.FRONTEND_URL?.trim().replace(/\/+$/, "") ||
		"https://witzo.ai";
	const signInUrl = `${frontendBase}/login`;
	const resetUrl = `${frontendBase}/forgot-password`;
	const supportUrl = `${frontendBase}/contact-us`;
	const currentYear = new Date().getFullYear();
	const formatted = formatUtcDateTime(changedAt);

	const subject = "Witzo Password Changed";

	const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Witzo Password Changed</title>
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
      style="background:linear-gradient(180deg, #f9f1ff 0%, #ffffff 55%); margin:0; padding:0;"
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
            style="max-width:600px; background-color:#ffffff; border:1px solid #f1e4fb;"
          >

            <tr>
              <td style="padding:0 28px;">
                <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                  <tr>
                    <td
                      style="padding:26px 0 22px 0; border-bottom:1px solid #f3e8ff;"
                    >
                      <table role="presentation" border="0" cellspacing="0" cellpadding="0" width="100%">
                        <tr>
                          <td valign="middle" width="64">
                            <table
                              role="presentation"
                              border="0"
                              cellspacing="0"
                              cellpadding="0"
                              width="56"
                              height="56"
                              style="background-color:#f6ecff; border-radius:16px;"
                            >
                              <tr>
                                <td align="center" valign="middle" style="font-size:22px; line-height:22px; color:#7e22ce; font-weight:700;">
                                  !
                                </td>
                              </tr>
                            </table>
                          </td>
                          <td valign="middle">
                            <p style="margin:0 0 6px 0; color:#7e22ce; font-size:12px; font-weight:700; letter-spacing:0.8px; text-transform:uppercase;">
                              Security Alert
                            </p>
                            <p style="margin:0; color:#111827; font-size:24px; line-height:1.25; font-weight:800;">
                              Your password was changed
                            </p>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:30px 28px 24px 28px; color:#0f172a; font-size:14px; line-height:1.7;">
                <p style="margin:0 0 16px 0; font-size:18px; font-weight:700; color:#111827;">
                  Hi ${displayName},
                </p>

                <p style="margin:0 0 20px 0; color:#111827; font-size:14px;">
                  Your Witzo AI account password was successfully changed on <strong>${formatted.date}</strong> at <strong>${formatted.time} UTC</strong>.
                </p>
                <table role="presentation" border="0" cellspacing="0" cellpadding="0" style="margin:0 auto 24px auto;">
                  <tr>
                    <td align="center" bgcolor="#7916bb" style="border-radius:12px;">
                      <a
                        href="${signInUrl}"
                        style="display:inline-block; padding:10px 24px; color:#ffffff; font-size:14px; font-weight:700; text-decoration:none;"
                      >
                        Sign in
                      </a>
                    </td>
                  </tr>
                </table>

                <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin:0 0 18px 0;">
                  <tr>
                    <td style="padding:0 0 12px 0;">
                      <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                        <tr>
                          <td width="22" valign="top" style="color:#111827; font-size:16px; line-height:20px;">&bull;</td>
                          <td valign="top" style="color:#111827; font-size:14px;">
                            If you made this change, no further action is needed. You can continue using Witzo AI as normal.
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                        <tr>
                          <td width="22" valign="top" style="color:#111827; font-size:16px; line-height:20px;">&bull;</td>
                          <td valign="top" style="color:#111827; font-size:14px;">
                            If you did not make this change, reset your password immediately and contact our security team.
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>

                <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin:0;">
                  <tr>
                    <td style="border:1px solid #fecaca; background-color:#fff5f5; border-radius:14px; padding:14px 16px;">
                      <p style="margin:0; color:#991b1b; font-size:13px; line-height:1.7; font-weight:600;">
                        Did not recognize this activity? Secure your account right away by resetting your password <a href="${resetUrl}" style="color:#991b1b; text-decoration:underline;">here</a> and review recent access to prevent unauthorized use.
                      </p>
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
		"Witzo Password Changed",
		"",
		`Hi ${getDisplayNameFromEmail(recipientEmail)},`,
		`Your Witzo AI account password was successfully changed on ${formatted.date} at ${formatted.time} UTC.`,
		"",
		`Sign in: ${signInUrl}`,
		`Reset password if this wasn't you: ${resetUrl}`,
		`Need help? Contact support: ${supportUrl}`,
	].join("\n");

	return { subject, html, text };
}
