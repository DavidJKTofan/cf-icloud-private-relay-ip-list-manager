const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

// Operational knobs via env:
// - ACCOUNT_ID, API_TOKEN, LIST_NAME (required)
// - IPV4_LIST_SOURCE_URL, IPV6_LIST_SOURCE_URL (required)
// - ALLOW_IPV6_PROMOTE_TO_64 = 'true' | 'false' (optional, default 'false')
// - FETCH_RETRIES = integer (optional, default 3)

function log(...args) {
	// Replace with your preferred logging/monitoring
	console.log(...args);
}

async function fetchWithRetry(url, opts = {}, retries = 3, initialDelayMs = 300) {
	let attempt = 0;
	while (true) {
		try {
			const res = await fetch(url, opts);
			if (!res.ok) {
				// capture body (text) for better diagnostics
				let bodyText;
				try {
					bodyText = await res.text();
				} catch (e) {
					bodyText = '<unreadable body>';
				}
				const err = new Error(`HTTP ${res.status}: ${bodyText}`);
				err.status = res.status;
				err.body = bodyText;
				throw err;
			}
			return res;
		} catch (err) {
			attempt++;
			if (attempt > retries) throw err;
			const delay = initialDelayMs * Math.pow(2, attempt - 1);
			await new Promise((r) => setTimeout(r, delay));
		}
	}
}

async function fetchIPList(sourceURL, retries) {
	const res = await fetchWithRetry(sourceURL, { method: 'GET' }, retries);
	const ct = res.headers.get('content-type') || '';
	// Try JSON first (some sources return JSON array). Otherwise treat as text lines.
	if (ct.includes('application/json')) {
		const data = await res.json();
		if (!Array.isArray(data)) throw new Error('Expected JSON array from source');
		return data.map(String);
	}
	const text = await res.text();
	// If text looks like JSON array anyway
	const trimmed = text.trim();
	if (trimmed.startsWith('[')) {
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed)) return parsed.map(String);
		} catch (_) {}
	}
	// Treat as newline-separated list
	return trimmed
		.split(/\r?\n/)
		.map((s) => s.trim())
		.filter(Boolean);
}

// Detect IPv4 via simple URL parse and verify octets
function looksLikeIPv4(addr) {
	try {
		// URL will accept things like "127.0.0.1"
		new URL(`http://${addr}`);
		// Ensure exactly 4 octets in dotted form
		return /^\d{1,3}(\.\d{1,3}){3}$/.test(addr.split('/')[0]);
	} catch {
		return false;
	}
}

// Detect IPv6 via bracketed URL trick (works for many valid IPv6 forms)
function looksLikeIPv6(addr) {
	const ipOnly = addr.split('/')[0];
	try {
		new URL(`http://[${ipOnly}]`);
		return true;
	} catch {
		return false;
	}
}

function parseCIDR(entry) {
	const parts = String(entry).trim();
	if (!parts) return null;
	const slashIndex = parts.indexOf('/');
	if (slashIndex === -1) {
		return { ip: parts, prefix: null };
	}
	const ip = parts.slice(0, slashIndex);
	const prefixStr = parts.slice(slashIndex + 1);
	const prefix = Number(prefixStr);
	if (!Number.isFinite(prefix) || prefixStr.trim() === '' || String(prefix) !== prefixStr) return null;
	return { ip, prefix };
}

function normalizeIPv4(ip, prefix) {
	// Accept prefix null -> treat as /32
	const p = prefix === null ? 32 : prefix;
	if (p < 8 || p > 32) return null;
	// quick validation of octets
	const octets = ip.split('.');
	if (octets.length !== 4) return null;
	for (const o of octets) {
		if (!/^\d+$/.test(o)) return null;
		const n = Number(o);
		if (n < 0 || n > 255) return null;
	}
	return `${ip}/${p}`;
}

function normalizeIPv6(ip, prefix, allowPromoteTo64 = false) {
	// IPv6 must have prefix between 12 and 64 per your requirement.
	// If prefix === null and allowPromoteTo64 true, promote to /64.
	let p = prefix;
	if (p === null) {
		if (allowPromoteTo64) p = 64;
		else return null;
	}
	if (p < 12 || p > 64) return null;
	// Validate IPv6 via URL trick
	try {
		new URL(`http://[${ip}]`);
	} catch {
		return null;
	}
	return `${ip}/${p}`;
}

function validateAndNormalize(entry, opts = {}) {
	// Returns normalized CIDR string (e.g. "1.2.3.0/24" or "2606:.../64") or null if invalid.
	const parsed = parseCIDR(entry);
	if (!parsed) return null;
	const { ip, prefix } = parsed;
	if (looksLikeIPv4(ip)) {
		return normalizeIPv4(ip, prefix);
	} else if (looksLikeIPv6(ip)) {
		return normalizeIPv6(ip, prefix, opts.allowPromoteIPv6);
	}
	return null;
}

async function getOrCreateList(env) {
	const url = `${CLOUDFLARE_API_BASE}/accounts/${env.ACCOUNT_ID}/rules/lists`;
	const res = await fetchWithRetry(
		url,
		{
			method: 'GET',
			headers: { Authorization: `Bearer ${env.API_TOKEN}`, 'Content-Type': 'application/json' },
		},
		Number(env.FETCH_RETRIES || 3)
	);
	const { result } = await res.json();
	const existing = result.find((l) => l.name === env.LIST_NAME);
	if (existing) return existing.id;

	const createRes = await fetchWithRetry(
		url,
		{
			method: 'POST',
			headers: { Authorization: `Bearer ${env.API_TOKEN}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: env.LIST_NAME,
				kind: 'ip',
				description: 'Managed list of iCloud Private Relay egress IPs (IPv4 & IPv6) — maintained by Worker',
			}),
		},
		Number(env.FETCH_RETRIES || 3)
	);

	const createJson = await createRes.json();
	return createJson.result.id;
}

async function getListItems(env, listId, expectedCount) {
	const baseUrl = `${CLOUDFLARE_API_BASE}/accounts/${env.ACCOUNT_ID}/rules/lists/${listId}/items`;
	const perPage = 500;
	const maxItems = expectedCount || 20000; // upper bound to avoid infinite loop
	const items = [];
	let cursor = null;

	try {
		do {
			const url = `${baseUrl}?per_page=${perPage}` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
			const res = await fetchWithRetry(
				url,
				{
					method: 'GET',
					headers: { Authorization: `Bearer ${env.API_TOKEN}`, 'Content-Type': 'application/json' },
				},
				Number(env.FETCH_RETRIES || 3)
			);

			const json = await res.json();
			if (!json.result || !Array.isArray(json.result)) throw new Error(`Unexpected response shape: ${JSON.stringify(json)}`);

			const pageItems = json.result.map((r) => String(r.ip).trim()).filter(Boolean);
			items.push(...pageItems);

			if (items.length >= maxItems) {
				console.log(`getListItems: reached MAX_ITEMS (${maxItems}), stopping fetch.`);
				break;
			}

			const ri = json.result_info || {};
			cursor = ri.cursor || (ri.cursors ? ri.cursors.next || ri.cursors.after || null : null);

			if (!cursor || pageItems.length === 0) break;
		} while (true);

		return items;
	} catch (err) {
		console.error('getListItems failed:', err.message || err);
		throw err;
	}
}

function setsEqual(aArr, bArr) {
	if (aArr.length !== bArr.length) return false;
	const a = new Set(aArr);
	for (const v of bArr) if (!a.has(v)) return false;
	return true;
}

async function replaceListItems(env, listId, items) {
	// Cloudflare expects PUT with array of { ip: 'x/x' }.
	const url = `${CLOUDFLARE_API_BASE}/accounts/${env.ACCOUNT_ID}/rules/lists/${listId}/items`;
	const body = items.map((ip) => ({ ip }));
	const res = await fetchWithRetry(
		url,
		{
			method: 'PUT',
			headers: { Authorization: `Bearer ${env.API_TOKEN}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		},
		Number(env.FETCH_RETRIES || 3)
	);
	const json = await res.json();
	if (!json.success) throw new Error(`Failed to replace list items: ${JSON.stringify(json)}`);
	return json;
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === '/info') {
			return new Response(
				JSON.stringify(
					{
						worker_name: 'iCloud Private Relay IP List Manager (refactor)',
						cron_trigger_info: {
							description: 'Runs to fetch and update IPv4 and IPv6 lists (enforces CIDR bounds).',
						},
						status: 'running',
					},
					null,
					2
				),
				{ headers: { 'Content-Type': 'application/json' } }
			);
		}
		return new Response('Not Found', { status: 404 });
	},

	async scheduled(event, env, ctx) {
		// Run the heavy lifting in waitUntil so the scheduler returns quickly but the job continues.
		ctx.waitUntil(
			(async () => {
				try {
					if (!env.ACCOUNT_ID || !env.API_TOKEN || !env.LIST_NAME) {
						throw new Error('Missing required environment variables: ACCOUNT_ID, API_TOKEN, LIST_NAME');
					}
					const retries = Number(env.FETCH_RETRIES || 3);
					log('Fetching IPv4 source...');
					const rawIpv4 = await fetchIPList(env.IPV4_LIST_SOURCE_URL, retries);
					log('Fetching IPv6 source...');
					const rawIpv6 = await fetchIPList(env.IPV6_LIST_SOURCE_URL, retries);

					const allowPromoteIPv6 = String(env.ALLOW_IPV6_PROMOTE_TO_64 || 'false').toLowerCase() === 'true';
					const normalizeOpts = { allowPromoteIPv6 };
					const combinedRaw = [...rawIpv4, ...rawIpv6];
					log(`Fetched ${combinedRaw.length} raw entries.`);

					const normalized = [];
					const dropped = [];
					for (const entry of combinedRaw) {
						const n = validateAndNormalize(entry, normalizeOpts);
						if (n) normalized.push(n);
						else dropped.push(String(entry).trim());
					}

					// Deduplicate and sort
					const unique = Array.from(new Set(normalized)).sort();

					log(`Normalized ${unique.length} items. Dropped ${dropped.length} invalid entries.`);

					const listId = await getOrCreateList(env);
					log('Using listId:', listId);

					const existing = await getListItems(env, listId);
					log(`Existing list has ${existing.length} items.`);

					if (setsEqual(existing, unique)) {
						log('No changes detected. Skipping update.');
						return;
					}

					// Replace items
					log('Updating list with new items...');
					const resp = await replaceListItems(env, listId, unique);
					log('Update successful:', resp);
				} catch (err) {
					log('Scheduled job failed:', err && err.message ? err.message : err);
				}
			})()
		);
	},
};
