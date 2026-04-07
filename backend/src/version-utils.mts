import type { IServiceVersion } from "./types.mjs";

/**
 * Parses a version string from LXC notes into service version entries.
 *
 * Formats:
 *   Single-service:  "v4.12.3"         → [{ service: "main", currentVersion: "v4.12.3" }]
 *   Multi-service:   "traefik:v3.6, zitadel:v4.12.3"
 *                    → [{ service: "traefik", currentVersion: "v3.6" }, ...]
 */
export function parseVersionString(
  version: string | undefined,
  ociImage?: string,
): IServiceVersion[] {
  if (!version || !version.trim()) {
    return [];
  }

  const trimmed = version.trim();

  // Multi-service format: contains comma-separated "service:version" pairs
  if (trimmed.includes(",")) {
    return trimmed.split(",").map((part) => {
      const p = part.trim();
      const colonIdx = p.indexOf(":");
      if (colonIdx > 0) {
        return {
          service: p.substring(0, colonIdx).trim(),
          image: "",
          currentVersion: p.substring(colonIdx + 1).trim(),
        };
      }
      // Fallback: no colon in this segment
      return { service: "main", image: "", currentVersion: p };
    });
  }

  // Single entry that may or may not have a colon
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx > 0 && !trimmed.startsWith("v") && !/^\d/.test(trimmed)) {
    // Looks like "service:version" (not "v4.12.3" or "4.12.3")
    return [
      {
        service: trimmed.substring(0, colonIdx).trim(),
        image: "",
        currentVersion: trimmed.substring(colonIdx + 1).trim(),
      },
    ];
  }

  // Plain version string
  return [
    {
      service: "main",
      image: ociImage || "",
      currentVersion: trimmed,
    },
  ];
}

/**
 * Merges image names from a compose file into parsed service versions.
 * composeImages maps service name → full image (e.g. "traefik" → "traefik",
 * "zitadel" → "ghcr.io/zitadel/zitadel").
 */
export function mergeComposeImages(
  services: IServiceVersion[],
  composeImages: Record<string, string>,
): IServiceVersion[] {
  return services.map((svc) => {
    if (svc.image) return svc;
    const img = composeImages[svc.service];
    return img ? { ...svc, image: img } : svc;
  });
}
