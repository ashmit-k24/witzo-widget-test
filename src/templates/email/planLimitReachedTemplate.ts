import { config } from "../../config/env";
import { PlanType } from "../../config/planConfig";

interface PlanLimitReachedEmailTemplateParams {
	recipientEmail: string;
	planType: PlanType;
	conversationsUsed: number;
	conversationsLimit: number;
	resetDate: Date;
}

interface PlanLimitReachedEmailTemplateResult {
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

function formatPlanName(
	planType: PlanType,
): string {
	return (
		planType.charAt(0).toUpperCase() +
		planType.slice(1).toLowerCase()
	);
}

function formatResetDate(date: Date): string {
	return new Intl.DateTimeFormat("en-GB", {
		day: "2-digit",
		month: "short",
		year: "numeric",
		timeZone: "UTC",
	}).format(date);
}

export function buildPlanLimitReachedEmailTemplate(
	params: PlanLimitReachedEmailTemplateParams,
): PlanLimitReachedEmailTemplateResult {
	const {
		recipientEmail,
		planType,
		conversationsUsed,
		conversationsLimit,
		resetDate,
	} = params;
	const displayName = escapeHtml(
		getDisplayNameFromEmail(recipientEmail),
	);
	const displayPlanName =
		formatPlanName(planType);
	const escapedPlanName = escapeHtml(
		displayPlanName,
	);
	const formattedResetDate = escapeHtml(
		formatResetDate(resetDate),
	);
	const frontendBase =
		config.FRONTEND_URL?.trim().replace(
			/\/+$/,
			"",
		) || "https://witzo.ai";
	const plansUrl = `${frontendBase}/dashboard/subscription?utm_source=plan_limit_email&utm_medium=email&utm_campaign=usage_limit_reached`;
	const supportUrl = `${frontendBase}/contact-us`;
	const currentYear = new Date().getFullYear();
	const subject = `Witzo ${displayPlanName} Plan Limit Reached`;

	const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Witzo ${escapedPlanName} Plan Limit Reached</title>
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
      style="background-color:#f7f3fb; margin:0; padding:0;"
    >
      <tr>
        <td align="center" style="padding:16px 10px 26px 10px;">
          <table role="presentation" border="0" cellspacing="0" cellpadding="0" width="100%" style="max-width:560px;">
            <tr>
              <td align="center" style="padding:0 0 14px 0;">
                <img
                  src="https://weboclient.co.in/witzo-email-template/assets/witzo-logo.png"
                  alt="Witzo"
                  width="168"
                  style="display:block; border:0; outline:none; text-decoration:none; width:168px; max-width:100%; height:auto;"
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
            style="max-width:560px; background-color:#ffffff; border:1px solid #ede6f6; border-radius:18px;"
          >
            <tr>
              <td style="padding:24px 22px 18px 22px; color:#0f172a; font-size:14px; line-height:1.55;">
                                <p style="margin:0 0 10px 0; color:#111827; font-size:21px; line-height:1.25; font-weight:700;">
                  Your chatbot has reached the ${escapedPlanName} plan limit
                </p>

                <p style="margin:0 0 10px 0; font-size:17px; font-weight:700; color:#111827;">
                  Hi ${displayName},
                </p>

                <p style="margin:0 0 14px 0; color:#111827; font-size:14px;">
                  Your Witzo AI chatbot has reached its monthly conversation limit on the ${escapedPlanName} plan.
                </p>

                <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin:0 0 14px 0;">
                  <tr>
                    <td style="border:1px solid #efe8f7; border-radius:16px; padding:14px 16px;">
                      <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                        <tr>
                          <td colspan="2" style="padding:0 0 10px 0; color:#111827; font-size:15px; font-weight:700;">
                            Plan status
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:6px 14px 6px 0; color:#6b7280; font-size:13px;">Plan</td>
                          <td align="right" style="padding:6px 0; color:#111827; font-size:13px; font-weight:600;">${escapedPlanName}</td>
                        </tr>
                        <tr>
                          <td style="padding:6px 14px 6px 0; color:#6b7280; font-size:13px;">Limit</td>
                          <td align="right" style="padding:6px 0; color:#111827; font-size:13px; font-weight:600;">${conversationsLimit} conversations/month</td>
                        </tr>
                        <tr>
                          <td style="padding:6px 14px 6px 0; color:#6b7280; font-size:13px;">Used</td>
                          <td align="right" style="padding:6px 0; color:#b45309; font-size:13px; font-weight:700;">${conversationsUsed} of ${conversationsLimit}</td>
                        </tr>
                        <tr>
                          <td style="padding:6px 14px 6px 0; color:#6b7280; font-size:13px;">Limit resets</td>
                          <td align="right" style="padding:6px 0; color:#111827; font-size:13px; font-weight:600;">${formattedResetDate}</td>
                        </tr>
                        <tr>
                          <td colspan="2" style="padding:10px 0 0 0;">
                            <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                              <tr>
                                <td style="border-top:1px solid #f2edf7; font-size:0; line-height:0;">&nbsp;</td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:10px 14px 6px 0; color:#6b7280; font-size:13px;">Chatbot</td>
                          <td align="right" style="padding:10px 0 6px 0; color:#111827; font-size:13px; font-weight:600;">Stopped for new visitors</td>
                        </tr>
                        <tr>
                          <td style="padding:6px 14px 6px 0; color:#6b7280; font-size:13px;">Visitors</td>
                          <td align="right" style="padding:6px 0; color:#111827; font-size:13px; font-weight:600;">Fallback or no response</td>
                        </tr>
                        <tr>
                          <td style="padding:6px 14px 0 0; color:#6b7280; font-size:13px;">Your data</td>
                          <td align="right" style="padding:6px 0 0 0; color:#111827; font-size:13px; font-weight:600;">Fully intact</td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>

                <table role="presentation" border="0" cellspacing="0" cellpadding="0" style="margin:0 auto 10px auto;">
                  <tr>
                    <td align="center" style="border-radius:12px; background:#7a08fa; background:linear-gradient(102.39deg, #7a08fa -79.19%, #f4464b 130.72%);">
                      <a
                        href="${plansUrl}"
                        style="display:inline-block; padding:10px 22px; color:#ffffff; font-size:13px; font-weight:700; text-decoration:none;"
                      >
                        View all plans
                      </a>
                    </td>
                  </tr>
                </table>

                <p style="margin:0; color:#6b7280; font-size:12px; line-height:1.55;">
                  Upgrade any time to restore chatbot responses immediately and continue serving visitors without interruption.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 22px 18px 22px; color:#111827; font-size:14px; line-height:1.6;">
                <p style="margin:0;">Best Regards,</p>
                <p style="margin:0; font-weight:700;">Team Witzo AI</p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 22px;">
                <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="border-top:1px solid #ebe7f1; font-size:0; line-height:0;">&nbsp;</td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:14px 22px 20px 22px; color:#374151; font-size:12px; line-height:1.65;">
                <p style="margin:0;">
                  Need help? <a href="${supportUrl}" style="color:#374151; text-decoration:underline;">Contact</a> the Witzo support team for onboarding guidance and best practices.
                </p>
              </td>
            </tr>
          </table>

          <table role="presentation" border="0" cellspacing="0" cellpadding="0" width="100%" style="max-width:560px;">
            <tr>
              <td align="center" style="padding:22px 0 8px 0;">
                <img
                  src="https://weboclient.co.in/witzo-email-template/assets/witzo-small-logo.svg"
                  alt="Witzo"
                  width="40"
                  style="display:block; border:0; outline:none; text-decoration:none; width:40px; max-width:100%; height:auto;"
                />
              </td>
            </tr>
            <tr>
              <td align="center" style="font-size:12px; font-weight:500; color:#5f4b63; padding-top:6px;">
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
		`Witzo ${displayPlanName} Plan Limit Reached`,
		"",
		`Hi ${getDisplayNameFromEmail(recipientEmail)},`,
		`Your Witzo AI chatbot has reached its monthly conversation limit on the ${displayPlanName} plan.`,
		`Plan: ${displayPlanName}`,
		`Limit: ${conversationsLimit} conversations/month`,
		`Used: ${conversationsUsed} of ${conversationsLimit}`,
		`Limit resets: ${formatResetDate(resetDate)}`,
		"Chatbot status: Stopped for new visitors",
		"Your data remains fully intact.",
		`View all plans: ${plansUrl}`,
		`Need help? Contact support: ${supportUrl}`,
	].join("\n");

	return { subject, html, text };
}
