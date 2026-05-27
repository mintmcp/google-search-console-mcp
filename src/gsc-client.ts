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
      "No access token found. Provide your Google OAuth access token via the 'Authorization: Bearer <token>' header.",
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

// ── Error formatting ──────────────────────────────────────────────

export function formatGoogleApiError(err: unknown): string {
  const e = err as {
    response?: { data?: { error?: { message?: unknown } }; status?: unknown };
    status?: unknown;
    code?: unknown;
    errors?: unknown;
    message?: unknown;
  };

  const parts: string[] = [];

  // HTTP status only from numeric status fields. gaxios `code` may be a network
  // error code (e.g. ECONNRESET, ENOTFOUND), which is not an HTTP status.
  const httpStatus =
    typeof e?.response?.status === "number"
      ? e.response.status
      : typeof e?.status === "number"
        ? e.status
        : typeof e?.code === "number"
          ? e.code
          : undefined;
  if (httpStatus !== undefined) {
    parts.push(`HTTP ${httpStatus}`);
  }

  if (typeof e?.code === "string" && e.code.length > 0 && e.code !== String(httpStatus)) {
    parts.push(e.code);
  }

  const apiMessage = e?.response?.data?.error?.message;
  if (typeof apiMessage === "string" && apiMessage.length > 0) {
    parts.push(apiMessage);
  }

  if (Array.isArray(e?.errors)) {
    const details = e.errors
      .map((entry) => {
        const item = entry as { message?: unknown; reason?: unknown };
        const msg = typeof item?.message === "string" ? item.message : undefined;
        const reason = typeof item?.reason === "string" ? item.reason : undefined;
        if (msg && reason) return `${msg} (${reason})`;
        return msg ?? reason;
      })
      .filter((d): d is string => typeof d === "string" && d.length > 0);
    if (details.length > 0) parts.push(details.join("; "));
  }

  if (parts.length > 0) return parts.join(": ");

  if (typeof e?.message === "string" && e.message.length > 0) return e.message;
  return String(err);
}

async function callGoogle<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    throw new Error(formatGoogleApiError(err));
  }
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
  const res = await callGoogle(() =>
    sc.searchanalytics.query({
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
    }),
  );
  return res.data;
}

// ── URL Inspection ────────────────────────────────────────────────

export async function inspectUrl(siteUrl: string, inspectionUrl: string) {
  const sc = getSearchConsole();
  const res = await callGoogle(() =>
    sc.urlInspection.index.inspect({
      requestBody: {
        inspectionUrl,
        siteUrl,
      },
    }),
  );
  return res.data;
}

// ── Sitemaps ──────────────────────────────────────────────────────

export async function listSitemaps(siteUrl: string) {
  const sc = getSearchConsole();
  const res = await callGoogle(() => sc.sitemaps.list({ siteUrl }));
  return res.data;
}

export async function submitSitemap(siteUrl: string, feedpath: string) {
  const sc = getSearchConsole();
  await callGoogle(() => sc.sitemaps.submit({ siteUrl, feedpath }));
  return { status: "success", siteUrl, feedpath };
}

// ── Indexing API ──────────────────────────────────────────────────

export async function submitUrlForIndexing(url: string, type: "URL_UPDATED" | "URL_DELETED") {
  const { accessToken } = getContext();
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  const indexing = google.indexing({ version: "v3", auth });
  const res = await callGoogle(() =>
    indexing.urlNotifications.publish({
      requestBody: { url, type },
    }),
  );
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
  const res = await callGoogle(() => sc.sites.list());
  return res.data;
}
