import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, "..");

const urls = [
  "https://api-timigogohehe.replit.app/",
  "https://api-keitroyuki.replit.app",
  "https://api-yoichihiro9.replit.app/",
  "https://api-biden2028win.replit.app/",
  "https://api-integrations-chenhongji1218.replit.app"
];

const apiKey = "wei123..";
const backendBuildPath = path.join(WORKSPACE_ROOT, "artifacts/api-server/dist/index.mjs");
const modelsPath = path.join(WORKSPACE_ROOT, "models.json");

async function main() {
  console.log("📦 Step 1: Building backend code locally...");
  try {
    execSync("pnpm --filter @workspace/api-server run build", { cwd: WORKSPACE_ROOT, stdio: "inherit" });
    console.log("✅ Build successful!");
  } catch (err) {
    console.error("❌ Build failed:", err.message);
    process.exit(1);
  }

  console.log("\n📖 Reading compiled files...");
  if (!fs.existsSync(backendBuildPath)) {
    console.error(`❌ Build output not found at: ${backendBuildPath}`);
    process.exit(1);
  }
  const backendContent = fs.readFileSync(backendBuildPath, "utf8");
  const modelsContent = fs.readFileSync(modelsPath, "utf8");

  for (const rawUrl of urls) {
    const baseUrl = rawUrl.replace(/\/+$/, "");
    console.log(`\n🚀 Uploading to: ${baseUrl}`);

    // 1. Upload models.json (no restart)
    try {
      const res = await fetch(`${baseUrl}/api/update/upload-file`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          path: "models.json",
          content: modelsContent,
          restart: false
        })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        console.log("   ✅ models.json uploaded");
      } else {
        console.log(`   ❌ models.json upload failed (${res.status}):`, data);
      }
    } catch (err) {
      console.log(`   ❌ models.json upload error:`, err.message);
    }

    // 2. Upload backend dist/index.mjs (with restart)
    try {
      const res = await fetch(`${baseUrl}/api/update/upload-file`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          path: "artifacts/api-server/dist/index.mjs",
          content: backendContent,
          restart: true
        })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        console.log("   ✅ dist/index.mjs uploaded & restart triggered!");
      } else {
        console.log(`   ❌ dist/index.mjs upload failed (${res.status}):`, data);
      }
    } catch (err) {
      console.log(`   ❌ dist/index.mjs upload error:`, err.message);
    }
  }

  console.log("\n🎉 Hot deployment process finished.");
}

main().catch(console.error);
