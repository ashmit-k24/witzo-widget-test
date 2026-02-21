import { config } from "../config/env";

export const WIDGET_KEY_CACHE_TTL_SECONDS = 3_600;
export const WIDGET_ANALYTICS_BUFFER_KEY = "analytics:buffer";
export const WIDGET_ANALYTICS_BATCH_SIZE = config.ANALYTICS_BUFFER_SIZE;
