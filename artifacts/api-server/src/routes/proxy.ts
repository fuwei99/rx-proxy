import { Router, type IRouter, type Request, type Response } from "express";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { readJson, writeJson } from "../lib/cloudPersist";
import { getSillyTavernMode } from "./settings";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

const OPENAI_CHAT_MODELS = [
  "gpt-5.2", "gpt-5.1", "gpt-5", "gpt-5-mini", "gpt-5-nano",
  "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano",
  "gpt-4o", "gpt-4o-mini",
  "o4-mini", "o3", "o3-mini",
];
const OPENAI_THINKING_ALIASES = OPENAI_CHAT_MODELS
  .filter((m) => m.startsWith("o"))
  .map((m) => `${m}-thinking`);

const ANTHROPIC_BASE_MODELS = [
  "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5", "claude-opus-4-1",
  "claude-sonnet-4-6", "claude-sonnet-4-5",
  "claude-haiku-4-5",
];

// Models with Anthropic built-in web search injected automatically
const ANTHROPIC_SEARCH_MODELS = [
  "claude-opus-4-6-search",
];

// Models that support 300k output via beta header (opus/sonnet 4.6+)
const ANTHROPIC_300K_BASE_MODELS = [
  "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6",
];

const GEMINI_BASE_MODELS = [
  "gemini-3.1-pro-preview", "gemini-3-flash-preview",
  "gemini-2.5-pro", "gemini-2.5-flash",
];

const OPENROUTER_FEATURED = [
  "x-ai/grok-4.20", "x-ai/grok-4.1-fast", "x-ai/grok-4-fast",
  "meta-llama/llama-4-maverick", "meta-llama/llama-4-scout",
  "deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v3.2", "deepseek/deepseek-r1", "deepseek/deepseek-r1-0528",
  "mistralai/mistral-small-2603", "qwen/qwen3.5-122b-a10b",
  "google/gemini-2.5-pro", "anthropic/claude-opus-4.6", "anthropic/claude-opus-4.6:online", "anthropic/claude-opus-4.6-fast",
  "anthropic/claude-opus-4.7", "anthropic/claude-opus-4.7-fast",
  "cohere/command-a", "amazon/nova-premier-v1", "baidu/ernie-4.5-300b-a47b",
  "z-ai/glm-5.1", "qwen/qwen3.6-plus", "minimax/minimax-m2.7", "moonshotai/kimi-k2.6", "xiaomi/mimo-v2.5-pro",
  "openai/gpt-5.5-pro", "openai/gpt-5.5",
  "openai/gpt-5.4", "openai/gpt-5.4-pro", "openai/gpt-5.4-mini", "openai/gpt-5.4-nano",
  "openai/gpt-5.4-image-2",
  "google/gemini-3.1-flash-image-preview", "google/gemini-3-pro-image-preview", "google/gemini-2.5-flash-image",
  "bytedance-seed/seedream-4.5",
];

// OpenRouter models that support reasoning via { reasoning: { enabled: true } }
const OPENROUTER_THINKING_BASE = [
  "anthropic/claude-opus-4.6",
  "anthropic/claude-opus-4.7",
  "minimax/minimax-m2.7",
  "z-ai/glm-5.1",
  "moonshotai/kimi-k2.6",
  "xiaomi/mimo-v2.5-pro",
];
const OPENROUTER_THINKING_MODELS: string[] = OPENROUTER_THINKING_BASE.map((id) => `${id}-thinking`);

// OpenRouter models with effort-based reasoning (always-on, no plain variant).
// Exposed as <base>-low / <base>-high (always visible)
const OPENROUTER_EFFORT_BASE = [
  "google/gemini-3.1-pro-preview",
];
// Base (plain) variants of these models default to thinking if reasoning is omitted;
// must explicitly send effort:"none" to disable it.
const OPENROUTER_EFFORT_NONE_SET = new Set(["minimax/minimax-m2.7", "z-ai/glm-5.1", "moonshotai/kimi-k2.6", "xiaomi/mimo-v2.5-pro"]);

// Image models that return images alongside text — inject modalities:["image","text"]
const OPENROUTER_IMAGE_TEXT_MODELS = new Set([
  "openai/gpt-5.4-image-2",
  "google/gemini-3.1-flash-image-preview", "google/gemini-3-pro-image-preview", "google/gemini-2.5-flash-image",
]);
// Image-only models (no text output) — inject modalities:["image"]
const OPENROUTER_IMAGE_ONLY_MODELS = new Set([
  "bytedance-seed/seedream-4.5",
]);
// Union for response normalization (message.images[] → message.content[])
const OPENROUTER_IMAGE_MODELS = new Set([...OPENROUTER_IMAGE_TEXT_MODELS, ...OPENROUTER_IMAGE_ONLY_MODELS]);
const OPENROUTER_EFFORT_MODELS: string[] = OPENROUTER_EFFORT_BASE.flatMap((id) => [
  `${id}-low`,
  `${id}-high`,
]);

const OPENAI_MODELS = OPENAI_CHAT_MODELS.map((id) => ({ id, description: "OpenAI model" }));
const CLAUDE_MODELS = [
  ...ANTHROPIC_BASE_MODELS.flatMap((id) => [
    { id, description: "Anthropic Claude model" },
    { id: `${id}-thinking`, description: "Extended thinking" },
  ]),
  ...ANTHROPIC_SEARCH_MODELS.map((id) => ({ id, description: "Anthropic Claude with built-in web search" })),
];

const ALL_MODELS = [
  ...OPENAI_CHAT_MODELS.map((id) => ({ id })),
  ...OPENAI_THINKING_ALIASES.map((id) => ({ id })),
  ...ANTHROPIC_BASE_MODELS.flatMap((id) => [
    { id },
    { id: `${id}-thinking` },
  ]),
  ...ANTHROPIC_SEARCH_MODELS.map((id) => ({ id })),
  ...GEMINI_BASE_MODELS.flatMap((id) => [
    { id }, { id: `${id}-thinking` },
  ]),
  ...OPENROUTER_FEATURED.map((id) => ({ id })),
  ...OPENROUTER_THINKING_MODELS.map((id) => ({ id })),
  ...OPENROUTER_EFFORT_MODELS.map((id) => ({ id })),
];

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
// Model provider map + enable/disable management
// ---------------------------------------------------------------------------

type ModelProvider = "openai" | "anthropic" | "gemini" | "openrouter";

// Build a complete id → provider lookup from the model constants above
const MODEL_PROVIDER_MAP = new Map<string, ModelProvider>();

for (const id of OPENAI_CHAT_MODELS) { MODEL_PROVIDER_MAP.set(id, "openai"); }
for (const id of OPENAI_THINKING_ALIASES) { MODEL_PROVIDER_MAP.set(id, "openai"); }
for (const base of ANTHROPIC_BASE_MODELS) {
  MODEL_PROVIDER_MAP.set(base, "anthropic");
  MODEL_PROVIDER_MAP.set(`${base}-thinking`, "anthropic");
}
for (const id of ANTHROPIC_SEARCH_MODELS) { MODEL_PROVIDER_MAP.set(id, "anthropic"); }
for (const base of ANTHROPIC_300K_BASE_MODELS) {
  MODEL_PROVIDER_MAP.set(`${base}-300k-thinking`, "anthropic");
}
for (const base of GEMINI_BASE_MODELS) {
  MODEL_PROVIDER_MAP.set(base, "gemini");
  MODEL_PROVIDER_MAP.set(`${base}-thinking`, "gemini");
}
for (const id of OPENROUTER_FEATURED) { MODEL_PROVIDER_MAP.set(id, "openrouter"); }
for (const id of OPENROUTER_THINKING_MODELS) { MODEL_PROVIDER_MAP.set(id, "openrouter"); }
for (const id of OPENROUTER_EFFORT_MODELS) { MODEL_PROVIDER_MAP.set(id, "openrouter"); }

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
  totalDurationMs: number;
  totalTtftMs: number;
  streamingCalls: number;
}

interface ModelStat {
  calls: number;
  promptTokens: number;
  completionTokens: number;
}

const EMPTY_STAT = (): BackendStat => ({
  calls: 0, errors: 0, promptTokens: 0, completionTokens: 0,
  totalDurationMs: 0, totalTtftMs: 0, streamingCalls: 0,
});

const EMPTY_MODEL_STAT = (): ModelStat => ({
  calls: 0, promptTokens: 0, completionTokens: 0,
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
        if (raw && typeof raw === "object" && "calls" in (raw as Record<string, unknown>)) {
          statsMap.set(label, {
            calls:            Number((raw as BackendStat).calls)            || 0,
            errors:           Number((raw as BackendStat).errors)           || 0,
            promptTokens:     Number((raw as BackendStat).promptTokens)     || 0,
            completionTokens: Number((raw as BackendStat).completionTokens) || 0,
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

function recordCallStat(label: string, durationMs: number, prompt: number, completion: number, ttftMs?: number, model?: string): void {
  const s = getStat(label);
  s.calls++;
  s.promptTokens += prompt;
  s.completionTokens += completion;
  s.totalDurationMs += durationMs;
  if (ttftMs !== undefined) { s.totalTtftMs += ttftMs; s.streamingCalls++; }
  if (model) {
    const ms = getModelStat(model);
    ms.calls++;
    ms.promptTokens += prompt;
    ms.completionTokens += completion;
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

  let providedKey: string | undefined;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    providedKey = authHeader.slice(7);
  } else if (typeof xApiKey === "string") {
    providedKey = xApiKey;
  }

  if (!providedKey) {
    res.status(401).json({ error: { message: "Missing API key (provide Authorization: Bearer <key> or x-api-key header)", type: "invalid_request_error" } });
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

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get("/v1/models", requireApiKey, (_req: Request, res: Response) => {
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
      description: m.description,
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
  | { type: "text"; text: string }
  | { type: "image"; source: AnthropicImageSource }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

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

router.post("/v1/chat/completions", requireApiKey, async (req: Request, res: Response) => {
  const { model, messages, stream, max_tokens, temperature, top_p, tools, tool_choice, reasoning: clientReasoning } = req.body as {
    model?: string;
    messages: OAIMessage[];
    stream?: boolean;
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    tools?: OAITool[];
    tool_choice?: unknown;
    reasoning?: { effort?: string; enabled?: boolean };
  };

  // Normalize: strip legacy -visible suffix before any other processing
  const selectedModel = model ? stripVisibleSuffix(model) : model;

  // Reject disabled models early
  if (selectedModel && !isModelEnabled(selectedModel)) {
    res.status(403).json({ error: { message: `Model '${selectedModel}' is disabled on this gateway`, type: "invalid_request_error", code: "model_disabled" } });
    return;
  }
  const provider = MODEL_PROVIDER_MAP.get(selectedModel) ?? "openai";
  const isClaudeModel = provider === "anthropic";
  const isGeminiModel = provider === "gemini";
  const isOpenRouterModel = provider === "openrouter";
  const shouldStream = stream ?? false;
  const startTime = Date.now();

  const finalMessages = (isClaudeModel && getSillyTavernMode() && !tools?.length)
    ? [...messages, { role: "user" as const, content: "继续" }]
    : messages;

  const MAX_FRIEND_RETRIES = 3;
  const triedFriendUrls = new Set<string>();
  let backend = pickBackend();
  if (!backend) { res.status(503).json({ error: { message: "No available backends — all sub-nodes are down and local fallback is disabled", type: "service_unavailable" } }); return; }

  for (let attempt = 0; ; attempt++) {
    const backendLabel = backend.kind === "local" ? "local" : backend.label;
    req.log.info({ model: selectedModel, backend: backendLabel, attempt, counter: requestCounter - 1, sillyTavern: isClaudeModel && getSillyTavernMode(), toolCount: tools?.length ?? 0 }, "Proxy request");

    try {
      let result: { promptTokens: number; completionTokens: number; ttftMs?: number };
      if (backend.kind === "friend") {
        triedFriendUrls.add(backend.url);
        result = await handleFriendProxy({ req, res, backend, model: selectedModel, messages: finalMessages, stream: shouldStream, maxTokens: max_tokens, tools, toolChoice: tool_choice, startTime });
      } else if (isClaudeModel) {
        const webSearch = selectedModel.endsWith("-search");
        const stripped = webSearch ? selectedModel.replace(/-search$/, "") : selectedModel;
        const is300k = stripped.includes("-300k");
        const strippedOf300k = is300k ? stripped.replace("-300k", "") : stripped;
        const thinkingEnabled = strippedOf300k.endsWith("-thinking");
        const resolvedModel = thinkingEnabled ? strippedOf300k.replace(/-thinking$/, "") : strippedOf300k;
        const CLAUDE_MODEL_MAX: Record<string, number> = {
          "claude-haiku-4-5": 8096,
          "claude-sonnet-4-5": 64000,
          "claude-sonnet-4-6": 128000,
          "claude-opus-4-1": 64000,
          "claude-opus-4-5": 64000,
          "claude-opus-4-6": 128000,
          "claude-opus-4-7": 128000,
        };
        const modelMax = is300k ? 300000 : (CLAUDE_MODEL_MAX[resolvedModel] ?? 32000);
        const defaultMaxTokens = thinkingEnabled ? Math.max(modelMax, 32000) : modelMax;
        const client = makeLocalAnthropic();
        result = await handleClaude({ req, res, client, model: resolvedModel, messages: finalMessages, stream: shouldStream, maxTokens: max_tokens ?? defaultMaxTokens, temperature, topP: top_p, thinking: thinkingEnabled, thinkingVisible: thinkingEnabled, tools, toolChoice: tool_choice, webSearch, use300k: is300k, startTime });
      } else if (isGeminiModel) {
        const thinkingEnabled = selectedModel.endsWith("-thinking");
        const actualModel = thinkingEnabled ? selectedModel.replace(/-thinking$/, "") : selectedModel;
        result = await handleGemini({ req, res, model: actualModel, messages: finalMessages, stream: shouldStream, maxTokens: max_tokens, thinking: thinkingEnabled, thinkingVisible: thinkingEnabled, startTime });
      } else if (isOpenRouterModel) {
        // Detect effort-based models: <base>-low or <base>-high (always visible)
        const orEffortMatch = selectedModel.match(/^(.+)-(low|high)$/);
        const orThinkingEnabled = !orEffortMatch && selectedModel.endsWith("-thinking");

        let orActualModel: string;
        let orReasoning: { enabled: boolean } | { effort: string } | undefined;

        if (orEffortMatch) {
          orActualModel = orEffortMatch[1];
          orReasoning = { effort: orEffortMatch[2] };
        } else {
          orActualModel = orThinkingEnabled ? selectedModel.replace(/-thinking$/, "") : selectedModel;
          if (orThinkingEnabled) {
            orReasoning = { enabled: true };
          } else if (OPENROUTER_EFFORT_NONE_SET.has(orActualModel)) {
            orReasoning = { effort: "none" };
          } else {
            orReasoning = undefined;
          }
        }

        // Client-provided reasoning takes priority over the model-suffix-derived value
        const finalOrReasoning = clientReasoning ?? orReasoning;

        const client = makeLocalOpenRouter();
        const orImageModalities = OPENROUTER_IMAGE_TEXT_MODELS.has(orActualModel)
          ? ["image", "text"] as const
          : OPENROUTER_IMAGE_ONLY_MODELS.has(orActualModel)
            ? ["image"] as const
            : undefined;
        result = await handleOpenAI({ req, res, client, model: orActualModel, messages: finalMessages, stream: shouldStream, maxTokens: max_tokens, tools, toolChoice: tool_choice, startTime, reasoning: finalOrReasoning, thinkingVisible: !!(orThinkingEnabled || orEffortMatch), imageModalities: orImageModalities });
      } else {
        const client = makeLocalOpenAI();
        result = await handleOpenAI({ req, res, client, model: selectedModel, messages: finalMessages, stream: shouldStream, maxTokens: max_tokens, tools, toolChoice: tool_choice, startTime });
      }
      // ✅ Success — record stats, mark friend healthy, and exit retry loop
      if (backend.kind === "friend") setHealth(backend.url, true);
      const duration = Date.now() - startTime;
      recordCallStat(backendLabel, duration, result.promptTokens, result.completionTokens, result.ttftMs, selectedModel);
      pushRequestLog({
        method: req.method, path: req.path, model: selectedModel,
        backend: backendLabel, status: 200, duration, stream: shouldStream,
        promptTokens: result.promptTokens, completionTokens: result.completionTokens,
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
        stream: shouldStream, level: errStatus >= 500 ? "error" : "warn",
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
// Forwarded to the client as-is, but stripped from history before re-sending to Claude.
const SERVER_TOOL_BLOCK_TYPES = new Set(["server_tool_use", "web_search_tool_result"]);

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
  const m = model.match(/-(\d+)-(\d+)/);
  if (!m) return false;
  return parseInt(m[1]) * 100 + parseInt(m[2]) >= 406;
}

function sanitizeAnthropicMessages(messages: AnthropicMessage[], model?: string): AnthropicMessage[] {
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

  // IDs of server_tool_use blocks stripped from assistant messages.
  // Used to drop matching tool_result blocks in subsequent user messages.
  const strippedServerToolIds = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Fix assistant message content: strip markers from text, fill missing tool_use_ids
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const blocks = msg.content as Record<string, unknown>[];
      let lastToolId: string | undefined;
      const cleanContent = blocks.flatMap((block) => {
        // Strip server-side tool blocks and record their IDs so we can drop
        // any matching tool_result in the following user message
        if (SERVER_TOOL_BLOCK_TYPES.has(block.type as string)) {
          if (typeof block.id === "string") strippedServerToolIds.add(block.id as string);
          if (typeof block.tool_use_id === "string") strippedServerToolIds.add(block.tool_use_id as string);
          return [];
        }
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
      result.push({ ...msg, content: cleanContent } as AnthropicMessage);
      continue;
    }

    // For user messages that may contain tool_result blocks
    if (msg.role === "user" && Array.isArray(msg.content)) {
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

      for (const block of msg.content as Record<string, unknown>[]) {
        if (block.type === "tool_result") {
          // Drop tool_result blocks that reference a stripped server_tool_use — no matching tool_use exists
          if (typeof block.tool_use_id === "string" && strippedServerToolIds.has(block.tool_use_id as string)) {
            continue;
          }
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
        result.push({ ...msg, content: finalContent } as AnthropicMessage);
      }
      continue;
    }

    // Fallback: pass through other messages but still strip empty text blocks
    if (Array.isArray(msg.content)) {
      const cleaned = (msg.content as Record<string, unknown>[]).filter(
        (b) => !(b.type === "text" && (b.text === "" || b.text == null))
      );
      if (cleaned.length > 0) {
        result.push({ ...msg, content: cleaned } as AnthropicMessage);
      }
      continue;
    }

    result.push(msg);
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

router.post("/v1/messages", requireApiKey, async (req: Request, res: Response) => {
  const body = req.body as {
    model?: string;
    messages: AnthropicMessage[];
    system?: string | { type: string; text: string }[];
    stream?: boolean;
    max_tokens?: number;
    temperature?: number;
    thinking?: { type: "enabled"; budget_tokens: number };
    tools?: unknown[];
    [key: string]: unknown;
  };

  const { model, messages, system, stream, max_tokens, tools: clientTools, ...rest } = body;
  const rawModel = stripVisibleSuffix(model ?? "claude-sonnet-4-5");

  // Reject disabled models
  if (!isModelEnabled(rawModel)) {
    res.status(403).json({ error: { type: "invalid_request_error", message: `Model '${rawModel}' is disabled on this gateway` } });
    return;
  }

  // Resolve model-suffix aliases (same system as /v1/chat/completions)
  const webSearch = rawModel.endsWith("-search");
  const stripped = webSearch ? rawModel.replace(/-search$/, "") : rawModel;
  const thinkingEnabled = stripped.endsWith("-thinking");
  const selectedModel = thinkingEnabled ? stripped.replace(/-thinking$/, "") : stripped;

  // Model-specific max_tokens defaults
  const CLAUDE_MODEL_MAX: Record<string, number> = {
    "claude-haiku-4-5": 8096,
    "claude-sonnet-4-5": 64000,
    "claude-sonnet-4-6": 128000,
    "claude-opus-4-1": 64000,
    "claude-opus-4-5": 64000,
    "claude-opus-4-6": 128000,
    "claude-opus-4-7": 128000,
  };
  const modelMax = CLAUDE_MODEL_MAX[selectedModel] ?? 32000;
  const defaultMaxTokens = thinkingEnabled ? Math.max(modelMax, 32000) : modelMax;
  const maxTokens = max_tokens ?? defaultMaxTokens;

  const shouldStream = stream ?? false;
  const startTime = Date.now();

  req.log.info({ model: selectedModel, rawModel, stream: shouldStream, webSearch, thinking: thinkingEnabled }, "Anthropic /v1/messages request");

  // Build thinking param if needed (and not already provided by client)
  const isAdaptiveThinkingModel = selectedModel.includes("4-6") || selectedModel.includes("4.6") || selectedModel.includes("4-7") || selectedModel.includes("4.7");
  const thinkingParam = thinkingEnabled && !rest.thinking
    ? isAdaptiveThinkingModel
      ? { thinking: { type: "adaptive" as const }, output_config: { effort: "xhigh" } }
      : { thinking: { type: "enabled" as const, budget_tokens: 16000 } }
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
  const sanitizedMessages = sanitizeAnthropicMessages(messages, selectedModel);

  try {
    const client = makeLocalAnthropic();

    const createParams = {
      model: selectedModel,
      max_tokens: maxTokens,
      messages: sanitizedMessages,
      ...(system ? { system } : {}),
      ...thinkingParam,
      ...(mergedTools.length ? { tools: mergedTools } : {}),
      ...safeRest,
    } as Parameters<typeof client.messages.create>[0];

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

      try {
        const claudeStream = client.messages.stream(createParams as Parameters<typeof client.messages.stream>[0]);

        for await (const event of claudeStream) {
          if (event.type === "message_start") {
            inputTokens = event.message.usage.input_tokens;
          } else if (event.type === "message_delta") {
            outputTokens = event.usage.output_tokens;
          }

          writeAndFlush(res, `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        }
        writeAndFlush(res, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
        res.end();
        const dur = Date.now() - startTime;
        recordCallStat("local", dur, inputTokens, outputTokens, undefined, selectedModel);
        pushRequestLog({
          method: req.method, path: req.path, model: selectedModel,
          backend: "local", status: 200, duration: dur, stream: true,
          promptTokens: inputTokens, completionTokens: outputTokens, level: "info",
        });
      } finally {
        clearInterval(keepalive);
      }
    } else {
      const rawResult = await client.messages.create(createParams);
      const resultWithMarkers = rawResult;
      const usage = (rawResult as { usage?: { input_tokens?: number; output_tokens?: number } }).usage ?? {};
      const dur = Date.now() - startTime;
      recordCallStat("local", dur, usage.input_tokens ?? 0, usage.output_tokens ?? 0, undefined, selectedModel);
      pushRequestLog({
        method: req.method, path: req.path, model: selectedModel,
        backend: "local", status: 200, duration: dur, stream: false,
        promptTokens: usage.input_tokens ?? 0, completionTokens: usage.output_tokens ?? 0, level: "info",
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
  backend?: string;
  status: number;
  duration: number;
  stream: boolean;
  promptTokens?: number;
  completionTokens?: number;
  level: "info" | "warn" | "error";
  error?: string;
}

const REQUEST_LOG_MAX = 200;
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
  const models = ALL_MODELS.map((m) => ({
    id: m.id,
    provider: MODEL_PROVIDER_MAP.get(m.id) ?? "openrouter",
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
}): Promise<{ promptTokens: number; completionTokens: number; ttftMs?: number }> {
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
    res.json(json);
    const usage = json["usage"] as { prompt_tokens?: number; completion_tokens?: number } | null | undefined;
    if ((usage?.prompt_tokens ?? 0) === 0) {
      const inputChars = messages.reduce((acc, m) => {
        if (typeof m.content === "string") return acc + m.content.length;
        if (Array.isArray(m.content))
          return acc + (m.content as Array<{ type: string; text?: string }>)
            .filter((p) => p.type === "text").reduce((a, p) => a + (p.text?.length ?? 0), 0);
        return acc;
      }, 0);
      const outputChars = (json["choices"] as Array<{ message?: { content?: string } }>)?.[0]?.message?.content?.length ?? 0;
      return { promptTokens: Math.ceil(inputChars / 4), completionTokens: Math.ceil(outputChars / 4) };
    }
    return { promptTokens: usage?.prompt_tokens ?? 0, completionTokens: usage?.completion_tokens ?? 0 };
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
    if (result.promptTokens === 0) {
      const inputChars = messages.reduce((acc, m) => {
        if (typeof m.content === "string") return acc + m.content.length;
        if (Array.isArray(m.content))
          return acc + (m.content as Array<{ type: string; text?: string }>)
            .filter((p) => p.type === "text").reduce((a, p) => a + (p.text?.length ?? 0), 0);
        return acc;
      }, 0);
      const outputContent = ((json["choices"] as Array<{ message?: { content?: string } }>)?.[0]?.message?.content ?? "").length;
      return { promptTokens: Math.ceil(inputChars / 4), completionTokens: Math.ceil(outputContent / 4), ttftMs: result.ttftMs };
    }
    return result;
  }

  setSseHeaders(res);
  const keepaliveTimer = setInterval(() => writeAndFlush(res, ": keep-alive\n\n"), 15_000);

  let promptTokens = 0;
  let completionTokens = 0;
  let ttftMs: number | undefined;
  let outputChars = 0;

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
            const usage = chunk["usage"] as { prompt_tokens?: number; completion_tokens?: number } | null | undefined;
            if (usage && typeof usage === "object") {
              promptTokens = usage.prompt_tokens ?? promptTokens;
              completionTokens = usage.completion_tokens ?? completionTokens;
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

  return { promptTokens, completionTokens, ttftMs };
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
  req, res, client, model, messages, stream, maxTokens, tools, toolChoice, startTime, reasoning, thinkingVisible, imageModalities,
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
}): Promise<{ promptTokens: number; completionTokens: number; ttftMs?: number }> {
  const params: Parameters<typeof client.chat.completions.create>[0] = {
    model,
    messages: messages as Parameters<typeof client.chat.completions.create>[0]["messages"],
    stream,
  };
  if (maxTokens) (params as Record<string, unknown>)["max_completion_tokens"] = maxTokens;
  if (tools?.length) (params as Record<string, unknown>)["tools"] = tools;
  if (toolChoice !== undefined) (params as Record<string, unknown>)["tool_choice"] = toolChoice;
  if (reasoning) (params as Record<string, unknown>)["reasoning"] = reasoning;
  if (imageModalities) (params as Record<string, unknown>)["modalities"] = imageModalities;

  // Image models don't support streaming — always return non-streaming response
  // to avoid base64 content being split across SSE chunks incorrectly
  if (imageModalities && stream) {
    const result = await client.chat.completions.create({ ...params, stream: false });
    const resultRecord = result as unknown as Record<string, unknown>;
    normalizeImageResponse(resultRecord);
    res.json(result);
    return {
      promptTokens: result.usage?.prompt_tokens ?? 0,
      completionTokens: result.usage?.completion_tokens ?? 0,
    };
  }

  if (stream) {
    try {
      setSseHeaders(res);
      let ttftMs: number | undefined;
      let promptTokens = 0;
      let completionTokens = 0;
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
        }
        // OpenRouter returns reasoning content in delta.reasoning — remap to reasoning_content
        const orReasoning = delta?.reasoning as string | undefined;
        if (orReasoning) {
          const reasoningChunk = { ...chunk, choices: [{ ...chunk.choices?.[0], delta: { reasoning_content: orReasoning } }] };
          writeAndFlush(res, `data: ${JSON.stringify(reasoningChunk)}\n\n`);
          continue;
        }
        writeAndFlush(res, `data: ${JSON.stringify(chunk)}\n\n`);
      }
      writeAndFlush(res, "data: [DONE]\n\n");
      res.end();
      return { promptTokens, completionTokens, ttftMs };
    } catch (streamErr) {
      if (res.headersSent || !routingSettings.fakeStream) throw streamErr;
      req.log.warn({ err: streamErr }, "Real streaming failed, falling back to fake-stream");
      const result = await client.chat.completions.create({ ...params, stream: false });
      return fakeStreamResponse(res, result as unknown as Record<string, unknown>, startTime);
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
    res.json(result);
    return {
      promptTokens: result.usage?.prompt_tokens ?? 0,
      completionTokens: result.usage?.completion_tokens ?? 0,
    };
  }
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
interface GeminiUsage { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number }
interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsage;
}

/** Extract answer text and reasoning text from Gemini parts. */
function extractGeminiParts(parts: GeminiPart[]): { answer: string; reasoning: string } {
  const answer = parts.filter((p) => !p.thought).map((p) => p.text).join("");
  const reasoning = parts.filter((p) => p.thought).map((p) => p.text).join("");
  return { answer, reasoning };
}

async function handleGemini({
  req, res, model, messages, stream, maxTokens, thinking = false, thinkingVisible = false, startTime,
}: {
  req: Request;
  res: Response;
  model: string;
  messages: OAIMessage[];
  stream: boolean;
  maxTokens?: number;
  thinking?: boolean;
  thinkingVisible?: boolean;
  startTime: number;
}): Promise<{ promptTokens: number; completionTokens: number; ttftMs?: number }> {
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
  if (thinking) {
    generationConfig.thinkingConfig = {
      thinkingBudget: maxTokens ? Math.min(maxTokens, 32768) : 16384,
      includeThoughts: true,
    };
  }

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
      return { promptTokens, completionTokens, ttftMs };
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
      return fakeStreamResponse(res, json as unknown as Record<string, unknown>, startTime);
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

    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message, finish_reason: "stop" }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
    });
    return { promptTokens, completionTokens };
  }
}

async function handleClaude({
  req, res, client, model, messages, stream, maxTokens, temperature, topP, thinking = false, thinkingVisible = false, tools, toolChoice, webSearch = false, use300k = false, startTime,
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
  startTime: number;
}): Promise<{ promptTokens: number; completionTokens: number; ttftMs?: number }> {
  // Extract system prompt
  const systemMessages = messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : (m.content as OAIContentPart[]).map((p) => (p.type === "text" ? (p as { type: "text"; text: string }).text : "")).join("")))
    .join("\n");

  // Convert all messages including tool_calls / tool roles
  const chatMessages = convertMessagesForClaude(messages);

  const isAdaptiveThinkingModel = model.includes("4-6") || model.includes("4.6") || model.includes("4-7") || model.includes("4.7");
  const thinkingParam = thinking
    ? use300k
      ? { thinking: { type: "enabled" as const, effort: "max" } }
      : isAdaptiveThinkingModel
        ? { thinking: { type: "adaptive" as const }, output_config: { effort: "xhigh" } }
        : { thinking: { type: "enabled" as const, budget_tokens: 16000 } }
    : {};

  // Per-request options: inject 300k beta header when needed
  const requestOptions = use300k
    ? { headers: { "anthropic-beta": "output-300k-2026-03-24" } }
    : {};

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

  const buildCreateParams = () => ({
    model,
    max_tokens: maxTokens,
    ...((isAdaptiveThinkingModel && !use300k)
      ? {}
      : { temperature: temperature ?? 1 }),
    ...(systemMessages ? { system: systemMessages } : {}),
    ...thinkingParam,
    messages: chatMessages,
    ...(allAnthropicTools?.length ? { tools: allAnthropicTools } : {}),
    ...(anthropicToolChoice ? { tool_choice: anthropicToolChoice } : {}),
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
      let ttftMs: number | undefined;
      // Track current tool_use block index for streaming
      let currentToolIndex = -1;
      const toolIndexMap = new Map<number, number>(); // content_block index → tool_calls array index
      let toolCallCount = 0;

      for await (const event of claudeStream) {
        if (event.type === "message_start") {
          inputTokens = event.message.usage.input_tokens;
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
          const stopReason = event.delta.stop_reason;
          const finishReason = stopReason === "tool_use" ? "tool_calls" : (stopReason ?? "stop");
          writeAndFlush(res, `data: ${JSON.stringify({ id: msgId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens } })}\n\n`);
        }
      }

      writeAndFlush(res, "data: [DONE]\n\n");
      res.end();
      return { promptTokens: inputTokens, completionTokens: outputTokens, ttftMs };
    } finally {
      clearInterval(keepalive);
    }

  } else {
    // Non-streaming — some models (e.g. claude-opus-4) require streaming;
    // detect the error and transparently upgrade to stream + collect.
    let result: Anthropic.Message;
    try {
      result = await client.messages.create(buildCreateParams() as Parameters<typeof client.messages.create>[0], requestOptions);
    } catch (nonStreamErr: unknown) {
      const errMsg = nonStreamErr instanceof Error ? nonStreamErr.message : String(nonStreamErr);
      if (/streaming.*required|requires.*stream/i.test(errMsg)) {
        req.log.warn("Claude model requires streaming — upgrading to stream+collect for non-stream request");
        const claudeStream = client.messages.stream(buildCreateParams() as Parameters<typeof client.messages.stream>[0], requestOptions);
        const collected = await claudeStream.finalMessage();
        result = collected;
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

    res.json({
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
    });
    return { promptTokens: result.usage.input_tokens, completionTokens: result.usage.output_tokens };
  }
}

export default router;
