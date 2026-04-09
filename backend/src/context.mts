import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdirSync } from "fs";
import { createLogger } from "./logger/index.mjs";

const logger = createLogger("context");

export class Context {
  private context: Record<string, any> = {};
  private secretFilePath: string;
  private storageContextFilePath: string; // path to the storage context file (storagecontext.json) that contains the context for the storage context (e.g. vm, ve, etc.) of the application
  constructor(storageContextFilePath: string, secretFilePath: string) {
    this.storageContextFilePath = storageContextFilePath;
    this.secretFilePath = secretFilePath;
    this.readContextFromFile();
  }
  private readContextFromFile(): void {
    try {
      const raw = readFileSync(this.storageContextFilePath, "utf-8");
      const jsonText = raw.startsWith("enc:") ? this.decrypt(raw) : raw;
      this.context = JSON.parse(jsonText);
    } catch {
      logger.info("No context file found, creating empty context");
      this.context = {};
      this.writeAll();
    }
  }
  set(key: string, value: any): void {
    this.context[key] = value;
    this.writeAll();
  }

  get<T = any>(key: string): T | undefined {
    return this.context[key];
  }

  has(key: string): boolean {
    return key in this.context;
  }

  remove(key: string): void {
    delete this.context[key];
    // Persist removal to disk to ensure deletions survive reloads
    this.writeAll();
  }

  clear(): void {
    this.context = {};
    this.writeAll();
  }

  keys(): string[] {
    return Object.keys(this.context);
  }
  /**
   * Read all context entries with the given prefix and instantiate them with the given class
   * @param ctxPrefix
   * @param Clazz
   */
  protected loadContexts<C extends new (data: any) => any>(
    ctxPrefix: string,
    Clazz: C,
  ) {
    // Iterate directly over context keys instead of cloning
    // This avoids DataCloneError when context contains non-serializable objects
    // Context is loaded from JSON file, so values are plain objects
    for (const key of Object.keys(this.context)) {
      if (!key.startsWith(ctxPrefix + "_")) {
        continue;
      }
      const value = this.context[key];
      // Only process plain objects (not already instantiated classes)
      // Values from JSON file are always plain objects
      if (value && typeof value === "object" && value.constructor === Object) {
        const instance = new Clazz(value);
        // Do not persist here; only populate in-memory cache
        this.context[key] = instance;
      }
    }
  }

  // ===== Encryption / Decryption helpers (used by StorageContext and consumers) =====
  private getSecretFilePath(): string {
    return this.secretFilePath;
  }

  private readOrCreateSecret(): Buffer {
    const secretPath = this.getSecretFilePath();
    try {
      if (existsSync(secretPath)) {
        const raw = readFileSync(secretPath, "utf-8").trim();
        if (raw) {
          try {
            return Buffer.from(raw, "base64");
          } catch {}
        }
      }
    } catch {}
    const key = randomBytes(32);
    try {
      // Ensure base directory exists before writing the secret file
      const secretDir = path.dirname(secretPath);
      if (!existsSync(secretDir)) {
        mkdirSync(secretDir, { recursive: true });
      }
      writeFileSync(secretPath, key.toString("base64"), "utf-8");
    } catch {}
    return key;
  }

  encrypt(plainText: string): string {
    const key = this.readOrCreateSecret();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([
      cipher.update(plainText, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const packed = Buffer.concat([iv, tag, enc]).toString("base64");
    return `enc:${packed}`;
  }

  decrypt(encText: string): string {
    try {
      const pref = encText.startsWith("enc:") ? encText.slice(4) : encText;
      const buf = Buffer.from(pref, "base64");
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(12, 28);
      const data = buf.subarray(28);
      const key = this.readOrCreateSecret();
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      const dec = Buffer.concat([decipher.update(data), decipher.final()]);
      return dec.toString("utf8");
    } catch (err: any) {
      throw new Error(`Failed to decrypt data: ${err?.message || String(err)}`);
    }
  }

  isEncrypted(val: unknown): boolean {
    return typeof val === "string" && val.startsWith("enc:");
  }

  decryptIfEncrypted<T = unknown>(val: T): T | string {
    if (typeof val === "string" && this.isEncrypted(val)) {
      try {
        return this.decrypt(val);
      } catch (err: any) {
        throw new Error(
          `Failed to decrypt encrypted value: ${err?.message || String(err)}`,
        );
      }
    }
    return val;
  }

  private sanitizeForWrite(obj: any): any {
    // No per-field encryption anymore; entire file is encrypted by writeAll
    const transform = (val: any): any => {
      if (Array.isArray(val)) return val.map(transform);
      if (val && typeof val === "object") {
        const out: any = {};
        for (const [k, v] of Object.entries(val)) out[k] = transform(v);
        return out;
      }
      return val;
    };
    return transform(obj);
  }

  private sanitizeForRead(obj: any): any {
    // No per-field decryption anymore; entire file is decrypted in constructor
    const transform = (val: any): any => {
      if (Array.isArray(val)) return val.map(transform);
      if (val && typeof val === "object") {
        const out: any = {};
        for (const [k, v] of Object.entries(val)) out[k] = transform(v);
        return out;
      }
      return val;
    };
    return transform(obj);
  }

  private writeAll(): void {
    try {
      const json = JSON.stringify(this.context, null, 2);
      const out = process.env.DEPLOYER_PLAINTEXT_CONTEXT === "1" ? json : this.encrypt(json);
      writeFileSync(this.storageContextFilePath, out, "utf-8");
    } catch (err) {
      logger.error("Failed to write context", { error: err });
    }
  }
}
