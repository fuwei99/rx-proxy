import { Router, type IRouter, type Request, type Response } from "express";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

const SETTINGS_FILE = resolve(process.cwd(), "server_settings.json");

interface ServerSettings {
  sillyTavernMode: boolean;
}

function loadSettings(): ServerSettings {
  try {
    if (existsSync(SETTINGS_FILE)) {
      return JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) as ServerSettings;
    }
  } catch {}
  return { sillyTavernMode: false };
}

function saveSettings(s: ServerSettings): void {
  try { writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2)); } catch {}
}

const settings: ServerSettings = loadSettings();

export function getSillyTavernMode(): boolean {
  return settings.sillyTavernMode;
}

// ---------------------------------------------------------------------------
// Auth helper — reuse same logic as proxy (Bearer or x-api-key)
// ---------------------------------------------------------------------------

function checkApiKey(req: Request, res: Response): boolean {
  const proxyKey = process.env.PROXY_API_KEY;
  if (!proxyKey) {
    res.status(500).json({ error: { message: "Server API key not configured", type: "server_error" } });
    return false;
  }
  const authHeader = req.headers["authorization"];
  const xApiKey = req.headers["x-api-key"];
  let provided: string | undefined;
  if (authHeader?.startsWith("Bearer ")) provided = authHeader.slice(7);
  else if (typeof xApiKey === "string") provided = xApiKey;

  if (!provided || provided !== proxyKey) {
    res.status(401).json({ error: { message: "Unauthorized", type: "invalid_request_error" } });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// GET /setup-status — public, no auth required
// ---------------------------------------------------------------------------

router.get("/setup-status", (_req: Request, res: Response) => {
  const configured = !!process.env.PROXY_API_KEY;
  const integrationsReady = !!(
    process.env.AI_INTEGRATIONS_OPENAI_BASE_URL &&
    process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL &&
    process.env.AI_INTEGRATIONS_GEMINI_BASE_URL &&
    process.env.AI_INTEGRATIONS_OPENROUTER_BASE_URL
  );
  const storageReady = !!process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  res.json({ configured, integrationsReady, storageReady });
});

// ---------------------------------------------------------------------------
// GET /settings/sillytavern — 读取当前设置
// ---------------------------------------------------------------------------

router.get("/settings/sillytavern", (req: Request, res: Response) => {
  if (!checkApiKey(req, res)) return;
  res.json({ enabled: settings.sillyTavernMode });
});

// ---------------------------------------------------------------------------
// POST /settings/sillytavern — 更新设置
// ---------------------------------------------------------------------------

router.post("/settings/sillytavern", (req: Request, res: Response) => {
  if (!checkApiKey(req, res)) return;
  const { enabled } = req.body as { enabled?: boolean };
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: { message: "enabled 字段必须为 boolean", type: "invalid_request_error" } });
    return;
  }
  settings.sillyTavernMode = enabled;
  saveSettings(settings);
  res.json({ enabled: settings.sillyTavernMode });
});

export default router;
