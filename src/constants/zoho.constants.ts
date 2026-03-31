export const ZOHO_SYNC_DELIVERY_TIMEOUT_MS = 10_000;
export const ZOHO_SYNC_MAX_ATTEMPTS = 8;
export const ZOHO_SYNC_PROCESS_BATCH_SIZE = 20;
export const ZOHO_SYNC_PROCESS_INTERVAL_MS = 15_000;
export const ZOHO_SYNC_BACKOFF_BASE_MS = 30_000;
export const ZOHO_SYNC_BACKOFF_MAX_MS = 3_600_000;

export const ZOHO_DEFAULT_SCOPES = [
	"ZohoCRM.modules.leads.CREATE",
	"ZohoCRM.modules.leads.READ",
	"ZohoCRM.modules.leads.UPDATE",
	"ZohoCRM.modules.notes.CREATE",
	"ZohoCRM.settings.fields.READ",
] as const;
