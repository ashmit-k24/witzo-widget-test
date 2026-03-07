import dns from "node:dns/promises";
import net from "node:net";

const BLOCKED_HOSTNAMES = new Set([
	"localhost",
	"metadata.google.internal",
	"metadata.azure.internal",
]);

const BLOCKED_IPV4 = new Set([
	"0.0.0.0",
	"127.0.0.1",
	"169.254.169.254",
	"255.255.255.255",
]);

function isPrivateIPv4(address: string): boolean {
	if (BLOCKED_IPV4.has(address)) {
		return true;
	}

	const octets = address.split(".").map((part) => Number(part));
	if (octets.length !== 4 || octets.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
		return true;
	}

	const [first, second] = octets;
	if (first === 10 || first === 127) return true;
	if (first === 172 && second >= 16 && second <= 31) return true;
	if (first === 192 && second === 168) return true;
	if (first === 169 && second === 254) return true;
	if (first === 100 && second >= 64 && second <= 127) return true;
	if (first === 192 && second === 0) return true;
	if (first === 198 && (second === 18 || second === 19)) return true;
	if (first >= 224) return true;
	return false;
}

function isPrivateIPv6(address: string): boolean {
	const normalized = address.toLowerCase();
	return (
		normalized === "::" ||
		normalized === "::1" ||
		normalized.startsWith("fc") ||
		normalized.startsWith("fd") ||
		normalized.startsWith("fe8") ||
		normalized.startsWith("fe9") ||
		normalized.startsWith("fea") ||
		normalized.startsWith("feb")
	);
}

export function isPrivateOrReservedAddress(address: string): boolean {
	const ipVersion = net.isIP(address);
	if (ipVersion === 4) {
		return isPrivateIPv4(address);
	}
	if (ipVersion === 6) {
		return isPrivateIPv6(address);
	}
	return true;
}

async function assertPublicHostname(hostname: string): Promise<void> {
	const normalizedHostname = hostname.trim().toLowerCase();
	if (!normalizedHostname) {
		throw new Error("Hostname is required");
	}

	if (
		BLOCKED_HOSTNAMES.has(normalizedHostname) ||
		normalizedHostname.endsWith(".local")
	) {
		throw new Error("Hostname is not allowed");
	}

	if (net.isIP(normalizedHostname)) {
		if (isPrivateOrReservedAddress(normalizedHostname)) {
			throw new Error("IP address is not allowed");
		}
		return;
	}

	const resolved = await dns.lookup(normalizedHostname, {
		all: true,
		verbatim: true,
	});
	if (!resolved.length) {
		throw new Error("Unable to resolve hostname");
	}

	if (resolved.some((record) => isPrivateOrReservedAddress(record.address))) {
		throw new Error("Resolved address is not allowed");
	}
}

export async function assertSafeOutgoingUrl(
	rawUrl: string,
	options?: {
		allowHttp?: boolean;
	},
): Promise<URL> {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new Error("URL must be valid");
	}

	const allowHttp = options?.allowHttp ?? false;
	if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) {
		throw new Error("Only allowed URL protocols are supported");
	}

	if (parsed.username || parsed.password) {
		throw new Error("URLs with embedded credentials are not allowed");
	}

	await assertPublicHostname(parsed.hostname);
	return parsed;
}

export async function assertSafeRedirectTarget(
	hostname: string,
): Promise<void> {
	await assertPublicHostname(hostname);
}
