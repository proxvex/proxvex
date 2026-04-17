import type { IResourceRepository } from "./persistence/repositories.mjs";

export interface VersionEntry {
  variable: string;
  defaultTag: string;
  imageUrl: string | undefined;
}

/**
 * Parses versions.sh library to extract version tag definitions.
 *
 * Format expected:
 *   DOCKER_zitadel_TAG="${DOCKER_zitadel_TAG:-v4.12.3}"  # ghcr.io/zitadel/zitadel
 *   OCI_postgres_TAG="${OCI_postgres_TAG:-16-alpine}"     # postgres
 */
export function parseVersionsLib(
  repos: IResourceRepository,
): Map<string, VersionEntry> {
  const result = new Map<string, VersionEntry>();

  // Load base versions.sh
  const content = repos.getScript({
    name: "versions.sh",
    scope: "shared",
    category: "library",
  });
  if (content) {
    for (const [k, v] of parseVersionsContent(content)) {
      result.set(k, v);
    }
  }

  // Merge local overrides from versions-local.sh (may override defaults)
  const localContent = repos.getScript({
    name: "versions-local.sh",
    scope: "shared",
    category: "library",
  });
  if (localContent) {
    for (const [k, v] of parseVersionsContent(localContent)) {
      result.set(k, v);
    }
  }

  return result;
}

/**
 * Parses versions.sh content string.
 */
export function parseVersionsContent(content: string): Map<string, VersionEntry> {
  const result = new Map<string, VersionEntry>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Match: VAR_TAG="${VAR_TAG:-default}"  # optional-image-url
    const fallbackMatch = trimmed.match(
      /^((?:DOCKER|OCI)_\w+_TAG)="\$\{\1:-([^}]+)\}"(?:\s+#\s*(.+))?$/,
    );
    if (fallbackMatch) {
      result.set(fallbackMatch[1]!, {
        variable: fallbackMatch[1]!,
        defaultTag: fallbackMatch[2]!,
        imageUrl: fallbackMatch[3]?.trim(),
      });
      continue;
    }

    // Match simple assignment: VAR_TAG="value"  # optional-image-url
    const simpleMatch = trimmed.match(
      /^((?:DOCKER|OCI)_\w+_TAG)="([^"]*)"(?:\s+#\s*(.+))?$/,
    );
    if (simpleMatch) {
      result.set(simpleMatch[1]!, {
        variable: simpleMatch[1]!,
        defaultTag: simpleMatch[2]!,
        imageUrl: simpleMatch[3]?.trim(),
      });
    }
  }
  return result;
}

/**
 * Gets the OCI image tag for an application from versions.sh.
 * Looks up OCI_<appId>_TAG (with hyphens replaced by underscores).
 */
export function getOciImageTag(
  versions: Map<string, VersionEntry>,
  appId: string,
): string | undefined {
  const varName = `OCI_${appId.replace(/-/g, "_")}_TAG`;
  return versions.get(varName)?.defaultTag;
}
