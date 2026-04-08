import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Tests for oci_version_lib.py fallback behavior.
 *
 * Runs the library functions via python3 subprocess with mocked skopeo.
 * Uses a fake skopeo wrapper script to simulate various failure modes.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const LIB_PATH = join(REPO_ROOT, "json/shared/scripts/library/oci_version_lib.py");
const LIB_CONTENT = readFileSync(LIB_PATH, "utf-8");

/** Run a Python snippet with oci_version_lib prepended via stdin. */
function runPython(code: string, env?: Record<string, string>): { stdout: string; stderr: string; exitCode: number } {
  const script = LIB_CONTENT + "\n" + code;
  try {
    const result = execSync("python3", {
      input: script,
      encoding: "utf-8",
      timeout: 15000,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout: result.trim(), stderr: "", exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: (err.stdout ?? "").trim(),
      stderr: (err.stderr ?? "").trim(),
      exitCode: err.status ?? 1,
    };
  }
}

describe("oci_version_lib", () => {
  describe("extract_version_from_labels", () => {
    it("should extract org.opencontainers.image.version", () => {
      const result = runPython(`
labels = {"Labels": {"org.opencontainers.image.version": "17.5"}}
print(extract_version_from_labels(labels))
`);
      expect(result.stdout).toBe("17.5");
    });

    it("should strip leading v from version", () => {
      const result = runPython(`
labels = {"Labels": {"org.opencontainers.image.version": "v2.1.0"}}
print(extract_version_from_labels(labels))
`);
      expect(result.stdout).toBe("2.1.0");
    });

    it("should try io.hass.version as fallback", () => {
      const result = runPython(`
labels = {"Labels": {"io.hass.version": "2024.3.1"}}
print(extract_version_from_labels(labels))
`);
      expect(result.stdout).toBe("2024.3.1");
    });

    it("should return None when no labels", () => {
      const result = runPython(`
print(extract_version_from_labels({"Labels": {}}))
`);
      expect(result.stdout).toBe("None");
    });

    it("should return None when Labels is None", () => {
      const result = runPython(`
print(extract_version_from_labels({}))
`);
      expect(result.stdout).toBe("None");
    });
  });

  describe("_pick_candidate_tags", () => {
    it("should pick numeric version tags sorted descending", () => {
      const result = runPython(`
tags = ["latest", "v14.7", "v14.6", "12.2.8", "alpine", "bullseye", "v9.0.1"]
print(",".join(_pick_candidate_tags(tags, 3)))
`);
      expect(result.stdout).toBe("v14.7,v14.6,12.2.8");
    });

    it("should handle tags with v prefix", () => {
      const result = runPython(`
tags = ["v1.0", "v2.0", "v10.0"]
print(",".join(_pick_candidate_tags(tags, 5)))
`);
      expect(result.stdout).toBe("v10.0,v2.0,v1.0");
    });

    it("should return empty for non-version tags", () => {
      const result = runPython(`
tags = ["latest", "alpine", "bullseye", "slim"]
print(len(_pick_candidate_tags(tags)))
`);
      expect(result.stdout).toBe("0");
    });
  });

  describe("resolve_image_version", () => {
    it("should return tag directly for non-latest tags", () => {
      const result = runPython(`
print(resolve_image_version("postgres:16-alpine"))
`);
      expect(result.stdout).toBe("16-alpine");
    });

    it("should strip v from non-latest tags", () => {
      const result = runPython(`
print(resolve_image_version("postgrest/postgrest:v14.7"))
`);
      expect(result.stdout).toBe("14.7");
    });

    it("should return unknown when skopeo is not available", () => {
      // Override oci_skopeo_inspect to return None (simulates missing/broken skopeo)
      const result = runPython(`
def oci_skopeo_inspect(ref, timeout=30):
    return None

print(resolve_image_version("postgres:latest"))
`);
      expect(result.stdout).toBe("unknown");
    });

    it("should return unknown when skopeo fails (rate limit simulation)", () => {
      // Override oci_skopeo_inspect to simulate failure
      const result = runPython(`
def oci_skopeo_inspect(ref, timeout=30):
    return None  # Simulate rate limit / network error

print(resolve_image_version("postgres:latest"))
`);
      expect(result.stdout).toBe("unknown");
    });

    it("should resolve version from labels when inspect succeeds", () => {
      const result = runPython(`
def oci_skopeo_inspect(ref, timeout=30):
    return {"Labels": {"org.opencontainers.image.version": "17.5"}, "Digest": "sha256:abc"}

print(resolve_image_version("postgres:latest"))
`);
      expect(result.stdout).toBe("17.5");
    });

    it("should fall back to digest matching when no labels", () => {
      const result = runPython(`
_inspect_calls = []
def oci_skopeo_inspect(ref, timeout=30):
    _inspect_calls.append(ref)
    if ":latest" in ref:
        return {"Labels": {}, "Digest": "sha256:matchme"}
    if ":18.3" in ref:
        return {"Digest": "sha256:matchme"}
    return {"Digest": "sha256:nomatch"}

def skopeo_list_tags(repo, timeout=30):
    return ["latest", "18.3", "18.2", "17.5", "alpine"]

version = resolve_image_version("postgres:latest")
print(version)
`);
      expect(result.stdout).toBe("18.3");
    });

    it("should strip v from digest-matched tags", () => {
      const result = runPython(`
def oci_skopeo_inspect(ref, timeout=30):
    if ":latest" in ref:
        return {"Labels": {}, "Digest": "sha256:abc123"}
    if ":v14.7" in ref:
        return {"Digest": "sha256:abc123"}
    return {"Digest": "sha256:other"}

def skopeo_list_tags(repo, timeout=30):
    return ["latest", "v14.7", "v14.6", "v9.0.1"]

print(resolve_image_version("postgrest/postgrest:latest"))
`);
      expect(result.stdout).toBe("14.7");
    });

    it("should return unknown when digest matching finds no match", () => {
      const result = runPython(`
def oci_skopeo_inspect(ref, timeout=30):
    if ":latest" in ref:
        return {"Labels": {}, "Digest": "sha256:unique"}
    return {"Digest": "sha256:different"}

def skopeo_list_tags(repo, timeout=30):
    return ["1.0", "2.0", "3.0"]

print(resolve_image_version("myapp:latest"))
`);
      expect(result.stdout).toBe("unknown");
    });

    it("should handle skopeo_list_tags failure gracefully", () => {
      const result = runPython(`
def oci_skopeo_inspect(ref, timeout=30):
    return {"Labels": {}, "Digest": "sha256:abc"}

def skopeo_list_tags(repo, timeout=30):
    return []  # Simulate failure

print(resolve_image_version("postgres:latest"))
`);
      expect(result.stdout).toBe("unknown");
    });

    it("should check local tags before remote tags", () => {
      const result = runPython(`
checked = []
def oci_skopeo_inspect(ref, timeout=30):
    checked.append(ref)
    if ":latest" in ref:
        return {"Labels": {}, "Digest": "sha256:target"}
    if ":16.5" in ref:
        return {"Digest": "sha256:target"}
    return {"Digest": "sha256:other"}

def skopeo_list_tags(repo, timeout=30):
    raise RuntimeError("should not be called")

version = resolve_image_version("postgres:latest", local_tags=["16.5", "15.3"])
print(version)
# Verify list-tags was not called (local match found first)
`);
      expect(result.stdout).toBe("16.5");
    });
  });

  describe("cache", () => {
    let cacheDir: string;
    let cachePath: string;

    function runWithCache(code: string, cacheContent?: object): { stdout: string; stderr: string; exitCode: number } {
      // Write cache file and override path constants in the library
      cacheDir = join(tmpdir(), `oci-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(cacheDir, { recursive: true });
      cachePath = join(cacheDir, "cache.json");

      if (cacheContent) {
        writeFileSync(cachePath, JSON.stringify(cacheContent));
      }

      // Override cache path so tests don't touch real files
      const patchedCode = `
_TEST_CACHE_PATH = ${JSON.stringify(cachePath)}
_test_cache = None  # Reset lazy cache
${code}`;
      const result = runPython(patchedCode);

      // Cleanup
      try { rmSync(cacheDir, { recursive: true, force: true }); } catch {}
      return result;
    }

    it("should return cached version without calling skopeo (test mode)", () => {
      const result = runWithCache(`
# Verify no skopeo call is made
import subprocess as _sp
_original_run = _sp.run
def _mock_run(*a, **kw):
    raise RuntimeError("skopeo should not be called in test mode")
_sp.run = _mock_run

print(resolve_image_version("postgres:latest"))
`, {
        _meta: { mode: "test" },
        versions: { "postgres:latest": "17.5" },
        inspect: {},
        tags: {},
      });
      expect(result.stdout).toBe("17.5");
    });

    it("should return unknown in test mode when version not cached (no skopeo)", () => {
      const result = runWithCache(`
print(resolve_image_version("unknown-image:latest"))
`, {
        _meta: { mode: "test" },
        versions: {},
        inspect: {},
        tags: {},
      });
      expect(result.stdout).toBe("unknown");
    });

    it("should use cached inspect data in test mode", () => {
      const result = runWithCache(`
data = oci_skopeo_inspect("myapp:latest")
if data:
    print(data.get("Digest", ""))
else:
    print("None")
`, {
        _meta: { mode: "test" },
        versions: {},
        inspect: { "myapp:latest": { Digest: "sha256:cached", Labels: {}, _ts: 0 } },
        tags: {},
      });
      expect(result.stdout).toBe("sha256:cached");
    });

    it("should use cached tags in test mode", () => {
      const result = runWithCache(`
tags = skopeo_list_tags("postgres")
print(",".join(tags))
`, {
        _meta: { mode: "test" },
        versions: {},
        inspect: {},
        tags: { postgres: { tags: ["17.5", "16.4", "15.3"], _ts: 0 } },
      });
      expect(result.stdout).toBe("17.5,16.4,15.3");
    });

    it("should detect test mode correctly", () => {
      const result = runWithCache(`
_load_test_cache()
print(_is_test_mode())
`, {
        _meta: { mode: "test" },
        versions: {},
      });
      expect(result.stdout).toBe("True");
    });

    it("should not be test mode with empty cache", () => {
      const result = runWithCache(`
_load_test_cache()
print(_is_test_mode())
`);
      expect(result.stdout).toBe("False");
    });

    it("should resolve version from labels via cached inspect", () => {
      const result = runWithCache(`
print(resolve_image_version("home-assistant:latest"))
`, {
        _meta: { mode: "test" },
        versions: {},
        inspect: {
          "home-assistant:latest": {
            Labels: { "org.opencontainers.image.version": "2024.3.1" },
            Digest: "sha256:ha",
            _ts: 0,
          },
        },
        tags: {},
      });
      expect(result.stdout).toBe("2024.3.1");
    });

    it("should resolve version via digest matching using cached data", () => {
      const result = runWithCache(`
print(resolve_image_version("postgres:latest"))
`, {
        _meta: { mode: "test" },
        versions: {},
        inspect: {
          "postgres:latest": { Labels: {}, Digest: "sha256:abc", _ts: 0 },
          "postgres:17.5": { Digest: "sha256:abc", _ts: 0 },
          "postgres:16.4": { Digest: "sha256:other", _ts: 0 },
        },
        tags: { postgres: { tags: ["17.5", "16.4", "15.3"], _ts: 0 } },
      });
      expect(result.stdout).toBe("17.5");
    });
  });
});
