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

function getFilesRecursively(dir, relativeTo) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getFilesRecursively(filePath, relativeTo));
    } else {
      results.push(path.relative(relativeTo, filePath).replace(/\\/g, "/"));
    }
  }
  return results;
}

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
    console.log("✅ Backend build successful!");
  } catch (err) {
    console.error("❌ Backend build failed:", err.message);
    process.exit(1);
  }

  console.log("\n📦 Step 2: Building frontend (dashboard) locally...");
  try {
    execSync("pnpm --filter @workspace/api-portal run build", { cwd: WORKSPACE_ROOT, stdio: "inherit" });
    console.log("✅ Frontend build successful!");
  } catch (err) {
    console.error("❌ Frontend build failed:", err.message);
    process.exit(1);
  }

  // Dynamically collect files to upload
  const filesToUpload = [];

  // 1. Config and modified source files
  filesToUpload.push({ path: "models.json", restart: false });
  filesToUpload.push({ path: "artifacts/api-server/src/routes/health.ts", restart: false });
  filesToUpload.push({ path: "artifacts/api-server/src/routes/update.ts", restart: false });
  filesToUpload.push({ path: "artifacts/api-server/src/index.ts", restart: false });

  // 2. Scan and add all backend dist files (excluding index.mjs which we want to upload last to restart)
  const backendDistDir = path.join(WORKSPACE_ROOT, "artifacts/api-server/dist");
  const backendDistFiles = getFilesRecursively(backendDistDir, WORKSPACE_ROOT);
  
  const indexMjsRel = "artifacts/api-server/dist/index.mjs";
  for (const rel of backendDistFiles) {
    if (rel !== indexMjsRel) {
      filesToUpload.push({ path: rel, restart: false });
    }
  }

  // 3. Scan and add all frontend built static files
  const frontendDistDir = path.join(WORKSPACE_ROOT, "artifacts/api-portal/dist/public");
  const frontendDistFiles = getFilesRecursively(frontendDistDir, WORKSPACE_ROOT);
  for (const rel of frontendDistFiles) {
    filesToUpload.push({ path: rel, restart: false });
  }

  // 4. Finally, add the backend main entrypoint index.mjs to trigger restart
  if (fs.existsSync(path.join(WORKSPACE_ROOT, indexMjsRel))) {
    filesToUpload.push({ path: indexMjsRel, restart: true });
  }

  console.log(`\n📋 Prepared ${filesToUpload.length} files for deployment.`);

  for (const rawUrl of targetUrls) {
    const baseUrl = rawUrl.replace(/\/+$/, "");
    console.log(`\n🚀 Uploading files to: ${baseUrl}`);

    for (const file of filesToUpload) {
      const fullPath = path.join(WORKSPACE_ROOT, file.path);
      if (!fs.existsSync(fullPath)) {
        console.warn(`   ⚠️ File not found, skipping: ${file.path}`);
        continue;
      }

      // Read as base64 to handle both binary and text assets safely
      const content = fs.readFileSync(fullPath).toString("base64");
      
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
            encoding: "base64",
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
