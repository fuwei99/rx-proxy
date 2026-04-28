import { Router, type IRouter, type Request, type Response } from "express";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  readFileSync, writeFileSync, existsSync,
  readdirSync, statSync, mkdirSync,
} from "fs";
import { resolve, join, dirname, relative } from "path";

const router: IRouter = Router();
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Workspace root (monorepo root)
// ---------------------------------------------------------------------------

const WORKSPACE_ROOT = resolve(process.cwd(), "../../");

// ---------------------------------------------------------------------------
// GitHub config — set UPDATE_CHECK_URL to GITHUB_RAW_VERSION_URL on sub-nodes
// ---------------------------------------------------------------------------

const GITHUB_OWNER = "Akatsuki03";
const GITHUB_REPO  = "Replit2Api";
const GITHUB_BRANCH = "main";
const GITHUB_API  = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;
export const GITHUB_RAW_VERSION_URL =
  `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/version.json`;

// Strip every non-ASCII character so the value is always safe as an HTTP header.
// Node.js throws ERR_INVALID_CHAR for any char outside 0x00-0x7F in header values.
// e.g. "1.0.4β" → "1.0.4" , "1.0.4b" → "1.0.4b" (unchanged)
export function safeVersionHeader(version: string): string {
  return version.replace(/[^\x00-\x7F]/g, "");
}

function githubHeaders(withToken = true): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "Replit2Api-Updater",
  };
  const tok = process.env.GITHUB_TOKEN;
  if (withToken && tok) h.Authorization = `token ${tok}`;
  return h;
}

// ---------------------------------------------------------------------------
// Version info
// ---------------------------------------------------------------------------

interface VersionInfo {
  version: string;
  name?: string;
  releaseDate?: string;
  releaseNotes?: string;
}

function readLocalVersion(): VersionInfo {
  const candidates = [
    resolve(process.cwd(), "version.json"),
    resolve(WORKSPACE_ROOT, "version.json"),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")) as VersionInfo;
    } catch {}
  }
  return { version: "unknown" };
}

// Parse version string — supports v1.2.3, v1.2.3a, v1.2.3b, v1.2.3rc1, v1.2.3-beta, etc.
// Returns { nums: numeric segments[], pre: pre-release suffix (empty = stable release) }
function parseVersion(v: string): { nums: number[]; pre: string } {
  const clean = v.replace(/^v/i, "").trim();
  // Match numeric part (multi-segment) and optional pre-release suffix
  const match = clean.match(/^([\d]+(?:\.[\d]+)*)(.*)$/);
  if (!match) return { nums: [0], pre: "" };
  const nums = match[1].split(".").map((n) => parseInt(n, 10) || 0);
  const pre  = match[2].trim(); // e.g. a, b, rc1, -beta
  return { nums, pre };
}

function isNewer(remote: string, local: string): boolean {
  const r = parseVersion(remote);
  const l = parseVersion(local);
  const len = Math.max(r.nums.length, l.nums.length);

  // Compare numeric segments first
  for (let i = 0; i < len; i++) {
    if ((r.nums[i] ?? 0) > (l.nums[i] ?? 0)) return true;
    if ((r.nums[i] ?? 0) < (l.nums[i] ?? 0)) return false;
  }

  // Same numeric parts: stable release (no suffix) > pre-release (has suffix)
  if (!r.pre && l.pre) return true;  // remote is stable, local is pre-release → update available
  if (r.pre && !l.pre) return false; // remote is pre-release, local is stable → no update

  // Both have suffixes: compare lexicographically (b > a, rc2 > rc1, etc.)
  if (r.pre && l.pre) return r.pre > l.pre;

  return false;
}

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

function checkApiKey(req: Request, res: Response): boolean {
  const proxyKey = process.env.PROXY_API_KEY;
  if (!proxyKey) {
    res.status(500).json({ error: "Server API key not configured" });
    return false;
  }
  const authHeader = req.headers["authorization"];
  const xApiKey = req.headers["x-api-key"];
  let provided: string | undefined;
  if (authHeader?.startsWith("Bearer ")) provided = authHeader.slice(7);
  else if (typeof xApiKey === "string") provided = xApiKey;
  if (!provided || provided !== proxyKey) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// File scanner — collect all source file contents for bundle / GitHub push
// ---------------------------------------------------------------------------

const BUNDLE_INCLUDE_DIRS = [
  "artifacts/api-server/src",
  "artifacts/api-portal/src",
];

const BUNDLE_INCLUDE_FILES = [
  "version.json",
  "artifacts/api-portal/index.html",
  "artifacts/api-server/build.mjs",
  "artifacts/api-portal/package.json",
  "artifacts/api-portal/tsconfig.json",
  "artifacts/api-portal/vite.config.ts",
  "artifacts/api-portal/components.json",
  "artifacts/api-server/package.json",
  "artifacts/api-server/tsconfig.json",
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.base.json",
  ".npmrc",
  ".replitignore",
  "README.md",
];

const BUNDLE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".css", ".html", ".md", ".yaml", ".yml"]);
const BUNDLE_EXCLUDE    = new Set(["node_modules", "dist", ".git", ".cache"]);

function scanDir(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  if (!existsSync(dir)) return files;
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      if (BUNDLE_EXCLUDE.has(entry)) continue;
      const full = join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else {
        const ext = entry.slice(entry.lastIndexOf("."));
        if (BUNDLE_EXTENSIONS.has(ext)) {
          const rel = relative(WORKSPACE_ROOT, full);
          try { files[rel] = readFileSync(full, "utf8"); } catch {}
        }
      }
    }
  };
  walk(dir);
  return files;
}

function buildBundle(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const dir of BUNDLE_INCLUDE_DIRS) {
    Object.assign(files, scanDir(join(WORKSPACE_ROOT, dir)));
  }
  for (const rel of BUNDLE_INCLUDE_FILES) {
    const full = join(WORKSPACE_ROOT, rel);
    try {
      if (existsSync(full)) files[rel] = readFileSync(full, "utf8");
    } catch {}
  }
  return files;
}


// ---------------------------------------------------------------------------
// GitHub: download latest files and apply to local workspace
// Uses GitHub Git Trees API (public repo — no token required; token raises rate limit)
// ---------------------------------------------------------------------------

async function applyFromGitHub(): Promise<{ written: number }> {
  // Fetch full file tree
  const treeRes = await fetch(`${GITHUB_API}/git/trees/${GITHUB_BRANCH}?recursive=1`, {
    headers: githubHeaders(),
  });
  if (!treeRes.ok) throw new Error(`Failed to fetch GitHub tree: HTTP ${treeRes.status}`);
  const treeData = await treeRes.json() as {
    tree: { path: string; type: string; sha: string; url: string }[];
  };

  // Filter to only bundle-included files
  const bundleFilesSet = new Set(BUNDLE_INCLUDE_FILES);
  const filesToFetch = treeData.tree.filter((item) => {
    if (item.type !== "blob") return false;
    if (bundleFilesSet.has(item.path)) return true;
    return BUNDLE_INCLUDE_DIRS.some((dir) => item.path.startsWith(dir + "/"));
  });

  let written = 0;
  for (const file of filesToFetch) {
    try {
      // Fetch base64 content via Contents API
      const r = await fetch(`${GITHUB_API}/contents/${file.path}?ref=${GITHUB_BRANCH}`, {
        headers: githubHeaders(),
      });
      if (!r.ok) { console.warn(`[apply-github] skip ${file.path}: HTTP ${r.status}`); continue; }
      const data = await r.json() as { content: string };
      const content = Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8");
      const fullPath = join(WORKSPACE_ROOT, file.path);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, "utf8");
      written++;
    } catch (e) {
      console.warn(`[apply-github] write failed ${file.path}:`, e);
    }
  }
  return { written };
}

// ---------------------------------------------------------------------------
// Check whether UPDATE_CHECK_URL points to GitHub
// ---------------------------------------------------------------------------

function isGitHubCheckUrl(url: string | undefined): boolean {
  if (!url) return false;
  return url.includes("raw.githubusercontent.com") || url.includes("github.com");
}

// ---------------------------------------------------------------------------
// GET /update/version — local version + optional remote check
// ---------------------------------------------------------------------------

router.get("/update/version", async (_req: Request, res: Response) => {
  const local = readLocalVersion();
  // Prefer env override; fall back to official GitHub repo
  const checkUrl = process.env.UPDATE_CHECK_URL || GITHUB_RAW_VERSION_URL;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(checkUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const remote = (await r.json()) as VersionInfo;
    const hasUpdate = isNewer(remote.version, local.version);
    res.json({
      ...local,
      hasUpdate,
      latestVersion: remote.version,
      latestReleaseNotes: remote.releaseNotes,
      latestReleaseDate: remote.releaseDate,
      source: isGitHubCheckUrl(checkUrl) ? "github" : "replit",
    });
  } catch (err) {
    res.json({ ...local, hasUpdate: false, checkError: err instanceof Error ? err.message : "check failed" });
  }
});

// ---------------------------------------------------------------------------
// GET /update/bundle — public endpoint, returns JSON file bundle (legacy Replit update compat)
// ---------------------------------------------------------------------------

router.get("/update/bundle", (_req: Request, res: Response) => {
  try {
    const local = readLocalVersion();
    const files = buildBundle();
    res.json({ version: local.version, releaseNotes: local.releaseNotes, fileCount: Object.keys(files).length, files });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "bundle failed" });
  }
});

// ---------------------------------------------------------------------------
// POST /update/apply — protected: pull update from GitHub or upstream Replit and restart
// If UPDATE_CHECK_URL points to GitHub raw → pull from GitHub (default)
// Otherwise → legacy Replit bundle mode
// ---------------------------------------------------------------------------

let updateInProgress = false;

router.post("/update/apply", async (req: Request, res: Response) => {
  if (!checkApiKey(req, res)) return;
  if (updateInProgress) {
    res.status(409).json({ error: "Update already in progress, please wait" });
    return;
  }

  const checkUrl = process.env.UPDATE_CHECK_URL;
  // Default: always GitHub mode; legacy bundle mode only when a non-GitHub UPDATE_CHECK_URL is set
  const useGitHub = !checkUrl || isGitHubCheckUrl(checkUrl) || process.env.GITHUB_APPLY === "true";

  res.json({
    status: "started",
    source: useGitHub ? "github" : "replit",
    message: useGitHub
      ? "Pulling latest code from GitHub, server will restart automatically in ~30-60s..."
      : "Downloading update bundle from upstream Replit instance, server will restart in ~30s...",
  });
  updateInProgress = true;

  (async () => {
    try {
      if (useGitHub) {
        const { written } = await applyFromGitHub();
        console.log(`[update] wrote ${written} files from GitHub`);
      } else {
        // Legacy Replit bundle mode
        const bundleUrl = checkUrl!.replace(/\/update\/version$/, "/update/bundle");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        const r = await fetch(bundleUrl, { signal: controller.signal });
        clearTimeout(timer);
        if (!r.ok) throw new Error(`Download failed HTTP ${r.status}`);
        const bundle = (await r.json()) as { version: string; files: Record<string, string> };
        for (const [relPath, content] of Object.entries(bundle.files)) {
          const fullPath = join(WORKSPACE_ROOT, relPath);
          mkdirSync(dirname(fullPath), { recursive: true });
          writeFileSync(fullPath, content, "utf8");
        }
        console.log(`[update] wrote ${Object.keys(bundle.files).length} files from Replit bundle`);
      }

      // Install dependencies
      await execFileAsync("pnpm", ["install", "--no-frozen-lockfile"], { cwd: WORKSPACE_ROOT });

      // Exit → Workflow auto-restarts
      setTimeout(() => process.exit(0), 500);
    } catch (err) {
      updateInProgress = false;
      console.error("[update] update failed:", err instanceof Error ? err.message : err);
    }
  })();
});

// ---------------------------------------------------------------------------
// GET /update/status
// ---------------------------------------------------------------------------

router.get("/update/status", (_req: Request, res: Response) => {
  res.json({
    inProgress: updateInProgress,
    githubRepo: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`,
    githubRawVersionUrl: GITHUB_RAW_VERSION_URL,
  });
});

export default router;
