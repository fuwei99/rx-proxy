/**
 * cloudPersist.ts
 *
 * Cross-environment JSON persistence helper.
 *
 * - In production (when DEFAULT_OBJECT_STORAGE_BUCKET_ID is set): reads and
 *   writes JSON to GCS via Replit sidecar auth so data survives redeploys.
 * - In local development (no bucket env var): falls back to the local
 *   filesystem so you can iterate without cloud credentials.
 *
 * Dev and prod use separate GCS prefixes to prevent cross-contamination:
 *   prod  → "config/"
 *   dev   → "config_dev/"
 */

import { Storage } from "@google-cloud/storage";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

const BUCKET_ID = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
const IS_PROD = !!process.env.REPLIT_DEPLOYMENT;
const GCS_PREFIX = IS_PROD ? "config/" : "config_dev/";
const LOCAL_DIR = IS_PROD ? "data_prod" : "data_dev";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

let _storage: Storage | null = null;
function getStorage(): Storage {
  if (!_storage) {
    _storage = new Storage({
      credentials: {
        audience: "replit",
        subject_token_type: "access_token",
        token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
        type: "external_account",
        credential_source: {
          url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
          format: {
            type: "json",
            subject_token_field_name: "access_token",
          },
        },
        universe_domain: "googleapis.com",
      } as unknown as { client_email: string; private_key: string },
      projectId: "",
    });
  }
  return _storage;
}

/**
 * Read a JSON config file.  Returns `null` if the file does not exist yet.
 * @param name  Base filename, e.g. "dynamic_backends.json"
 */
export async function readJson<T>(name: string): Promise<T | null> {
  if (BUCKET_ID) {
    try {
      const bucket = getStorage().bucket(BUCKET_ID);
      const file = bucket.file(`${GCS_PREFIX}${name}`);
      const [exists] = await file.exists();
      if (!exists) return null;
      const [contents] = await file.download();
      return JSON.parse(contents.toString("utf8")) as T;
    } catch {
      return null;
    }
  }

  const localPath = resolve(process.cwd(), LOCAL_DIR, name);
  if (!existsSync(localPath)) return null;
  try {
    return JSON.parse(readFileSync(localPath, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Write a JSON config file.
 * @param name  Base filename, e.g. "dynamic_backends.json"
 * @param data  The data to serialise and persist.
 */
export async function writeJson<T>(name: string, data: T): Promise<void> {
  const json = JSON.stringify(data, null, 2);

  if (BUCKET_ID) {
    try {
      const bucket = getStorage().bucket(BUCKET_ID);
      const file = bucket.file(`${GCS_PREFIX}${name}`);
      await file.save(json, { contentType: "application/json" });
    } catch (err) {
      console.error(`[cloudPersist] GCS write failed for ${name}:`, err);
    }
    return;
  }

  const localPath = resolve(process.cwd(), LOCAL_DIR, name);
  mkdirSync(dirname(localPath), { recursive: true });
  writeFileSync(localPath, json, "utf8");
}
