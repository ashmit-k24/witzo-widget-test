interface FollowUpEmailTemplateParams {
	visitorName?: string | null;
	widgetOwnerName?: string | null;
}

interface FollowUpEmailTemplateResult {
	subject: string;
	html: string;
	text: string;
}

export function buildFollowUpEmailTemplate(
	params: FollowUpEmailTemplateParams,
): FollowUpEmailTemplateResult {
	const { visitorName, widgetOwnerName } = params;
	const greeting = visitorName ? `Hi ${visitorName}` : "Hi there";
	const from = widgetOwnerName || "Witzo";
	const subject = `Thanks for chatting with ${from}!`;

	const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${subject}</title>
  </head>
  <body style="margin:0;padding:0;background:#f3f6fb;font-family:Segoe UI,Roboto,Arial,sans-serif;color:#0f2238;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f3f6fb;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 16px 40px rgba(15,34,56,0.12);">
            <tr>
              <td style="background:linear-gradient(130deg,#0f172a 0%,#1d4ed8 45%,#22d3ee 100%);padding:30px 30px 26px 30px;">
                <div style="font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#cae4ff;font-weight:700;">${from}</div>
                <h1 style="margin:10px 0 0 0;font-size:30px;line-height:1.2;color:#ffffff;font-weight:800;">Thanks for chatting!</h1>
                <p style="margin:12px 0 0 0;color:#d7ecff;font-size:15px;line-height:1.6;">
                  We appreciate you reaching out.
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:28px 30px 8px 30px;">
                <p style="margin:0;font-size:16px;line-height:1.7;color:#324a62;">
                  ${greeting},
                </p>
                <p style="margin:14px 0 0 0;font-size:15px;line-height:1.8;color:#4d657e;">
                  Thank you for reaching out and chatting with us today. We hope we were able to help answer your questions.
                </p>
                <p style="margin:14px 0 0 0;font-size:15px;line-height:1.8;color:#4d657e;">
                  If you have any further questions or need additional assistance, please don't hesitate to get in touch — we're always happy to help.
                </p>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:20px 0;background:#f8fbff;border:1px solid #d7e8f8;border-radius:14px;">
                  <tr>
                    <td style="padding:16px 18px;">
                      <p style="margin:0;font-size:14px;line-height:1.7;color:#4d657e;">
                        This email was sent because you recently chatted with <strong>${from}</strong>. If you didn't initiate this conversation, you can safely ignore this email.
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
                      Powered by <a href="https://witzo.ai" style="color:#1d4ed8;text-decoration:none;">Witzo AI</a>
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
		subject,
		"",
		`${greeting},`,
		"",
		"Thank you for reaching out and chatting with us today. We hope we were able to help answer your questions.",
		"",
		"If you have any further questions or need additional assistance, please don't hesitate to get in touch.",
		"",
		`— ${from}`,
		"",
		"Powered by Witzo AI",
	].join("\n");

	return { subject, html, text };
}
