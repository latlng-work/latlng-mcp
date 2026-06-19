#!/usr/bin/env node

const SERVER_NAME = 'latlng-mcp';
const SERVER_VERSION = '0.1.0';
const DEFAULT_BASE_URL = 'https://api.latlng.work';

const tools = [
  {
    name: 'geocode_address',
    description: 'Convert an address or place name into latitude and longitude coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Address or place name to geocode.' },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
        lang: { type: 'string', description: 'Optional language code, for example en.' },
        lat: { type: 'number', description: 'Optional latitude to bias results.' },
        lon: { type: 'number', description: 'Optional longitude to bias results.' }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'reverse_geocode',
    description: 'Convert latitude and longitude coordinates into an address.',
    inputSchema: {
      type: 'object',
      properties: {
        lat: { type: 'number', description: 'Latitude.' },
        lon: { type: 'number', description: 'Longitude.' },
        limit: { type: 'integer', minimum: 1, maximum: 10, default: 1 },
        lang: { type: 'string', description: 'Optional language code, for example en.' }
      },
      required: ['lat', 'lon'],
      additionalProperties: false
    }
  },
  {
    name: 'search_places',
    description: 'Search for places by name, optionally biased by location and category.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Place name or search query.' },
        lat: { type: 'number', description: 'Optional latitude to bias results.' },
        lon: { type: 'number', description: 'Optional longitude to bias results.' },
        type: { type: 'string', description: 'Optional place category, for example restaurant or cafe.' },
        country: { type: 'string', description: 'Optional country code, for example US.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'find_nearby_places',
    description: 'Find points of interest near a latitude and longitude.',
    inputSchema: {
      type: 'object',
      properties: {
        lat: { type: 'number', description: 'Center latitude.' },
        lon: { type: 'number', description: 'Center longitude.' },
        radius: { type: 'integer', minimum: 1, maximum: 50000, default: 1000 },
        type: { type: 'string', description: 'Optional place category, for example restaurant or cafe.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
      },
      required: ['lat', 'lon'],
      additionalProperties: false
    }
  },
  {
    name: 'list_place_categories',
    description: 'List supported place categories for place search and nearby queries.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  }
];

function getApiKey() {
  const apiKey = process.env.LATLNG_API_KEY || '';
  if (!apiKey) {
    throw new Error('LATLNG_API_KEY is required for tool calls. Create a Server Key at https://dash.latlng.work.');
  }
  if (!apiKey.startsWith('latlng_')) {
    throw new Error('LATLNG_API_KEY must be a dashboard Server Key that starts with latlng_.');
  }
  return apiKey;
}

function getBaseUrl() {
  return (process.env.LATLNG_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function assertNumber(value, name) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`${name} must be a number.`);
  }
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value ?? fallback, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function buildUrl(path, params) {
  const url = new URL(`${getBaseUrl()}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function callLatLng(path, params) {
  const response = await fetch(buildUrl(path, params), {
    headers: {
      Accept: 'application/json',
      'User-Agent': `${SERVER_NAME}/${SERVER_VERSION}`,
      'X-Api-Key': getApiKey()
    }
  });

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && body.error
      ? body.error
      : `LatLng API returned HTTP ${response.status}`;
    const details = typeof body === 'object' && body !== null ? body : { body };
    throw new Error(`${message}: ${JSON.stringify(details)}`);
  }

  return body;
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'geocode_address': {
      const query = String(args.query || '').trim();
      if (!query) throw new Error('query is required.');
      return callLatLng('/api', {
        q: query,
        limit: clampInteger(args.limit, 5, 1, 20),
        lang: args.lang,
        lat: args.lat,
        lon: args.lon
      });
    }
    case 'reverse_geocode': {
      assertNumber(args.lat, 'lat');
      assertNumber(args.lon, 'lon');
      return callLatLng('/reverse', {
        lat: args.lat,
        lon: args.lon,
        limit: clampInteger(args.limit, 1, 1, 10),
        lang: args.lang
      });
    }
    case 'search_places': {
      const query = String(args.query || '').trim();
      if (!query) throw new Error('query is required.');
      return callLatLng('/v1/places/search', {
        q: query,
        lat: args.lat,
        lon: args.lon,
        type: args.type,
        country: args.country,
        limit: clampInteger(args.limit, 20, 1, 50)
      });
    }
    case 'find_nearby_places': {
      assertNumber(args.lat, 'lat');
      assertNumber(args.lon, 'lon');
      return callLatLng('/v1/places/nearby', {
        lat: args.lat,
        lon: args.lon,
        radius: clampInteger(args.radius, 1000, 1, 50000),
        type: args.type,
        limit: clampInteger(args.limit, 20, 1, 100)
      });
    }
    case 'list_place_categories':
      return callLatLng('/v1/places/categories', {});
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function success(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function failure(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleMessage(message) {
  if (!message || typeof message !== 'object') return;

  const { id, method, params } = message;

  try {
    if (method === 'initialize') {
      success(id, {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
      });
      return;
    }

    if (method === 'notifications/initialized') return;

    if (method === 'ping') {
      success(id, {});
      return;
    }

    if (method === 'tools/list') {
      success(id, { tools });
      return;
    }

    if (method === 'tools/call') {
      const result = await callTool(String(params?.name || ''), params?.arguments || {});
      success(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      return;
    }

    failure(id, -32601, `Method not found: ${method}`);
  } catch (error) {
    failure(id, -32000, error instanceof Error ? error.message : String(error));
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;
    try {
      void handleMessage(JSON.parse(line));
    } catch (error) {
      failure(null, -32700, error instanceof Error ? error.message : String(error));
    }
  }
});
