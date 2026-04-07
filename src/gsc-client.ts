import { AsyncLocalStorage } from "node:async_hooks";
import { google, type searchconsole_v1 } from "googleapis";

// Per-request context carrying the user's OAuth access token
interface RequestContext {
  accessToken: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

function getContext(): RequestContext {
  const ctx = requestContext.getStore();
  if (!ctx || !ctx.accessToken) {
    throw new Error(
      "No access token found. Configure GSC_ACCESS_TOKEN in your MintMCP connection settings.",
    );
  }
  return ctx;
}

function getSearchConsole(): searchconsole_v1.Searchconsole {
  const { accessToken } = getContext();
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.searchconsole({ version: "v1", auth });
}

// ── Search Analytics ──────────────────────────────────────────────

export interface SearchAnalyticsParams {
  siteUrl: string;
  startDate: string;
  endDate: string;
  dimensions?: string[];
  dimensionFilterGroups?: searchconsole_v1.Schema$ApiDimensionFilterGroup[];
  rowLimit?: number;
  startRow?: number;
  type?: string;
  aggregationType?: string;
  dataState?: string;
}

export async function querySearchAnalytics(params: SearchAnalyticsParams) {
  const sc = getSearchConsole();
  const res = await sc.searchanalytics.query({
    siteUrl: params.siteUrl,
    requestBody: {
      startDate: params.startDate,
      endDate: params.endDate,
      dimensions: params.dimensions,
      dimensionFilterGroups: params.dimensionFilterGroups,
      rowLimit: params.rowLimit ?? 1000,
      startRow: params.startRow ?? 0,
      type: params.type ?? "web",
      aggregationType: params.aggregationType,
      dataState: params.dataState ?? "final",
    },
  });
  return res.data;
}

// ── URL Inspection ────────────────────────────────────────────────

export async function inspectUrl(siteUrl: string, inspectionUrl: string) {
  const sc = getSearchConsole();
  const res = await sc.urlInspection.index.inspect({
    requestBody: {
      inspectionUrl,
      siteUrl,
    },
  });
  return res.data;
}

// ── Sitemaps ──────────────────────────────────────────────────────

export async function listSitemaps(siteUrl: string) {
  const sc = getSearchConsole();
  const res = await sc.sitemaps.list({ siteUrl });
  return res.data;
}

export async function submitSitemap(siteUrl: string, feedpath: string) {
  const sc = getSearchConsole();
  await sc.sitemaps.submit({ siteUrl, feedpath });
  return { status: "success", siteUrl, feedpath };
}

// ── Indexing API ──────────────────────────────────────────────────

export async function submitUrlForIndexing(url: string, type: "URL_UPDATED" | "URL_DELETED") {
  const { accessToken } = getContext();
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  const indexing = google.indexing({ version: "v3", auth });
  const res = await indexing.urlNotifications.publish({
    requestBody: { url, type },
  });
  return res.data;
}

export async function batchSubmitUrls(urls: string[], type: "URL_UPDATED" | "URL_DELETED") {
  const results: Array<{ url: string; status: string; error?: string }> = [];
  for (const url of urls) {
    try {
      await submitUrlForIndexing(url, type);
      results.push({ url, status: "success" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ url, status: "error", error: msg });
    }
  }
  return results;
}

// ── Sites ─────────────────────────────────────────────────────────

export async function listSites() {
  const sc = getSearchConsole();
  const res = await sc.sites.list();
  return res.data;
}
