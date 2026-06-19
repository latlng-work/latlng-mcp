# LatLng MCP Worker

Standalone Cloudflare Worker for the remote LatLng MCP endpoint.

## Links

- Website: https://www.latlng.work
- MCP endpoint: https://mcp.latlng.work/mcp

## Endpoint

```text
POST https://mcp.latlng.work/mcp
GET  https://mcp.latlng.work/.well-known/mcp/server-card.json
GET  https://mcp.latlng.work/health
```

## Authentication

Tool discovery and the first 10 anonymous tool calls per day work without a key.
For higher limits, create a free LatLng Server Key at https://dash.latlng.work.

Accepted formats:

```text
Authorization: Bearer latlng_...
X-Api-Key: latlng_...
```

Public maps keys (`pk_latlng_...`) are rejected before tool discovery or tool calls. The worker validates keys against the same `latlng-db` D1 database used by the dashboard and API worker.

## Tools

- `geocode_address`
- `reverse_geocode`
- `search_places`
- `find_nearby_places`
- `list_place_categories`

## Development

```bash
npm install
npm run start
```

The `start` script runs a stdio MCP server for local clients and registry checks.
It answers `initialize`, `ping`, and `tools/list` without credentials. Tool calls
require a LatLng Server Key in `LATLNG_API_KEY`.

## Docker

```bash
docker build -t latlng-mcp .
docker run -i --rm -e LATLNG_API_KEY=latlng_your_dashboard_server_key latlng-mcp
```

For registry checks that only introspect the server, no API key is required.

## Worker Development

```bash
npm install
npm run dev
```

## Deploy

```bash
npm run deploy:production
```
