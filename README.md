# Google Search Console MCP Server

Remote HTTP MCP server for Google Search Console. Exposes 15 tools for search analytics, URL inspection, indexing, and sitemap management.

## Google Cloud Setup

### 1. Enable APIs

Enable both APIs in your Google Cloud project:

- [Google Search Console API](https://console.developers.google.com/apis/api/searchconsole.googleapis.com/overview)
- [Web Search Indexing API](https://console.developers.google.com/apis/api/indexing.googleapis.com/overview)

### 2. Create OAuth Credentials

1. Go to **APIs & Services > Credentials**
2. Click **Create Credentials > OAuth client ID**
3. Select **Web application**
4. Add your redirect URI. If deploying on MintMCP, this is `https://app.mintmcp.com/oauth/callback`. For other hosts, use the callback URL the platform provides.
5. Save the **Client ID** and **Client Secret**

### 3. Configure OAuth Consent Screen

Go to **APIs & Services > OAuth consent screen > Scopes** and add:

```
https://www.googleapis.com/auth/webmasters
https://www.googleapis.com/auth/indexing
```

| Scope | Grants access to |
|---|---|
| `webmasters` | Search Console read + write (analytics, sitemaps, URL inspection) |
| `indexing` | Indexing API (submit/remove URLs) |

### 4. OAuth URLs

| Field | Value |
|---|---|
| Authorization URL | `https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent` |
| Token URL | `https://oauth2.googleapis.com/token` |

The `access_type=offline` parameter is required to obtain a refresh token so the server can refresh expired access tokens automatically.

## Tools

### Discovery
- **list_sites** — List all Search Console properties the authenticated user has access to

### Analytics
- **search_analytics** — Query search analytics data (clicks, impressions, CTR, position) with filters and dimensions
- **site_snapshot** — Quick performance overview with top queries and pages
- **generate_report** — Comprehensive report with daily trends, device/country breakdowns

### Insights
- **quick_wins** — Keywords ranking positions 8-20 with decent impressions (close to page 1)
- **content_gaps** — Queries with high impressions but low CTR
- **traffic_drops** — Pages that lost clicks between two date ranges
- **ctr_opportunities** — Pages with below-average CTR for their position
- **cannibalization_check** — Queries where multiple pages compete
- **content_decay** — Pages with declining performance over time

### Inspection
- **url_inspection** — Check a URL's index status, crawl info, referring pages, and sitemaps

### Indexing
- **submit_url** — Submit a single URL to the Indexing API
- **batch_submit** — Submit up to 200 URLs per day

### Sitemaps
- **list_sitemaps** — List all submitted sitemaps
- **submit_sitemap** — Submit a new sitemap

## Deploying on MintMCP

Three settings in MintMCP's Hosted OAuth config trip people up. All three need to be set before the consent screen will appear.

**1. Redirect URI (in Google Cloud Console, not MintMCP)**

```
https://app.mintmcp.com/oauth/callback
```

Paste that into your Google OAuth client under **Authorized redirect URIs**.

**2. Scopes (MintMCP Hosted OAuth → Scopes field, comma-separated)**

Google requires fully qualified scope URIs. Short names (`webmasters`, `indexing`) are rejected.

```
https://www.googleapis.com/auth/webmasters,https://www.googleapis.com/auth/indexing
```

**3. Header mapping (MintMCP Hosted OAuth → Header mappings)**

Map the OAuth `access_token` response field to an outbound `Authorization` header with a `Bearer ` prefix (trailing space). This is what gets the token to the server on each request.

| Field | Header | Prefix |
|---|---|---|
| `access_token` | `Authorization` | `Bearer ` |

Save, then click **Continue with OAuth** on the Installation tab to complete the flow.

## Development

```bash
npm install
npm run dev
```

## Build & Run

```bash
npm run build
npm start
```

## Docker

```bash
docker build -t gsc-mcp .
docker run -p 8000:8000 gsc-mcp
```

## Authentication

The server extracts the OAuth access token from requests in this order:

1. `x-gsc-access-token` header
2. `Authorization: Bearer <token>` header
3. `GSC_ACCESS_TOKEN` environment variable
