interface Env {
  DB: D1Database;
  API_BASE_URL: string;
  DASHBOARD_URL: string;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<unknown>;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, any>;
}

interface ApiKeyRecord {
  id: string;
  user_id: string;
  key_type?: string | null;
  plan?: string | null;
}

const SERVER_NAME = 'latlng-mcp';
const SERVER_VERSION = '0.1.0';
const API_KEY_CACHE_TTL_MS = 5 * 60 * 1000;
const MCP_REGISTRY_AUTH = 'v=MCPv1; k=ecdsap384; p=Au18cMa5MP2TV4IdOdcUkLrBgmmkPTw8WEXs8otd+uQPiasin+vv7gd+ncphoIkHdg==';

const apiKeyCache = new Map<string, {
  valid: boolean;
  keyType: string;
  userId: string | null;
  plan: string;
  keyId: string | null;
  expiresAt: number;
}>();

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
        lon: { type: 'number', description: 'Optional longitude to bias results.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
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
        lang: { type: 'string', description: 'Optional language code, for example en.' },
      },
      required: ['lat', 'lon'],
      additionalProperties: false,
    },
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
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
      required: ['query'],
      additionalProperties: false,
    },
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
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      required: ['lat', 'lon'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_place_categories',
    description: 'List supported place categories for place search and nearby queries.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

function corsHeaders(request: Request): HeadersInit {
  return {
    'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key',
    'Access-Control-Allow-Credentials': 'true',
  };
}

function jsonResponse(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(request),
    },
  });
}

function jsonRpcResult(id: JsonRpcRequest['id'], result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function jsonRpcError(id: JsonRpcRequest['id'], code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function getApiKey(request: Request): string {
  const auth = request.headers.get('Authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }

  const headerKey = request.headers.get('X-Api-Key');
  if (headerKey) return headerKey.trim();

  return '';
}

async function hashApiKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function validateServerKey(apiKey: string, env: Env): Promise<{ valid: true; userId: string; plan: string; keyId: string } | { valid: false; reason: string }> {
  if (!apiKey) {
    return { valid: false, reason: `Missing API key. Create a Server Key in the LatLng dashboard at ${env.DASHBOARD_URL}.` };
  }

  if (!apiKey.startsWith('latlng_')) {
    return { valid: false, reason: 'MCP requires a dashboard Server Key that starts with latlng_. Public maps keys that start with pk_latlng_ are not allowed.' };
  }

  const cached = apiKeyCache.get(apiKey);
  if (cached && cached.expiresAt > Date.now()) {
    if (!cached.valid || cached.keyType !== 'secret' || !cached.userId || !cached.keyId) {
      return { valid: false, reason: 'Invalid LatLng Server Key.' };
    }
    return { valid: true, userId: cached.userId, plan: cached.plan, keyId: cached.keyId };
  }

  const keyHash = await hashApiKey(apiKey);
  const row = await env.DB.prepare(`
    SELECT ak.id, ak.user_id, ak.key_type, u.plan
    FROM api_keys ak
    JOIN users u ON ak.user_id = u.id
    WHERE ak.key_hash = ?
  `).bind(keyHash).first<ApiKeyRecord>();

  if (!row) {
    apiKeyCache.set(apiKey, {
      valid: false,
      keyType: 'secret',
      userId: null,
      plan: 'free',
      keyId: null,
      expiresAt: Date.now() + API_KEY_CACHE_TTL_MS,
    });
    return { valid: false, reason: 'Invalid LatLng Server Key.' };
  }

  const keyType = row.key_type || 'secret';
  apiKeyCache.set(apiKey, {
    valid: true,
    keyType,
    userId: row.user_id,
    plan: row.plan || 'free',
    keyId: row.id,
    expiresAt: Date.now() + API_KEY_CACHE_TTL_MS,
  });

  if (keyType !== 'secret') {
    return { valid: false, reason: 'MCP requires a secret Server Key. Public maps keys are not allowed.' };
  }

  await env.DB.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?')
    .bind(new Date().toISOString(), row.id)
    .run()
    .catch(() => undefined);

  return { valid: true, userId: row.user_id, plan: row.plan || 'free', keyId: row.id };
}

function assertNumber(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`${name} must be a number.`);
  }
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function apiUrl(env: Env, path: string, params: Record<string, unknown>): URL {
  const url = new URL(`${env.API_BASE_URL.replace(/\/+$/, '')}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function callLatLng(env: Env, apiKey: string, path: string, params: Record<string, unknown>) {
  const response = await fetch(apiUrl(env, path, params), {
    headers: {
      'Accept': 'application/json',
      'User-Agent': `${SERVER_NAME}/${SERVER_VERSION}`,
      'X-Api-Key': apiKey,
    },
  });

  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body
      ? String((body as { error: unknown }).error)
      : `LatLng API returned HTTP ${response.status}`;
    throw new Error(`${message}: ${JSON.stringify(body)}`);
  }

  return body;
}

async function callTool(env: Env, apiKey: string, name: string, args: Record<string, any> = {}) {
  switch (name) {
    case 'geocode_address': {
      const query = String(args.query || '').trim();
      if (!query) throw new Error('query is required.');
      return callLatLng(env, apiKey, '/api', {
        q: query,
        limit: clampInteger(args.limit, 5, 1, 20),
        lang: args.lang,
        lat: args.lat,
        lon: args.lon,
      });
    }
    case 'reverse_geocode': {
      assertNumber(args.lat, 'lat');
      assertNumber(args.lon, 'lon');
      return callLatLng(env, apiKey, '/reverse', {
        lat: args.lat,
        lon: args.lon,
        limit: clampInteger(args.limit, 1, 1, 10),
        lang: args.lang,
      });
    }
    case 'search_places': {
      const query = String(args.query || '').trim();
      if (!query) throw new Error('query is required.');
      return callLatLng(env, apiKey, '/v1/places/search', {
        q: query,
        lat: args.lat,
        lon: args.lon,
        type: args.type,
        country: args.country,
        limit: clampInteger(args.limit, 20, 1, 50),
      });
    }
    case 'find_nearby_places': {
      assertNumber(args.lat, 'lat');
      assertNumber(args.lon, 'lon');
      return callLatLng(env, apiKey, '/v1/places/nearby', {
        lat: args.lat,
        lon: args.lon,
        radius: clampInteger(args.radius, 1000, 1, 50000),
        type: args.type,
        limit: clampInteger(args.limit, 20, 1, 100),
      });
    }
    case 'list_place_categories':
      return callLatLng(env, apiKey, '/v1/places/categories', {});
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function serverCard(request: Request) {
  const origin = new URL(request.url).origin;
  return jsonResponse(request, {
    serverInfo: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    authentication: {
      required: true,
      schemes: ['apiKey'],
      instructions: 'Pass a LatLng dashboard Server Key using Authorization: Bearer latlng_... or X-Api-Key: latlng_.... Public maps keys are rejected.',
    },
    endpoints: {
      mcp: `${origin}/mcp`,
    },
    tools,
    resources: [],
    prompts: [],
  });
}

async function handleJsonRpc(request: Request, env: Env): Promise<Response> {
  const apiKey = getApiKey(request);
  const auth = await validateServerKey(apiKey, env);
  if (!auth.valid) {
    return jsonResponse(request, jsonRpcError(null, -32001, auth.reason), 401);
  }

  let rpc: JsonRpcRequest;
  try {
    rpc = await request.json() as JsonRpcRequest;
  } catch {
    return jsonResponse(request, jsonRpcError(null, -32700, 'Invalid JSON-RPC payload.'), 400);
  }

  try {
    switch (rpc.method) {
      case 'initialize':
        return jsonResponse(request, jsonRpcResult(rpc.id, {
          protocolVersion: rpc.params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }));

      case 'notifications/initialized':
        return new Response(null, { status: 202, headers: corsHeaders(request) });

      case 'ping':
        return jsonResponse(request, jsonRpcResult(rpc.id, {}));

      case 'tools/list':
        return jsonResponse(request, jsonRpcResult(rpc.id, { tools }));

      case 'tools/call': {
        const result = await callTool(env, apiKey, String(rpc.params?.name || ''), rpc.params?.arguments || {});
        return jsonResponse(request, jsonRpcResult(rpc.id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        }));
      }

      case 'resources/list':
        return jsonResponse(request, jsonRpcResult(rpc.id, { resources: [] }));

      case 'prompts/list':
        return jsonResponse(request, jsonRpcResult(rpc.id, { prompts: [] }));

      default:
        return jsonResponse(request, jsonRpcError(rpc.id, -32601, `Method not found: ${rpc.method}`), 404);
    }
  } catch (error) {
    if (rpc.method === 'tools/call') {
      return jsonResponse(request, jsonRpcResult(rpc.id, {
        isError: true,
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      }));
    }

    return jsonResponse(request, jsonRpcError(rpc.id, -32000, error instanceof Error ? error.message : String(error)), 500);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(request) });
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return jsonResponse(request, { status: 'ok', service: SERVER_NAME });
    }

    if (request.method === 'GET' && url.pathname === '/.well-known/mcp/server-card.json') {
      return serverCard(request);
    }

    if (request.method === 'GET' && url.pathname === '/.well-known/mcp-registry-auth') {
      return new Response(MCP_REGISTRY_AUTH, {
        headers: {
          ...corsHeaders(request),
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'public, max-age=300',
        },
      });
    }

    if (request.method === 'POST' && (url.pathname === '/' || url.pathname === '/mcp')) {
      return handleJsonRpc(request, env);
    }

    return jsonResponse(request, { error: 'Not found' }, 404);
  },
};
