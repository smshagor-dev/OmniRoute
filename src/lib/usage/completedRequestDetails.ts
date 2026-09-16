import { Buffer } from "node:buffer";
import { getDbInstance } from "../db/core";
import type { PendingRequestDetail } from "./usageHistory";
import { MAX_PREVIEW_STRING, truncatePendingPreview } from "./usageHistory/helpers";

const COMPLETED_DETAIL_TTL_MS = 120_000;
const MAX_COMPLETED_DETAILS = 256;
const MAX_COMPLETED_DETAILS_BYTES = 4 * 1024 * 1024;
const MAX_COMPLETED_STREAM_CHUNKS_PER_STAGE = 64;
const OVERSIZED_DETAIL_MARKER = "[omitted: completed detail exceeded cache byte budget]";

const completedDetails = new Map<string, PendingRequestDetail>();
const completedDetailTimers = new Map<string, ReturnType<typeof setTimeout>>();
const completedDetailBytes = new Map<string, number>();
let totalCompletedDetailBytes = 0;

/**
 * Force a diagnostic string onto its own backing store before it enters the
 * completed-request cache. V8 can otherwise keep a multi-megabyte parent string
 * alive for a tiny `slice()` preview. A UTF-8 round-trip is intentionally used
 * here because the cached values are already bounded diagnostics, not request
 * payloads on the hot provider path.
 */
function materializeString(value: string): string {
  return Buffer.from(value, "utf8").toString("utf8");
}

function materializeNullableString(value: string | null | undefined): string | null | undefined {
  return typeof value === "string" ? materializeString(value) : value;
}

function prepareDiagnosticString(
  value: string | null | undefined
): string | null | undefined {
  if (typeof value !== "string") return value;
  const preview =
    value.length > MAX_PREVIEW_STRING ? `${value.slice(0, MAX_PREVIEW_STRING)}...` : value;
  return materializeString(preview);
}

function materializePreview(value: unknown): unknown {
  if (typeof value === "string") return materializeString(value);
  if (Array.isArray(value)) return value.map((entry) => materializePreview(entry));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
      materializeString(key),
      materializePreview(entryValue),
    ])
  );
}

function preparePayloadPreview(value: unknown): unknown {
  return materializePreview(truncatePendingPreview(value));
}

function prepareStreamChunk(value: string): string {
  const preview =
    value.length > MAX_PREVIEW_STRING ? `${value.slice(0, MAX_PREVIEW_STRING)}...` : value;
  return materializeString(preview);
}

function prepareStreamChunkList(values?: string[]): string[] | undefined {
  if (!values) return undefined;
  const kept = values
    .slice(0, MAX_COMPLETED_STREAM_CHUNKS_PER_STAGE)
    .map((value) => prepareStreamChunk(value));
  if (values.length > MAX_COMPLETED_STREAM_CHUNKS_PER_STAGE) {
    kept.push(`[TRUNCATED_STREAM_CHUNKS: ${values.length - MAX_COMPLETED_STREAM_CHUNKS_PER_STAGE}]`);
  }
  return kept;
}

function prepareCompletedDetail(detail: PendingRequestDetail): PendingRequestDetail {
  return {
    ...detail,
    id: materializeString(detail.id),
    model: materializeString(detail.model),
    provider: materializeString(detail.provider),
    connectionId: materializeNullableString(detail.connectionId) ?? null,
    clientEndpoint: prepareDiagnosticString(detail.clientEndpoint),
    providerUrl: prepareDiagnosticString(detail.providerUrl),
    error: prepareDiagnosticString(detail.error),
    errorCode: prepareDiagnosticString(detail.errorCode),
    stage: prepareDiagnosticString(detail.stage),
    correlationId: materializeNullableString(detail.correlationId),
    sessionTag: prepareDiagnosticString(detail.sessionTag),
    clientRequest:
      detail.clientRequest === undefined ? undefined : preparePayloadPreview(detail.clientRequest),
    providerRequest:
      detail.providerRequest === undefined ? undefined : preparePayloadPreview(detail.providerRequest),
    providerResponse:
      detail.providerResponse === undefined ? undefined : preparePayloadPreview(detail.providerResponse),
    clientResponse:
      detail.clientResponse === undefined ? undefined : preparePayloadPreview(detail.clientResponse),
    streamChunks: detail.streamChunks
      ? {
          provider: prepareStreamChunkList(detail.streamChunks.provider),
          openai: prepareStreamChunkList(detail.streamChunks.openai),
          client: prepareStreamChunkList(detail.streamChunks.client),
        }
      : detail.streamChunks,
  };
}

function estimateCompletedDetailBytes(detail: PendingRequestDetail): number {
  try {
    const serialized = JSON.stringify(detail);
    return Buffer.byteLength(serialized ?? "", "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function compactOversizedDetail(detail: PendingRequestDetail): PendingRequestDetail {
  return {
    ...detail,
    clientRequest: detail.clientRequest === undefined ? undefined : OVERSIZED_DETAIL_MARKER,
    providerRequest: detail.providerRequest === undefined ? undefined : OVERSIZED_DETAIL_MARKER,
    providerResponse: detail.providerResponse === undefined ? undefined : OVERSIZED_DETAIL_MARKER,
    clientResponse: detail.clientResponse === undefined ? undefined : OVERSIZED_DETAIL_MARKER,
    streamChunks: null,
  };
}

function removeCompletedDetailEntry(id: string) {
  if (!completedDetails.has(id)) return;
  completedDetails.delete(id);
  const bytes = completedDetailBytes.get(id) ?? 0;
  completedDetailBytes.delete(id);
  totalCompletedDetailBytes = Math.max(0, totalCompletedDetailBytes - bytes);
}

function deleteCompletedDetail(id: string) {
  removeCompletedDetailEntry(id);
  const existingTimer = completedDetailTimers.get(id);
  if (existingTimer) {
    clearTimeout(existingTimer);
    completedDetailTimers.delete(id);
  }
}

function trimCompletedDetails() {
  while (
    completedDetails.size > MAX_COMPLETED_DETAILS ||
    totalCompletedDetailBytes > MAX_COMPLETED_DETAILS_BYTES
  ) {
    const oldestId = completedDetails.keys().next().value;
    if (!oldestId) break;
    deleteCompletedDetail(oldestId);
  }
}

export function getCompletedDetails(): Map<string, PendingRequestDetail> {
  return completedDetails;
}

export function getCompletedDetailCacheStats() {
  return {
    entries: completedDetails.size,
    bytes: totalCompletedDetailBytes,
    maxEntries: MAX_COMPLETED_DETAILS,
    maxBytes: MAX_COMPLETED_DETAILS_BYTES,
  };
}

export function storeCompletedDetail(detail: PendingRequestDetail) {
  let stored = prepareCompletedDetail(detail);
  let bytes = estimateCompletedDetailBytes(stored);

  // A pathological diagnostic object must not defeat the global byte cap by
  // being larger than the cache all by itself. Preserve metadata needed for
  // correlation and replace only payload-heavy fields.
  if (bytes > MAX_COMPLETED_DETAILS_BYTES) {
    stored = compactOversizedDetail(stored);
    bytes = estimateCompletedDetailBytes(stored);
  }

  const previousBytes = completedDetailBytes.get(stored.id) ?? 0;
  totalCompletedDetailBytes = Math.max(0, totalCompletedDetailBytes - previousBytes);
  completedDetails.set(stored.id, stored);
  completedDetailBytes.set(stored.id, bytes);
  totalCompletedDetailBytes += bytes;
  trimCompletedDetails();
}

export function scheduleCompletedDetailCleanup(id: string) {
  // If byte/count trimming rejected or already evicted this entry, do not leave
  // behind a timer for an object the cache no longer owns.
  if (!completedDetails.has(id)) return;

  const existingTimer = completedDetailTimers.get(id);
  if (existingTimer) clearTimeout(existingTimer);
  const timer = setTimeout(() => {
    completedDetailTimers.delete(id);
    removeCompletedDetailEntry(id);
  }, COMPLETED_DETAIL_TTL_MS);
  timer.unref?.();
  completedDetailTimers.set(id, timer);
}

export function clearCompletedDetails() {
  for (const timer of completedDetailTimers.values()) clearTimeout(timer);
  completedDetailTimers.clear();
  completedDetails.clear();
  completedDetailBytes.clear();
  totalCompletedDetailBytes = 0;
}

function isUnset(value: unknown): boolean {
  return value === undefined || value === null;
}

export function maybeEnrichCompletedDetail(updated: PendingRequestDetail, connectionId: string) {
  // Operate on the already-truncated/materialized cached copy, not the original
  // completion object. Besides avoiding work for an entry evicted by the byte
  // budget, this prevents the async enrichment closure from prolonging the
  // lifetime of a large sliced-string backing store after finalize returns.
  const cached = completedDetails.get(updated.id);
  if (!cached) return;
  updated = cached;

  void (async () => {
    try {
      if (!isUnset(updated.providerResponse) && !isUnset(updated.clientResponse)) return;

      const db = getDbInstance();
      const sinceIso = new Date(Date.now() - 30_000).toISOString();
      const rows = db
        .prepare(
          `SELECT artifact_relpath FROM call_logs WHERE connection_id = ? AND model = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT 5`
        )
        .all(connectionId, updated.model, sinceIso) as Array<{ artifact_relpath: string | null }>;
      for (const row of rows) {
        if (!row.artifact_relpath) continue;
        const { readCallArtifact, isSizeLimitOmissionMarker } = await import("./callLogArtifacts");
        const art = readCallArtifact(row.artifact_relpath);
        if (art.state !== "ready" || !art.artifact) continue;
        const pipeline = art.artifact.pipeline as
          | { providerResponse?: unknown; clientResponse?: unknown }
          | undefined;
        // pipeline.* first: it is the translated payload of one specific side.
        // `responseBody` is a single coarse value handed to both sides, so it
        // may only fill a side still empty AFTER the pipeline had its turn --
        // testing emptiness once before the loop let it overwrite the payload
        // just recovered, showing a provider payload as the client response.
        if (isUnset(updated.providerResponse) && pipeline?.providerResponse) {
          updated.providerResponse = pipeline.providerResponse;
        }
        if (isUnset(updated.clientResponse) && pipeline?.clientResponse) {
          updated.clientResponse = pipeline.clientResponse;
        }
        // A size-limited artifact stores an omission marker string in place of
        // the body. It is truthy, so recovering it here overwrites a real
        // payload with "[omitted: ...]".
        const responseBody = isSizeLimitOmissionMarker(art.artifact.responseBody)
          ? null
          : art.artifact.responseBody;
        if (responseBody) {
          if (isUnset(updated.providerResponse)) updated.providerResponse = responseBody;
          if (isUnset(updated.clientResponse)) updated.clientResponse = responseBody;
        }
        if (updated.providerResponse || updated.clientResponse) {
          if (completedDetails.has(updated.id)) storeCompletedDetail(updated);
          break;
        }
      }
    } catch (e) {
      try {
        console.warn(
          "[usageHistory] failed to enrich completed detail from artifacts:",
          e && (e.message || e)
        );
      } catch {}
    }
  })();
}
