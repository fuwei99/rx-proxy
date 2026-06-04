import { Router, type IRouter, type Request, type Response } from "express";
import express from "express";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { readJson, writeJson } from "../lib/cloudPersist";
import { getSillyTavernMode } from "./settings";
import {
  ALL_MODELS,
  GEMINI_MODELS,
  MODEL_PROVIDER_MAP,
  getAnthropicDefaults,
  getGeminiAlias,
  getOpenRouterImageConfigTags,
  getOpenRouterModalities,
  getOpenRouterParams,
  getOpenRouterProviderRouting,
  getOpenRouterReasoning,
  getPricing,
  readModelsJsonText,
  refreshModelRegistryIfChanged,
  replaceModelsJson,
  modelHasFeature,
  resolveModel,
  type ModelProvider,
  type GeminiModelAlias,
} from "../lib/modelRegistry";

const router: IRouter = Router();
router.use(/^\/v1\/images\/(generations|edits)$/, expressRawBody);

function expressRawBody(req: Request, res: Response, next: () => void): void {
  express.raw({ type: () => true, limit: "50mb" })(req, res, next);
}

// ---------------------------------------------------------------------------
// Backend pool — round-robin across local account + multiple friend proxies
// with background health checking
// ---------------------------------------------------------------------------

type Backend =
  | { kind: "local" }
  | { kind: "friend"; label: string; url: string; apiKey: string };

interface HealthEntry { healthy: boolean; checkedAt: number }
const healthCache = new Map<string, HealthEntry>();
const HEALTH_TTL_MS = 30_000;   // reuse cached result for 30s
const HEALTH_TIMEOUT_MS = 15_000; // 15s timeout per check (Replit cold starts can take 10–30s)

// ---------------------------------------------------------------------------
// Dynamic backends (cloud-persisted via GCS in production, local file in dev)
// ---------------------------------------------------------------------------

interface DynamicBackend { label: string; url: string; enabled?: boolean }

let dynamicBackends: DynamicBackend[] = [];

function saveDynamicBackends(list: DynamicBackend[]): void {
  writeJson("dynamic_backends.json", list).catch((err) => {
    console.error("[persist] failed to save dynamic_backends:", err);
  });
}

// ---------------------------------------------------------------------------
// Model enable/disable management
// ---------------------------------------------------------------------------

// Strip legacy -visible suffix for backward compatibility.
// -low-thinking-visible / -high-thinking-visible → -low / -high
// -thinking-visible → -thinking
function stripVisibleSuffix(m: string): string {
  if (m.endsWith("-low-thinking-visible") || m.endsWith("-high-thinking-visible"))
    return m.replace(/-thinking-visible$/, "");
  if (m.endsWith("-thinking-visible"))
    return m.replace(/-visible$/, "");
  return m;
}

let disabledModels: Set<string> = new Set<string>();

function saveDisabledModels(set: Set<string>): void {
  writeJson("disabled_models.json", [...set]).catch((err) => {
    console.error("[persist] failed to save disabled_models:", err);
  });
}

interface RoutingSettings { localEnabled: boolean; localFallback: boolean; fakeStream: boolean }
let routingSettings: RoutingSettings = { localEnabled: true, localFallback: true, fakeStream: true };

export const initReady: Promise<void> = (async () => {
  const [savedBackends, savedDisabled, savedRouting] = await Promise.all([
    readJson<DynamicBackend[]>("dynamic_backends.json").catch(() => null),
    readJson<string[]>("disabled_models.json").catch(() => null),
    readJson<Partial<RoutingSettings>>("routing_settings.json").catch(() => null),
  ]);
  if (Array.isArray(savedBackends)) {
    dynamicBackends = savedBackends;
    console.log(`[init] loaded ${dynamicBackends.length} dynamic backend(s)`);
  }
  if (Array.isArray(savedDisabled)) {
    disabledModels = new Set<string>(savedDisabled);
    console.log(`[init] loaded ${disabledModels.size} disabled model(s)`);
  }
  if (savedRouting && typeof savedRouting === "object") {
    if (typeof savedRouting.localEnabled === "boolean") routingSettings.localEnabled = savedRouting.localEnabled;
    if (typeof savedRouting.localFallback === "boolean") routingSettings.localFallback = savedRouting.localFallback;
    if (typeof savedRouting.fakeStream === "boolean") routingSettings.fakeStream = savedRouting.fakeStream;
  }
  console.log("[init] routing settings:", JSON.stringify(routingSettings));
})();

function saveRoutingSettings(): void {
  writeJson("routing_settings.json", routingSettings).catch((err) => {
    console.error("[routing] failed to save settings:", err);
  });
}

function isModelEnabled(id: string): boolean {
  return !disabledModels.has(id);
}

// Normalize sub-node endpoint URL — ensures it ends with /api.
// Sub-nodes use the same dual-mount architecture: /api/v1/* routes.
function normalizeSubNodeUrl(raw: string): string {
  const url = raw.trim().replace(/\/+$/, "");
  if (!url) return url;
  return /\/api$/i.test(url) ? url : url + "/api";
}

function getFriendProxyConfigs(): { label: string; url: string; apiKey: string }[] {
  const apiKey = process.env.PROXY_API_KEY ?? "";
  const configs: { label: string; url: string; apiKey: string }[] = [];

  // Auto-scan FRIEND_PROXY_URL, FRIEND_PROXY_URL_2 … FRIEND_PROXY_URL_20 from env
  const envKeys = ["FRIEND_PROXY_URL", ...Array.from({ length: 19 }, (_, i) => `FRIEND_PROXY_URL_${i + 2}`)];
  for (const key of envKeys) {
    const raw = process.env[key];
    if (raw) configs.push({ label: key.replace("FRIEND_PROXY_URL", "FRIEND"), url: normalizeSubNodeUrl(raw), apiKey });
  }

  // Merge dynamic backends (added via API), skip duplicates and disabled ones
  const knownUrls = new Set(configs.map((c) => c.url));
  for (const d of dynamicBackends) {
    const url = normalizeSubNodeUrl(d.url);
    if (!knownUrls.has(url) && d.enabled !== false) configs.push({ label: d.label, url, apiKey });
  }

  return configs;
}

// getAllFriendProxyConfigs — 返回全部节点（含禁用的），专供统计页面使用
function getAllFriendProxyConfigs(): { label: string; url: string; apiKey: string; enabled: boolean }[] {
  const apiKey = process.env.PROXY_API_KEY ?? "";
  const configs: { label: string; url: string; apiKey: string; enabled: boolean }[] = [];

  const envKeys = ["FRIEND_PROXY_URL", ...Array.from({ length: 19 }, (_, i) => `FRIEND_PROXY_URL_${i + 2}`)];
  for (const key of envKeys) {
    const raw = process.env[key];
    if (raw) configs.push({ label: key.replace("FRIEND_PROXY_URL", "FRIEND"), url: normalizeSubNodeUrl(raw), apiKey, enabled: true });
  }

  const knownUrls = new Set(configs.map((c) => c.url));
  for (const d of dynamicBackends) {
    const url = normalizeSubNodeUrl(d.url);
    if (!knownUrls.has(url)) configs.push({ label: d.label, url, apiKey, enabled: d.enabled !== false });
  }

  return configs;
}

async function probeHealth(url: string, apiKey: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const resp = await fetch(`${url}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    return resp.ok;
  } catch {
    return false;
  }
}

function getCachedHealth(url: string): boolean | null {
  const entry = healthCache.get(url);
  if (!entry) return null; // unknown — never checked
  if (Date.now() - entry.checkedAt < HEALTH_TTL_MS) return entry.healthy;
  return null; // stale
}

function setHealth(url: string, healthy: boolean): void {
  healthCache.set(url, { healthy, checkedAt: Date.now() });
}

// Refresh stale/unknown health entries in the background (non-blocking)
function refreshHealthAsync(): void {
  const configs = getFriendProxyConfigs();
  for (const { url, apiKey } of configs) {
    if (getCachedHealth(url) === null) {
      probeHealth(url, apiKey).then((ok) => setHealth(url, ok)).catch(() => setHealth(url, false));
    }
  }
}

// Kick off initial health checks after a short delay (server hasn't fully started yet)
setTimeout(refreshHealthAsync, 2000);
// Recheck every 30s
setInterval(refreshHealthAsync, HEALTH_TTL_MS);

function buildBackendPool(): Backend[] {
  const friends: Backend[] = [];

  for (const { label, url, apiKey } of getFriendProxyConfigs()) {
    const healthy = getCachedHealth(url);
    if (healthy !== false) {
      friends.push({ kind: "friend", label, url, apiKey });
    }
  }

  if (friends.length > 0) return friends;

  if (routingSettings.localFallback && routingSettings.localEnabled) return [{ kind: "local" }];

  return [];
}

let requestCounter = 0;

function pickBackend(): Backend | null {
  const pool = buildBackendPool();
  if (pool.length === 0) return null;
  const backend = pool[requestCounter % pool.length];
  requestCounter++;
  return backend;
}

function pickBackendExcluding(exclude: Set<string>): Backend | null {
  const friends = buildBackendPool().filter(
    (b) => b.kind === "friend" && !exclude.has(b.url)
  );
  if (friends.length > 0) return friends[requestCounter % friends.length];
  if (routingSettings.localFallback && routingSettings.localEnabled) return { kind: "local" };
  return null;
}

// ---------------------------------------------------------------------------
// Client factories
// ---------------------------------------------------------------------------

function makeLocalOpenAI(): OpenAI {
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  if (!apiKey || !baseURL) {
    throw new Error(
      "OpenAI integration is not configured. Please add the OpenAI integration in Replit (Tools → Integrations) to use GPT models."
    );
  }
  return new OpenAI({ apiKey, baseURL });
}

function makeLocalAnthropic(): Anthropic {
  const apiKey = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
  const baseURL = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
  if (!apiKey || !baseURL) {
    throw new Error(
      "Anthropic integration is not configured. Please add the Anthropic integration in Replit (Tools → Integrations) to use Claude models."
    );
  }
  return new Anthropic({ apiKey, baseURL });
}

function makeLocalGemini(): { apiKey: string; baseUrl: string } {
  const apiKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
  const baseUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
  if (!apiKey || !baseUrl) {
    throw new Error(
      "Gemini integration is not configured. Please add the Gemini integration in Replit (Tools → Integrations) to use Gemini models."
    );
  }
  return { apiKey, baseUrl: baseUrl.replace(/\/$/, "") };
}

function makeLocalOpenRouter(): OpenAI {
  const apiKey = process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY;
  const baseURL = process.env.AI_INTEGRATIONS_OPENROUTER_BASE_URL;
  if (!apiKey || !baseURL) {
    throw new Error(
      "OpenRouter integration is not configured. Please add the OpenRouter integration in Replit (Tools → Integrations) to use OpenRouter models."
    );
  }
  return new OpenAI({ apiKey, baseURL });
}


// ---------------------------------------------------------------------------
// Per-backend usage statistics — persisted to cloudPersist ("usage_stats.json")
// ---------------------------------------------------------------------------

const STATS_FILE = "usage_stats.json";

interface BackendStat {
  calls: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  totalCostUsd: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalDurationMs: number;
  totalTtftMs: number;
  streamingCalls: number;
}

interface ModelStat {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalCostUsd: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

interface ExtendedUsageMetrics {
  totalTokens?: number;
  costUsd?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

const EMPTY_STAT = (): BackendStat => ({
  calls: 0, errors: 0, promptTokens: 0, completionTokens: 0,
  totalCostUsd: 0, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
  totalDurationMs: 0, totalTtftMs: 0, streamingCalls: 0,
});

const EMPTY_MODEL_STAT = (): ModelStat => ({
  calls: 0, promptTokens: 0, completionTokens: 0,
  totalCostUsd: 0, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
});

const statsMap = new Map<string, BackendStat>();
const modelStatsMap = new Map<string, ModelStat>();

// ── Persistence helpers ────────────────────────────────────────────────────

function statsToObject(): { backends: Record<string, BackendStat>; models: Record<string, ModelStat> } {
  return {
    backends: Object.fromEntries(statsMap.entries()),
    models: Object.fromEntries(modelStatsMap.entries()),
  };
}

async function persistStats(): Promise<void> {
  try { await writeJson(STATS_FILE, statsToObject()); } catch {}
}

let _saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(): void {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { _saveTimer = null; void persistStats(); }, 2_000);
}

setInterval(() => { void persistStats(); }, 60_000);

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    console.log(`[stats] ${sig} received, flushing stats…`);
    persistStats().finally(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000);
  });
}

export const statsReady: Promise<void> = (async () => {
  try {
    const saved = await readJson<Record<string, unknown>>(STATS_FILE);
    if (saved && typeof saved === "object") {
      const backendsRaw = (saved as { backends?: Record<string, BackendStat> }).backends ?? saved as Record<string, BackendStat>;
      const modelsRaw = (saved as { models?: Record<string, ModelStat> }).models;

      for (const [label, raw] of Object.entries(backendsRaw)) {
        if (raw && typeof raw === "object" && "calls" in (raw as unknown as Record<string, unknown>)) {
          statsMap.set(label, {
            calls:            Number((raw as BackendStat).calls)            || 0,
            errors:           Number((raw as BackendStat).errors)           || 0,
            promptTokens:     Number((raw as BackendStat).promptTokens)     || 0,
            completionTokens: Number((raw as BackendStat).completionTokens) || 0,
            totalCostUsd:     Number((raw as BackendStat).totalCostUsd)     || 0,
            cachedTokens:     Number((raw as BackendStat).cachedTokens)     || 0,
            cacheWriteTokens: Number((raw as BackendStat).cacheWriteTokens) || 0,
            reasoningTokens:  Number((raw as BackendStat).reasoningTokens)  || 0,
            totalDurationMs:  Number((raw as BackendStat).totalDurationMs)  || 0,
            totalTtftMs:      Number((raw as BackendStat).totalTtftMs)      || 0,
            streamingCalls:   Number((raw as BackendStat).streamingCalls)   || 0,
          });
        }
      }

      if (modelsRaw && typeof modelsRaw === "object") {
        for (const [model, raw] of Object.entries(modelsRaw)) {
          if (raw && typeof raw === "object") {
            modelStatsMap.set(model, {
              calls:            Number(raw.calls)            || 0,
              promptTokens:     Number(raw.promptTokens)     || 0,
              completionTokens: Number(raw.completionTokens) || 0,
              totalCostUsd:     Number(raw.totalCostUsd)     || 0,
              cachedTokens:     Number(raw.cachedTokens)     || 0,
              cacheWriteTokens: Number(raw.cacheWriteTokens) || 0,
              reasoningTokens:  Number(raw.reasoningTokens)  || 0,
            });
          }
        }
      }

      console.log(`[stats] loaded ${statsMap.size} backend(s), ${modelStatsMap.size} model(s) from ${STATS_FILE}`);
    }
  } catch {
    console.warn(`[stats] could not load ${STATS_FILE}, starting fresh`);
  }
})();

// ── Stat accessors ─────────────────────────────────────────────────────────

function getStat(label: string): BackendStat {
  if (!statsMap.has(label)) statsMap.set(label, EMPTY_STAT());
  return statsMap.get(label)!;
}

function recordCallStat(label: string, durationMs: number, prompt: number, completion: number, ttftMs?: number, model?: string, usage?: ExtendedUsageMetrics): void {
  const s = getStat(label);
  s.calls++;
  s.promptTokens += prompt;
  s.completionTokens += completion;
  s.totalCostUsd += usage?.costUsd ?? 0;
  s.cachedTokens += usage?.cachedTokens ?? 0;
  s.cacheWriteTokens += usage?.cacheWriteTokens ?? 0;
  s.reasoningTokens += usage?.reasoningTokens ?? 0;
  s.totalDurationMs += durationMs;
  if (ttftMs !== undefined) { s.totalTtftMs += ttftMs; s.streamingCalls++; }
  if (model) {
    const ms = getModelStat(model);
    ms.calls++;
    ms.promptTokens += prompt;
    ms.completionTokens += completion;
    ms.totalCostUsd += usage?.costUsd ?? 0;
    ms.cachedTokens += usage?.cachedTokens ?? 0;
    ms.cacheWriteTokens += usage?.cacheWriteTokens ?? 0;
    ms.reasoningTokens += usage?.reasoningTokens ?? 0;
  }
  scheduleSave();
}

function getModelStat(model: string): ModelStat {
  if (!modelStatsMap.has(model)) modelStatsMap.set(model, EMPTY_MODEL_STAT());
  return modelStatsMap.get(model)!;
}

function recordErrorStat(label: string): void { getStat(label).errors++; scheduleSave(); }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setSseHeaders(res: Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();
}

function writeAndFlush(res: Response, data: string) {
  res.write(data);
  (res as unknown as { flush?: () => void }).flush?.();
}

function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function extractExtendedUsageMetrics(usage: unknown): ExtendedUsageMetrics | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const usageRecord = usage as Record<string, unknown>;
  const promptDetails = usageRecord.prompt_tokens_details as Record<string, unknown> | undefined;
  const completionDetails = usageRecord.completion_tokens_details as Record<string, unknown> | undefined;

  const metrics: ExtendedUsageMetrics = {
    totalTokens: readFiniteNumber(usageRecord.total_tokens),
    costUsd: readFiniteNumber(usageRecord.cost),
    cachedTokens: readFiniteNumber(promptDetails?.cached_tokens),
    cacheWriteTokens: readFiniteNumber(promptDetails?.cache_write_tokens),
    reasoningTokens: readFiniteNumber(completionDetails?.reasoning_tokens),
  };

  if (Object.values(metrics).every((v) => v === undefined)) return undefined;
  return metrics;
}

type ClaudeCostRates = { inputPerMTok: number; outputPerMTok: number; cacheWritePerMTok: number; cacheReadPerMTok: number };
type GeminiCostRates = { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok: number };

function selectPricingTier(model: string | undefined, promptTokens: number) {
  const tiers = getPricing(model);
  if (!tiers?.length) return undefined;
  return [...tiers]
    .sort((a, b) => a.min_tokens - b.min_tokens)
    .filter((tier) => promptTokens >= tier.min_tokens)
    .at(-1);
}

function getGeminiCostRates(model: string | undefined, promptTokens: number): GeminiCostRates | undefined {
  const tier = selectPricingTier(model, promptTokens);
  if (!tier || tier.input === undefined || tier.output === undefined) return undefined;
  return {
    inputPerMTok: tier.input,
    outputPerMTok: tier.output,
    cacheReadPerMTok: tier.cache_read ?? 0,
  };
}

function getClaudeFallbackCostRates(model: string | undefined, promptTokens: number): ClaudeCostRates | undefined {
  const tier = selectPricingTier(model, promptTokens);
  if (!tier || tier.input === undefined || tier.output === undefined) return undefined;
  return {
    inputPerMTok: tier.input,
    outputPerMTok: tier.output,
    cacheWritePerMTok: tier.cache_write ?? 0,
    cacheReadPerMTok: tier.cache_read ?? 0,
  };
}

function withEstimatedCostIfMissing(
  model: string | undefined,
  promptTokens: number,
  completionTokens: number,
  usage?: ExtendedUsageMetrics,
): ExtendedUsageMetrics | undefined {
  if (usage?.costUsd !== undefined) return usage;

  const geminiRates = getGeminiCostRates(model, promptTokens);
  if (geminiRates) {
    const cachedTokens = usage?.cachedTokens ?? 0;
    const reasoningTokens = usage?.reasoningTokens ?? 0;
    const billableInputTokens = Math.max(0, promptTokens - cachedTokens);
    const billableOutputTokens = completionTokens + reasoningTokens;
    const estimatedCostUsd = (
      billableInputTokens * geminiRates.inputPerMTok
      + cachedTokens * geminiRates.cacheReadPerMTok
      + billableOutputTokens * geminiRates.outputPerMTok
    ) / 1_000_000;

    return {
      ...(usage ?? {}),
      totalTokens: usage?.totalTokens ?? (promptTokens + completionTokens + reasoningTokens),
      costUsd: estimatedCostUsd,
    };
  }

  const rates = getClaudeFallbackCostRates(model, promptTokens);
  if (!rates) return usage;

  const cachedTokens = usage?.cachedTokens ?? 0;
  const cacheWriteTokens = usage?.cacheWriteTokens ?? 0;
  const estimatedCostUsd = (
    promptTokens * rates.inputPerMTok
    + completionTokens * rates.outputPerMTok
    + cacheWriteTokens * rates.cacheWritePerMTok
    + cachedTokens * rates.cacheReadPerMTok
  ) / 1_000_000;

  return {
    ...(usage ?? {}),
    totalTokens: usage?.totalTokens ?? (promptTokens + completionTokens),
    costUsd: estimatedCostUsd,
  };
}

function extractAnthropicUsageMetrics(usage: unknown): ExtendedUsageMetrics | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const usageRecord = usage as Record<string, unknown>;
  const inputDetails = usageRecord.input_tokens_details as Record<string, unknown> | undefined;
  const outputDetails = usageRecord.output_tokens_details as Record<string, unknown> | undefined;
  const promptTokens = readFiniteNumber(usageRecord.input_tokens);
  const completionTokens = readFiniteNumber(usageRecord.output_tokens);
  const totalTokens = readFiniteNumber(usageRecord.total_tokens)
    ?? (promptTokens !== undefined || completionTokens !== undefined
      ? (promptTokens ?? 0) + (completionTokens ?? 0)
      : undefined);

  const metrics: ExtendedUsageMetrics = {
    totalTokens,
    costUsd: readFiniteNumber(usageRecord.cost),
    cachedTokens: readFiniteNumber(usageRecord.cache_read_input_tokens)
      ?? readFiniteNumber(inputDetails?.cache_read_input_tokens)
      ?? readFiniteNumber(inputDetails?.cached_tokens),
    cacheWriteTokens: readFiniteNumber(usageRecord.cache_creation_input_tokens)
      ?? readFiniteNumber(inputDetails?.cache_creation_input_tokens)
      ?? readFiniteNumber(inputDetails?.cache_write_tokens),
    reasoningTokens: readFiniteNumber(outputDetails?.reasoning_tokens),
  };

  if (Object.values(metrics).every((v) => v === undefined)) return undefined;
  return metrics;
}

const MAX_DEBUG_LOG_CHARS = 20_000;

function stringifyForDebugLog(payload: unknown): string {
  try {
    const serialized = JSON.stringify(payload);
    if (serialized.length <= MAX_DEBUG_LOG_CHARS) return serialized;
    return `${serialized.slice(0, MAX_DEBUG_LOG_CHARS)}... [truncated ${serialized.length - MAX_DEBUG_LOG_CHARS} chars]`;
  } catch {
    return "[unserializable payload]";
  }
}

function logResponseDebug(req: Request, label: string, payload: unknown): void {
  req.log.info({ response: stringifyForDebugLog(payload) }, label);
}

async function fakeStreamResponse(
  res: Response,
  json: Record<string, unknown>,
  startTime: number,
): Promise<{ promptTokens: number; completionTokens: number; ttftMs: number }> {
  const id = (json["id"] as string) ?? `chatcmpl-fake-${Date.now()}`;
  const model = (json["model"] as string) ?? "unknown";
  const created = (json["created"] as number) ?? Math.floor(Date.now() / 1000);
  const choices = (json["choices"] as Array<Record<string, unknown>>) ?? [];
  const usage = json["usage"] as { prompt_tokens?: number; completion_tokens?: number } | undefined;

  setSseHeaders(res);

  const roleChunk = {
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  };
  writeAndFlush(res, `data: ${JSON.stringify(roleChunk)}\n\n`);
  const ttftMs = Date.now() - startTime;

  const fullContent = (choices[0]?.["message"] as { content?: string })?.content ?? "";
  const toolCalls = (choices[0]?.["message"] as { tool_calls?: unknown[] })?.tool_calls;

  if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
    const tcChunk = {
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }],
    };
    writeAndFlush(res, `data: ${JSON.stringify(tcChunk)}\n\n`);
  }

  const CHUNK_SIZE = 4;
  for (let i = 0; i < fullContent.length; i += CHUNK_SIZE) {
    const slice = fullContent.slice(i, i + CHUNK_SIZE);
    const chunk = {
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { content: slice }, finish_reason: null }],
    };
    writeAndFlush(res, `data: ${JSON.stringify(chunk)}\n\n`);
    if (i + CHUNK_SIZE < fullContent.length) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  const finishReason = (choices[0]?.["finish_reason"] as string) ?? "stop";
  const stopChunk = {
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
  writeAndFlush(res, `data: ${JSON.stringify(stopChunk)}\n\n`);
  writeAndFlush(res, "data: [DONE]\n\n");
  res.end();

  return {
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    ttftMs,
  };
}

function requireApiKey(req: Request, res: Response, next: () => void) {
  const proxyKey = process.env.PROXY_API_KEY;
  if (!proxyKey) {
    res.status(500).json({ error: { message: "Server API key not configured", type: "server_error" } });
    return;
  }

  const authHeader = req.headers["authorization"];
  const xApiKey = req.headers["x-api-key"];
  const xGoogApiKey = req.headers["x-goog-api-key"];

  let providedKey: string | undefined;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    providedKey = authHeader.slice(7);
  } else if (typeof xApiKey === "string") {
    providedKey = xApiKey;
  } else if (typeof xGoogApiKey === "string") {
    providedKey = xGoogApiKey;
  }

  if (!providedKey) {
    res.status(401).json({ error: { message: "Missing API key (provide Authorization: Bearer <key>, x-api-key, or x-goog-api-key header)", type: "invalid_request_error" } });
    return;
  }
  if (providedKey !== proxyKey) {
    res.status(401).json({ error: { message: "Invalid API key", type: "invalid_request_error" } });
    return;
  }
  next();
}

function requireApiKeyWithQuery(req: Request, res: Response, next: () => void) {
  const queryKey = req.query["key"] as string | undefined;
  if (queryKey) {
    req.headers["authorization"] = `Bearer ${queryKey}`;
  }
  requireApiKey(req, res, next);
}

interface ParsedImageRequest {
  fields: Record<string, string>;
  images: string[];
}

function parseMultipartImageRequest(req: Request): ParsedImageRequest {
  const contentType = req.headers["content-type"] ?? "";
  const boundary = /boundary=([^;]+)/i.exec(String(contentType))?.[1];
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!boundary || body.length === 0) return { fields: {}, images: [] };

  const boundaryText = `--${boundary}`;
  const text = body.toString("latin1");
  const parts = text.split(boundaryText).slice(1, -1);
  const fields: Record<string, string> = {};
  const images: string[] = [];

  for (const part of parts) {
    const trimmed = part.replace(/^\r\n/, "").replace(/\r\n$/, "");
    const splitAt = trimmed.indexOf("\r\n\r\n");
    if (splitAt < 0) continue;
    const rawHeaders = trimmed.slice(0, splitAt);
    const rawBody = trimmed.slice(splitAt + 4);
    const name = /name="([^"]+)"/i.exec(rawHeaders)?.[1];
    if (!name) continue;
    const contentTypeHeader = /content-type:\s*([^\r\n]+)/i.exec(rawHeaders)?.[1]?.trim();
    const filename = /filename="([^"]*)"/i.exec(rawHeaders)?.[1];
    const partBuffer = Buffer.from(rawBody, "latin1");
    if (filename || contentTypeHeader?.startsWith("image/")) {
      const mime = contentTypeHeader && contentTypeHeader.startsWith("image/") ? contentTypeHeader : "image/png";
      images.push(`data:${mime};base64,${partBuffer.toString("base64")}`);
    } else {
      fields[name] = partBuffer.toString("utf8").trim();
    }
  }

  return { fields, images };
}

function parseJsonImageRequest(req: Request): ParsedImageRequest {
  const body = Buffer.isBuffer(req.body)
    ? JSON.parse(req.body.toString("utf8") || "{}") as Record<string, unknown>
    : (req.body ?? {}) as Record<string, unknown>;
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === "string") fields[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") fields[key] = String(value);
  }
  const images: string[] = [];
  const image = body.image;
  const inputImage = body.input_image;
  for (const value of [image, inputImage]) {
    if (typeof value === "string") images.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string") images.push(item);
    }
  }
  return { fields, images };
}

function parseOpenAIImageRequest(req: Request): ParsedImageRequest {
  const contentType = String(req.headers["content-type"] ?? "");
  if (contentType.includes("multipart/form-data")) return parseMultipartImageRequest(req);
  return parseJsonImageRequest(req);
}

function sizeToAspectRatio(size?: string): string | undefined {
  const match = /^(\d+)x(\d+)$/i.exec(size ?? "");
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return undefined;
  const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
  const d = gcd(width, height);
  return `${width / d}:${height / d}`;
}

function extractOpenAIImageData(result: Record<string, unknown>, responseFormat: string): Array<Record<string, string>> {
  const choices = result.choices as Array<Record<string, unknown>> | undefined;
  const data: Array<Record<string, string>> = [];
  for (const choice of choices ?? []) {
    const msg = choice.message as Record<string, unknown> | undefined;
    const content = typeof msg?.content === "string" ? msg.content : "";
    const matches = content.matchAll(/data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/g);
    for (const match of matches) {
      if (responseFormat === "url") data.push({ url: `data:image/png;base64,${match[1]}` });
      else data.push({ b64_json: match[1] ?? "" });
    }
  }
  return data;
}

function applyNestedValue(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    const existing = cursor[part];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1] ?? path] = value;
}

function normalizeTaggedValue(value: string, normalize?: unknown): string {
  if (normalize === "lowercase") return value.toLowerCase();
  if (normalize === "uppercase") return value.toUpperCase();
  return value;
}

function extractImageConfigTags(prompt: string, model: ReturnType<typeof resolveModel>): { prompt: string; imageConfig: Record<string, unknown> } {
  const config = getOpenRouterImageConfigTags(model);
  const tagDefs = config?.tags;
  if (!tagDefs || typeof tagDefs !== "object" || Array.isArray(tagDefs)) return { prompt, imageConfig: {} };
  const imageConfig: Record<string, unknown> = {};
  let nextPrompt = prompt;
  const strip = config.strip_from_prompt !== false;

  nextPrompt = nextPrompt.replace(/<\|\|([a-zA-Z0-9_-]+):([^|]+)\|\|>/g, (full, rawName: string, rawValue: string) => {
    const tagDef = (tagDefs as Record<string, unknown>)[rawName];
    if (!tagDef || typeof tagDef !== "object" || Array.isArray(tagDef)) return full;
    const record = tagDef as Record<string, unknown>;
    const target = typeof record.target === "string" ? record.target : undefined;
    if (!target?.startsWith("image_config.")) return full;
    const normalized = normalizeTaggedValue(rawValue.trim(), record.normalize);
    const allowed = Array.isArray(record.allowed) ? record.allowed.map(String) : undefined;
    if (allowed && !allowed.includes(normalized)) return strip ? "" : full;
    applyNestedValue(imageConfig, target.replace(/^image_config\./, ""), normalized);
    return strip ? "" : full;
  });

  return { prompt: nextPrompt.replace(/\n{3,}/g, "\n\n").trim(), imageConfig };
}

function extractImageTagsFromMessages(messages: OAIMessage[], model: ReturnType<typeof resolveModel>): { messages: OAIMessage[]; imageConfig: Record<string, unknown> } {
  const imageConfig: Record<string, unknown> = {};
  const next = messages.map((msg) => {
    if (typeof msg.content === "string") {
      const extracted = extractImageConfigTags(msg.content, model);
      Object.assign(imageConfig, extracted.imageConfig);
      return { ...msg, content: extracted.prompt } as OAIMessage;
    }
    if (Array.isArray(msg.content)) {
      let changed = false;
      const content = msg.content.map((part) => {
        if (part.type !== "text" || typeof (part as { text?: unknown }).text !== "string") return part;
        const extracted = extractImageConfigTags((part as { text: string }).text, model);
        Object.assign(imageConfig, extracted.imageConfig);
        if (extracted.prompt !== (part as { text: string }).text) changed = true;
        return { ...part, text: extracted.prompt };
      });
      return changed ? ({ ...msg, content } as OAIMessage) : msg;
    }
    return msg;
  });
  return { messages: next, imageConfig };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get("/v1/models", requireApiKey, (_req: Request, res: Response) => {
  refreshModelRegistryIfChanged();
  const pool = buildBackendPool();
  const friendStatuses = getFriendProxyConfigs().map(({ label, url }) => ({
    label,
    url,
    status: getCachedHealth(url) === null ? "unknown" : getCachedHealth(url) ? "healthy" : "down",
  }));
  res.json({
    object: "list",
    data: ALL_MODELS.filter((m) => isModelEnabled(m.id)).map((m) => ({
      id: m.id,
      object: "model",
      created: 1700000000,
      owned_by: "replit-proxy",
      description: (m as { description?: string }).description,
    })),
    _meta: {
      active_backends: pool.length,
      local: "healthy",
      friends: friendStatuses,
    },
  });
});

// ---------------------------------------------------------------------------
// Image format conversion: OpenAI image_url → Anthropic image
// ---------------------------------------------------------------------------

router.get("/v1beta/models", requireApiKeyWithQuery, (_req: Request, res: Response) => {
  refreshModelRegistryIfChanged();
  res.json({
    models: GEMINI_MODELS
      .filter((m) => isModelEnabled(m.id))
      .map((m) => ({
        name: `models/${m.id}`,
        version: "001",
        displayName: m.id,
        description: m.description,
        supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
      })),
  });
});

router.post(/^\/v1(?:beta)?\/models\/([^/]+):(generateContent|streamGenerateContent)$/, requireApiKeyWithQuery, async (req: Request, res: Response) => {
  const requestedModel = decodeURIComponent(String(req.params[0] ?? ""));
  const action = String(req.params[1] ?? "");
  const stream = action === "streamGenerateContent";
  const startTime = Date.now();

  try {
    const selectedModel = stripVisibleSuffix(requestedModel.replace(/^models\//, ""));
    if (!isModelEnabled(selectedModel)) {
      res.status(403).json({ error: { message: `Model '${selectedModel}' is disabled on this gateway`, type: "invalid_request_error", code: "model_disabled" } });
      return;
    }
    if (MODEL_PROVIDER_MAP.get(selectedModel) !== "gemini") {
      res.status(404).json({ error: { message: `Gemini native endpoint only supports Gemini provider models. '${selectedModel}' is not available here.`, type: "invalid_request_error", code: "model_not_found" } });
      return;
    }
    const alias = resolveGeminiAlias(selectedModel);
    if (!alias) {
      res.status(404).json({ error: { message: `Unknown Gemini model '${selectedModel}'`, type: "invalid_request_error", code: "model_not_found" } });
      return;
    }

    req.log.info({ model: selectedModel, upstreamModel: alias.actualModel, stream }, "Gemini native request");
    req.log.info({ payload: JSON.stringify(req.body) }, "Gemini native full payload");

    const result = await handleGeminiNative({ req, res, selectedModel, alias, body: req.body, stream, startTime });
    const duration = Date.now() - startTime;
    const finalUsage = withEstimatedCostIfMissing(selectedModel, result.promptTokens, result.completionTokens, result.usage);
    recordCallStat("local", duration, result.promptTokens, result.completionTokens, result.ttftMs, selectedModel, finalUsage);
    pushRequestLog({
      method: req.method, path: req.path, model: selectedModel,
      backend: "local", provider: "gemini", status: 200, duration, stream,
      promptTokens: result.promptTokens, completionTokens: result.completionTokens,
      totalTokens: finalUsage?.totalTokens ?? result.promptTokens + result.completionTokens,
      costUsd: finalUsage?.costUsd,
      cachedTokens: finalUsage?.cachedTokens,
      cacheWriteTokens: finalUsage?.cacheWriteTokens,
      reasoningTokens: finalUsage?.reasoningTokens,
      level: "info",
    });
  } catch (err) {
    const duration = Date.now() - startTime;
    recordErrorStat("local");
    const message = err instanceof Error ? err.message : String(err);
    req.log.error({ err }, "Gemini native request failed");
    pushRequestLog({
      method: req.method, path: req.path, model: requestedModel,
      backend: "local", provider: "gemini", status: 500, duration, stream,
      level: "error", error: message,
    });
    if (!res.headersSent) {
      res.status(500).json({ error: { message, type: "server_error" } });
    } else if (!res.writableEnded) {
      writeAndFlush(res, `data: ${JSON.stringify({ error: { message } })}\n\n`);
      res.end();
    }
  }
});

type OAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } }
  | Record<string, unknown>;

type OAIToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type OAITool = {
  type: "function";
  function: { name: string; description?: string; parameters?: unknown };
};

type OAIMessage =
  | { role: "system"; content: string | OAIContentPart[] }
  | { role: "user"; content: string | OAIContentPart[] }
  | { role: "assistant"; content: string | OAIContentPart[] | null; tool_calls?: OAIToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string }
  | { role: string; content: string | OAIContentPart[] | null };

type AnthropicImageSource =
  | { type: "base64"; media_type: string; data: string }
  | { type: "url"; url: string };

type AnthropicContentPart =
  | { type: "text"; text: string; cache_control?: { type?: string; ttl?: string } }
  | { type: "image"; source: AnthropicImageSource }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string | AnthropicContentPart[] }
  | Record<string, unknown>;

type AnthropicMessage = { role: "user" | "assistant"; content: string | AnthropicContentPart[] };

function convertContentForClaude(content: string | OAIContentPart[] | null | undefined): string | AnthropicContentPart[] {
  if (!content) return "";
  if (typeof content === "string") return content;

  return content.map((part): AnthropicContentPart => {
    if (part.type === "image_url") {
      const url = (part as { type: "image_url"; image_url: { url: string } }).image_url.url;
      if (url.startsWith("data:")) {
        const [header, data] = url.split(",");
        const media_type = header.replace("data:", "").replace(";base64", "");
        return { type: "image", source: { type: "base64", media_type, data } };
      } else {
        return { type: "image", source: { type: "url", url } };
      }
    }
    if (part.type === "text") {
      return { type: "text", text: (part as { type: "text"; text: string }).text };
    }
    return { type: "text", text: JSON.stringify(part) };
  });
}

// Convert OpenAI tools array → Anthropic tools array
function convertToolsForClaude(tools: OAITool[]): { name: string; description: string; input_schema: unknown }[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? "",
    input_schema: t.function.parameters ?? { type: "object", properties: {} },
  }));
}

// Convert OpenAI messages (incl. tool_calls / tool roles) → Anthropic messages
function convertMessagesForClaude(messages: OAIMessage[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue; // handled as top-level system param

    if (msg.role === "assistant") {
      const assistantMsg = msg as Extract<OAIMessage, { role: "assistant" }>;
      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
        // Convert tool_calls to Anthropic tool_use blocks
        const parts: AnthropicContentPart[] = [];
        const textContent = assistantMsg.content;
        if (textContent && (typeof textContent === "string" ? textContent.trim() : textContent.length > 0)) {
          const converted = convertContentForClaude(textContent as string | OAIContentPart[]);
          if (typeof converted === "string") {
            if (converted.trim()) parts.push({ type: "text", text: converted });
          } else {
            parts.push(...converted);
          }
        }
        for (const tc of assistantMsg.tool_calls) {
          let input: unknown = {};
          try { input = JSON.parse(tc.function.arguments); } catch {}
          parts.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
        }
        result.push({ role: "assistant", content: parts });
      } else {
        result.push({
          role: "assistant",
          content: convertContentForClaude(assistantMsg.content as string | OAIContentPart[]),
        });
      }
    } else if (msg.role === "tool") {
      // Tool results → Anthropic user message with tool_result
      const toolMsg = msg as Extract<OAIMessage, { role: "tool" }>;
      result.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolMsg.tool_call_id, content: toolMsg.content }],
      });
    } else {
      // user (and any other role)
      result.push({
        role: "user",
        content: convertContentForClaude(msg.content as string | OAIContentPart[]),
      });
    }
  }

  return result;
}

router.post(/^\/v1\/images\/(generations|edits)$/, requireApiKey, async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const { fields, images } = parseOpenAIImageRequest(req);
    const model = stripVisibleSuffix(fields.model ?? "bytedance-seed/seedream-4.5");
    const prompt = fields.prompt ?? "";
    const n = Math.max(1, Math.min(4, Number(fields.n ?? 1) || 1));
    const responseFormat = fields.response_format === "url" ? "url" : "b64_json";
    const resolved = resolveModel(model);
    if (!resolved) {
      res.status(404).json({ error: { message: `Unknown model '${model}'`, type: "invalid_request_error", code: "model_not_found" } });
      return;
    }
    if (!isModelEnabled(model)) {
      res.status(403).json({ error: { message: `Model '${model}' is disabled on this gateway`, type: "invalid_request_error", code: "model_disabled" } });
      return;
    }
    if (resolved.provider !== "openrouter" || !modelHasFeature(resolved, "image_only")) {
      res.status(400).json({ error: { message: `Model '${model}' is not configured as an OpenRouter image model`, type: "invalid_request_error" } });
      return;
    }

    const tagged = extractImageConfigTags(prompt, resolved);
    const content: OAIContentPart[] = [{ type: "text", text: fields.size ? `${tagged.prompt}\n\nRequested size: ${fields.size}.` : tagged.prompt }];
    for (const imageUrl of images) content.push({ type: "image_url", image_url: { url: imageUrl } });

    const client = makeLocalOpenRouter();
    const imageConfig: Record<string, unknown> = { ...tagged.imageConfig };
    const aspectRatio = fields.aspect_ratio ?? sizeToAspectRatio(fields.size);
    if (aspectRatio) imageConfig.aspect_ratio = aspectRatio;
    if (fields.quality) imageConfig.quality = fields.quality;
    if (fields.size) imageConfig.size = fields.size;
    if (fields.image_size) imageConfig.image_size = fields.image_size;

    const data: Array<Record<string, string>> = [];
    let promptTokens = 0;
    let completionTokens = 0;
    let usage: ExtendedUsageMetrics | undefined;
    for (let i = 0; i < n; i++) {
      const params: Record<string, unknown> = {
        model: resolved.actualModel,
        messages: [{ role: "user", content }],
        stream: false,
        modalities: getOpenRouterModalities(resolved) ?? ["image"],
      };
      const providerRouting = getOpenRouterProviderRouting(resolved);
      if (providerRouting) params.provider = providerRouting;
      if (Object.keys(imageConfig).length > 0) params.image_config = imageConfig;
      const result = await client.chat.completions.create(params as unknown as Parameters<typeof client.chat.completions.create>[0]) as OpenAI.Chat.Completions.ChatCompletion;
      const resultRecord = result as unknown as Record<string, unknown>;
      normalizeImageResponse(resultRecord);
      data.push(...extractOpenAIImageData(resultRecord, responseFormat));
      promptTokens += result.usage?.prompt_tokens ?? 0;
      completionTokens += result.usage?.completion_tokens ?? 0;
      usage = extractExtendedUsageMetrics(result.usage) ?? usage;
    }

    const duration = Date.now() - startTime;
    recordCallStat("openrouter", duration, promptTokens, completionTokens, undefined, model, usage);
    pushRequestLog({
      method: req.method, path: req.path, model,
      backend: "openrouter", status: 200, duration, stream: false,
      promptTokens, completionTokens,
      totalTokens: usage?.totalTokens ?? (promptTokens + completionTokens),
      costUsd: usage?.costUsd,
      cachedTokens: usage?.cachedTokens,
      cacheWriteTokens: usage?.cacheWriteTokens,
      reasoningTokens: usage?.reasoningTokens,
      level: "info",
    });
    res.json({ created: Math.floor(Date.now() / 1000), data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Image generation failed";
    req.log.error({ err }, "OpenAI-compatible image endpoint failed");
    pushRequestLog({
      method: req.method, path: req.path, backend: "openrouter",
      status: 500, duration: Date.now() - startTime, stream: false,
      level: "error", error: message,
    });
    res.status(500).json({ error: { message, type: "api_error" } });
  }
});

router.post("/v1/chat/completions", requireApiKey, async (req: Request, res: Response) => {
  const { model, messages, stream, max_tokens, temperature, top_p, tools, tool_choice, reasoning: clientReasoning, reasoning_effort: clientReasoningEffort, cache_control } = req.body as {
    model?: string;
    messages: OAIMessage[];
    stream?: boolean;
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    tools?: OAITool[];
    tool_choice?: unknown;
    reasoning?: { effort?: string; enabled?: boolean };
    reasoning_effort?: string;
    cache_control?: { type?: string };
  };

  // Convert top-level reasoning_effort → OpenRouter { effort } format (client-provided reasoning takes priority)
  const resolvedClientReasoning: { effort: string } | { enabled: boolean } | undefined =
    typeof clientReasoning?.effort === "string"
      ? { effort: clientReasoning.effort }
      : typeof clientReasoning?.enabled === "boolean"
        ? { enabled: clientReasoning.enabled }
        : clientReasoningEffort
          ? { effort: clientReasoningEffort }
          : undefined;

  // Normalize: strip legacy -visible suffix before any other processing
  const selectedModel = model ? stripVisibleSuffix(model) : model;
  if (!selectedModel) {
    res.status(400).json({ error: { message: "Missing required field 'model'", type: "invalid_request_error" } });
    return;
  }

  const resolved = resolveModel(selectedModel);
  if (!resolved) {
    res.status(404).json({ error: { message: `Unknown model '${selectedModel}'`, type: "invalid_request_error", code: "model_not_found" } });
    return;
  }

  // Reject disabled models early
  if (!isModelEnabled(selectedModel)) {
    res.status(403).json({ error: { message: `Model '${selectedModel}' is disabled on this gateway`, type: "invalid_request_error", code: "model_disabled" } });
    return;
  }
  const provider = resolved.provider;
  const isClaudeModel = provider === "anthropic";
  const isGeminiModel = provider === "gemini";
  const isOpenRouterModel = provider === "openrouter";
  const isOpenRouterAnthropicModel = isOpenRouterModel && (selectedModel?.startsWith("anthropic/") ?? false);
  const shouldStream = stream ?? false;
  const startTime = Date.now();

  const finalMessages = ((isClaudeModel || isOpenRouterAnthropicModel) && getSillyTavernMode() && !tools?.length)
    ? [...messages, { role: "user" as const, content: "继续" }]
    : messages;

  const MAX_FRIEND_RETRIES = 3;
  const triedFriendUrls = new Set<string>();
  let backend = pickBackend();
  if (!backend) { res.status(503).json({ error: { message: "No available backends — all sub-nodes are down and local fallback is disabled", type: "service_unavailable" } }); return; }

  for (let attempt = 0; ; attempt++) {
    const backendLabel = backend.kind === "local" ? "local" : backend.label;
    req.log.info({ model: selectedModel, backend: backendLabel, attempt, counter: requestCounter - 1, sillyTavern: isClaudeModel && getSillyTavernMode(), toolCount: tools?.length ?? 0 }, "Proxy request");
    req.log.info({ payload: JSON.stringify(req.body) }, "Proxy request full payload");

    try {
      let result: { promptTokens: number; completionTokens: number; ttftMs?: number; usage?: ExtendedUsageMetrics };
      if (backend.kind === "friend") {
        triedFriendUrls.add(backend.url);
        result = await handleFriendProxy({ req, res, backend, model: selectedModel, messages: finalMessages, stream: shouldStream, maxTokens: max_tokens, tools, toolChoice: tool_choice, startTime });
      } else if (isClaudeModel) {
        const webSearch = modelHasFeature(resolved, "web_search");
        const thinkingEnabled = modelHasFeature(resolved, "visible_reasoning");
        const modelMax = resolved.maxTokens ?? 32000;
        const defaultMaxTokens = thinkingEnabled ? Math.max(modelMax, 32000) : modelMax;
        const client = makeLocalAnthropic();
        const cacheControl = cache_control ?? { type: "ephemeral" };
        result = await handleClaude({
          req,
          res,
          client,
          model: resolved.actualModel,
          messages: finalMessages,
          stream: shouldStream,
          maxTokens: max_tokens ?? defaultMaxTokens,
          temperature,
          topP: top_p,
          thinking: thinkingEnabled,
          thinkingVisible: thinkingEnabled,
          tools,
          toolChoice: tool_choice,
          webSearch,
          use300k: modelHasFeature(resolved, "output_300k_beta"),
          cacheControl,
          startTime,
          anthropicDefaults: getAnthropicDefaults(resolved),
          requestHeaders: resolved.headers,
        });
      } else if (isGeminiModel) {
        const geminiAlias = selectedModel ? resolveGeminiAlias(selectedModel) : undefined;
        if (!geminiAlias) {
          res.status(404).json({ error: { message: `Unknown Gemini model '${selectedModel}'`, type: "invalid_request_error", code: "model_not_found" } });
          return;
        }
        result = await handleGemini({ req, res, model: geminiAlias.actualModel, messages: finalMessages, stream: shouldStream, maxTokens: max_tokens, thinkingConfig: geminiAlias.thinkingConfig, startTime });
      } else if (isOpenRouterModel) {
        // Client-provided reasoning takes priority over the model-suffix-derived value
        const finalOrReasoning = resolvedClientReasoning ?? getOpenRouterReasoning(resolved);
        const orActualModel = resolved.actualModel;
        const orProviderRouting = getOpenRouterProviderRouting(resolved);

        if (orActualModel.startsWith("anthropic/")) {
          const cacheControl = cache_control ?? { type: "ephemeral" };
          result = await handleOpenRouterFetch({
            req,
            res,
            model: orActualModel,
            messages: finalMessages,
            stream: shouldStream,
            maxTokens: max_tokens,
            tools,
            toolChoice: tool_choice,
            startTime,
            reasoning: finalOrReasoning,
            providerRouting: orProviderRouting,
            cacheControl,
          });
        } else {
          const client = makeLocalOpenRouter();
          const orImageModalities = getOpenRouterModalities(resolved);
          let imageConfig: Record<string, unknown> | undefined;
          let routedMessages = finalMessages;
          if (orImageModalities) {
            const extracted = extractImageTagsFromMessages(finalMessages, resolved);
            routedMessages = extracted.messages;
            imageConfig = extracted.imageConfig;
          }
          result = await handleOpenAI({ req, res, client, model: orActualModel, messages: routedMessages, stream: shouldStream, maxTokens: max_tokens, tools, toolChoice: tool_choice, startTime, reasoning: finalOrReasoning, thinkingVisible: modelHasFeature(resolved, "visible_reasoning"), imageModalities: orImageModalities, providerRouting: orProviderRouting, imageConfig });
        }
      } else {
        const client = makeLocalOpenAI();
        result = await handleOpenAI({ req, res, client, model: resolved.actualModel, messages: finalMessages, stream: shouldStream, maxTokens: max_tokens, tools, toolChoice: tool_choice, startTime });
      }
      // ✅ Success — record stats, mark friend healthy, and exit retry loop
      if (backend.kind === "friend") setHealth(backend.url, true);
      const duration = Date.now() - startTime;
      const finalUsage = withEstimatedCostIfMissing(selectedModel, result.promptTokens, result.completionTokens, result.usage);
      recordCallStat(backendLabel, duration, result.promptTokens, result.completionTokens, result.ttftMs, selectedModel, finalUsage);
      pushRequestLog({
        method: req.method, path: req.path, model: selectedModel,
        backend: backendLabel, status: 200, duration, stream: shouldStream,
        promptTokens: result.promptTokens, completionTokens: result.completionTokens,
        totalTokens: finalUsage?.totalTokens ?? (result.promptTokens + result.completionTokens),
        costUsd: finalUsage?.costUsd,
        cachedTokens: finalUsage?.cachedTokens,
        cacheWriteTokens: finalUsage?.cacheWriteTokens,
        reasoningTokens: finalUsage?.reasoningTokens,
        provider,
        level: "info",
      });
      break;
    } catch (err: unknown) {
      // ❌ Failure — record error, decide whether to retry on a different node
      recordErrorStat(backendLabel);

      const is5xx = err instanceof FriendProxyHttpError && err.status >= 500;
      const errMsg = err instanceof Error ? err.message : "";
      const isNetworkErr = err instanceof TypeError
        || ["fetch", "aborted", "terminated", "closed", "upstream", "ECONNRESET", "socket hang up", "UND_ERR"]
          .some((kw) => errMsg.includes(kw));

      if (backend.kind === "friend" && (is5xx || isNetworkErr)) {
        setHealth(backend.url, false);
        req.log.warn({ url: backend.url, attempt, is5xx, isNetworkErr }, "Friend backend marked unhealthy, considering retry");

        if (attempt < MAX_FRIEND_RETRIES && !res.headersSent) {
          const next = pickBackendExcluding(triedFriendUrls);
          if (next?.kind === "friend") {
            backend = next;
            continue; // retry with next friend node
          }
        }
      }

      req.log.error({ err }, "Proxy request failed");
      const errStatus = (err instanceof FriendProxyHttpError ? err.status : undefined) ?? 500;
      pushRequestLog({
        method: req.method, path: req.path, model: selectedModel,
        backend: backendLabel, status: errStatus, duration: Date.now() - startTime,
        stream: shouldStream, provider, level: errStatus >= 500 ? "error" : "warn",
        error: errMsg || "Unknown error",
      });
      if (!res.headersSent) {
        res.status(500).json({ error: { message: errMsg || "Unknown error", type: "server_error" } });
      } else if (!res.writableEnded) {
        writeAndFlush(res, `data: ${JSON.stringify({ error: { message: errMsg || "Unknown error" } })}\n\n`);
        writeAndFlush(res, "data: [DONE]\n\n");
        res.end();
      }
      break;
    }
  }
});

// ---------------------------------------------------------------------------
// Anthropic-native /v1/messages endpoint
// Accepts Anthropic API format directly (for clients like Cherry Studio, Claude.ai compatible tools)
// ---------------------------------------------------------------------------

const TOOL_ID_MARKER_RE = /<!--\s*tool_id:([^-\s]+?)\s*-->/g;

/**
 * Inject a hidden <!-- tool_id:xxx --> marker into the first text block of a
 * non-streaming Anthropic response that contains tool_use blocks.
 * This lets clients that strip tool_use metadata still carry the id in text,
 * so we can recover it on the next request without scanning history.
 */
// Block types produced by Anthropic's built-in server-side tools (e.g. web_search_20250305).
// Forwarded to the client by default; optionally hidden for specific clients.
const SERVER_TOOL_BLOCK_TYPES = new Set(["server_tool_use", "web_search_tool_result"]);
const SEARCH_INVISIBLE_TAG = "<||search-invisible||>";
const SEARCH_VISIBLE_TAG = "<||search-visible||>";

function stripSearchControlTagsFromText(text: string): { text: string; invisibleEnabled: boolean; visibleEnabled: boolean; changed: boolean } {
  const invisibleEnabled = text.includes(SEARCH_INVISIBLE_TAG);
  const visibleEnabled = text.includes(SEARCH_VISIBLE_TAG);
  if (!invisibleEnabled && !visibleEnabled) {
    return { text, invisibleEnabled, visibleEnabled, changed: false };
  }
  return {
    text: text.split(SEARCH_INVISIBLE_TAG).join("").split(SEARCH_VISIBLE_TAG).join(""),
    invisibleEnabled,
    visibleEnabled,
    changed: true,
  };
}

function stripSearchControlTagsFromSystem(system: unknown): { system: unknown; invisibleEnabled: boolean; visibleEnabled: boolean } {
  if (typeof system === "string") {
    const stripped = stripSearchControlTagsFromText(system);
    return { system: stripped.changed ? stripped.text : system, invisibleEnabled: stripped.invisibleEnabled, visibleEnabled: stripped.visibleEnabled };
  }

  if (!Array.isArray(system)) {
    return { system, invisibleEnabled: false, visibleEnabled: false };
  }

  let invisibleEnabled = false;
  let visibleEnabled = false;
  let changed = false;
  const nextSystem = system.map((block) => {
    if (!block || typeof block !== "object") return block;
    const record = block as Record<string, unknown>;
    if (record.type !== "text" || typeof record.text !== "string") return block;
    const stripped = stripSearchControlTagsFromText(record.text);
    invisibleEnabled ||= stripped.invisibleEnabled;
    visibleEnabled ||= stripped.visibleEnabled;
    if (!stripped.changed) return block;
    changed = true;
    return { ...record, text: stripped.text };
  });

  return { system: changed ? nextSystem : system, invisibleEnabled, visibleEnabled };
}

function stripSearchControlTagsFromMessages(messages: AnthropicMessage[]): { messages: AnthropicMessage[]; invisibleEnabled: boolean; visibleEnabled: boolean } {
  let invisibleEnabled = false;
  let visibleEnabled = false;

  const cleaned = messages.map((msg) => {
    if (typeof msg.content === "string") {
      const stripped = stripSearchControlTagsFromText(msg.content);
      if (!stripped.changed) return msg;
      invisibleEnabled ||= stripped.invisibleEnabled;
      visibleEnabled ||= stripped.visibleEnabled;
      return { ...msg, content: stripped.text } as AnthropicMessage;
    }

    if (!Array.isArray(msg.content)) return msg;

    let changed = false;
    const nextContent = (msg.content as Record<string, unknown>[]).map((block) => {
      if (block.type !== "text" || typeof block.text !== "string") return block;
      const stripped = stripSearchControlTagsFromText(block.text as string);
      if (!stripped.changed) return block;
      invisibleEnabled ||= stripped.invisibleEnabled;
      visibleEnabled ||= stripped.visibleEnabled;
      changed = true;
      return { ...block, text: stripped.text };
    });

    if (!changed) return msg;
    return { ...msg, content: nextContent } as AnthropicMessage;
  });

  return { messages: cleaned, invisibleEnabled, visibleEnabled };
}

function shouldHideServerToolStreamEvent(
  event: Record<string, unknown>,
  hiddenIndexes: Set<number>
): boolean {
  const type = event.type as string | undefined;
  if (!type) return false;

  if (type === "content_block_start") {
    const index = event.index as number | undefined;
    const blockType = (event.content_block as { type?: string } | undefined)?.type;
    if (index !== undefined && blockType && SERVER_TOOL_BLOCK_TYPES.has(blockType)) {
      hiddenIndexes.add(index);
      return true;
    }
    return false;
  }

  if (type === "content_block_delta" || type === "content_block_stop") {
    const index = event.index as number | undefined;
    return index !== undefined && hiddenIndexes.has(index);
  }

  return false;
}

function filterServerToolBlocksInContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return (content as Record<string, unknown>[]).filter((block) => !SERVER_TOOL_BLOCK_TYPES.has((block.type as string) ?? ""));
}

function summarizeUnknownForReference(value: unknown, maxChars = 1200): string {
  let s: string;
  if (typeof value === "string") s = value;
  else s = stringifyForDebugLog(value);
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}...`;
}

function extractServerToolReferenceText(block: Record<string, unknown>): string | null {
  const blockType = (block.type as string) ?? "";
  if (!SERVER_TOOL_BLOCK_TYPES.has(blockType)) return null;

  if (blockType === "web_search_tool_result") {
    const payload = block.content ?? block.result ?? block;
    const text = summarizeUnknownForReference(payload);
    return text.trim() ? text : null;
  }

  const toolName = typeof block.name === "string" ? block.name : "server_tool_use";
  const inputText = block.input !== undefined ? summarizeUnknownForReference(block.input) : "";
  return inputText ? `[${toolName}] ${inputText}` : `[${toolName}]`;
}

function collectServerToolReferencesFromContent(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const refs: string[] = [];
  for (const block of content as Record<string, unknown>[]) {
    const ref = extractServerToolReferenceText(block);
    if (ref) refs.push(ref);
  }
  return refs;
}

function buildSearchReferenceAppendix(references: string[]): string {
  if (references.length === 0) return "";
  const lines = references.map((ref, idx) => `- [${idx + 1}] ${ref}`);
  return `---\n工具调用的结果（references）：\n${lines.join("\n")}`;
}

function appendReferencesToAssistantContent(content: unknown, references: string[]): unknown {
  if (!Array.isArray(content) || references.length === 0) return content;

  const blocks = [...(content as Record<string, unknown>[])];
  const appendix = buildSearchReferenceAppendix(references);
  if (!appendix) return blocks;

  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.type === "text" && typeof block.text === "string") {
      blocks[i] = { ...block, text: `${block.text}\n\n${appendix}` };
      return blocks;
    }
  }

  blocks.push({ type: "text", text: appendix });
  return blocks;
}

function injectToolIdMarker(
  content: Record<string, unknown>[]
): Record<string, unknown>[] {
  let lastToolUseId: string | undefined;
  let markerInjected = false;
  return content.map((block) => {
    if ((block.type === "tool_use" || block.type === "server_tool_use") && typeof block.id === "string") {
      lastToolUseId = block.id as string;
      markerInjected = false;
      return block;
    }
    if (block.type === "text" && lastToolUseId && !markerInjected) {
      markerInjected = true;
      return { ...block, text: `<!-- tool_id:${lastToolUseId}-->` + (block.text ?? "") };
    }
    return block;
  });
}

/**
 * Sanitize Anthropic messages before forwarding to the API:
 *
 * 1. Extract <!-- tool_id:xxx --> markers that were previously injected into
 *    assistant text replies, and use those ids to fill in missing tool_use_id
 *    fields on tool_result blocks in the following user message.
 * 2. Strip the markers from assistant text before forwarding upstream.
 * 3. As a fallback, scan assistant messages for tool_use blocks when no marker
 *    is present (handles old history that pre-dates the marker injection).
 * 4. Drop any tool_result block that still has no resolvable id.
 * 5. Remove user messages that become empty after dropping bad blocks.
 */
/** Returns true if the model version is 4.6 or newer (no assistant prefill support). */
function modelNoPrefill(model: string): boolean {
  return modelHasFeature(model, "no_prefill");
}

function sanitizeAnthropicMessages(messages: AnthropicMessage[], model?: string): AnthropicMessage[] {
  const dropInvalidThinkingBlocks = (blocks: Record<string, unknown>[]): Record<string, unknown>[] =>
    blocks.filter((b) => {
      if (b.type !== "thinking") return true;
      return typeof b.signature === "string" && b.signature.trim().length > 0;
    });

  // ── Pass 1: collect marker-based ids & fallback tool_use ids per message ──
  type IdSource = { ids: string[]; msgIndex: number };
  const markerIdsByMsg = new Map<number, IdSource>(); // assistant msgIndex → ids from markers
  const toolUseIdsByMsg = new Map<number, IdSource>(); // assistant msgIndex → ids from tool_use blocks

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const blocks = Array.isArray(msg.content) ? (msg.content as Record<string, unknown>[]) : [];

    const markerIds: string[] = [];
    const toolUseIds: string[] = [];

    for (const block of blocks) {
      if ((block.type === "tool_use" || block.type === "server_tool_use") && typeof block.id === "string") {
        toolUseIds.push(block.id as string);
      }
      if (block.type === "text" && typeof block.text === "string") {
        for (const m of (block.text as string).matchAll(TOOL_ID_MARKER_RE)) {
          markerIds.push(m[1]);
        }
      }
    }

    if (markerIds.length > 0) markerIdsByMsg.set(i, { ids: markerIds, msgIndex: i });
    if (toolUseIds.length > 0) toolUseIdsByMsg.set(i, { ids: toolUseIds, msgIndex: i });
  }

  // ── Pass 2: strip markers, fill tool_use_ids ──
  const result: AnthropicMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const normalizedMsg = Array.isArray(msg.content)
      ? { ...msg, content: dropInvalidThinkingBlocks(msg.content as Record<string, unknown>[]) }
      : msg;

    // Fix assistant message content: strip markers from text, fill missing tool_use_ids
    if (normalizedMsg.role === "assistant" && Array.isArray(normalizedMsg.content)) {
      const blocks = normalizedMsg.content as Record<string, unknown>[];
      let lastToolId: string | undefined;
      const cleanContent = blocks.flatMap((block) => {
        // Track the last seen tool_use id within this assistant message
        if (block.type === "tool_use" && typeof block.id === "string") {
          lastToolId = block.id as string;
          return [block];
        }
        // Fill in missing tool_use_id on tool_result blocks using the marker in text
        if (block.type === "tool_result" && !block.tool_use_id) {
          const markerIds = markerIdsByMsg.get(i)?.ids ?? [];
          const id = markerIds[0] ?? lastToolId;
          if (id) return [{ ...block, tool_use_id: id }];
          return [block];
        }
        // Strip markers from text blocks; drop the block entirely if it becomes empty
        if (block.type === "text" && typeof block.text === "string") {
          const cleaned = (block.text as string).replace(TOOL_ID_MARKER_RE, "").trimStart();
          if (!cleaned) return []; // drop empty text blocks
          return [{ ...block, text: cleaned }];
        }
        return [block];
      });
      result.push({ ...normalizedMsg, content: cleanContent } as AnthropicMessage);
      continue;
    }

    // For user messages that may contain tool_result blocks
    if (normalizedMsg.role === "user" && Array.isArray(normalizedMsg.content)) {
      // Determine which id pool to use: prefer marker ids from immediately preceding assistant msg
      const prevIdx = i - 1;
      const idPool: string[] = (
        markerIdsByMsg.get(prevIdx) ??
        toolUseIdsByMsg.get(prevIdx) ??
        // walk backwards for older history
        (() => {
          for (let j = prevIdx - 1; j >= 0; j--) {
            const src = markerIdsByMsg.get(j) ?? toolUseIdsByMsg.get(j);
            if (src) return src;
          }
          return undefined;
        })()
      )?.ids ?? [];

      let idIndex = 0;
      const sanitizedContent: unknown[] = [];

      for (const block of normalizedMsg.content as Record<string, unknown>[]) {
        if (block.type === "tool_result") {
          if (block.tool_use_id) {
            sanitizedContent.push(block);
          } else {
            const id = idPool[idIndex++];
            if (id) {
              sanitizedContent.push({ ...block, tool_use_id: id });
            }
            // else drop — unfixable, sending it causes a 400
          }
        } else {
          sanitizedContent.push(block);
        }
      }

      // Also drop empty text blocks that clients sometimes send
      const finalContent = sanitizedContent.filter(
        (b) => !((b as Record<string, unknown>).type === "text" && ((b as Record<string, unknown>).text === "" || (b as Record<string, unknown>).text == null))
      );

      if (finalContent.length > 0) {
        result.push({ ...normalizedMsg, content: finalContent } as AnthropicMessage);
      }
      continue;
    }

    // Fallback: pass through other messages but still strip empty text blocks
    if (Array.isArray(normalizedMsg.content)) {
      const cleaned = (normalizedMsg.content as Record<string, unknown>[]).filter(
        (b) => !(b.type === "text" && (b.text === "" || b.text == null))
      );
      if (cleaned.length > 0) {
        result.push({ ...normalizedMsg, content: cleaned } as AnthropicMessage);
      }
      continue;
    }

    result.push(normalizedMsg as AnthropicMessage);
  }

  // ── Pass 3: drop orphaned tool_use / tool_result blocks ──
  // If an assistant message has tool_use blocks with no matching tool_result in the
  // next user message, strip those tool_use blocks.
  // If a user message has tool_result blocks with no tool_use_id, or whose
  // tool_use_id has no matching tool_use in the previous assistant message, drop them.
  // Clients that don't send back full tool call history are treated as plain chat.
  const cleaned: AnthropicMessage[] = [];

  // Collect all surviving tool_use IDs per message index after Pass 2
  const survivingToolUseIds = new Map<number, Set<string>>();
  for (let i = 0; i < result.length; i++) {
    const msg = result[i];
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const ids = new Set(
        (msg.content as Record<string, unknown>[])
          .filter((b) => b.type === "tool_use" && typeof b.id === "string")
          .map((b) => b.id as string)
      );
      if (ids.size > 0) survivingToolUseIds.set(i, ids);
    }
  }

  for (let i = 0; i < result.length; i++) {
    const msg = result[i];

    // Strip orphaned tool_use blocks from assistant messages
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const toolUseIds = survivingToolUseIds.get(i);
      if (toolUseIds && toolUseIds.size > 0) {
        const next = result[i + 1];
        const nextBlocks = (next?.role === "user" && Array.isArray(next.content))
          ? (next.content as Record<string, unknown>[])
          : [];
        const resultIds = new Set(
          nextBlocks
            .filter((b) => b.type === "tool_result" && typeof b.tool_use_id === "string")
            .map((b) => b.tool_use_id as string)
        );
        const orphanIds = new Set([...toolUseIds].filter((id) => !resultIds.has(id)));
        if (orphanIds.size > 0) {
          // Remove stripped IDs so the user-message pass knows they're gone
          orphanIds.forEach((id) => toolUseIds.delete(id));
          const strippedBlocks = (msg.content as Record<string, unknown>[]).filter(
            (b) => !(b.type === "tool_use" && orphanIds.has(b.id as string))
          );
          if (strippedBlocks.length === 0) continue;
          cleaned.push({ ...msg, content: strippedBlocks } as AnthropicMessage);
          continue;
        }
      }
    }

    // Strip orphaned / id-less tool_result blocks from user messages
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const prevToolUseIds = survivingToolUseIds.get(i - 1) ?? new Set<string>();
      const sanitized = (msg.content as Record<string, unknown>[]).filter((b) => {
        if (b.type !== "tool_result") return true;
        const tid = b.tool_use_id as string | undefined;
        // Drop if no id, or if the matching tool_use was stripped / never existed
        if (!tid) return false;
        if (prevToolUseIds.size > 0 && !prevToolUseIds.has(tid)) return false;
        return true;
      });
      if (sanitized.length === 0) continue;
      cleaned.push({ ...msg, content: sanitized } as AnthropicMessage);
      continue;
    }

    cleaned.push(msg);
  }

  // Claude 4.6+ does not support assistant prefill — append a user "continue" if last message is assistant
  if (model && modelNoPrefill(model) && cleaned.length > 0 && cleaned[cleaned.length - 1].role === "assistant") {
    cleaned.push({ role: "user", content: "continue" } as AnthropicMessage);
  }

  return cleaned;
}

function normalizeOpenRouterClaudeModel(model: string): string {
  return resolveModel(stripVisibleSuffix(model))?.actualModel ?? model;
}

function isSupportedOpenRouterClaudeModel(model: string): boolean {
  return modelHasFeature(stripVisibleSuffix(model), "anthropic_messages_bridge");
}

function shouldRouteAnthropicMessagesViaOpenRouter(model: string): boolean {
  return isSupportedOpenRouterClaudeModel(model);
}

function toOpenRouterClaudeModel(model: string): string {
  return normalizeOpenRouterClaudeModel(model);
}

function hasAnthropicCacheControl(system: unknown, messages: AnthropicMessage[]): boolean {
  const blockHasCache = (block: unknown): boolean =>
    !!block && typeof block === "object" && !!(block as Record<string, unknown>).cache_control;

  if (Array.isArray(system) && system.some(blockHasCache)) return true;
  return messages.some((msg) => Array.isArray(msg.content) && msg.content.some(blockHasCache));
}

function withDefaultAnthropicCacheControl(system: unknown, messages: AnthropicMessage[]): AnthropicMessage[] {
  if (hasAnthropicCacheControl(system, messages)) return messages;
  const next = messages.map((msg) => ({
    ...msg,
    content: Array.isArray(msg.content) ? [...msg.content] : msg.content,
  })) as AnthropicMessage[];

  for (let i = next.length - 1; i >= 0; i--) {
    const msg = next[i];
    if (msg.role !== "assistant") continue;
    if (typeof msg.content === "string") {
      msg.content = [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }];
      return next;
    }
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const block = msg.content[j] as Record<string, unknown>;
      if (block.type === "text") {
        msg.content[j] = { ...block, cache_control: { type: "ephemeral" } };
        return next;
      }
    }
  }

  return next;
}

function mapClaudeEffortToOpenRouterVerbosity(model: string, effort: unknown): string | undefined {
  if (typeof effort !== "string") return undefined;
  const normalized = effort.toLowerCase();
  const map = resolveModel(stripVisibleSuffix(model))?.openrouter.verbosity_effort_map;
  return map && typeof map === "object" && !Array.isArray(map) && typeof (map as Record<string, unknown>)[normalized] === "string"
    ? (map as Record<string, string>)[normalized]
    : undefined;
}

function applyAnthropicThinkingForOpenRouter(model: string, payload: Record<string, unknown>, rest: Record<string, unknown>, modelThinkingEnabled = false): void {
  const thinking = rest.thinking as Record<string, unknown> | undefined;
  if (thinking && !rest.reasoning) {
    if (thinking.type === "adaptive") {
      payload.reasoning = { enabled: true };
      delete payload.thinking;
    } else if (thinking.type === "enabled" && typeof thinking.budget_tokens === "number") {
      payload.reasoning = { max_tokens: thinking.budget_tokens };
      delete payload.thinking;
    } else {
      payload.thinking = thinking;
    }
  } else if (!thinking && modelThinkingEnabled && !rest.reasoning) {
    payload.reasoning = { enabled: true };
    delete payload.thinking;
  } else if (!thinking && !rest.reasoning) {
    const defaultReasoning = getOpenRouterReasoning(resolveModel(stripVisibleSuffix(model)));
    if (defaultReasoning) payload.reasoning = defaultReasoning;
    delete payload.thinking;
  } else if (!thinking) {
    delete payload.thinking;
  }

  const outputConfig = rest.output_config as Record<string, unknown> | undefined;
  const verbosity = mapClaudeEffortToOpenRouterVerbosity(model, outputConfig?.effort);
  if (verbosity && !rest.verbosity) payload.verbosity = verbosity;
  delete payload.output_config;
}

function anthropicContentToOpenAI(content: string | AnthropicContentPart[]): string | OAIContentPart[] {
  if (typeof content === "string") return content;

  const parts: OAIContentPart[] = [];
  for (const part of content) {
    if (part.type === "text") {
      const p = part as { text?: string; cache_control?: { type?: string; ttl?: string } };
      parts.push({
        type: "text",
        text: p.text ?? "",
        ...(p.cache_control ? { cache_control: p.cache_control } : {}),
      });
      continue;
    }
    if (part.type === "image") {
      const source = (part as { source?: AnthropicImageSource }).source;
      if (!source) continue;
      const url = source.type === "base64"
        ? `data:${source.media_type};base64,${source.data}`
        : source.url;
      parts.push({ type: "image_url", image_url: { url } });
      continue;
    }
    // OpenAI-compatible chat history has no signed Anthropic thinking block.
    // Drop thinking history instead of leaking it as user-visible text.
  }

  return parts;
}

function anthropicMessagesToOpenAI(system: unknown, messages: AnthropicMessage[]): OAIMessage[] {
  const out: OAIMessage[] = [];
  if (typeof system === "string" && system.trim()) {
    out.push({ role: "system", content: system });
  } else if (Array.isArray(system) && system.length > 0) {
    out.push({ role: "system", content: anthropicContentToOpenAI(system as AnthropicContentPart[]) });
  }

  for (const msg of messages) {
    if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        out.push({ role: "assistant", content: msg.content });
        continue;
      }

      const textParts: AnthropicContentPart[] = [];
      const toolCalls: OAIToolCall[] = [];
      for (const part of msg.content) {
        if (part.type === "tool_use") {
          const tool = part as { id?: string; name?: string; input?: unknown };
          toolCalls.push({
            id: tool.id ?? `toolu_${toolCalls.length}`,
            type: "function",
            function: {
              name: tool.name ?? "tool",
              arguments: JSON.stringify(tool.input ?? {}),
            },
          });
        } else {
          textParts.push(part);
        }
      }

      const content = textParts.length ? anthropicContentToOpenAI(textParts) : "";
      out.push({
        role: "assistant",
        content,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    if (typeof msg.content === "string") {
      out.push({ role: "user", content: msg.content });
      continue;
    }

    const userParts: AnthropicContentPart[] = [];
    for (const part of msg.content) {
      if (part.type === "tool_result") {
        const toolResult = part as { tool_use_id?: string; content?: string | AnthropicContentPart[] };
        const toolContent = typeof toolResult.content === "string"
          ? toolResult.content
          : JSON.stringify(toolResult.content ?? "");
        out.push({
          role: "tool",
          tool_call_id: toolResult.tool_use_id ?? "toolu_unknown",
          content: toolContent,
        });
      } else {
        userParts.push(part);
      }
    }
    if (userParts.length > 0) {
      out.push({ role: "user", content: anthropicContentToOpenAI(userParts) });
    }
  }

  return out;
}

function anthropicToolsToOpenAI(tools: unknown[] | undefined): OAITool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => {
    const t = tool as Record<string, unknown>;
    return {
      type: "function",
      function: {
        name: String(t.name ?? "tool"),
        description: typeof t.description === "string" ? t.description : "",
        parameters: t.input_schema ?? { type: "object", properties: {} },
      },
    };
  });
}

function anthropicToolChoiceToOpenAI(toolChoice: unknown): unknown {
  if (!toolChoice || typeof toolChoice !== "object") return toolChoice;
  const choice = toolChoice as Record<string, unknown>;
  if (choice.type === "auto") return "auto";
  if (choice.type === "none") return "none";
  if (choice.type === "any") return "required";
  if (choice.type === "tool" && typeof choice.name === "string") {
    return { type: "function", function: { name: choice.name } };
  }
  return toolChoice;
}

function openAIMessageToAnthropicContent(message: Record<string, unknown> | undefined): AnthropicContentPart[] {
  if (!message) return [{ type: "text", text: "" }];
  const content: AnthropicContentPart[] = [];

  const reasoningDetails = message.reasoning_details;
  if (Array.isArray(reasoningDetails)) {
    for (const detail of reasoningDetails as Record<string, unknown>[]) {
      const text = typeof detail.text === "string"
        ? detail.text
        : typeof detail.reasoning === "string"
          ? detail.reasoning
          : undefined;
      if (text && text.trim()) {
        content.push({
          type: "thinking",
          thinking: text,
          ...(typeof detail.signature === "string" ? { signature: detail.signature } : {}),
        });
      }
    }
  }

  if (!content.some((block) => block.type === "thinking")) {
    const reasoning = message.reasoning_content ?? message.reasoning;
    if (typeof reasoning === "string" && reasoning.trim()) {
      content.push({ type: "thinking", thinking: reasoning });
    }
  }

  const msgContent = message.content;
  if (typeof msgContent === "string" && msgContent.length > 0) {
    content.push({ type: "text", text: msgContent });
  } else if (Array.isArray(msgContent)) {
    for (const part of msgContent as Record<string, unknown>[]) {
      if (part.type === "text" && typeof part.text === "string") {
        content.push({ type: "text", text: part.text });
      }
    }
  }

  const toolCalls = message.tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const raw of toolCalls as Record<string, unknown>[]) {
      const fn = raw.function as Record<string, unknown> | undefined;
      let input: unknown = {};
      if (typeof fn?.arguments === "string" && fn.arguments.trim()) {
        try { input = JSON.parse(fn.arguments); } catch { input = {}; }
      }
      content.push({
        type: "tool_use",
        id: typeof raw.id === "string" ? raw.id : `toolu_${content.length}`,
        name: typeof fn?.name === "string" ? fn.name : "tool",
        input,
      });
    }
  }

  return content.length ? content : [{ type: "text", text: "" }];
}

function mapOpenAIFinishReasonToAnthropic(reason: unknown): string | null {
  if (reason === "tool_calls" || reason === "function_call") return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "stop") return "end_turn";
  return typeof reason === "string" ? reason : null;
}

function anthropicStopReasonToOpenAI(reason: unknown): string | undefined {
  if (reason === "max_tokens") return "length";
  if (reason === "tool_use") return "tool_calls";
  if (reason === "end_turn" || reason === "stop_sequence") return "stop";
  return undefined;
}

async function handleAnthropicMessagesViaOpenRouter({
  req, res, model, messages, system, stream, maxTokens, cacheControl, tools, toolChoice, rest, startTime, modelThinkingEnabled = false,
}: {
  req: Request;
  res: Response;
  model: string;
  messages: AnthropicMessage[];
  system?: unknown;
  stream: boolean;
  maxTokens: number;
  cacheControl?: { type?: string; ttl?: string };
  tools?: unknown[];
  toolChoice?: unknown;
  rest: Record<string, unknown>;
  startTime: number;
  modelThinkingEnabled?: boolean;
}): Promise<void> {
  const apiKey = process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY;
  const baseURL = process.env.AI_INTEGRATIONS_OPENROUTER_BASE_URL;
  if (!apiKey || !baseURL) {
    throw new Error("OpenRouter integration is not configured. Set AI_INTEGRATIONS_OPENROUTER_API_KEY and AI_INTEGRATIONS_OPENROUTER_BASE_URL.");
  }

  const endpoint = `${baseURL.replace(/\/$/, "")}/chat/completions`;
  const resolved = resolveModel(stripVisibleSuffix(model));
  const openAIModel = toOpenRouterClaudeModel(model);
  const bridgeMessages = cacheControl
    ? messages
    : withDefaultAnthropicCacheControl(system, messages);
  const payload: Record<string, unknown> = {
    ...(getOpenRouterParams(resolved) ?? {}),
    ...rest,
    model: openAIModel,
    messages: anthropicMessagesToOpenAI(system, bridgeMessages),
    stream,
    max_tokens: maxTokens,
  };
  const providerRouting = getOpenRouterProviderRouting(resolved);
  if (providerRouting && !payload.provider) payload.provider = providerRouting;
  if (stream) payload.stream_options = { include_usage: true };
  const convertedTools = anthropicToolsToOpenAI(tools);
  if (convertedTools?.length) payload.tools = convertedTools;
  const convertedToolChoice = anthropicToolChoiceToOpenAI(toolChoice);
  if (convertedToolChoice !== undefined) payload.tool_choice = convertedToolChoice;
  if (cacheControl) payload.cache_control = cacheControl;
  if (rest.stop_sequences && !rest.stop) {
    payload.stop = rest.stop_sequences;
    delete payload.stop_sequences;
  }
  applyAnthropicThinkingForOpenRouter(model, payload, rest, modelThinkingEnabled);

  const upstream = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => "");
    throw new Error(`OpenRouter Anthropic bridge error ${upstream.status}: ${errText}`);
  }

  if (stream) {
    if (!upstream.body) throw new Error("OpenRouter Anthropic bridge stream response missing body");

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    const msgId = `msg_${Date.now()}`;
    writeAndFlush(res, `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })}\n\n`);

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let contentIndex = -1;
    let activeTextIndex: number | null = null;
    let activeThinkingIndex: number | null = null;
    const toolIndexes = new Map<number, number>();
    let promptTokens = 0;
    let completionTokens = 0;
    let usageMetrics: ExtendedUsageMetrics | undefined;
    let stopReason: string | null = null;

    const startBlock = (block: Record<string, unknown>): number => {
      const index = ++contentIndex;
      writeAndFlush(res, `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index, content_block: block })}\n\n`);
      return index;
    };
    const stopBlock = (index: number): void => {
      writeAndFlush(res, `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index })}\n\n`);
    };
    const handleChunk = (chunk: Record<string, unknown>): void => {
      const usage = chunk.usage as Record<string, unknown> | undefined;
      if (usage) {
        promptTokens = Number(usage.prompt_tokens) || promptTokens;
        completionTokens = Number(usage.completion_tokens) || completionTokens;
        usageMetrics = extractExtendedUsageMetrics(usage) ?? usageMetrics;
      }

      const choice = (chunk.choices as Record<string, unknown>[] | undefined)?.[0];
      const delta = choice?.delta as Record<string, unknown> | undefined;
      if (!delta) return;

      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === "string" && reasoning) {
        if (activeThinkingIndex === null) {
          if (activeTextIndex !== null) { stopBlock(activeTextIndex); activeTextIndex = null; }
          activeThinkingIndex = startBlock({ type: "thinking", thinking: "", signature: "" });
        }
        writeAndFlush(res, `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: activeThinkingIndex, delta: { type: "thinking_delta", thinking: reasoning } })}\n\n`);
      }

      const content = delta.content;
      if (typeof content === "string" && content) {
        if (activeTextIndex === null) {
          if (activeThinkingIndex !== null) { stopBlock(activeThinkingIndex); activeThinkingIndex = null; }
          activeTextIndex = startBlock({ type: "text", text: "" });
        }
        writeAndFlush(res, `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: activeTextIndex, delta: { type: "text_delta", text: content } })}\n\n`);
      }

      const toolCalls = delta.tool_calls as Record<string, unknown>[] | undefined;
      if (Array.isArray(toolCalls)) {
        if (activeTextIndex !== null) { stopBlock(activeTextIndex); activeTextIndex = null; }
        if (activeThinkingIndex !== null) { stopBlock(activeThinkingIndex); activeThinkingIndex = null; }
        for (const tc of toolCalls) {
          const toolCallIndex = Number(tc.index) || 0;
          const fn = tc.function as Record<string, unknown> | undefined;
          let blockIndex = toolIndexes.get(toolCallIndex);
          if (blockIndex === undefined) {
            blockIndex = startBlock({
              type: "tool_use",
              id: typeof tc.id === "string" ? tc.id : `toolu_${toolCallIndex}`,
              name: typeof fn?.name === "string" ? fn.name : "tool",
              input: {},
            });
            toolIndexes.set(toolCallIndex, blockIndex);
          }
          if (typeof fn?.arguments === "string" && fn.arguments) {
            writeAndFlush(res, `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: fn.arguments } })}\n\n`);
          }
        }
      }

      if (choice?.finish_reason) {
        stopReason = mapOpenAIFinishReasonToAnthropic(choice.finish_reason);
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const raw = trimmed.slice(5).trim();
          if (!raw || raw === "[DONE]") continue;
          try { handleChunk(JSON.parse(raw) as Record<string, unknown>); } catch {}
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (activeTextIndex !== null) stopBlock(activeTextIndex);
    if (activeThinkingIndex !== null) stopBlock(activeThinkingIndex);
    for (const index of toolIndexes.values()) stopBlock(index);

    const finalUsageMetrics = withEstimatedCostIfMissing(openAIModel, promptTokens, completionTokens, usageMetrics);
    const dur = Date.now() - startTime;
    recordCallStat("openrouter", dur, promptTokens, completionTokens, undefined, model, finalUsageMetrics);
    pushRequestLog({
      method: req.method, path: req.path, model,
      backend: "openrouter", status: 200, duration: dur, stream: true,
      promptTokens,
      completionTokens,
      totalTokens: finalUsageMetrics?.totalTokens ?? (promptTokens + completionTokens),
      costUsd: finalUsageMetrics?.costUsd,
      cachedTokens: finalUsageMetrics?.cachedTokens,
      cacheWriteTokens: finalUsageMetrics?.cacheWriteTokens,
      reasoningTokens: finalUsageMetrics?.reasoningTokens,
      level: "info",
    });
    writeAndFlush(res, `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stopReason ?? "end_turn", stop_sequence: null }, usage: { output_tokens: completionTokens } })}\n\n`);
    writeAndFlush(res, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
    res.end();
    return;
  }

  const result = await upstream.json() as Record<string, unknown>;
  logResponseDebug(req, "OpenRouter Anthropic bridge response", result);

  const choice = ((result.choices as Record<string, unknown>[] | undefined) ?? [])[0];
  const message = choice?.message as Record<string, unknown> | undefined;
  const usage = (result.usage as Record<string, unknown> | undefined) ?? {};
  const inputTokens = Number(usage.prompt_tokens) || 0;
  const outputTokens = Number(usage.completion_tokens) || 0;
  const anthropicUsage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: (usage.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens ?? 0,
    cache_creation_input_tokens: (usage.prompt_tokens_details as Record<string, unknown> | undefined)?.cache_write_tokens ?? 0,
  };
  const anthropicContent = openAIMessageToAnthropicContent(message);
  const stopReason = mapOpenAIFinishReasonToAnthropic(choice?.finish_reason);
  const responseJson = {
    id: typeof result.id === "string" ? result.id : `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content: anthropicContent,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: anthropicUsage,
  };

  const dur = Date.now() - startTime;
  const finalUsageMetrics = withEstimatedCostIfMissing(openAIModel, inputTokens, outputTokens, extractExtendedUsageMetrics(result.usage));
  recordCallStat("openrouter", dur, inputTokens, outputTokens, undefined, model, finalUsageMetrics);
  pushRequestLog({
    method: req.method, path: req.path, model,
    backend: "openrouter", status: 200, duration: dur, stream,
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens: finalUsageMetrics?.totalTokens ?? (inputTokens + outputTokens),
    costUsd: finalUsageMetrics?.costUsd,
    cachedTokens: finalUsageMetrics?.cachedTokens,
    cacheWriteTokens: finalUsageMetrics?.cacheWriteTokens,
    reasoningTokens: finalUsageMetrics?.reasoningTokens,
    level: "info",
  });

  if (!stream) {
    res.json(responseJson);
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  writeAndFlush(res, `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { ...responseJson, content: [] } })}\n\n`);
  anthropicContent.forEach((block, index) => {
    const startBlock = block.type === "text"
      ? { type: "text", text: "" }
      : block.type === "thinking"
        ? { type: "thinking", thinking: "", signature: "" }
        : block.type === "tool_use"
          ? { type: "tool_use", id: block.id, name: block.name, input: {} }
          : block;
    writeAndFlush(res, `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index, content_block: startBlock })}\n\n`);
    if (block.type === "text") {
      writeAndFlush(res, `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } })}\n\n`);
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      writeAndFlush(res, `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } })}\n\n`);
    } else if (block.type === "tool_use") {
      writeAndFlush(res, `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } })}\n\n`);
    }
    writeAndFlush(res, `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index })}\n\n`);
  });
  writeAndFlush(res, `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } })}\n\n`);
  writeAndFlush(res, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
  res.end();
}

router.post("/v1/messages", requireApiKey, async (req: Request, res: Response) => {
  const body = req.body as {
    model?: string;
    messages: AnthropicMessage[];
    system?: string | { type: string; text: string }[];
    stream?: boolean;
    max_tokens?: number;
    temperature?: number;
    thinking?: { type: "enabled"; budget_tokens: number };
    cache_control?: { type?: string };
    tools?: unknown[];
    [key: string]: unknown;
  };

  const { model, messages, system, stream, max_tokens, cache_control, tools: clientTools, ...rest } = body;
  const rawModel = stripVisibleSuffix(model ?? "claude-sonnet-4-5");
  const resolvedRawModel = resolveModel(rawModel);
  if (!resolvedRawModel) {
    res.status(404).json({ error: { type: "invalid_request_error", message: `Unknown model '${rawModel}'` } });
    return;
  }
  const isSearchModel = modelHasFeature(resolvedRawModel, "web_search");
  const taggedSystem = stripSearchControlTagsFromSystem(system);
  const tagged = stripSearchControlTagsFromMessages(messages);
  const searchInvisibleEnabled = tagged.invisibleEnabled || taggedSystem.invisibleEnabled;
  const searchVisibleEnabled = tagged.visibleEnabled || taggedSystem.visibleEnabled;
  const appendSearchReferenceText = isSearchModel && searchVisibleEnabled;
  const hideSearchToolFromClient = isSearchModel && (searchInvisibleEnabled || searchVisibleEnabled);

  const routeViaOpenRouter = shouldRouteAnthropicMessagesViaOpenRouter(rawModel);

  if (!isModelEnabled(rawModel)) {
    res.status(403).json({ error: { type: "invalid_request_error", message: `Model '${rawModel}' is disabled on this gateway` } });
    return;
  }

  const webSearch = modelHasFeature(resolvedRawModel, "web_search");
  const thinkingEnabled = modelHasFeature(resolvedRawModel, "visible_reasoning");
  const selectedModel = routeViaOpenRouter ? rawModel : resolvedRawModel.actualModel;
  const modelMax = resolvedRawModel.maxTokens ?? 32000;
  const defaultMaxTokens = thinkingEnabled ? Math.max(modelMax, 32000) : modelMax;
  const maxTokens = max_tokens ?? defaultMaxTokens;

  const shouldStream = stream ?? false;
  const startTime = Date.now();

  req.log.info({ model: selectedModel, rawModel, stream: shouldStream, webSearch, thinking: thinkingEnabled, hideSearchToolFromClient, appendSearchReferenceText }, "Anthropic /v1/messages request");
  req.log.info({ payload: JSON.stringify(req.body) }, "Anthropic /v1/messages full payload");

  const thinkingParam = thinkingEnabled && !rest.thinking
    ? getAnthropicDefaults(resolvedRawModel)
    : {};

  // Inject web_search tool if needed, alongside any client-supplied tools
  const webSearchTool = webSearch ? [{ type: "web_search_20250305", name: "web_search" }] : [];
  const mergedTools = [...webSearchTool, ...(clientTools ?? [])];

  // Vertex AI rejects requests that specify both temperature and top_p — drop top_p
  const safeRest = { ...(rest as Record<string, unknown>) };
  if (safeRest.temperature !== undefined && safeRest.top_p !== undefined) {
    delete safeRest.top_p;
  }
  // Sanitize messages: fill in missing tool_use_id on tool_result blocks
  const sanitizedMessages = sanitizeAnthropicMessages(tagged.messages, selectedModel);

  if (routeViaOpenRouter) {
    try {
      await handleAnthropicMessagesViaOpenRouter({
        req,
        res,
        model: selectedModel,
        messages: sanitizedMessages,
        system: taggedSystem.system as string | { type: string; text: string }[] | undefined,
        stream: shouldStream,
        maxTokens,
        cacheControl: cache_control,
        tools: mergedTools,
        toolChoice: safeRest.tool_choice,
        rest: safeRest,
        startTime,
        modelThinkingEnabled: thinkingEnabled,
      });
    } catch (err: unknown) {
      recordErrorStat("openrouter");
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      req.log.error({ err }, "/v1/messages OpenRouter bridge request failed");
      pushRequestLog({
        method: req.method, path: req.path, model: selectedModel,
        backend: "openrouter", status: 500, duration: Date.now() - startTime,
        stream: shouldStream, level: "error", error: errMsg,
      });
      if (!res.headersSent) {
        res.status(500).json({ error: { type: "api_error", message: errMsg } });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
    return;
  }

  // 优化缓存策略：将断点移动到最后一条 assistant 消息，以提高动态 user 消息（如带时间戳）下的命中率
  let finalCacheControl: { type?: string } | undefined = cache_control ?? { type: "ephemeral" };
  if (finalCacheControl?.type === "ephemeral") {
    for (let i = sanitizedMessages.length - 1; i >= 0; i--) {
      if (sanitizedMessages[i].role === "assistant") {
        const msg = sanitizedMessages[i];
        if (typeof msg.content === "string") {
          msg.content = [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }];
        } else if (Array.isArray(msg.content) && msg.content.length > 0) {
          const lastPart = msg.content[msg.content.length - 1] as any;
          lastPart.cache_control = { type: "ephemeral" };
        }
        finalCacheControl = undefined; // 已手动注入，取消顶层控制
        break;
      }
    }
  }

  try {
    const client = makeLocalAnthropic();

    const createParams = {
      model: selectedModel,
      max_tokens: maxTokens,
      messages: sanitizedMessages,
      ...(taggedSystem.system ? { system: taggedSystem.system } : {}),
      ...(finalCacheControl ? { cache_control: finalCacheControl } : {}),
      ...thinkingParam,
      ...(mergedTools.length ? { tools: mergedTools } : {}),
      ...safeRest,
    } as Parameters<typeof client.messages.create>[0];
    const requestOptions = resolvedRawModel.headers ? { headers: resolvedRawModel.headers } : undefined;

    if (shouldStream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      const keepalive = setInterval(() => {
        if (!res.writableEnded) writeAndFlush(res, ": keepalive\n\n");
      }, 5000);
      req.on("close", () => clearInterval(keepalive));

      let inputTokens = 0;
      let outputTokens = 0;
      let usageMetrics: ExtendedUsageMetrics | undefined;
      let seenMessageStop = false;

      try {
        const claudeStream = client.messages.stream(createParams as Parameters<typeof client.messages.stream>[0], requestOptions);

        const hiddenIndexes = new Set<number>();
        const hiddenServerBlocks = new Map<number, { startBlock: Record<string, unknown>; textChunks: string[] }>();
        let maxContentBlockIndex = -1;
        for await (const event of claudeStream) {
          const eventRecord = event as unknown as Record<string, unknown>;
          const eventType = eventRecord.type as string | undefined;
          const eventIndex = eventRecord.index as number | undefined;
          if (typeof eventIndex === "number") maxContentBlockIndex = Math.max(maxContentBlockIndex, eventIndex);

          if (hideSearchToolFromClient && shouldHideServerToolStreamEvent(eventRecord, hiddenIndexes)) {
            if (appendSearchReferenceText && eventType === "content_block_start" && typeof eventIndex === "number") {
              hiddenServerBlocks.set(eventIndex, {
                startBlock: (eventRecord.content_block as Record<string, unknown> | undefined) ?? {},
                textChunks: [],
              });
            } else if (appendSearchReferenceText && eventType === "content_block_delta" && typeof eventIndex === "number") {
              const state = hiddenServerBlocks.get(eventIndex);
              const delta = eventRecord.delta as Record<string, unknown> | undefined;
              if (state && delta) {
                if (delta.type === "text_delta" && typeof delta.text === "string") {
                  state.textChunks.push(delta.text);
                } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
                  state.textChunks.push(delta.partial_json);
                }
              }
            }
            continue;
          }
          logResponseDebug(req, "Claude /v1/messages stream response event", event);
          if (event.type === "message_start") {
            inputTokens = event.message.usage.input_tokens;
            usageMetrics = extractAnthropicUsageMetrics(event.message.usage);
          } else if (event.type === "message_delta") {
            outputTokens = event.usage.output_tokens;
            const deltaUsage = extractAnthropicUsageMetrics(event.usage);
            if (deltaUsage) usageMetrics = { ...usageMetrics, ...deltaUsage };
          } else if (event.type === "message_stop") {
            seenMessageStop = true;
          }

          const eventRecordUsage = (eventRecord.usage ?? undefined) as unknown;
          const genericUsage = extractAnthropicUsageMetrics(eventRecordUsage);
          if (genericUsage) usageMetrics = { ...usageMetrics, ...genericUsage };
          const usageOutputTokens = (eventRecord.usage as { output_tokens?: number } | undefined)?.output_tokens;
          if (typeof usageOutputTokens === "number") {
            outputTokens = usageOutputTokens;
          }

          writeAndFlush(res, `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        }

        if (appendSearchReferenceText && hiddenServerBlocks.size > 0) {
          const refs = [...hiddenServerBlocks.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, state]) => {
              const joined = state.textChunks.join("").trim();
              return joined || extractServerToolReferenceText(state.startBlock) || "";
            })
            .filter((s) => !!s);

          const appendix = buildSearchReferenceAppendix(refs);
          if (appendix) {
            const appendIndex = maxContentBlockIndex + 1;
            const startEvent = { type: "content_block_start", index: appendIndex, content_block: { type: "text", text: "" } };
            const deltaEvent = { type: "content_block_delta", index: appendIndex, delta: { type: "text_delta", text: `\n\n${appendix}` } };
            const stopEvent = { type: "content_block_stop", index: appendIndex };
            writeAndFlush(res, `event: content_block_start\ndata: ${JSON.stringify(startEvent)}\n\n`);
            writeAndFlush(res, `event: content_block_delta\ndata: ${JSON.stringify(deltaEvent)}\n\n`);
            writeAndFlush(res, `event: content_block_stop\ndata: ${JSON.stringify(stopEvent)}\n\n`);
          }
        }
        if (!seenMessageStop) {
          writeAndFlush(res, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
        }
        res.end();
        const dur = Date.now() - startTime;
        const baseUsageMetrics = usageMetrics
          ? { ...usageMetrics, totalTokens: usageMetrics.totalTokens ?? (inputTokens + outputTokens) }
          : undefined;
        const finalUsageMetrics = withEstimatedCostIfMissing(selectedModel, inputTokens, outputTokens, baseUsageMetrics);
        recordCallStat("local", dur, inputTokens, outputTokens, undefined, selectedModel, finalUsageMetrics);
        pushRequestLog({
          method: req.method, path: req.path, model: selectedModel,
          backend: "local", status: 200, duration: dur, stream: true,
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          totalTokens: finalUsageMetrics?.totalTokens ?? (inputTokens + outputTokens),
          costUsd: finalUsageMetrics?.costUsd,
          cachedTokens: finalUsageMetrics?.cachedTokens,
          cacheWriteTokens: finalUsageMetrics?.cacheWriteTokens,
          reasoningTokens: finalUsageMetrics?.reasoningTokens,
          level: "info",
        });
      } finally {
        clearInterval(keepalive);
      }
    } else {
      const rawResult = await client.messages.create(createParams, requestOptions);
      const rawContent = (rawResult as unknown as { content?: unknown }).content;
      const resultWithMarkers = appendSearchReferenceText
        ? {
            ...rawResult,
            content: appendReferencesToAssistantContent(
              filterServerToolBlocksInContent(rawContent),
              collectServerToolReferencesFromContent(rawContent)
            ),
          }
        : hideSearchToolFromClient
          ? {
              ...rawResult,
              content: filterServerToolBlocksInContent(rawContent),
            }
          : rawResult;
      logResponseDebug(req, "Claude /v1/messages non-stream response", resultWithMarkers);
      const usage = (rawResult as { usage?: unknown }).usage;
      const usageMetrics = extractAnthropicUsageMetrics(usage);
      const usageRecord = (usage ?? {}) as { input_tokens?: number; output_tokens?: number };
      const dur = Date.now() - startTime;
      const inputTokens = usageRecord.input_tokens ?? 0;
      const outputTokens = usageRecord.output_tokens ?? 0;
      const finalUsageMetrics = withEstimatedCostIfMissing(selectedModel, inputTokens, outputTokens, usageMetrics);
      recordCallStat("local", dur, inputTokens, outputTokens, undefined, selectedModel, finalUsageMetrics);
      pushRequestLog({
        method: req.method, path: req.path, model: selectedModel,
        backend: "local", status: 200, duration: dur, stream: false,
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens: finalUsageMetrics?.totalTokens ?? (inputTokens + outputTokens),
        costUsd: finalUsageMetrics?.costUsd,
        cachedTokens: finalUsageMetrics?.cachedTokens,
        cacheWriteTokens: finalUsageMetrics?.cacheWriteTokens,
        reasoningTokens: finalUsageMetrics?.reasoningTokens,
        level: "info",
      });
      res.json(resultWithMarkers);
    }
  } catch (err: unknown) {
    recordErrorStat("local");
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    req.log.error({ err }, "/v1/messages request failed");
    pushRequestLog({
      method: req.method, path: req.path, model: selectedModel,
      backend: "local", status: 500, duration: Date.now() - startTime,
      stream: shouldStream, level: "error", error: errMsg,
    });
    if (!res.headersSent) {
      res.status(500).json({ error: { type: "server_error", message: errMsg } });
    } else {
      writeAndFlush(res, `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "server_error", message: errMsg } })}\n\n`);
      res.end();
    }
  }
});

// ---------------------------------------------------------------------------
// Real-time request log ring buffer + SSE
// ---------------------------------------------------------------------------

interface RequestLog {
  id: number;
  time: string;
  method: string;
  path: string;
  model?: string;
  provider?: ModelProvider;
  backend?: string;
  status: number;
  duration: number;
  stream: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  level: "info" | "warn" | "error";
  error?: string;
}

const REQUEST_LOG_MAX = 5_000;
const requestLogs: RequestLog[] = [];
let logIdCounter = 0;
const logSSEClients: Set<Response> = new Set();

export function pushRequestLog(entry: Omit<RequestLog, "id" | "time">): void {
  const log: RequestLog = { id: ++logIdCounter, time: new Date().toISOString(), ...entry };
  requestLogs.push(log);
  if (requestLogs.length > REQUEST_LOG_MAX) requestLogs.shift();
  const data = `data: ${JSON.stringify(log)}\n\n`;
  for (const client of logSSEClients) {
    try { client.write(data); } catch { logSSEClients.delete(client); }
  }
}

router.get("/v1/admin/logs", requireApiKey, (_req: Request, res: Response) => {
  res.json({ logs: requestLogs });
});

router.get("/v1/admin/logs/stream", requireApiKeyWithQuery, (req: Request, res: Response) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  logSSEClients.add(res);
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": heartbeat\n\n");
  }, 20000);
  req.on("close", () => { clearInterval(heartbeat); logSSEClients.delete(res); });
});

router.get("/v1/stats", requireApiKey, (_req: Request, res: Response) => {
  const allConfigs = getAllFriendProxyConfigs();
  const allLabels = ["local", ...allConfigs.map((c) => c.label)];
  const result: Record<string, unknown> = {};
  for (const label of allLabels) {
    const s = getStat(label);
    const cfg = allConfigs.find((c) => c.label === label);
    result[label] = {
      calls: s.calls,
      errors: s.errors,
      streamingCalls: s.streamingCalls,
      promptTokens: s.promptTokens,
      completionTokens: s.completionTokens,
      totalTokens: s.promptTokens + s.completionTokens,
      totalCostUsd: s.totalCostUsd,
      cachedTokens: s.cachedTokens,
      cacheWriteTokens: s.cacheWriteTokens,
      reasoningTokens: s.reasoningTokens,
      avgDurationMs: s.calls > 0 ? Math.round(s.totalDurationMs / s.calls) : 0,
      avgTtftMs: s.streamingCalls > 0 ? Math.round(s.totalTtftMs / s.streamingCalls) : null,
      health: label === "local" ? "healthy" : getCachedHealth(cfg?.url ?? "") === false ? "down" : "healthy",
      url: label === "local" ? null : cfg?.url ?? null,
      dynamic: dynamicBackends.some((d) => d.label === label),
      enabled: cfg ? cfg.enabled : true,
    };
  }
  const modelStats: Record<string, ModelStat> = Object.fromEntries(modelStatsMap.entries());
  res.json({ stats: result, modelStats, uptimeSeconds: Math.round(process.uptime()), routing: routingSettings });
});

router.post("/v1/admin/stats/reset", requireApiKey, (_req: Request, res: Response) => {
  statsMap.clear();
  modelStatsMap.clear();
  scheduleSave();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Admin: manage dynamic backends at runtime (no restart / redeploy required)
// ---------------------------------------------------------------------------

router.get("/v1/admin/backends", requireApiKey, (_req: Request, res: Response) => {
  const apiKey = process.env.PROXY_API_KEY ?? "";
  const envConfigs = (() => {
    const list: { label: string; url: string }[] = [];
    const envKeys = ["FRIEND_PROXY_URL", ...Array.from({ length: 19 }, (_, i) => `FRIEND_PROXY_URL_${i + 2}`)];
    for (const key of envKeys) { const url = process.env[key]; if (url) list.push({ label: key.replace("FRIEND_PROXY_URL", "FRIEND"), url }); }
    return list;
  })();
  res.json({
    local: { url: null, source: "local" },
    env: envConfigs.map((c) => ({ ...c, source: "env", health: getCachedHealth(c.url) === false ? "down" : "healthy" })),
    dynamic: dynamicBackends.map((d) => ({ ...d, source: "dynamic", health: getCachedHealth(d.url) === false ? "down" : "healthy" })),
    apiKey,
  });
});

router.post("/v1/admin/backends", requireApiKey, (req: Request, res: Response) => {
  const { url } = req.body as { url?: string };
  if (!url || typeof url !== "string" || !url.startsWith("http")) {
    res.status(400).json({ error: "Valid https URL required" });
    return;
  }
  const cleanUrl = url.replace(/\/+$/, "");
  const normalizedUrl = normalizeSubNodeUrl(cleanUrl);
  const allUrls = getFriendProxyConfigs().map((c) => c.url);
  if (allUrls.includes(normalizedUrl)) { res.status(409).json({ error: "URL already in pool" }); return; }
  const label = `DYNAMIC_${dynamicBackends.length + 1}`;
  dynamicBackends.push({ label, url: cleanUrl });
  saveDynamicBackends(dynamicBackends);
  const apiKey = process.env.PROXY_API_KEY ?? "";
  probeHealth(normalizedUrl, apiKey).then((ok) => setHealth(normalizedUrl, ok)).catch(() => setHealth(normalizedUrl, false));
  res.json({ label, url: cleanUrl, source: "dynamic" });
});

router.delete("/v1/admin/backends/:label", requireApiKey, (req: Request, res: Response) => {
  const { label } = req.params;
  const before = dynamicBackends.length;
  dynamicBackends = dynamicBackends.filter((d) => d.label !== label);
  if (dynamicBackends.length === before) { res.status(404).json({ error: "Dynamic backend not found" }); return; }
  saveDynamicBackends(dynamicBackends);
  res.json({ deleted: true, label });
});

// PATCH /v1/admin/backends/:label — 切换单个节点启用/禁用
router.patch("/v1/admin/backends/:label", requireApiKey, (req: Request, res: Response) => {
  const { label } = req.params;
  const { enabled } = req.body as { enabled?: boolean };
  if (typeof enabled !== "boolean") { res.status(400).json({ error: "enabled (boolean) required" }); return; }
  const target = dynamicBackends.find((d) => d.label === label);
  if (!target) { res.status(404).json({ error: "Dynamic backend not found" }); return; }
  target.enabled = enabled;
  saveDynamicBackends(dynamicBackends);
  res.json({ label, enabled });
});

// PATCH /v1/admin/backends — 批量切换（labels 数组 + enabled 布尔值）
router.patch("/v1/admin/backends", requireApiKey, (req: Request, res: Response) => {
  const { labels, enabled } = req.body as { labels?: string[]; enabled?: boolean };
  if (!Array.isArray(labels) || typeof enabled !== "boolean") {
    res.status(400).json({ error: "labels (string[]) and enabled (boolean) required" });
    return;
  }
  const set = new Set(labels);
  let updated = 0;
  for (const d of dynamicBackends) {
    if (set.has(d.label)) { d.enabled = enabled; updated++; }
  }
  saveDynamicBackends(dynamicBackends);
  res.json({ updated, enabled });
});

router.get("/v1/admin/routing", requireApiKey, (_req: Request, res: Response) => {
  res.json(routingSettings);
});

router.patch("/v1/admin/routing", requireApiKey, (req: Request, res: Response) => {
  const { localEnabled, localFallback, fakeStream } = req.body as Partial<RoutingSettings>;
  if (typeof localEnabled === "boolean") routingSettings.localEnabled = localEnabled;
  if (typeof localFallback === "boolean") routingSettings.localFallback = localFallback;
  if (typeof fakeStream === "boolean") routingSettings.fakeStream = fakeStream;
  saveRoutingSettings();
  res.json(routingSettings);
});

// ---------------------------------------------------------------------------
// Admin: model enable/disable management
// ---------------------------------------------------------------------------

// GET /v1/admin/models — list all models with provider + enabled status
router.get("/v1/admin/models", requireApiKey, (_req: Request, res: Response) => {
  refreshModelRegistryIfChanged();
  const models = ALL_MODELS.map((m) => ({
    id: m.id,
    provider: MODEL_PROVIDER_MAP.get(m.id) ?? "openrouter",
    description: m.description,
    enabled: isModelEnabled(m.id),
  }));
  const summary: Record<string, { total: number; enabled: number }> = {};
  for (const m of models) {
    if (!summary[m.provider]) summary[m.provider] = { total: 0, enabled: 0 };
    summary[m.provider].total++;
    if (m.enabled) summary[m.provider].enabled++;
  }
  res.json({ models, summary });
});

// PATCH /v1/admin/models — bulk enable/disable by ids or by provider
// Body: { ids?: string[], provider?: string, enabled: boolean }
router.patch("/v1/admin/models", requireApiKey, (req: Request, res: Response) => {
  refreshModelRegistryIfChanged();
  const { ids, provider, enabled } = req.body as { ids?: string[]; provider?: string; enabled?: boolean };
  if (typeof enabled !== "boolean") { res.status(400).json({ error: "enabled (boolean) required" }); return; }

  let targets: string[] = [];
  if (Array.isArray(ids) && ids.length > 0) {
    targets = ids.filter((id) => MODEL_PROVIDER_MAP.has(id));
  } else if (typeof provider === "string") {
    targets = ALL_MODELS.map((m) => m.id).filter((id) => MODEL_PROVIDER_MAP.get(id) === provider);
  } else {
    res.status(400).json({ error: "ids (string[]) or provider (string) required" }); return;
  }

  for (const id of targets) {
    if (enabled) disabledModels.delete(id);
    else disabledModels.add(id);
  }
  saveDisabledModels(disabledModels);
  res.json({ updated: targets.length, enabled, ids: targets });
});

router.get("/v1/admin/model-registry", requireApiKey, (_req: Request, res: Response) => {
  try {
    refreshModelRegistryIfChanged();
    res.json({ content: readModelsJsonText(), models: ALL_MODELS.length });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to read models.json";
    res.status(500).json({ error: message });
  }
});

router.post("/v1/admin/model-registry/upload", requireApiKey, (req: Request, res: Response) => {
  const { content } = req.body as { content?: unknown };
  if (typeof content !== "string" || !content.trim()) {
    res.status(400).json({ error: "content (string) is required" });
    return;
  }
  try {
    const result = replaceModelsJson(content);
    disabledModels = new Set([...disabledModels].filter((id) => MODEL_PROVIDER_MAP.has(id)));
    saveDisabledModels(disabledModels);
    res.json({ ok: true, ...result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Invalid models.json";
    res.status(400).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// Distinguishes upstream HTTP errors (5xx) from network/timeout errors so the
// retry logic can make the right decision about whether to try another node.
class FriendProxyHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "FriendProxyHttpError";
  }
}

// handleFriendProxy — raw fetch (bypasses SDK SSE parsing) so chunk.usage is
// captured reliably regardless of the friend proxy's SDK version or chunk format.
// SSE headers are committed only after the first chunk arrives, which preserves
// the retry window in case the upstream connection fails immediately.
async function handleFriendProxy({
  req, res, backend, model, messages, stream, maxTokens, tools, toolChoice, startTime,
}: {
  req: Request;
  res: Response;
  backend: Extract<Backend, { kind: "friend" }>;
  model: string;
  messages: OAIMessage[];
  stream: boolean;
  maxTokens?: number;
  tools?: OAITool[];
  toolChoice?: unknown;
  startTime: number;
}): Promise<{ promptTokens: number; completionTokens: number; ttftMs?: number; usage?: ExtendedUsageMetrics }> {
  const body: Record<string, unknown> = { model, messages, stream };
  body["max_tokens"] = maxTokens ?? 16000; // always override sub-node's potentially low default
  if (stream) body["stream_options"] = { include_usage: true };
  if (tools?.length) body["tools"] = tools;
  if (toolChoice !== undefined) body["tool_choice"] = toolChoice;

  // ── Non-streaming (or fake-stream when client wants stream but we call non-stream) ──
  if (!stream) {
    const fetchRes = await fetch(`${backend.url}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${backend.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!fetchRes.ok) {
      const errText = await fetchRes.text().catch(() => "unknown");
      throw new FriendProxyHttpError(fetchRes.status, `Friend proxy error ${fetchRes.status}: ${errText}`);
    }
    const json = await fetchRes.json() as Record<string, unknown>;
    // Extract usage details from headers if available (propagated from subnode)
    const headerCost = fetchRes.headers.get("x-proxy-cost-usd");
    const headerCached = fetchRes.headers.get("x-proxy-tokens-cached");
    const headerCacheWrite = fetchRes.headers.get("x-proxy-tokens-cache-write");
    const headerReasoning = fetchRes.headers.get("x-proxy-tokens-reasoning");
    const headerPrompt = fetchRes.headers.get("x-proxy-tokens-prompt");
    const headerCompletion = fetchRes.headers.get("x-proxy-tokens-completion");

    let usage: ExtendedUsageMetrics | undefined;
    if (headerPrompt || headerCompletion || headerCost || headerCached || headerReasoning) {
      usage = {
        totalTokens: (readFiniteNumber(headerPrompt) ?? 0) + (readFiniteNumber(headerCompletion) ?? 0),
        costUsd: readFiniteNumber(headerCost),
        cachedTokens: readFiniteNumber(headerCached),
        cacheWriteTokens: readFiniteNumber(headerCacheWrite),
        reasoningTokens: readFiniteNumber(headerReasoning),
      };
    } else {
      usage = extractExtendedUsageMetrics(json["usage"]);
    }

    const pTok = readFiniteNumber(headerPrompt) ?? (json["usage"] as any)?.prompt_tokens ?? 0;
    const cTok = readFiniteNumber(headerCompletion) ?? (json["usage"] as any)?.completion_tokens ?? 0;

    setUsageHeaders(res, pTok, cTok, usage);
    res.json(json);

    if (pTok === 0) {
      const inputChars = messages.reduce((acc, m) => {
        if (typeof m.content === "string") return acc + m.content.length;
        if (Array.isArray(m.content))
          return acc + (m.content as Array<{ type: string; text?: string }>)
            .filter((p) => p.type === "text").reduce((a, p) => a + (p.text?.length ?? 0), 0);
        return acc;
      }, 0);
      const outputChars = (json["choices"] as Array<{ message?: { content?: string } }>)?.[0]?.message?.content?.length ?? 0;
      return { promptTokens: Math.ceil(inputChars / 4), completionTokens: Math.ceil(outputChars / 4), usage };
    }
    return { promptTokens: pTok, completionTokens: cTok, usage };
  }

  // ── Streaming ────────────────────────────────────────────────────────────
  const fetchRes = await fetch(`${backend.url}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${backend.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  });

  if (!fetchRes.ok) {
    const errText = await fetchRes.text().catch(() => "unknown");
    throw new FriendProxyHttpError(fetchRes.status, `Friend proxy error ${fetchRes.status}: ${errText}`);
  }

  const contentType = fetchRes.headers.get("content-type") ?? "";
  if (contentType.includes("application/json") && routingSettings.fakeStream) {
    req.log.info("Friend returned JSON for stream request — fake-streaming");
    const json = await fetchRes.json() as Record<string, unknown>;
    const result = await fakeStreamResponse(res, json, startTime);
    const usage = extractExtendedUsageMetrics(json["usage"]);
    if (result.promptTokens === 0) {
      const inputChars = messages.reduce((acc, m) => {
        if (typeof m.content === "string") return acc + m.content.length;
        if (Array.isArray(m.content))
          return acc + (m.content as Array<{ type: string; text?: string }>)
            .filter((p) => p.type === "text").reduce((a, p) => a + (p.text?.length ?? 0), 0);
        return acc;
      }, 0);
      const outputContent = ((json["choices"] as Array<{ message?: { content?: string } }>)?.[0]?.message?.content ?? "").length;
      return { promptTokens: Math.ceil(inputChars / 4), completionTokens: Math.ceil(outputContent / 4), ttftMs: result.ttftMs, usage };
    }
    return { ...result, usage };
  }

  setSseHeaders(res);
  const keepaliveTimer = setInterval(() => writeAndFlush(res, ": keep-alive\n\n"), 15_000);

  let promptTokens = 0;
  let completionTokens = 0;
  let ttftMs: number | undefined;
  let outputChars = 0;
  let usage: ExtendedUsageMetrics | undefined;

  try {

    const reader = fetchRes.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trimEnd();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") { writeAndFlush(res, "data: [DONE]\n\n"); continue; }
          try {
            const chunk = JSON.parse(data) as Record<string, unknown>;
            // Capture usage from any chunk that carries it
            const chunkUsage = chunk["usage"];
            if (chunkUsage && typeof chunkUsage === "object") {
              const parsed = extractExtendedUsageMetrics(chunkUsage);
              if (parsed) {
                promptTokens = (chunkUsage as any).prompt_tokens ?? promptTokens;
                completionTokens = (chunkUsage as any).completion_tokens ?? completionTokens;
                usage = { ...usage, ...parsed };
              } else {
                promptTokens = (chunkUsage as any).prompt_tokens ?? promptTokens;
                completionTokens = (chunkUsage as any).completion_tokens ?? completionTokens;
              }

            }
            // Record TTFT + accumulate output chars for fallback estimation
            const deltaContent = (chunk["choices"] as Array<{ delta?: { content?: string } }>)?.[0]?.delta?.content;
            if (deltaContent) {
              if (ttftMs === undefined) ttftMs = Date.now() - startTime;
              outputChars += deltaContent.length;
            }
            writeAndFlush(res, `data: ${JSON.stringify(chunk)}\n\n`);
          } catch { /* skip malformed chunk */ }
        }
      }
    } finally {
      reader.releaseLock();
    }
  } finally {
    clearInterval(keepaliveTimer);
  }

  res.end();

  // Fallback: estimate tokens from char count when sub-node didn't return usage
  if (promptTokens === 0) {
    const inputChars = messages.reduce((acc, m) => {
      if (typeof m.content === "string") return acc + m.content.length;
      if (Array.isArray(m.content))
        return acc + (m.content as Array<{ type: string; text?: string }>)
          .filter((p) => p.type === "text").reduce((a, p) => a + (p.text?.length ?? 0), 0);
      return acc;
    }, 0);
    promptTokens = Math.ceil(inputChars / 4);
    completionTokens = Math.ceil(outputChars / 4);
  }

  return { promptTokens, completionTokens, ttftMs, usage };
}

function normalizeImageResponse(result: Record<string, unknown>): void {
  const choices = (result.choices as Array<Record<string, unknown>> | undefined) ?? [];
  for (const choice of choices) {
    const msg = choice.message as Record<string, unknown> | undefined;
    if (!msg) continue;
    const images = msg.images as Array<{ image_url?: { url?: string } }> | undefined;
    if (!images?.length) continue;
    // Convert images[] → markdown image string in content
    const parts: string[] = [];
    if (typeof msg.content === "string" && msg.content) {
      parts.push(msg.content);
    }
    for (const img of images) {
      if (img.image_url?.url) {
        parts.push(`![image](${img.image_url.url})`);
      }
    }
    msg.content = parts.join("\n\n");
    delete msg.images;
  }
}

async function handleOpenAI({
  req, res, client, model, messages, stream, maxTokens, tools, toolChoice, startTime, reasoning, thinkingVisible, imageModalities, providerRouting, imageConfig,
}: {
  req: Request;
  res: Response;
  client: OpenAI;
  model: string;
  messages: OAIMessage[];
  stream: boolean;
  maxTokens?: number;
  tools?: OAITool[];
  toolChoice?: unknown;
  startTime: number;
  reasoning?: { enabled: boolean } | { effort: string };
  thinkingVisible?: boolean;
  imageModalities?: readonly string[];
  providerRouting?: Record<string, unknown>;
  imageConfig?: Record<string, unknown>;
}): Promise<{ promptTokens: number; completionTokens: number; ttftMs?: number; usage?: ExtendedUsageMetrics }> {
  const params: Parameters<typeof client.chat.completions.create>[0] = {
    model,
    messages: messages as Parameters<typeof client.chat.completions.create>[0]["messages"],
    stream,
  };
  const paramsRecord = params as unknown as Record<string, unknown>;
  if (maxTokens) paramsRecord["max_completion_tokens"] = maxTokens;
  if (tools?.length) paramsRecord["tools"] = tools;
  if (toolChoice !== undefined) paramsRecord["tool_choice"] = toolChoice;
  if (reasoning) paramsRecord["reasoning"] = reasoning;
  if (imageModalities) paramsRecord["modalities"] = imageModalities;
  if (providerRouting) paramsRecord["provider"] = providerRouting;
  if (imageConfig && Object.keys(imageConfig).length > 0) paramsRecord["image_config"] = imageConfig;

  // Image models don't support streaming — always return non-streaming response
  // to avoid base64 content being split across SSE chunks incorrectly
  if (imageModalities && stream) {
    const result = await client.chat.completions.create({ ...params, stream: false });
    const resultRecord = result as unknown as Record<string, unknown>;
    normalizeImageResponse(resultRecord);
    logResponseDebug(req, "OpenAI non-stream response (image stream fallback)", result);
    const usage = extractExtendedUsageMetrics(result.usage);
    setUsageHeaders(res, result.usage?.prompt_tokens ?? 0, result.usage?.completion_tokens ?? 0, usage);
    res.json(result);

    return {
      promptTokens: result.usage?.prompt_tokens ?? 0,
      completionTokens: result.usage?.completion_tokens ?? 0,
      usage,
    };
  }

  if (stream) {
    try {
      setSseHeaders(res);
      let ttftMs: number | undefined;
      let promptTokens = 0;
      let completionTokens = 0;
      let usage: ExtendedUsageMetrics | undefined;
      const streamResult = await client.chat.completions.create({
        ...params,
        stream: true,
        stream_options: { include_usage: true },
      });
      for await (const chunk of streamResult) {
        const delta = chunk.choices?.[0]?.delta as Record<string, unknown> | undefined;
        if (ttftMs === undefined && (delta?.content || (delta as Record<string, unknown> | undefined)?.tool_calls)) {
          ttftMs = Date.now() - startTime;
        }
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens ?? 0;
          completionTokens = chunk.usage.completion_tokens ?? 0;
          usage = extractExtendedUsageMetrics(chunk.usage);
        }
        // OpenRouter returns reasoning content in delta.reasoning — remap to reasoning_content
        const orReasoning = delta?.reasoning as string | undefined;
        if (orReasoning) {
          const reasoningChunk = { ...chunk, choices: [{ ...chunk.choices?.[0], delta: { reasoning_content: orReasoning } }] };
          logResponseDebug(req, "OpenAI stream response chunk", reasoningChunk);
          writeAndFlush(res, `data: ${JSON.stringify(reasoningChunk)}\n\n`);
          continue;
        }
        logResponseDebug(req, "OpenAI stream response chunk", chunk);
        writeAndFlush(res, `data: ${JSON.stringify(chunk)}\n\n`);
      }
      writeAndFlush(res, "data: [DONE]\n\n");
      res.end();
      return { promptTokens, completionTokens, ttftMs, usage };
    } catch (streamErr) {
      if (res.headersSent || !routingSettings.fakeStream) throw streamErr;
      req.log.warn({ err: streamErr }, "Real streaming failed, falling back to fake-stream");
      const result = await client.chat.completions.create({ ...params, stream: false });
      logResponseDebug(req, "OpenAI non-stream response (fake-stream fallback)", result);
      const fakeStats = await fakeStreamResponse(res, result as unknown as Record<string, unknown>, startTime);
      return { ...fakeStats, usage: extractExtendedUsageMetrics(result.usage) };
    }
  } else {
    const result = await client.chat.completions.create({ ...params, stream: false });
    const resultRecord = result as unknown as Record<string, unknown>;
    // OpenRouter non-stream: remap reasoning to reasoning_content whenever present
    {
      const choices = (resultRecord.choices as Array<Record<string, unknown>> | undefined) ?? [];
      for (const choice of choices) {
        const msg = choice.message as Record<string, unknown> | undefined;
        if (msg && msg.reasoning) {
          msg.reasoning_content = msg.reasoning;
          delete msg.reasoning;
        }
      }
    }
    // Image models: normalize message.images[] → message.content[] image_url parts
    if (imageModalities) normalizeImageResponse(resultRecord);
    logResponseDebug(req, "OpenAI non-stream response", result);
    const usage = extractExtendedUsageMetrics(result.usage);
    setUsageHeaders(res, result.usage?.prompt_tokens ?? 0, result.usage?.completion_tokens ?? 0, usage);
    res.json(result);

    return {
      promptTokens: result.usage?.prompt_tokens ?? 0,
      completionTokens: result.usage?.completion_tokens ?? 0,
      usage,
    };
  }
}

async function handleOpenRouterFetch({
  req, res, model, messages, stream, maxTokens, tools, toolChoice, startTime, reasoning, providerRouting, cacheControl,
}: {
  req: Request;
  res: Response;
  model: string;
  messages: OAIMessage[];
  stream: boolean;
  maxTokens?: number;
  tools?: OAITool[];
  toolChoice?: unknown;
  startTime: number;
  reasoning?: { enabled: boolean } | { effort: string };
  providerRouting?: Record<string, unknown>;
  cacheControl?: { type?: string };
}): Promise<{ promptTokens: number; completionTokens: number; ttftMs?: number; usage?: ExtendedUsageMetrics }> {
  const apiKey = process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY;
  const baseURL = process.env.AI_INTEGRATIONS_OPENROUTER_BASE_URL;
  if (!apiKey || !baseURL) {
    throw new Error(
      "OpenRouter integration is not configured. Please add the OpenRouter integration in Replit (Tools → Integrations) to use OpenRouter models."
    );
  }

  const endpoint = `${baseURL.replace(/\/$/, "")}/chat/completions`;

  // 优化缓存策略：将断点移动到最后一条 assistant 消息
  let finalCacheControl: { type?: string } | undefined = cacheControl;
  if (finalCacheControl?.type === "ephemeral") {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        const msg = messages[i];
        if (typeof msg.content === "string") {
          msg.content = [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }];
        } else if (Array.isArray(msg.content) && msg.content.length > 0) {
          const lastPart = msg.content[msg.content.length - 1] as any;
          lastPart.cache_control = { type: "ephemeral" };
        }
        finalCacheControl = undefined; // 已手动注入，取消顶层控制
        break;
      }
    }
  }

  const payload: Record<string, unknown> = {
    model,
    messages,
    stream,
  };
  Object.assign(payload, getOpenRouterParams(resolveModel(model)) ?? {});
  if (maxTokens) payload.max_tokens = maxTokens;
  if (tools?.length) payload.tools = tools;
  if (toolChoice !== undefined) payload.tool_choice = toolChoice;
  if (reasoning) payload.reasoning = reasoning;
  if (providerRouting) payload.provider = providerRouting;
  if (finalCacheControl) payload.cache_control = finalCacheControl;

  const upstream = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => "");
    throw new Error(`OpenRouter error ${upstream.status}: ${errText}`);
  }

  if (!stream) {
    const result = await upstream.json() as Record<string, unknown>;
    const choices = (result.choices as Array<Record<string, unknown>> | undefined) ?? [];
    for (const choice of choices) {
      const msg = choice.message as Record<string, unknown> | undefined;
      if (msg && msg.reasoning) {
        msg.reasoning_content = msg.reasoning;
        delete msg.reasoning;
      }
    }
    logResponseDebug(req, "OpenRouter fetch non-stream response", result);




    const usage = extractExtendedUsageMetrics(result.usage);
    const usageRecord = (result.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined) ?? {};
    setUsageHeaders(res, usageRecord.prompt_tokens ?? 0, usageRecord.completion_tokens ?? 0, usage);
    res.json(result);
    return {
      promptTokens: usageRecord.prompt_tokens ?? 0,
      completionTokens: usageRecord.completion_tokens ?? 0,
      usage,
    };
  }

  if (!upstream.body) {
    throw new Error("OpenRouter stream response missing body");
  }

  setSseHeaders(res);
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ttftMs: number | undefined;
  let promptTokens = 0;
  let completionTokens = 0;
  let usage: ExtendedUsageMetrics | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunkText = decoder.decode(value, { stream: true });
    writeAndFlush(res, chunkText);
    buffer += chunkText;

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        const chunk = JSON.parse(raw) as Record<string, unknown>;
        const firstChoice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0];
        const delta = firstChoice?.delta as Record<string, unknown> | undefined;
        if (ttftMs === undefined && (delta?.content || delta?.tool_calls)) {
          ttftMs = Date.now() - startTime;
        }
        const chunkUsage = chunk.usage;
        if (chunkUsage && typeof chunkUsage === "object") {
          const usageRecord = chunkUsage as { prompt_tokens?: number; completion_tokens?: number };
          promptTokens = usageRecord.prompt_tokens ?? promptTokens;
          completionTokens = usageRecord.completion_tokens ?? completionTokens;
          usage = extractExtendedUsageMetrics(chunkUsage) ?? usage;
        }
      } catch {
      }
    }
  }

  const tail = decoder.decode();
  if (tail) writeAndFlush(res, tail);
  res.end();
  return { promptTokens, completionTokens, ttftMs, usage };
}

// ---------------------------------------------------------------------------
// Gemini raw API types (used by direct fetch implementation)
// ---------------------------------------------------------------------------

interface GeminiPart { text: string; thought?: boolean }
interface GeminiContent { role: string; parts: GeminiPart[] }
interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
}
interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}
interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsage;
}

function resolveGeminiAlias(model: string): GeminiModelAlias | undefined {
  return getGeminiAlias(stripVisibleSuffix(model));
}

function extractGeminiUsageMetrics(usage: unknown): ExtendedUsageMetrics | undefined {
  const usageRecord = readRecord(usage);
  if (!usageRecord) return undefined;
  const promptTokens = readFiniteNumber(usageRecord.promptTokenCount);
  const completionTokens = readFiniteNumber(usageRecord.candidatesTokenCount);
  const totalTokens = readFiniteNumber(usageRecord.totalTokenCount)
    ?? (promptTokens !== undefined || completionTokens !== undefined
      ? (promptTokens ?? 0) + (completionTokens ?? 0)
      : undefined);

  const metrics: ExtendedUsageMetrics = {
    totalTokens,
    cachedTokens: readFiniteNumber(usageRecord.cachedContentTokenCount),
    reasoningTokens: readFiniteNumber(usageRecord.thoughtsTokenCount),
  };

  if (Object.values(metrics).every((v) => v === undefined)) return undefined;
  return metrics;
}

function setUsageHeaders(res: Response, prompt: number, completion: number, usage?: ExtendedUsageMetrics) {
  if (res.headersSent) return;
  res.setHeader("X-Proxy-Tokens-Prompt", String(prompt));
  res.setHeader("X-Proxy-Tokens-Completion", String(completion));
  if (usage) {
    if (usage.costUsd !== undefined) res.setHeader("X-Proxy-Cost-Usd", String(usage.costUsd));
    if (usage.cachedTokens !== undefined) res.setHeader("X-Proxy-Tokens-Cached", String(usage.cachedTokens));
    if (usage.cacheWriteTokens !== undefined) res.setHeader("X-Proxy-Tokens-Cache-Write", String(usage.cacheWriteTokens));
    if (usage.reasoningTokens !== undefined) res.setHeader("X-Proxy-Tokens-Reasoning", String(usage.reasoningTokens));
  }
}

function applyGeminiDefaultThinkingConfig(body: unknown, alias: GeminiModelAlias): Record<string, unknown> {
  const source = readRecord(body) ?? {};
  const generationConfig = readRecord(source.generationConfig);
  if (!alias.thinkingConfig || readRecord(generationConfig?.thinkingConfig)) {
    return { ...source };
  }
  return {
    ...source,
    generationConfig: {
      ...(generationConfig ?? {}),
      thinkingConfig: alias.thinkingConfig,
    },
  };
}

async function handleGeminiNative({
  req, res, selectedModel, alias, body, stream, startTime,
}: {
  req: Request;
  res: Response;
  selectedModel: string;
  alias: GeminiModelAlias;
  body: unknown;
  stream: boolean;
  startTime: number;
}): Promise<{ promptTokens: number; completionTokens: number; ttftMs?: number; usage?: ExtendedUsageMetrics }> {
  const { apiKey, baseUrl } = makeLocalGemini();
  const reqBody = applyGeminiDefaultThinkingConfig(body, alias);
  const headers = {
    "Content-Type": "application/json",
    "x-goog-api-key": apiKey,
  };

  if (!stream) {
    const url = `${baseUrl}/models/${alias.actualModel}:generateContent`;
    const upstream = await fetch(url, { method: "POST", headers, body: JSON.stringify(reqBody) });
    const text = await upstream.text();
    if (!upstream.ok) {
      res.status(upstream.status).type(upstream.headers.get("content-type") ?? "application/json").send(text);
      throw new Error(`Gemini native error ${upstream.status}: ${text}`);
    }

    let data: GeminiResponse;
    try {
      data = JSON.parse(text) as GeminiResponse;
    } catch {
      data = {};
    }
    logResponseDebug(req, "Gemini native response", data);
    const promptTokens = data.usageMetadata?.promptTokenCount ?? 0;
    const completionTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
    const usage = extractGeminiUsageMetrics(data.usageMetadata);
    setUsageHeaders(res, promptTokens, completionTokens, usage);
    res.status(upstream.status).type(upstream.headers.get("content-type") ?? "application/json").send(text);

    return { promptTokens, completionTokens, usage };
  }

  const url = `${baseUrl}/models/${alias.actualModel}:streamGenerateContent?alt=sse`;
  const upstream = await fetch(url, { method: "POST", headers, body: JSON.stringify(reqBody) });
  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => "");
    res.status(upstream.status).type(upstream.headers.get("content-type") ?? "application/json").send(errText);
    throw new Error(`Gemini native stream error ${upstream.status}: ${errText}`);
  }

  setSseHeaders(res);
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let ttftMs: number | undefined;
  let promptTokens = 0;
  let completionTokens = 0;
  let usage: ExtendedUsageMetrics | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (ttftMs === undefined) ttftMs = Date.now() - startTime;
      const text = decoder.decode(value, { stream: true });
      writeAndFlush(res, text);
      buf += text;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;
        let chunk: GeminiResponse;
        try { chunk = JSON.parse(raw) as GeminiResponse; } catch { continue; }
        if (chunk.usageMetadata) {
          promptTokens = chunk.usageMetadata.promptTokenCount ?? promptTokens;
          completionTokens = chunk.usageMetadata.candidatesTokenCount ?? completionTokens;
          usage = extractGeminiUsageMetrics(chunk.usageMetadata) ?? usage;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  res.end();
  return { promptTokens, completionTokens, ttftMs, usage };
}

/** Extract answer text and reasoning text from Gemini parts. */
function extractGeminiParts(parts: GeminiPart[]): { answer: string; reasoning: string } {
  const answer = parts.filter((p) => !p.thought).map((p) => p.text).join("");
  const reasoning = parts.filter((p) => p.thought).map((p) => p.text).join("");
  return { answer, reasoning };
}

async function handleGemini({
  req, res, model, messages, stream, maxTokens, thinkingConfig, startTime,
}: {
  req: Request;
  res: Response;
  model: string;
  messages: OAIMessage[];
  stream: boolean;
  maxTokens?: number;
  thinkingConfig?: Record<string, unknown>;
  startTime: number;
}): Promise<{ promptTokens: number; completionTokens: number; ttftMs?: number; usage?: ExtendedUsageMetrics }> {
  const { apiKey, baseUrl } = makeLocalGemini();

  let systemInstruction: string | undefined;
  const contents: GeminiContent[] = [];

  for (const msg of messages) {
    const textContent = typeof msg.content === "string"
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.filter((p: OAIContentPart) => p.type === "text").map((p) => (p as { type: "text"; text: string }).text).join("\n")
        : "";
    if (msg.role === "system") {
      systemInstruction = systemInstruction ? `${systemInstruction}\n${textContent}` : textContent;
    } else {
      contents.push({
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: textContent || " " }],
      });
    }
  }

  if (contents.length === 0) {
    contents.push({ role: "user", parts: [{ text: " " }] });
  }

  const generationConfig: Record<string, unknown> = {};
  if (maxTokens) generationConfig.maxOutputTokens = maxTokens;
  if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;

  const reqBody: Record<string, unknown> = { contents, generationConfig };
  if (systemInstruction) reqBody.systemInstruction = { parts: [{ text: systemInstruction }] };

  const headers = {
    "Content-Type": "application/json",
    "x-goog-api-key": apiKey,
  };

  if (stream) {
    const url = `${baseUrl}/models/${model}:streamGenerateContent?alt=sse`;
    setSseHeaders(res);
    let ttftMs: number | undefined;
    let promptTokens = 0;
    let completionTokens = 0;
    let usage: ExtendedUsageMetrics | undefined;
    const chatId = `chatcmpl-${Date.now()}`;

    try {
      const upstream = await fetch(url, { method: "POST", headers, body: JSON.stringify(reqBody) });
      if (!upstream.ok || !upstream.body) {
        const errText = await upstream.text().catch(() => "");
        throw new Error(`Gemini stream error ${upstream.status}: ${errText}`);
      }

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw || raw === "[DONE]") continue;
          let chunk: GeminiResponse;
          try { chunk = JSON.parse(raw) as GeminiResponse; } catch { continue; }
          const parts = chunk.candidates?.[0]?.content?.parts ?? [];
          if (chunk.usageMetadata) {
            promptTokens = chunk.usageMetadata.promptTokenCount ?? 0;
            completionTokens = chunk.usageMetadata.candidatesTokenCount ?? 0;
            usage = extractGeminiUsageMetrics(chunk.usageMetadata) ?? usage;
          }
          for (const part of parts) {
            const isThought = !!part.thought;
            const text = part.text ?? "";
            if (!text) continue;
            if (ttftMs === undefined) ttftMs = Date.now() - startTime;
            const delta: Record<string, string> = isThought
              ? { reasoning_content: text }
              : { content: text };
            const oaiChunk = {
              id: chatId, object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000), model,
              choices: [{
                index: 0,
                delta,
                finish_reason: (!isThought && chunk.candidates?.[0]?.finishReason === "STOP") ? "stop" : null,
              }],
            };
            writeAndFlush(res, `data: ${JSON.stringify(oaiChunk)}\n\n`);
          }
        }
      }

      writeAndFlush(res, "data: [DONE]\n\n");
      res.end();
      return { promptTokens, completionTokens, ttftMs, usage };
    } catch (streamErr) {
      if (res.headersSent) throw streamErr;
      if (!routingSettings.fakeStream) throw streamErr;
      req.log.warn({ err: streamErr }, "Gemini streaming failed, falling back to non-stream");

      const fallbackUrl = `${baseUrl}/models/${model}:generateContent`;
      const fallbackResp = await fetch(fallbackUrl, { method: "POST", headers, body: JSON.stringify(reqBody) });
      const fallbackJson = await fallbackResp.json() as GeminiResponse;
      const { answer: fbAnswer, reasoning: fbReasoning } = extractGeminiParts(fallbackJson.candidates?.[0]?.content?.parts ?? []);
      const pTokens = fallbackJson.usageMetadata?.promptTokenCount ?? 0;
      const cTokens = fallbackJson.usageMetadata?.candidatesTokenCount ?? 0;
      const msg: Record<string, string> = { role: "assistant", content: fbAnswer };
      if (fbReasoning) msg.reasoning_content = fbReasoning;
      const json = {
        id: `chatcmpl-${Date.now()}`, object: "chat.completion",
        created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message: msg, finish_reason: "stop" }],
        usage: { prompt_tokens: pTokens, completion_tokens: cTokens, total_tokens: pTokens + cTokens },
      };
      const fakeStats = await fakeStreamResponse(res, json as unknown as Record<string, unknown>, startTime);
      return { ...fakeStats, usage: extractGeminiUsageMetrics(fallbackJson.usageMetadata) };
    }
  } else {
    const url = `${baseUrl}/models/${model}:generateContent`;
    const upstream = await fetch(url, { method: "POST", headers, body: JSON.stringify(reqBody) });
    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      throw new Error(`Gemini error ${upstream.status}: ${errText}`);
    }
    const data = await upstream.json() as GeminiResponse;
    const { answer, reasoning } = extractGeminiParts(data.candidates?.[0]?.content?.parts ?? []);
    const promptTokens = data.usageMetadata?.promptTokenCount ?? 0;
    const completionTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
    const message: Record<string, string> = { role: "assistant", content: answer };
    if (reasoning) message.reasoning_content = reasoning;

    const usage = extractGeminiUsageMetrics(data.usageMetadata);
    setUsageHeaders(res, promptTokens, completionTokens, usage);
    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message, finish_reason: "stop" }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
    });
    return { promptTokens, completionTokens, usage };
  }
}

async function handleClaude({
  req, res, client, model, messages, stream, maxTokens, temperature, topP, thinking = false, thinkingVisible = false, tools, toolChoice, webSearch = false, use300k = false, cacheControl, startTime, anthropicDefaults, requestHeaders,
}: {
  req: Request;
  res: Response;
  client: Anthropic;
  model: string;
  messages: OAIMessage[];
  stream: boolean;
  maxTokens: number;
  temperature?: number;
  topP?: number;
  thinking?: boolean;
  thinkingVisible?: boolean;
  tools?: OAITool[];
  toolChoice?: unknown;
  webSearch?: boolean;
  use300k?: boolean;
  cacheControl?: { type?: string };
  startTime: number;
  anthropicDefaults?: Record<string, unknown>;
  requestHeaders?: Record<string, string>;
}): Promise<{ promptTokens: number; completionTokens: number; ttftMs?: number; usage?: ExtendedUsageMetrics }> {
  const effectiveCacheControl = cacheControl ?? { type: "ephemeral" };
  // Extract system prompt
  const systemMessages = messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : (m.content as OAIContentPart[]).map((p) => (p.type === "text" ? (p as { type: "text"; text: string }).text : "")).join("")))
    .join("\n");

  // Convert all messages including tool_calls / tool roles
  const chatMessages = convertMessagesForClaude(messages);

  const thinkingParam = thinking ? (anthropicDefaults ?? {}) : {};
  const requestOptions = requestHeaders ? { headers: requestHeaders } : {};

  // Convert tools to Anthropic format
  const anthropicTools = tools?.length ? convertToolsForClaude(tools) : undefined;

  // Inject Anthropic built-in web search tool when webSearch is enabled
  const webSearchTool = webSearch
    ? [{ type: "web_search_20250305" as const, name: "web_search" as const }]
    : [];
  const allAnthropicTools = webSearchTool.length
    ? [...webSearchTool, ...(anthropicTools ?? [])]
    : anthropicTools;

  // Convert tool_choice
  let anthropicToolChoice: unknown;
  if (toolChoice !== undefined && anthropicTools?.length) {
    if (toolChoice === "auto") anthropicToolChoice = { type: "auto" };
    else if (toolChoice === "none") anthropicToolChoice = { type: "none" };
    else if (toolChoice === "required") anthropicToolChoice = { type: "any" };
    else if (typeof toolChoice === "object" && (toolChoice as Record<string, unknown>).type === "function") {
      anthropicToolChoice = { type: "tool", name: ((toolChoice as Record<string, unknown>).function as Record<string, unknown>).name };
    }
  }

  // 优化缓存策略：将断点移动到最后一条 assistant 消息
  let finalCacheControl: { type?: string } | undefined = effectiveCacheControl;
  if (finalCacheControl?.type === "ephemeral") {
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      if (chatMessages[i].role === "assistant") {
        const msg = chatMessages[i];
        if (typeof msg.content === "string") {
          msg.content = [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }];
        } else if (Array.isArray(msg.content) && msg.content.length > 0) {
          const lastPart = msg.content[msg.content.length - 1] as any;
          lastPart.cache_control = { type: "ephemeral" };
        }
        finalCacheControl = undefined; // 已手动注入，取消顶层控制
        break;
      }
    }
  }

  const buildCreateParams = () => ({
    model,
    max_tokens: maxTokens,
    ...((thinkingParam.output_config && !use300k)
      ? {}
      : { temperature: temperature ?? 1 }),
    ...(systemMessages ? { system: systemMessages } : {}),
    ...thinkingParam,
    messages: chatMessages,
    ...(allAnthropicTools?.length ? { tools: allAnthropicTools } : {}),
    ...(anthropicToolChoice ? { tool_choice: anthropicToolChoice } : {}),
    ...(finalCacheControl ? { cache_control: finalCacheControl } : {}),
  });

  const msgId = `msg_${Date.now()}`;

  if (stream) {
    setSseHeaders(res);
    const keepalive = setInterval(() => {
      if (!res.writableEnded) writeAndFlush(res, ": keepalive\n\n");
    }, 5000);
    req.on("close", () => clearInterval(keepalive));

    try {
      const claudeStream = client.messages.stream(buildCreateParams() as Parameters<typeof client.messages.stream>[0], requestOptions);

      let inputTokens = 0;
      let outputTokens = 0;
      let usage: ExtendedUsageMetrics | undefined;
      let ttftMs: number | undefined;
      // Track current tool_use block index for streaming
      let currentToolIndex = -1;
      const toolIndexMap = new Map<number, number>(); // content_block index → tool_calls array index
      let toolCallCount = 0;

      for await (const event of claudeStream) {
        logResponseDebug(req, "Claude stream response event", event);
        if (event.type === "message_start") {
          inputTokens = event.message.usage.input_tokens;
          usage = extractAnthropicUsageMetrics(event.message.usage);
          writeAndFlush(res, `data: ${JSON.stringify({ id: msgId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`);

        } else if (event.type === "content_block_start") {
          const block = event.content_block;

          if (block.type === "tool_use") {
            // Map this content block index to tool_calls array index
            currentToolIndex = toolCallCount++;
            toolIndexMap.set(event.index, currentToolIndex);
            if (ttftMs === undefined) ttftMs = Date.now() - startTime;
            // Send tool_call start chunk
            writeAndFlush(res, `data: ${JSON.stringify({ id: msgId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { tool_calls: [{ index: currentToolIndex, id: block.id, type: "function", function: { name: block.name, arguments: "" } }] }, finish_reason: null }] })}\n\n`);
          }

        } else if (event.type === "content_block_delta") {
          const delta = event.delta;

          if (delta.type === "thinking_delta") {
            const cleaned = delta.thinking.replace(/<\/?think>/g, "");
            if (cleaned) writeAndFlush(res, `data: ${JSON.stringify({ id: msgId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { reasoning_content: cleaned }, finish_reason: null }] })}\n\n`);
          } else if (delta.type === "text_delta") {
            if (ttftMs === undefined) ttftMs = Date.now() - startTime;
            writeAndFlush(res, `data: ${JSON.stringify({ id: msgId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }] })}\n\n`);
          } else if (delta.type === "input_json_delta") {
            // Tool argument streaming
            const toolIdx = toolIndexMap.get(event.index) ?? currentToolIndex;
            writeAndFlush(res, `data: ${JSON.stringify({ id: msgId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { tool_calls: [{ index: toolIdx, function: { arguments: delta.partial_json } }] }, finish_reason: null }] })}\n\n`);
          }

        } else if (event.type === "message_delta") {
          outputTokens = event.usage.output_tokens;
          const deltaUsage = extractAnthropicUsageMetrics(event.usage);
          if (deltaUsage) usage = { ...usage, ...deltaUsage };
          const stopReason = event.delta.stop_reason;
          const finishReason = stopReason === "tool_use" ? "tool_calls" : (stopReason ?? "stop");
          writeAndFlush(res, `data: ${JSON.stringify({ id: msgId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens } })}\n\n`);
        }
      }

      writeAndFlush(res, "data: [DONE]\n\n");
      res.end();
      return {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        ttftMs,
        usage: usage ? { ...usage, totalTokens: usage.totalTokens ?? (inputTokens + outputTokens) } : undefined,
      };
    } finally {
      clearInterval(keepalive);
    }

  } else {
    // Non-streaming — some models (e.g. claude-opus-4) require streaming;
    // detect the error and transparently upgrade to stream + collect.
    let result: Anthropic.Message;
    try {
      result = await client.messages.create(buildCreateParams() as Parameters<typeof client.messages.create>[0], requestOptions) as unknown as Anthropic.Message;
      logResponseDebug(req, "Claude non-stream response", result);
    } catch (nonStreamErr: unknown) {
      const errMsg = nonStreamErr instanceof Error ? nonStreamErr.message : String(nonStreamErr);
      if (/streaming.*required|requires.*stream/i.test(errMsg)) {
        req.log.warn("Claude model requires streaming — upgrading to stream+collect for non-stream request");
        const claudeStream = client.messages.stream(buildCreateParams() as Parameters<typeof client.messages.stream>[0], requestOptions);
        const collected = await claudeStream.finalMessage();
        result = collected;
        logResponseDebug(req, "Claude non-stream response (stream-collect fallback)", result);
      } else {
        throw nonStreamErr;
      }
    }

    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCalls: OAIToolCall[] = [];

    for (const block of result.content) {
      if (block.type === "thinking") {
        const rawThinking = (block as { type: "thinking"; thinking: string }).thinking.replace(/<\/?think>/g, "");
        reasoningParts.push(rawThinking);
      } else if (block.type === "text") {
        textParts.push((block as { type: "text"; text: string }).text);
      } else if (block.type === "tool_use") {
        const toolBlock = block as { type: "tool_use"; id: string; name: string; input: unknown };
        toolCalls.push({
          id: toolBlock.id,
          type: "function",
          function: {
            name: toolBlock.name,
            arguments: JSON.stringify(toolBlock.input),
          },
        });
      }
    }

    const text = textParts.join("\n\n");
    const reasoning = reasoningParts.join("\n\n");
    const stopReason = result.stop_reason;
    const finishReason = stopReason === "tool_use" ? "tool_calls" : (stopReason ?? "stop");

    const responseJson = {
      id: result.id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          content: text || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      }],
      usage: {
        prompt_tokens: result.usage.input_tokens,
        completion_tokens: result.usage.output_tokens,
        total_tokens: result.usage.input_tokens + result.usage.output_tokens,
      },
    };
    logResponseDebug(req, "Claude OpenAI-compatible response", responseJson);
    const usage = extractAnthropicUsageMetrics(result.usage);
    setUsageHeaders(res, result.usage.input_tokens, result.usage.output_tokens, usage);
    res.json(responseJson);
    return {
      promptTokens: result.usage.input_tokens,
      completionTokens: result.usage.output_tokens,
      usage,
    };
  }
}

export default router;
