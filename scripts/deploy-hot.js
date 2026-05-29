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

async function main() {
  const targetFilter = process.argv[2];
  const targetUrls = targetFilter
    ? urls.filter((u) => u.toLowerCase().includes(targetFilter.toLowerCase()))
    : urls;

  if (targetUrls.length === 0) {
    console.error(`❌ No matching URLs found in configuration for filter: "${targetFilter}"`);
    console.log("Configured URLs:", urls);
    process.exit(1);
  }

  console.log("📦 Step 1: Building backend code locally...");
  try {
    execSync("pnpm --filter @workspace/api-server run build", { cwd: WORKSPACE_ROOT, stdio: "inherit" });
    console.log("✅ Build successful!");
  } catch (err) {
    console.error("❌ Build failed:", err.message);
    process.exit(1);
  }

  // Files to upload
  const filesToUpload = [
    { path: "models.json", restart: false },
    { path: "artifacts/api-server/src/routes/health.ts", restart: false },
    { path: "artifacts/api-server/src/routes/update.ts", restart: false },
    { path: "artifacts/api-server/dist/index.mjs", restart: true } // Restart on the last file
  ];

  for (const rawUrl of targetUrls) {
    const baseUrl = rawUrl.replace(/\/+$/, "");
    console.log(`\n🚀 Uploading files to: ${baseUrl}`);

    for (const file of filesToUpload) {
      const fullPath = path.join(WORKSPACE_ROOT, file.path);
      if (!fs.existsSync(fullPath)) {
        console.warn(`   ⚠️ File not found, skipping: ${file.path}`);
        continue;
      }
      
      const content = fs.readFileSync(fullPath, "utf8");
      try {
        const res = await fetch(`${baseUrl}/api/update/upload-file`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            path: file.path,
            content: content,
            restart: file.restart
          })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          console.log(`   ✅ ${file.path} uploaded${file.restart ? " (restart triggered)" : ""}`);
        } else {
          console.log(`   ❌ ${file.path} upload failed (${res.status}):`, data);
        }
      } catch (err) {
        console.log(`   ❌ ${file.path} upload error:`, err.message);
      }
    }
  }

  console.log("\n🎉 Hot deployment process finished.");
}

main().catch(console.error);
