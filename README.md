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
npm run dev
```

## Deploy

```bash
npm run deploy:production
```
