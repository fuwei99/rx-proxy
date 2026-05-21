import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { resolve } from "path";

export type ModelProvider = "openai" | "anthropic" | "gemini" | "openrouter";

export interface PricingTier {
  min_tokens: number;
  input?: number;
  output?: number;
  cache_write?: number;
  cache_read?: number;
}

type JsonObject = Record<string, unknown>;

interface RawAlias {
  id: string;
  description?: string;
  exposed?: boolean;
  max_tokens?: number;
  features?: string[];
  headers?: Record<string, string>;
  pricing?: PricingTier[];
  defaults?: JsonObject;
  openrouter?: JsonObject;
}

interface RawModel extends Omit<RawAlias, "id"> {
  model: string;
  provider: ModelProvider;
  actual_model: string;
  display_name?: string;
  aliases?: RawAlias[];
}

interface RawRegistry {
  version: string;
  compatibility?: {
    strip_visible_suffixes?: boolean;
    legacy_visible_suffixes?: string[];
  };
  models: RawModel[];
}

export interface ResolvedModel {
  id: string;
  model: string;
  provider: ModelProvider;
  actualModel: string;
  description?: string;
  displayName?: string;
  exposed: boolean;
  maxTokens?: number;
  features: string[];
  headers?: Record<string, string>;
  pricing?: PricingTier[];
  defaults: JsonObject;
  openrouter: JsonObject;
}

export interface ListedModel {
  id: string;
  provider: ModelProvider;
  description?: string;
}

export interface GeminiModelAlias {
  actualModel: string;
  thinkingConfig?: Record<string, unknown>;
  description: string;
}

interface BuiltRegistry {
  resolvedModels: Map<string, ResolvedModel>;
  exposedModels: ListedModel[];
  providerMap: Map<string, ModelProvider>;
  geminiModels: { id: string; description: string }[];
}

export const MODEL_PROVIDER_MAP = new Map<string, ModelProvider>();
export const ALL_MODELS: ListedModel[] = [];
export const GEMINI_MODELS: { id: string; description: string }[] = [];

function findModelsJsonPath(): string {
  const candidates = [
    resolve(process.cwd(), "models.json"),
    resolve(process.cwd(), "../../models.json"),
    resolve(process.cwd(), "../../../models.json"),
  ];
  const file = candidates.find((path) => existsSync(path));
  if (!file) throw new Error(`models.json not found. Tried: ${candidates.join(", ")}`);
  return file;
}

export function getModelsJsonPath(): string {
  return findModelsJsonPath();
}

export function readModelsJsonText(): string {
  return readFileSync(findModelsJsonPath(), "utf8");
}

function isRecord(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function deepMerge<T extends JsonObject>(base: T | undefined, override: JsonObject | undefined): T {
  const result: JsonObject = { ...(base ?? {}) };
  if (!override) return result as T;
  for (const [key, value] of Object.entries(override)) {
    const existing = result[key];
    result[key] = isRecord(existing) && isRecord(value)
      ? deepMerge(existing, value)
      : value;
  }
  return result as T;
}

function mergeFeatures(base?: string[], override?: string[]): string[] {
  return [...new Set([...(base ?? []), ...(override ?? [])])];
}

function undefinedIfEmpty<T extends JsonObject>(value: T): T | undefined {
  return Object.keys(value).length > 0 ? value : undefined;
}

function validateRawRegistry(rawRegistry: RawRegistry): void {
  if (!rawRegistry || typeof rawRegistry !== "object") throw new Error("models.json root must be an object");
  if (!Array.isArray(rawRegistry.models)) throw new Error("models.json must contain a models array");
  for (const [index, model] of rawRegistry.models.entries()) {
    if (!model || typeof model !== "object") throw new Error(`models[${index}] must be an object`);
    if (typeof model.model !== "string" || !model.model) throw new Error(`models[${index}].model is required`);
    if (!["openai", "anthropic", "gemini", "openrouter"].includes(model.provider)) {
      throw new Error(`models[${index}].provider is invalid`);
    }
    if (typeof model.actual_model !== "string" || !model.actual_model) {
      throw new Error(`models[${index}].actual_model is required`);
    }
    if (model.aliases !== undefined && !Array.isArray(model.aliases)) {
      throw new Error(`models[${index}].aliases must be an array`);
    }
    for (const [aliasIndex, alias] of (model.aliases ?? []).entries()) {
      if (typeof alias.id !== "string" || !alias.id) {
        throw new Error(`models[${index}].aliases[${aliasIndex}].id is required`);
      }
    }
  }
}

function resolveAlias(model: RawModel, alias?: RawAlias): ResolvedModel {
  return {
    id: alias?.id ?? model.model,
    model: model.model,
    provider: model.provider,
    actualModel: model.actual_model,
    description: alias?.description ?? model.description,
    displayName: model.display_name,
    exposed: alias?.exposed ?? model.exposed ?? true,
    maxTokens: alias?.max_tokens ?? model.max_tokens,
    features: mergeFeatures(model.features, alias?.features),
    headers: undefinedIfEmpty(deepMerge<Record<string, string>>(model.headers, alias?.headers)),
    pricing: alias?.pricing ?? model.pricing,
    defaults: deepMerge(model.defaults, alias?.defaults),
    openrouter: deepMerge(model.openrouter, alias?.openrouter),
  };
}

function buildRegistry(rawRegistry: RawRegistry): BuiltRegistry {
  validateRawRegistry(rawRegistry);
  const resolvedModels = new Map<string, ResolvedModel>();
  const exposedModels: ListedModel[] = [];

  for (const model of rawRegistry.models) {
    const aliases = model.aliases?.length ? model.aliases : [undefined];
    for (const alias of aliases) {
      const resolved = resolveAlias(model, alias);
      if (resolvedModels.has(resolved.id)) throw new Error(`Duplicate model id in models.json: ${resolved.id}`);
      resolvedModels.set(resolved.id, resolved);
      if (resolved.exposed) {
        exposedModels.push({ id: resolved.id, provider: resolved.provider, description: resolved.description });
      }
    }
  }

  const providerMap = new Map<string, ModelProvider>(
    [...resolvedModels.values()].map((model) => [model.id, model.provider]),
  );
  const geminiModels = exposedModels
    .filter((model) => model.provider === "gemini")
    .map((model) => ({ id: model.id, description: model.description ?? "Gemini model" }));
  return { resolvedModels, exposedModels, providerMap, geminiModels };
}

function readAndBuildRegistry(): { file: string; mtimeMs: number; raw: RawRegistry; built: BuiltRegistry } {
  const file = findModelsJsonPath();
  const mtimeMs = statSync(file).mtimeMs;
  const raw = JSON.parse(readFileSync(file, "utf8")) as RawRegistry;
  return { file, mtimeMs, raw, built: buildRegistry(raw) };
}

const initial = readAndBuildRegistry();
let loadedFile = initial.file;
let loadedMtimeMs = initial.mtimeMs;
let loadedRegistry = initial.built;

function publishRegistry(): void {
  MODEL_PROVIDER_MAP.clear();
  for (const [id, provider] of loadedRegistry.providerMap) MODEL_PROVIDER_MAP.set(id, provider);
  ALL_MODELS.splice(0, ALL_MODELS.length, ...loadedRegistry.exposedModels);
  GEMINI_MODELS.splice(0, GEMINI_MODELS.length, ...loadedRegistry.geminiModels);
}

publishRegistry();

export function refreshModelRegistryIfChanged(): void {
  const file = findModelsJsonPath();
  const mtimeMs = statSync(file).mtimeMs;
  if (file === loadedFile && mtimeMs === loadedMtimeMs) return;
  const next = readAndBuildRegistry();
  loadedFile = next.file;
  loadedMtimeMs = next.mtimeMs;
  loadedRegistry = next.built;
  publishRegistry();
}

export function replaceModelsJson(content: string): { modelFamilies: number; exposedModels: number; path: string } {
  const parsed = JSON.parse(content) as RawRegistry;
  const built = buildRegistry(parsed);
  const file = findModelsJsonPath();
  writeFileSync(file, content, "utf8");
  loadedFile = file;
  loadedMtimeMs = statSync(file).mtimeMs;
  loadedRegistry = built;
  publishRegistry();
  return { modelFamilies: parsed.models.length, exposedModels: built.exposedModels.length, path: file };
}

export function resolveModel(id: string | undefined): ResolvedModel | undefined {
  if (!id) return undefined;
  refreshModelRegistryIfChanged();
  return loadedRegistry.resolvedModels.get(id);
}

export function isKnownModel(id: string): boolean {
  refreshModelRegistryIfChanged();
  return loadedRegistry.resolvedModels.has(id);
}

export function modelHasFeature(model: string | ResolvedModel | undefined, feature: string): boolean {
  const resolved = typeof model === "string" ? resolveModel(model) : model;
  return !!resolved?.features.includes(feature);
}

export function getProviderRequest(model: ResolvedModel | undefined, provider: ModelProvider): JsonObject {
  const defaults = model?.defaults[provider];
  return isRecord(defaults) ? defaults : {};
}

export function getOpenRouterDefaults(model: ResolvedModel | undefined): JsonObject {
  return getProviderRequest(model, "openrouter");
}

export function getOpenRouterProviderRouting(model: ResolvedModel | undefined): Record<string, unknown> | undefined {
  const defaults = getOpenRouterDefaults(model);
  const provider = defaults.provider ?? defaults.provider_routing;
  return isRecord(provider) ? provider : undefined;
}

export function getOpenRouterParams(model: ResolvedModel | undefined): Record<string, unknown> | undefined {
  const params = getOpenRouterDefaults(model).params;
  return isRecord(params) ? params : undefined;
}

export function getOpenRouterImageConfigTags(model: ResolvedModel | undefined): Record<string, unknown> | undefined {
  const tags = getOpenRouterDefaults(model).image_config_tags;
  return isRecord(tags) ? tags : undefined;
}

export function getOpenRouterReasoning(model: ResolvedModel | undefined): { enabled: boolean } | { effort: string } | undefined {
  const reasoning = getOpenRouterDefaults(model).reasoning;
  if (!isRecord(reasoning)) return undefined;
  if (typeof reasoning.enabled === "boolean") return { enabled: reasoning.enabled };
  if (typeof reasoning.effort === "string") return { effort: reasoning.effort };
  return undefined;
}

export function getOpenRouterModalities(model: ResolvedModel | undefined): readonly string[] | undefined {
  const modalities = getOpenRouterDefaults(model).modalities;
  return Array.isArray(modalities) && modalities.every((item) => typeof item === "string") ? modalities : undefined;
}

export function getGeminiAlias(model: string): GeminiModelAlias | undefined {
  const resolved = resolveModel(model);
  if (!resolved || resolved.provider !== "gemini") return undefined;
  const geminiDefaults = getProviderRequest(resolved, "gemini");
  const thinkingConfig = geminiDefaults.thinkingConfig;
  return {
    actualModel: resolved.actualModel,
    thinkingConfig: isRecord(thinkingConfig) ? thinkingConfig : undefined,
    description: resolved.description ?? resolved.id,
  };
}

export function getAnthropicDefaults(model: ResolvedModel | undefined): JsonObject {
  return getProviderRequest(model, "anthropic");
}

export function getPricing(model: string | undefined): PricingTier[] | undefined {
  return resolveModel(model)?.pricing;
}
