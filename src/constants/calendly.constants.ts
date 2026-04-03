export const CALENDLY_DELIVERY_TIMEOUT_MS = 10_000;

export const CALENDLY_DEFAULT_SCOPES = [
	"default",
] as const;

export const CALENDLY_WEBHOOK_EVENTS = [
	"invitee.created",
	"invitee.canceled",
] as const;
