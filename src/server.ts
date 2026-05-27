import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import {
  requestContext,
  querySearchAnalytics,
  inspectUrl,
  listSitemaps,
  submitSitemap,
  submitUrlForIndexing,
  batchSubmitUrls,
  listSites,
} from "./gsc-client.js";

// ── Helper schemas ────────────────────────────────────────────────

const siteUrlSchema = z.string().describe(
  "The site URL as it appears in Search Console. Domain properties use 'sc-domain:example.com', URL-prefix properties use 'https://example.com/'.",
);

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Date in YYYY-MM-DD format.");

const dimensionFilterSchema = z.object({
  dimension: z.enum(["query", "page", "country", "device", "searchAppearance"]).describe("Dimension to filter on."),
  operator: z.enum(["equals", "notEquals", "contains", "notContains", "includingRegex", "excludingRegex"]).describe("Filter operator."),
  expression: z.string().describe("Filter value or regex pattern."),
});

// ── Server factory ────────────────────────────────────────────────

function createServer(): McpServer {
  const server = new McpServer(
    { name: "google-search-console", version: "0.1.0" },
    {
      instructions: [
        "Google Search Console MCP server. All tools require a siteUrl — use list_sites to discover available properties.",
        "Site URLs use the format 'sc-domain:example.com' for domain properties or 'https://example.com/' for URL-prefix properties.",
        "Date ranges should use YYYY-MM-DD format. GSC data is typically available with a 2-3 day delay.",
        "Use search_analytics for raw data queries. Use the analysis tools (quick_wins, content_gaps, etc.) for pre-built insights.",
      ].join("\n"),
    },
  );

  // ── list_sites ────────────────────────────────────────────────────

  server.registerTool(
    "list_sites",
  {
    description:
      "List all Search Console properties the authenticated user has access to. Call this first to discover valid siteUrl values for other tools.",
    inputSchema: {},
    outputSchema: {
      sites: z.array(z.object({
        siteUrl: z.string(),
        permissionLevel: z.string(),
      })),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    const data = await listSites();
    const sites = (data.siteEntry ?? []).map((s) => ({
      siteUrl: s.siteUrl ?? "",
      permissionLevel: s.permissionLevel ?? "unknown",
    }));
    const output = { sites };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
      structuredContent: output,
    };
  },
);

// ── search_analytics ──────────────────────────────────────────────

server.registerTool(
  "search_analytics",
  {
    description:
      "Query Google Search Console analytics data. Returns clicks, impressions, CTR, and position for the specified dimensions and date range. This is the core data tool — use it for custom queries. For pre-built insights, use quick_wins, content_gaps, traffic_drops, etc.",
    inputSchema: {
      siteUrl: siteUrlSchema,
      startDate: dateSchema.describe("Start date (inclusive) in YYYY-MM-DD format."),
      endDate: dateSchema.describe("End date (inclusive) in YYYY-MM-DD format."),
      dimensions: z.array(z.enum(["query", "page", "country", "device", "date", "searchAppearance"]))
        .default(["query"])
        .describe("Dimensions to group results by. Common: ['query'], ['page'], ['query','page'], ['date']."),
      filters: z.array(dimensionFilterSchema).optional()
        .describe("Optional filters to narrow results. Example: filter by country='usa' or page containing '/blog/'."),
      rowLimit: z.coerce.number().int().min(1).max(25000).default(1000)
        .describe("Max rows to return. Hard cap 25000."),
      startRow: z.coerce.number().int().min(0).default(0)
        .describe("Pagination offset. Use with rowLimit to page through results."),
      type: z.enum(["web", "image", "video", "news", "discover", "googleNews"]).default("web")
        .describe("Search type to query."),
      aggregationType: z.enum(["auto", "byPage", "byProperty"]).default("auto")
        .describe("How to aggregate results. 'byPage' gives per-URL data, 'byProperty' aggregates across the property."),
      dataState: z.enum(["final", "all"]).default("final")
        .describe("'final' = only finalized data. 'all' = includes fresh/partial data."),
    },
    outputSchema: {
      rows: z.array(z.object({
        keys: z.array(z.string()),
        clicks: z.number(),
        impressions: z.number(),
        ctr: z.number(),
        position: z.number(),
      })),
      responseAggregationType: z.string(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ siteUrl, startDate, endDate, dimensions, filters, rowLimit, startRow, type, aggregationType, dataState }) => {
    const dimensionFilterGroups = filters?.length
      ? [{ filters: filters.map((f) => ({ dimension: f.dimension, operator: f.operator, expression: f.expression })) }]
      : undefined;

    const data = await querySearchAnalytics({
      siteUrl,
      startDate,
      endDate,
      dimensions,
      dimensionFilterGroups,
      rowLimit,
      startRow,
      type,
      aggregationType,
      dataState,
    });

    const output = {
      rows: (data.rows ?? []).map((r) => ({
        keys: r.keys ?? [],
        clicks: r.clicks ?? 0,
        impressions: r.impressions ?? 0,
        ctr: r.ctr ?? 0,
        position: r.position ?? 0,
      })),
      responseAggregationType: data.responseAggregationType ?? aggregationType,
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
      structuredContent: output,
    };
  },
);

// ── site_snapshot ─────────────────────────────────────────────────

server.registerTool(
  "site_snapshot",
  {
    description:
      "Get a quick performance overview for a site over a date range. Returns totals and top queries/pages. Good for a fast health check.",
    inputSchema: {
      siteUrl: siteUrlSchema,
      startDate: dateSchema,
      endDate: dateSchema,
    },
    outputSchema: {
      totals: z.object({ clicks: z.number(), impressions: z.number(), ctr: z.number(), position: z.number() }),
      topQueries: z.array(z.object({ query: z.string(), clicks: z.number(), impressions: z.number(), ctr: z.number(), position: z.number() })),
      topPages: z.array(z.object({ page: z.string(), clicks: z.number(), impressions: z.number(), ctr: z.number(), position: z.number() })),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ siteUrl, startDate, endDate }) => {
    const [totalsData, queriesData, pagesData] = await Promise.all([
      querySearchAnalytics({ siteUrl, startDate, endDate, dimensions: [], rowLimit: 1 }),
      querySearchAnalytics({ siteUrl, startDate, endDate, dimensions: ["query"], rowLimit: 10 }),
      querySearchAnalytics({ siteUrl, startDate, endDate, dimensions: ["page"], rowLimit: 10 }),
    ]);

    const firstRow = totalsData.rows?.[0];
    const output = {
      totals: {
        clicks: firstRow?.clicks ?? 0,
        impressions: firstRow?.impressions ?? 0,
        ctr: firstRow?.ctr ?? 0,
        position: firstRow?.position ?? 0,
      },
      topQueries: (queriesData.rows ?? []).map((r) => ({
        query: r.keys?.[0] ?? "",
        clicks: r.clicks ?? 0,
        impressions: r.impressions ?? 0,
        ctr: r.ctr ?? 0,
        position: r.position ?? 0,
      })),
      topPages: (pagesData.rows ?? []).map((r) => ({
        page: r.keys?.[0] ?? "",
        clicks: r.clicks ?? 0,
        impressions: r.impressions ?? 0,
        ctr: r.ctr ?? 0,
        position: r.position ?? 0,
      })),
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
      structuredContent: output,
    };
  },
);

// ── quick_wins ────────────────────────────────────────────────────

server.registerTool(
  "quick_wins",
  {
    description:
      "Find keywords ranking in positions 8-20 with decent impressions — these are close to page 1 and may only need small optimizations to break through. Returns queries sorted by impression count descending.",
    inputSchema: {
      siteUrl: siteUrlSchema,
      startDate: dateSchema,
      endDate: dateSchema,
      minImpressions: z.coerce.number().int().min(0).default(100)
        .describe("Minimum impressions threshold. Lower for low-traffic sites."),
    },
    outputSchema: {
      quickWins: z.array(z.object({
        query: z.string(),
        page: z.string(),
        clicks: z.number(),
        impressions: z.number(),
        ctr: z.number(),
        position: z.number(),
      })),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ siteUrl, startDate, endDate, minImpressions }) => {
    const data = await querySearchAnalytics({
      siteUrl,
      startDate,
      endDate,
      dimensions: ["query", "page"],
      rowLimit: 25000,
    });

    const quickWins = (data.rows ?? [])
      .filter((r) => {
        const pos = r.position ?? 0;
        return pos >= 8 && pos <= 20 && (r.impressions ?? 0) >= minImpressions;
      })
      .sort((a, b) => (b.impressions ?? 0) - (a.impressions ?? 0))
      .slice(0, 50)
      .map((r) => ({
        query: r.keys?.[0] ?? "",
        page: r.keys?.[1] ?? "",
        clicks: r.clicks ?? 0,
        impressions: r.impressions ?? 0,
        ctr: r.ctr ?? 0,
        position: r.position ?? 0,
      }));

    const output = { quickWins };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
      structuredContent: output,
    };
  },
);

// ── content_gaps ──────────────────────────────────────────────────

server.registerTool(
  "content_gaps",
  {
    description:
      "Find queries with high impressions but very low CTR — your site appears in results but users aren't clicking. These suggest missing or weak content that could be improved or created.",
    inputSchema: {
      siteUrl: siteUrlSchema,
      startDate: dateSchema,
      endDate: dateSchema,
      maxCtr: z.coerce.number().min(0).max(1).default(0.02)
        .describe("Max CTR threshold. Queries below this are considered gaps. Default 2%."),
      minImpressions: z.coerce.number().int().min(0).default(200)
        .describe("Minimum impressions to filter noise."),
    },
    outputSchema: {
      gaps: z.array(z.object({
        query: z.string(),
        impressions: z.number(),
        clicks: z.number(),
        ctr: z.number(),
        position: z.number(),
      })),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ siteUrl, startDate, endDate, maxCtr, minImpressions }) => {
    const data = await querySearchAnalytics({
      siteUrl,
      startDate,
      endDate,
      dimensions: ["query"],
      rowLimit: 25000,
    });

    const gaps = (data.rows ?? [])
      .filter((r) => (r.ctr ?? 0) <= maxCtr && (r.impressions ?? 0) >= minImpressions)
      .sort((a, b) => (b.impressions ?? 0) - (a.impressions ?? 0))
      .slice(0, 50)
      .map((r) => ({
        query: r.keys?.[0] ?? "",
        impressions: r.impressions ?? 0,
        clicks: r.clicks ?? 0,
        ctr: r.ctr ?? 0,
        position: r.position ?? 0,
      }));

    const output = { gaps };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
      structuredContent: output,
    };
  },
);

// ── traffic_drops ─────────────────────────────────────────────────

server.registerTool(
  "traffic_drops",
  {
    description:
      "Compare two date ranges and find pages that lost the most clicks. Useful for diagnosing traffic declines after algorithm updates or content changes.",
    inputSchema: {
      siteUrl: siteUrlSchema,
      currentStartDate: dateSchema.describe("Start of the current/recent period."),
      currentEndDate: dateSchema.describe("End of the current/recent period."),
      previousStartDate: dateSchema.describe("Start of the comparison period (should be same duration)."),
      previousEndDate: dateSchema.describe("End of the comparison period."),
      minPreviousClicks: z.coerce.number().int().min(0).default(10)
        .describe("Minimum clicks in the previous period to filter noise."),
    },
    outputSchema: {
      drops: z.array(z.object({
        page: z.string(),
        previousClicks: z.number(),
        currentClicks: z.number(),
        clickChange: z.number(),
        previousPosition: z.number(),
        currentPosition: z.number(),
      })),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ siteUrl, currentStartDate, currentEndDate, previousStartDate, previousEndDate, minPreviousClicks }) => {
    const [currentData, previousData] = await Promise.all([
      querySearchAnalytics({ siteUrl, startDate: currentStartDate, endDate: currentEndDate, dimensions: ["page"], rowLimit: 25000 }),
      querySearchAnalytics({ siteUrl, startDate: previousStartDate, endDate: previousEndDate, dimensions: ["page"], rowLimit: 25000 }),
    ]);

    const previousMap = new Map(
      (previousData.rows ?? []).map((r) => [r.keys?.[0] ?? "", r]),
    );

    const drops = (currentData.rows ?? [])
      .map((r) => {
        const page = r.keys?.[0] ?? "";
        const prev = previousMap.get(page);
        if (!prev || (prev.clicks ?? 0) < minPreviousClicks) return null;
        return {
          page,
          previousClicks: prev.clicks ?? 0,
          currentClicks: r.clicks ?? 0,
          clickChange: (r.clicks ?? 0) - (prev.clicks ?? 0),
          previousPosition: prev.position ?? 0,
          currentPosition: r.position ?? 0,
        };
      })
      .filter((d): d is NonNullable<typeof d> => d !== null && d.clickChange < 0)
      .sort((a, b) => a.clickChange - b.clickChange)
      .slice(0, 50);

    const output = { drops };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
      structuredContent: output,
    };
  },
);

// ── ctr_opportunities ─────────────────────────────────────────────

server.registerTool(
  "ctr_opportunities",
  {
    description:
      "Find pages with high impressions but below-average CTR for their position. These pages rank well but their titles/descriptions aren't compelling enough to earn clicks.",
    inputSchema: {
      siteUrl: siteUrlSchema,
      startDate: dateSchema,
      endDate: dateSchema,
      minImpressions: z.coerce.number().int().min(0).default(500)
        .describe("Minimum impressions threshold."),
    },
    outputSchema: {
      opportunities: z.array(z.object({
        page: z.string(),
        clicks: z.number(),
        impressions: z.number(),
        ctr: z.number(),
        position: z.number(),
        expectedCtr: z.number(),
        ctrGap: z.number(),
      })),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ siteUrl, startDate, endDate, minImpressions }) => {
    // Rough expected CTR by position (industry benchmarks)
    const expectedCtrByPosition = (pos: number): number => {
      if (pos <= 1) return 0.30;
      if (pos <= 2) return 0.18;
      if (pos <= 3) return 0.12;
      if (pos <= 4) return 0.08;
      if (pos <= 5) return 0.06;
      if (pos <= 7) return 0.04;
      if (pos <= 10) return 0.025;
      return 0.01;
    };

    const data = await querySearchAnalytics({
      siteUrl,
      startDate,
      endDate,
      dimensions: ["page"],
      rowLimit: 25000,
    });

    const opportunities = (data.rows ?? [])
      .filter((r) => (r.impressions ?? 0) >= minImpressions)
      .map((r) => {
        const pos = r.position ?? 0;
        const ctr = r.ctr ?? 0;
        const expected = expectedCtrByPosition(pos);
        return {
          page: r.keys?.[0] ?? "",
          clicks: r.clicks ?? 0,
          impressions: r.impressions ?? 0,
          ctr,
          position: pos,
          expectedCtr: expected,
          ctrGap: expected - ctr,
        };
      })
      .filter((r) => r.ctrGap > 0)
      .sort((a, b) => b.ctrGap * b.impressions - a.ctrGap * a.impressions)
      .slice(0, 50);

    const output = { opportunities };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
      structuredContent: output,
    };
  },
);

// ── cannibalization_check ─────────────────────────────────────────

server.registerTool(
  "cannibalization_check",
  {
    description:
      "Find queries where multiple pages from your site compete for the same keyword. Cannibalization dilutes ranking power — consolidating pages can improve overall performance.",
    inputSchema: {
      siteUrl: siteUrlSchema,
      startDate: dateSchema,
      endDate: dateSchema,
      minImpressions: z.coerce.number().int().min(0).default(50)
        .describe("Minimum impressions per query-page pair to include."),
    },
    outputSchema: {
      cannibalized: z.array(z.object({
        query: z.string(),
        pages: z.array(z.object({
          page: z.string(),
          clicks: z.number(),
          impressions: z.number(),
          ctr: z.number(),
          position: z.number(),
        })),
      })),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ siteUrl, startDate, endDate, minImpressions }) => {
    const data = await querySearchAnalytics({
      siteUrl,
      startDate,
      endDate,
      dimensions: ["query", "page"],
      rowLimit: 25000,
    });

    // Group by query
    const byQuery = new Map<string, Array<{ page: string; clicks: number; impressions: number; ctr: number; position: number }>>();
    for (const r of data.rows ?? []) {
      if ((r.impressions ?? 0) < minImpressions) continue;
      const query = r.keys?.[0] ?? "";
      const entry = {
        page: r.keys?.[1] ?? "",
        clicks: r.clicks ?? 0,
        impressions: r.impressions ?? 0,
        ctr: r.ctr ?? 0,
        position: r.position ?? 0,
      };
      if (!byQuery.has(query)) byQuery.set(query, []);
      byQuery.get(query)!.push(entry);
    }

    const cannibalized = Array.from(byQuery.entries())
      .filter(([, pages]) => pages.length > 1)
      .map(([query, pages]) => ({
        query,
        pages: pages.sort((a, b) => b.impressions - a.impressions),
      }))
      .sort((a, b) => {
        const aImps = a.pages.reduce((s, p) => s + p.impressions, 0);
        const bImps = b.pages.reduce((s, p) => s + p.impressions, 0);
        return bImps - aImps;
      })
      .slice(0, 30);

    const output = { cannibalized };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
      structuredContent: output,
    };
  },
);

// ── content_decay ─────────────────────────────────────────────────

server.registerTool(
  "content_decay",
  {
    description:
      "Find pages with declining performance over time. Compares the first and second half of the date range to identify pages losing clicks/impressions progressively.",
    inputSchema: {
      siteUrl: siteUrlSchema,
      startDate: dateSchema.describe("Start of the analysis window (use a range of at least 60 days for meaningful results)."),
      endDate: dateSchema.describe("End of the analysis window."),
      minClicks: z.coerce.number().int().min(0).default(20)
        .describe("Minimum clicks in the first half to filter noise."),
    },
    outputSchema: {
      decaying: z.array(z.object({
        page: z.string(),
        firstHalfClicks: z.number(),
        secondHalfClicks: z.number(),
        clickDecline: z.number(),
        declinePercent: z.number(),
      })),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ siteUrl, startDate, endDate, minClicks }) => {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const mid = new Date(start.getTime() + (end.getTime() - start.getTime()) / 2);
    const midStr = mid.toISOString().split("T")[0];

    const [firstHalf, secondHalf] = await Promise.all([
      querySearchAnalytics({ siteUrl, startDate, endDate: midStr, dimensions: ["page"], rowLimit: 25000 }),
      querySearchAnalytics({ siteUrl, startDate: midStr, endDate, dimensions: ["page"], rowLimit: 25000 }),
    ]);

    const firstMap = new Map(
      (firstHalf.rows ?? []).map((r) => [r.keys?.[0] ?? "", r.clicks ?? 0]),
    );

    const decaying = (secondHalf.rows ?? [])
      .map((r) => {
        const page = r.keys?.[0] ?? "";
        const firstClicks = firstMap.get(page) ?? 0;
        const secondClicks = r.clicks ?? 0;
        if (firstClicks < minClicks) return null;
        const decline = secondClicks - firstClicks;
        return {
          page,
          firstHalfClicks: firstClicks,
          secondHalfClicks: secondClicks,
          clickDecline: decline,
          declinePercent: firstClicks > 0 ? Math.round((decline / firstClicks) * 100) : 0,
        };
      })
      .filter((d): d is NonNullable<typeof d> => d !== null && d.clickDecline < 0)
      .sort((a, b) => a.clickDecline - b.clickDecline)
      .slice(0, 50);

    const output = { decaying };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
      structuredContent: output,
    };
  },
);

// ── url_inspection ────────────────────────────────────────────────

server.registerTool(
  "url_inspection",
  {
    description:
      "Inspect a specific URL's index status in Google Search. Returns crawl info, indexing status, mobile usability, and rich results. Use this to debug why a page isn't appearing in search results.",
    inputSchema: {
      siteUrl: siteUrlSchema,
      inspectionUrl: z.string().url().describe("The fully qualified URL to inspect (e.g., 'https://example.com/page')."),
    },
    outputSchema: {
      inspectionResult: z.object({
        indexStatusResult: z.object({
          verdict: z.string(),
          coverageState: z.string(),
          crawledAs: z.string().optional(),
          lastCrawlTime: z.string().optional(),
          pageFetchState: z.string().optional(),
          robotsTxtState: z.string().optional(),
          indexingState: z.string().optional(),
          referringUrls: z.array(z.string()).optional(),
          sitemap: z.array(z.string()).optional(),
        }).optional(),
        mobileUsabilityResult: z.object({
          verdict: z.string(),
        }).optional(),
        richResultsResult: z.object({
          verdict: z.string(),
        }).optional(),
      }),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ siteUrl, inspectionUrl }) => {
    const data = await inspectUrl(siteUrl, inspectionUrl);

    const idx = data.inspectionResult?.indexStatusResult;
    const output = {
      inspectionResult: {
        indexStatusResult: idx
          ? {
              verdict: idx.verdict ?? "UNKNOWN",
              coverageState: idx.coverageState ?? "UNKNOWN",
              crawledAs: idx.crawledAs ?? undefined,
              lastCrawlTime: idx.lastCrawlTime ?? undefined,
              pageFetchState: idx.pageFetchState ?? undefined,
              robotsTxtState: idx.robotsTxtState ?? undefined,
              indexingState: idx.indexingState ?? undefined,
              referringUrls: idx.referringUrls ?? undefined,
              sitemap: idx.sitemap ?? undefined,
            }
          : undefined,
        mobileUsabilityResult: data.inspectionResult?.mobileUsabilityResult
          ? { verdict: data.inspectionResult.mobileUsabilityResult.verdict ?? "UNKNOWN" }
          : undefined,
        richResultsResult: data.inspectionResult?.richResultsResult
          ? { verdict: data.inspectionResult.richResultsResult.verdict ?? "UNKNOWN" }
          : undefined,
      },
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
      structuredContent: output,
    };
  },
);

// ── submit_url ────────────────────────────────────────────────────

server.registerTool(
  "submit_url",
  {
    description:
      "Submit a single URL to Google's Indexing API for crawling. Use URL_UPDATED to request indexing, URL_DELETED to request removal. Note: the Indexing API officially supports JobPosting and BroadcastEvent schema pages, but works broadly in practice.",
    inputSchema: {
      url: z.string().url().describe("The fully qualified URL to submit."),
      type: z.enum(["URL_UPDATED", "URL_DELETED"]).default("URL_UPDATED")
        .describe("URL_UPDATED = request indexing. URL_DELETED = request removal from index."),
    },
    outputSchema: {
      status: z.string(),
      url: z.string(),
      type: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ url, type }) => {
    await submitUrlForIndexing(url, type);
    const output = { status: "success", url, type };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
      structuredContent: output,
    };
  },
);

// ── batch_submit ──────────────────────────────────────────────────

server.registerTool(
  "batch_submit",
  {
    description:
      "Submit multiple URLs to Google's Indexing API in batch. Daily quota is 200 URLs. Each URL is submitted sequentially and results are reported individually.",
    inputSchema: {
      urls: z.array(z.string().url()).min(1).max(200)
        .describe("Array of fully qualified URLs to submit. Max 200 per day."),
      type: z.enum(["URL_UPDATED", "URL_DELETED"]).default("URL_UPDATED")
        .describe("URL_UPDATED = request indexing. URL_DELETED = request removal."),
    },
    outputSchema: {
      results: z.array(z.object({
        url: z.string(),
        status: z.string(),
        error: z.string().optional(),
      })),
      summary: z.object({
        total: z.number(),
        success: z.number(),
        failed: z.number(),
      }),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ urls, type }) => {
    const results = await batchSubmitUrls(urls, type);
    const success = results.filter((r) => r.status === "success").length;
    const output = {
      results,
      summary: { total: results.length, success, failed: results.length - success },
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
      structuredContent: output,
    };
  },
);

// ── list_sitemaps ─────────────────────────────────────────────────

server.registerTool(
  "list_sitemaps",
  {
    description: "List all sitemaps submitted for a Search Console property.",
    inputSchema: {
      siteUrl: siteUrlSchema,
    },
    outputSchema: {
      sitemaps: z.array(z.object({
        path: z.string(),
        lastSubmitted: z.string().optional(),
        isPending: z.boolean(),
        lastDownloaded: z.string().optional(),
        warnings: z.number(),
        errors: z.number(),
        type: z.string().optional(),
      })),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ siteUrl }) => {
    const data = await listSitemaps(siteUrl);
    const sitemaps = (data.sitemap ?? []).map((s) => ({
      path: s.path ?? "",
      lastSubmitted: s.lastSubmitted ?? undefined,
      isPending: s.isPending ?? false,
      lastDownloaded: s.lastDownloaded ?? undefined,
      warnings: Number(s.warnings ?? 0),
      errors: Number(s.errors ?? 0),
      type: s.type ?? undefined,
    }));
    const output = { sitemaps };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
      structuredContent: output,
    };
  },
);

// ── submit_sitemap ────────────────────────────────────────────────

server.registerTool(
  "submit_sitemap",
  {
    description:
      "Submit a sitemap to Google Search Console. The sitemap must be accessible at the provided URL.",
    inputSchema: {
      siteUrl: siteUrlSchema,
      feedpath: z.string().url().describe("The fully qualified URL of the sitemap (e.g., 'https://example.com/sitemap.xml')."),
    },
    outputSchema: {
      status: z.string(),
      siteUrl: z.string(),
      feedpath: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ siteUrl, feedpath }) => {
    const output = await submitSitemap(siteUrl, feedpath);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
      structuredContent: output,
    };
  },
);

// ── generate_report ───────────────────────────────────────────────

server.registerTool(
  "generate_report",
  {
    description:
      "Generate a comprehensive performance report combining totals, daily trend, top queries, top pages, device breakdown, and country breakdown. Returns all data in one call for efficient reporting.",
    inputSchema: {
      siteUrl: siteUrlSchema,
      startDate: dateSchema,
      endDate: dateSchema,
      topN: z.coerce.number().int().min(1).max(100).default(20)
        .describe("Number of top queries/pages to include."),
    },
    outputSchema: {
      totals: z.object({ clicks: z.number(), impressions: z.number(), ctr: z.number(), position: z.number() }),
      dailyTrend: z.array(z.object({ date: z.string(), clicks: z.number(), impressions: z.number(), ctr: z.number(), position: z.number() })),
      topQueries: z.array(z.object({ query: z.string(), clicks: z.number(), impressions: z.number(), ctr: z.number(), position: z.number() })),
      topPages: z.array(z.object({ page: z.string(), clicks: z.number(), impressions: z.number(), ctr: z.number(), position: z.number() })),
      deviceBreakdown: z.array(z.object({ device: z.string(), clicks: z.number(), impressions: z.number(), ctr: z.number(), position: z.number() })),
      countryBreakdown: z.array(z.object({ country: z.string(), clicks: z.number(), impressions: z.number(), ctr: z.number(), position: z.number() })),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ siteUrl, startDate, endDate, topN }) => {
    const [totalsData, dailyData, queriesData, pagesData, deviceData, countryData] = await Promise.all([
      querySearchAnalytics({ siteUrl, startDate, endDate, dimensions: [], rowLimit: 1 }),
      querySearchAnalytics({ siteUrl, startDate, endDate, dimensions: ["date"], rowLimit: 500 }),
      querySearchAnalytics({ siteUrl, startDate, endDate, dimensions: ["query"], rowLimit: topN }),
      querySearchAnalytics({ siteUrl, startDate, endDate, dimensions: ["page"], rowLimit: topN }),
      querySearchAnalytics({ siteUrl, startDate, endDate, dimensions: ["device"], rowLimit: 10 }),
      querySearchAnalytics({ siteUrl, startDate, endDate, dimensions: ["country"], rowLimit: 20 }),
    ]);

    const mapRow = (r: { keys?: string[] | null; clicks?: number | null; impressions?: number | null; ctr?: number | null; position?: number | null }) => ({
      clicks: r.clicks ?? 0,
      impressions: r.impressions ?? 0,
      ctr: r.ctr ?? 0,
      position: r.position ?? 0,
    });

    const firstRow = totalsData.rows?.[0];
    const output = {
      totals: {
        clicks: firstRow?.clicks ?? 0,
        impressions: firstRow?.impressions ?? 0,
        ctr: firstRow?.ctr ?? 0,
        position: firstRow?.position ?? 0,
      },
      dailyTrend: (dailyData.rows ?? []).map((r) => ({ date: r.keys?.[0] ?? "", ...mapRow(r) })),
      topQueries: (queriesData.rows ?? []).map((r) => ({ query: r.keys?.[0] ?? "", ...mapRow(r) })),
      topPages: (pagesData.rows ?? []).map((r) => ({ page: r.keys?.[0] ?? "", ...mapRow(r) })),
      deviceBreakdown: (deviceData.rows ?? []).map((r) => ({ device: r.keys?.[0] ?? "", ...mapRow(r) })),
      countryBreakdown: (countryData.rows ?? []).map((r) => ({ country: r.keys?.[0] ?? "", ...mapRow(r) })),
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
      structuredContent: output,
    };
  },
);

  return server;
}

// ── HTTP Transport ────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "google-search-console", version: "0.1.0" });
});

app.post("/mcp", async (req, res) => {
  try {
    // Extract the OAuth access token solely from the Authorization: Bearer header.
    const authHeader = req.headers["authorization"];
    const accessToken =
      authHeader && authHeader.toLowerCase().startsWith("bearer ")
        ? authHeader.slice(7)
        : "";

    // Create a fresh server + transport per request for concurrency safety:
    // Protocol stores a single transport, so a shared server would cross-wire
    // responses under concurrent requests (stateless per-request pattern).
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    res.on("close", () => transport.close());

    await requestContext.run({ accessToken }, async () => {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: err instanceof Error ? err.message : "Internal server error" },
        id: null,
      });
    }
  }
});

const PORT = 8000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`GSC MCP server listening on 0.0.0.0:${PORT}`);
});
