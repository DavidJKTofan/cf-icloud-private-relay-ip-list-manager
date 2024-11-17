const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

// Function to handle GET requests (for general info about the worker and cron)
async function handleGetRequest(request) {
	const url = new URL(request.url);
	if (url.pathname === '/info') {
		return new Response(
			JSON.stringify(
				{
					worker_name: 'iCloud Private Relay IP List Manager',
					cron_trigger_info: {
						description: 'This Worker is scheduled to run every 14 days to fetch and update an IPv4 and IPv6 list.',
						cron_schedule: '0 0 */14 * *', // Every 14th day at midnight UTC
						time_zone: 'UTC',
					},
					status: 'Worker is running',
				},
				null,
				2
			),
			{
				headers: { 'Content-Type': 'application/json' },
			}
		);
	}

	return new Response('Not Found', { status: 404 });
}

// Function to fetch the IP list (IPv4 or IPv6)
async function fetchIPList(sourceURL) {
	const response = await fetch(sourceURL);
	if (!response.ok) {
		throw new Error(`Failed to fetch IP list: ${response.status}`);
	}

	const data = await response.json(); // Parse the JSON directly
	return data;
}

// Function to get or create the Cloudflare IP list
async function getOrCreateList(env) {
	const listsResponse = await fetch(`${CLOUDFLARE_API_BASE}/accounts/${env.ACCOUNT_ID}/rules/lists`, {
		method: 'GET',
		headers: {
			Authorization: `Bearer ${env.API_TOKEN}`,
			'Content-Type': 'application/json',
		},
	});

	if (!listsResponse.ok) {
		throw new Error(`Failed to fetch lists: ${listsResponse.status}`);
	}

	const { result } = await listsResponse.json();
	const existingList = result.find((list) => list.name === env.LIST_NAME);

	if (existingList) {
		return existingList.id;
	}

	const createResponse = await fetch(`${CLOUDFLARE_API_BASE}/accounts/${env.ACCOUNT_ID}/rules/lists`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.API_TOKEN}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			name: env.LIST_NAME,
			kind: 'ip',
			description: 'Managed List of iCloud Private Relay egress IP addresses (IPv4 & IPv6) created by Cloudflare Worker',
		}),
	});

	if (!createResponse.ok) {
		const errorData = await createResponse.json();
		throw new Error(`Failed to create list: ${JSON.stringify(errorData)}`);
	}

	const { result: newList } = await createResponse.json();
	return newList.id;
}

// Function to update the Cloudflare list with both IPv4 and IPv6 entries
async function updateListItems(listId, validIPs, env) {
	const items = validIPs.map((ip) => ({ ip }));

	const updateResponse = await fetch(`${CLOUDFLARE_API_BASE}/accounts/${env.ACCOUNT_ID}/rules/lists/${listId}/items`, {
		method: 'PUT',
		headers: {
			Authorization: `Bearer ${env.API_TOKEN}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(items),
	});

	if (!updateResponse.ok) {
		const errorData = await updateResponse.json();
		throw new Error(`Failed to update list items: ${JSON.stringify(errorData)}`);
	}

	return updateResponse.json();
}

export default {
	async fetch(request, env, ctx) {
		// Handle normal GET requests
		if (request.method === 'GET') {
			console.log('GET REQUEST');
			return handleGetRequest(request);
		}

		// Handle other HTTP methods as needed, or return a 405 for unsupported methods
		return new Response('Method Not Allowed', { status: 405 });
	},

	async scheduled(event, env, ctx) {
		try {
			console.log('Fetching IPv4 list from source URL...');
			const ipv4List = await fetchIPList(env.IPV4_LIST_SOURCE_URL);

			console.log('Fetching IPv6 list from source URL...');
			const ipv6List = await fetchIPList(env.IPV6_LIST_SOURCE_URL);

			// Combine both lists (IPv4 and IPv6)
			const combinedList = [...ipv4List, ...ipv6List];

			console.log(`Fetched ${combinedList.length} entries. Proceeding to update Cloudflare Managed List...`);

			// Fetch or create the Cloudflare list
			const listId = await getOrCreateList(env);

			// Update the list with both IPv4 and IPv6 entries
			console.log(`Updating the list with ${combinedList.length} items...`);
			const result = await updateListItems(listId, combinedList, env);

			console.log('List updated successfully:', result);
			console.log('Cron Trigger processed successfully!');
			console.log('SUCCESS');
		} catch (error) {
			console.log('ERROR');
			console.error('Error during scheduled task:', error.message);
			console.error(error.stack); // Full stack trace for debugging
		}
	},
};
