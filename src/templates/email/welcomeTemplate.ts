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

export function buildWelcomeEmailTemplate(
	params: WelcomeEmailTemplateParams,
): WelcomeEmailTemplateResult {
	const { recipientEmail } = params;
	const displayName =
		getDisplayNameFromEmail(recipientEmail);
	const subject = "Welcome to Witzo AI";

	const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Welcome to Witzo AI</title>
  </head>
  <body style="margin:0;padding:0;background:#f3f6fb;font-family:Segoe UI,Roboto,Arial,sans-serif;color:#0f2238;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f3f6fb;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 16px 40px rgba(15,34,56,0.12);">
            <tr>
              <td style="background:linear-gradient(130deg,#0f172a 0%,#1d4ed8 45%,#22d3ee 100%);padding:30px 30px 26px 30px;">
                <div style="font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#cae4ff;font-weight:700;">Witzo AI</div>
                <h1 style="margin:10px 0 0 0;font-size:30px;line-height:1.2;color:#ffffff;font-weight:800;">Welcome aboard</h1>
                <p style="margin:12px 0 0 0;color:#d7ecff;font-size:15px;line-height:1.6;">
                  Your account is now active and ready to use.
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:28px 30px 8px 30px;">
                <p style="margin:0;font-size:16px;line-height:1.7;color:#324a62;">
                  Hi ${displayName},
                </p>
                <p style="margin:14px 0 0 0;font-size:15px;line-height:1.8;color:#4d657e;">
                  Thanks for signing up for Witzo AI. Your email has been verified successfully. You can now create your chatbot, connect data sources, and deploy your widget.
                </p>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:20px 0;background:#f8fbff;border:1px solid #d7e8f8;border-radius:14px;">
                  <tr>
                    <td style="padding:16px 18px;">
                      <p style="margin:0 0 8px 0;font-size:14px;font-weight:700;color:#0b4a8f;">Quick start</p>
                      <p style="margin:0;font-size:14px;line-height:1.7;color:#4d657e;">
                        1. Add your website data source<br />
                        2. Train your assistant<br />
                        3. Copy and embed the widget code
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:18px 30px 30px 30px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-top:1px solid #e4edf6;padding-top:14px;">
                  <tr>
                    <td style="font-size:12px;line-height:1.7;color:#7b91a8;">
                      Need help? Reply to this email and our team will assist you.
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
		"Welcome to Witzo AI",
		"",
		`Hi ${displayName},`,
		"Your account has been verified successfully.",
		"",
		"Quick start:",
		"1. Add your website data source",
		"2. Train your assistant",
		"3. Copy and embed the widget code",
		"",
		"Need help? Reply to this email.",
	].join("\n");

	return { subject, html, text };
}
