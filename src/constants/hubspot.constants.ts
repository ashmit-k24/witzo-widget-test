export const HUBSPOT_SYNC_DELIVERY_TIMEOUT_MS = 10_000;
export const HUBSPOT_SYNC_MAX_ATTEMPTS = 8;
export const HUBSPOT_SYNC_PROCESS_BATCH_SIZE = 20;
export const HUBSPOT_SYNC_PROCESS_INTERVAL_MS = 15_000;
export const HUBSPOT_SYNC_BACKOFF_BASE_MS = 30_000;
export const HUBSPOT_SYNC_BACKOFF_MAX_MS = 3_600_000;

export const HUBSPOT_DEFAULT_SCOPES = [
	"crm.objects.contacts.read",
	"crm.objects.contacts.write",
	"crm.objects.companies.read",
	"crm.objects.companies.write",
] as const;
