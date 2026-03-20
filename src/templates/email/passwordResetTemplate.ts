interface PasswordResetEmailTemplateParams {
	resetUrl: string;
	expiryMinutes: number;
}

interface PasswordResetEmailTemplateResult {
	subject: string;
	html: string;
	text: string;
}

export function buildPasswordResetEmailTemplate(
	params: PasswordResetEmailTemplateParams,
): PasswordResetEmailTemplateResult {
	const { resetUrl, expiryMinutes } = params;

	const subject = "Reset Your Witzo Password";

	const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Reset Your Password</title>
  </head>
  <body style="margin:0;padding:0;background:#f3f7fb;font-family:Segoe UI,Roboto,Arial,sans-serif;color:#10263d;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f3f7fb;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:620px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 16px 40px rgba(16,38,61,0.12);">
            <tr>
              <td style="padding:0;background:linear-gradient(135deg,#0f172a 0%,#1e3a8a 45%,#0ea5e9 100%);">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="padding:28px 28px 20px 28px;">
                      <div style="font-size:14px;letter-spacing:2px;text-transform:uppercase;color:#cde8ff;font-weight:600;">Witzo AI</div>
                      <h1 style="margin:10px 0 0 0;font-size:28px;line-height:1.2;color:#ffffff;font-weight:700;">Reset Your Password</h1>
                      <p style="margin:12px 0 0 0;color:#d7ebff;font-size:15px;line-height:1.55;">
                        Use the secure link below to choose a new password for your Witzo account.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 28px 10px 28px;">
                <p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:#324b64;">
                  Click the button below to reset your password. This link expires in <strong>${expiryMinutes} minutes</strong>.
                </p>
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:20px 0;">
                  <tr>
                    <td align="center" bgcolor="#0b4a8f" style="border-radius:12px;">
                      <a href="${resetUrl}" style="display:inline-block;padding:14px 22px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;">
                        Reset password
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0;font-size:14px;line-height:1.7;color:#4f6a84;word-break:break-all;">
                  If the button does not work, open this link in your browser:<br />
                  <a href="${resetUrl}" style="color:#0b4a8f;text-decoration:none;">${resetUrl}</a>
                </p>
                <p style="margin:16px 0 0 0;font-size:14px;line-height:1.6;color:#4f6a84;">
                  If you did not request this password reset, you can safely ignore this email.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 28px 28px 28px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-top:1px solid #e4edf6;padding-top:14px;">
                  <tr>
                    <td style="font-size:12px;line-height:1.6;color:#7b91a8;">
                      This is an automated security message from Witzo AI. Please do not reply to this email.
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

	const text = [
		"Witzo AI - Reset Your Password",
		"",
		`Open this link to reset your password: ${resetUrl}`,
		`This link expires in ${expiryMinutes} minutes.`,
		"",
		"If you did not request a password reset, you can safely ignore this email.",
	].join("\n");

	return { subject, html, text };
}
