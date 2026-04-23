import { Injectable } from '@angular/core';
import * as yaml from 'js-yaml';
import { IComposeWarning } from '../../../shared/types-frontend';

export interface ComposeService {
  name: string;
  config: Record<string, unknown>;
}

export interface ComposeProperties {
  services?: string;
  ports?: string;
  images?: string;
  networks?: string;
  volumes?: string;
  command?: string;
  user?: string;
}

export interface ParsedComposeData {
  composeData: Record<string, unknown>;
  services: ComposeService[];
  properties: ComposeProperties;
  environmentVariables: string[];
  environmentVariablesRequired?: string[];
  serviceEnvironmentVariables?: Record<string, string[]>;
  serviceEnvironmentVariablesRequired?: Record<string, string[]>;
  environmentVariableDefaults?: Record<string, string>;
  serviceEnvironmentVariableDefaults?: Record<string, Record<string, string>>;
  description?: string;
  volumes?: string[];
  envs?: string[]; // NEW: Environment variables in KEY=value format
}

@Injectable({
  providedIn: 'root'
})
export class DockerComposeService {

  private stripQuotes(value: string): string {
    return value.trim().replace(/^"|"$/g, '').replace(/^'|'$/g, '');
  }
  
  private isProbablyBase64(value: string): boolean {
    const s = value.trim();
    if (!s) return false;
    if (/[\r\n\t ]/.test(s)) return false;
    if (s.length % 4 !== 0) return false;
    return /^[A-Za-z0-9+/]+={0,2}$/.test(s);
  }

  public extractVarRefsFromString(value: string): { vars: string[]; defaults: Record<string, string>; required: string[] } {
    const vars = new Set<string>();
    const defaults: Record<string, string> = {};
    const required = new Set<string>();

    // ${VAR} / ${VAR:-default} / ${VAR-default}
    const braceRe = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(?::-|-)([^}]*))?\}/g;
    let m: RegExpExecArray | null;
    while ((m = braceRe.exec(value)) !== null) {
      const name = m[1];
      vars.add(name);
      const def = m[2];
      if (typeof def === 'string' && def.trim() !== '') {
        defaults[name] = this.stripQuotes(def);
      } else {
        required.add(name);
      }
    }

    // $VAR
    const dollarRe = /\$([A-Za-z_][A-Za-z0-9_]*)/g;
    while ((m = dollarRe.exec(value)) !== null) {
      vars.add(m[1]);
      required.add(m[1]);
    }

    return { vars: Array.from(vars), defaults, required: Array.from(required) };
  }

  /**
   * Resolve variables in a string using provided env values and defaults.
   * ${VAR:-default} -> uses env value if set, otherwise default
   * ${VAR} or $VAR -> uses env value if set, otherwise empty string
   */
  public resolveVariables(value: string, envValues = new Map<string, string>()): string {
    let result = value;

    // First resolve ${VAR:-default} and ${VAR-default} patterns
    result = result.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, varName, defaultValue) => {
      if (envValues.has(varName) && envValues.get(varName)) {
        return envValues.get(varName)!;
      }
      return defaultValue !== undefined ? this.stripQuotes(defaultValue) : '';
    });

    // Also handle ${VAR-default} (without colon - only uses default if var is unset)
    result = result.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)-([^}]*)\}/g, (_match, varName, defaultValue) => {
      if (envValues.has(varName)) {
        return envValues.get(varName)!;
      }
      return this.stripQuotes(defaultValue);
    });

    // Then resolve $VAR patterns (simple variable references)
    result = result.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, varName) => {
      return envValues.get(varName) || '';
    });

    return result;
  }
  
  private base64ToUtf8(base64: string): string {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }

  private utf8ToBase64(text: string): string {
    const bytes = new TextEncoder().encode(text);
    const chunkSize = 0x8000;
    let bin = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      bin += String.fromCharCode(...chunk);
    }
    return btoa(bin);
  }

  // ==================== Marker Functions ====================

  /**
   * Checks if a string contains {{ }} markers
   */
  hasMarkers(value: string): boolean {
    return typeof value === 'string' && /\{\{.*?\}\}/.test(value);
  }

  /**
   * Extracts marker names from a string (e.g., {{ POSTGRES_PASSWORD }} -> POSTGRES_PASSWORD)
   */
  extractMarkers(value: string): string[] {
    if (typeof value !== 'string') return [];
    const matches = value.match(/\{\{\s*(\w+)\s*\}\}/g) || [];
    return [...new Set(matches.map(m => m.replace(/\{\{\s*|\s*\}\}/g, '')))];
  }

  /**
   * Replaces {{ MARKER }} placeholders with values from the map
   */
  replaceMarkers(template: string, values: Map<string, string>): string {
    if (typeof template !== 'string') return template;
    let result = template;
    for (const [key, value] of values) {
      const regex = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
      result = result.replace(regex, value);
    }
    return result;
  }

  /**
   * Decodes a base64-encoded value (with optional file metadata format)
   * Returns null if decoding fails
   */
  decodeBase64Value(value: string): string | null {
    if (!value || typeof value !== 'string') return null;
    try {
      // Extract base64 content if value has file metadata format: file:filename:content:base64content
      const match = value.match(/^file:[^:]+:content:(.+)$/);
      const base64 = match ? match[1] : value;
      return this.base64ToUtf8(base64);
    } catch {
      return null;
    }
  }

  /**
   * Encodes a string to base64 with file metadata format
   */
  encodeToBase64WithMetadata(content: string, filename: string): string {
    const base64 = this.utf8ToBase64(content);
    return `file:${filename}:content:${base64}`;
  }

  /**
   * Checks if a base64-encoded value contains {{ }} markers
   */
  hasMarkersInBase64(value: string): boolean {
    const decoded = this.decodeBase64Value(value);
    return decoded !== null && this.hasMarkers(decoded);
  }

  /**
   * Extracts marker names from a base64-encoded value
   */
  extractMarkersFromBase64(value: string): string[] {
    const decoded = this.decodeBase64Value(value);
    return decoded ? this.extractMarkers(decoded) : [];
  }

  /**
   * Replaces markers in a base64-encoded value and returns the new base64 value
   */
  replaceMarkersInBase64(base64Value: string, values: Map<string, string>): string {
    const decoded = this.decodeBase64Value(base64Value);
    if (!decoded) return base64Value;

    const replaced = this.replaceMarkers(decoded, values);

    // Preserve original filename if present
    const filenameMatch = base64Value.match(/^file:([^:]+):content:/);
    const filename = filenameMatch ? filenameMatch[1] : '.env';

    return this.encodeToBase64WithMetadata(replaced, filename);
  }

  // ==================== End Marker Functions ====================

  private stripInlineCommentOutsideQuotes(s: string): string {
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "'" && !inDouble) inSingle = !inSingle;
      else if (ch === '"' && !inSingle) inDouble = !inDouble;
      else if (ch === '#' && !inSingle && !inDouble) {
        return s.substring(0, i).trimEnd();
      }
    }
    return s;
  }

  /**
   * Parse docker-compose.yml content from base64
   */
  parseComposeFile(base64OrValue: string): ParsedComposeData | null {
    try {
      // Extract base64 content if value has file metadata format
      const base64 = base64OrValue.match(/^file:[^:]+:content:(.+)$/)?.[1];
      let text: string;

      if (base64) {
        text = this.base64ToUtf8(base64);
      } else {
        // If it's likely base64, decode; otherwise accept YAML as-is
        if (this.isProbablyBase64(base64OrValue)) {
          text = this.base64ToUtf8(base64OrValue);
        } else {
          text = base64OrValue;
        }
      }
      const composeData = yaml.load(text) as Record<string, unknown>;
      
      if (!composeData) {
        return null;
      }
      
      const services = (composeData['services'] as Record<string, unknown>) || {};
      const serviceList: ComposeService[] = Object.entries(services).map(([name, config]) => ({
        name,
        config: config as Record<string, unknown>
      }));
      
      const properties = this.extractComposeProperties(composeData, services);
      const environmentVariables = this.extractEnvironmentVariables(composeData, services);
      const environmentVariablesRequired = this.extractRequiredEnvironmentVariables(composeData, services);

      const serviceEnvironmentVariables: Record<string, string[]> = {};
      const serviceEnvironmentVariablesRequired: Record<string, string[]> = {};
      const serviceEnvironmentVariableDefaults: Record<string, Record<string, string>> = {};
      for (const svc of serviceList) {
        serviceEnvironmentVariables[svc.name] = this.extractServiceEnvironmentVariables(svc.config);
        serviceEnvironmentVariablesRequired[svc.name] = this.extractServiceRequiredEnvironmentVariables(svc.config);
        serviceEnvironmentVariableDefaults[svc.name] = this.extractServiceEnvironmentVariableDefaults(svc.config);
      }

      const environmentVariableDefaults = this.extractGlobalDefaults(serviceEnvironmentVariableDefaults);
      
      const volumes: string[] = [];
      const envs: string[] = [];

      if (services && typeof services === 'object') {
        // Extract volumes and environment variables from all services
        for (const [, serviceConfig] of Object.entries(services)) {
          if (!serviceConfig || typeof serviceConfig !== 'object') continue;

          const serviceRecord = serviceConfig as Record<string, unknown>;
          
          // Extract volumes
          const svcVolumes = serviceRecord['volumes'];
          if (Array.isArray(svcVolumes)) {
            volumes.push(...svcVolumes.map(v => {
              const str = String(v);
              // Strip leading ./ from source path (common in docker-compose)
              // ./data:/var/lib/postgresql/data -> data:/var/lib/postgresql/data
              if (str.startsWith('./')) {
                return str.substring(2);
              }
              return str;
            }));
          }

          // Extract environment variables
          const environment = serviceRecord['environment'];
          if (environment) {
            if (Array.isArray(environment)) {
              for (const envEntry of environment) {
                if (typeof envEntry === 'string') {
                  envs.push(envEntry);
                }
              }
            } else if (typeof environment === 'object') {
              for (const [key, value] of Object.entries(environment as Record<string, unknown>)) {
                envs.push(`${key}=${value ?? ''}`);
              }
            }
          }
        }
      }

      return {
        composeData,
        services: serviceList,
        properties,
        environmentVariables,
        environmentVariablesRequired,
        serviceEnvironmentVariables,
        serviceEnvironmentVariablesRequired,
        environmentVariableDefaults,
        serviceEnvironmentVariableDefaults,
        volumes: [...new Set(volumes)],
        envs: [...new Set(envs)],
      };
    } catch (error) {
      console.error('Failed to parse docker-compose.yml:', error);
      return null;
    }
  }
  
  /**
   * Extract environment variables for a specific service
   */
  extractServiceEnvironmentVariables(serviceConfig: Record<string, unknown>): string[] {
    const envVars = new Set<string>();
    
    // Extract variable references from all string values
    const extractVarRefs = (obj: unknown): void => {
      if (typeof obj === 'string') {
        const { vars } = this.extractVarRefsFromString(obj);
        for (const v of vars) envVars.add(v);
      } else if (Array.isArray(obj)) {
        for (const item of obj) {
          extractVarRefs(item);
        }
      } else if (obj && typeof obj === 'object') {
        for (const value of Object.values(obj as Record<string, unknown>)) {
          extractVarRefs(value);
        }
      }
    };
    
    // Direct environment variables
    const environment = serviceConfig['environment'];
    if (environment) {
      if (Array.isArray(environment)) {
        // Format: ["KEY=value", "KEY2=value2"]
        for (const envEntry of environment) {
          if (typeof envEntry === 'string') {
            const equalIndex = envEntry.indexOf('=');
            if (equalIndex > 0) {
              const key = envEntry.substring(0, equalIndex).trim();
              envVars.add(key);
            }
          }
        }
      } else if (typeof environment === 'object') {
        // Format: { KEY: value, KEY2: value2 }
        for (const key of Object.keys(environment as Record<string, unknown>)) {
          envVars.add(key);
        }
      }
    }
    
    // Extract from all service properties
    extractVarRefs(serviceConfig);
    
    return Array.from(envVars).sort();
  }

  extractServiceEnvironmentVariableDefaults(serviceConfig: Record<string, unknown>): Record<string, string> {
    const defaults: Record<string, string> = {};

    const extractDefaults = (obj: unknown): void => {
      if (typeof obj === 'string') {
        const { defaults: d } = this.extractVarRefsFromString(obj);
        for (const [k, v] of Object.entries(d)) {
          if (!(k in defaults)) {
            defaults[k] = v;
          }
        }
      } else if (Array.isArray(obj)) {
        for (const item of obj) extractDefaults(item);
      } else if (obj && typeof obj === 'object') {
        for (const value of Object.values(obj as Record<string, unknown>)) extractDefaults(value);
      }
    };

    extractDefaults(serviceConfig);
    return defaults;
  }

  private extractGlobalDefaults(perService: Record<string, Record<string, string>>): Record<string, string> {
    const agg = new Map<string, Set<string>>();
    for (const defaults of Object.values(perService)) {
      for (const [k, v] of Object.entries(defaults)) {
        const set = agg.get(k) ?? new Set<string>();
        set.add(v);
        agg.set(k, set);
      }
    }

    const result: Record<string, string> = {};
    for (const [k, set] of agg.entries()) {
      if (set.size === 1) {
        result[k] = Array.from(set)[0];
      }
    }
    return result;
  }

  private collectDefaultValuesAllServices(data: ParsedComposeData): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    const perService = data.serviceEnvironmentVariableDefaults ?? {};
    for (const defaults of Object.values(perService)) {
      for (const [k, v] of Object.entries(defaults)) {
        const set = result.get(k) ?? new Set<string>();
        set.add(v);
        result.set(k, set);
      }
    }
    return result;
  }

  private collectDefaultValuesForService(data: ParsedComposeData, serviceName: string): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    const defaults = data.serviceEnvironmentVariableDefaults?.[serviceName] ?? {};
    for (const [k, v] of Object.entries(defaults)) {
      result.set(k, new Set<string>([v]));
    }
    return result;
  }

  filterEnvVarsEqualToComposeDefaults(
    envVars: Map<string, string>,
    data: ParsedComposeData,
    scope: 'all' | 'service' = 'all',
    selectedServiceName = ''
  ): Map<string, string> {
    const defaultsByKey =
      scope === 'service'
        ? this.collectDefaultValuesForService(data, selectedServiceName || data.services?.[0]?.name || '')
        : this.collectDefaultValuesAllServices(data);

    if (defaultsByKey.size === 0) {
      return new Map(envVars);
    }

    const filtered = new Map<string, string>();
    for (const [k, v] of envVars.entries()) {
      const defaults = defaultsByKey.get(k);
      if (defaults && defaults.has(v)) {
        continue;
      }
      filtered.set(k, v);
    }
    return filtered;
  }
  
  /**
   * Extract volumes for a specific service
   */
  extractServiceVolumes(serviceConfig: Record<string, unknown>, composeData: Record<string, unknown>): string[] {
    const volumesList: string[] = [];
    const volumeNames = new Set<string>();
    
    const volumes = serviceConfig['volumes'];
    if (volumes && Array.isArray(volumes)) {
      for (const volumeSpec of volumes) {
        if (typeof volumeSpec !== 'string') {
          continue;
        }
        
        // Parse volume specification: "host_path:container_path" or "host_path:container_path:ro"
        const parts = volumeSpec.split(':');
        if (parts.length < 2) {
          continue;
        }
        
        const hostPath = parts[0];
        const containerPath = parts[1];
        
        // Skip if it's a named volume reference (no slash in host_path)
        if (hostPath && !hostPath.includes('/') && hostPath !== '' && hostPath !== '.') {
          // Check if it's defined in top-level volumes section
          const topLevelVolumes = composeData['volumes'];
          if (topLevelVolumes && typeof topLevelVolumes === 'object' && hostPath in topLevelVolumes) {
            // Named volume - create path under volumes/<project>/<volume-name>
            const volumeKey = hostPath;
            volumeNames.add(volumeKey);
            const containerPathNormalized = containerPath.replace(/^\//, '');
            volumesList.push(`${volumeKey}=${containerPathNormalized}`);
          } else {
            // Unknown named volume, create default path
            const volumeKey = hostPath;
            volumeNames.add(volumeKey);
            const containerPathNormalized = containerPath.replace(/^\//, '');
            volumesList.push(`${volumeKey}=${containerPathNormalized}`);
          }
        } else if (hostPath.startsWith('./')) {
          // Relative path - convert to volumes/<project>/<name>
          // ./data -> volumes/<project>/data
          let relativeName = hostPath.substring(2).replace(/\/$/, '');
          if (!relativeName) {
            relativeName = 'data';
          }
          // Keep directory structure but use as volume key
          const volumeKey = relativeName.replace(/\//g, '_');
          const containerPathNormalized = containerPath.replace(/^\//, '');
          volumesList.push(`${volumeKey}=${containerPathNormalized}`);
        } else if (hostPath.startsWith('/')) {
          // Absolute path - use last component as key
          const pathParts = hostPath.split('/');
          const volumeKey = pathParts[pathParts.length - 1] || 'data';
          const containerPathNormalized = containerPath.replace(/^\//, '');
          volumesList.push(`${volumeKey}=${containerPathNormalized}`);
        } else {
          // Other format, try to use as-is
          const volumeKey = hostPath.replace(/\//g, '_').replace(/\./g, '_') || 'data';
          const containerPathNormalized = containerPath.replace(/^\//, '');
          volumesList.push(`${volumeKey}=${containerPathNormalized}`);
        }
      }
    }
    
    // Remove duplicates while preserving order
    const seen = new Set<string>();
    const uniqueVolumes: string[] = [];
    for (const vol of volumesList) {
      const key = vol.split('=')[0];
      if (!seen.has(key)) {
        seen.add(key);
        uniqueVolumes.push(vol);
      }
    }
    
    return uniqueVolumes;
  }
  
  /**
   * Parse .env file content from base64
   */
  parseEnvFile(base64OrValue: string): Map<string, string> {
    try {
      const base64 = base64OrValue.match(/^file:[^:]+:content:(.+)$/)?.[1];

      if (base64) {
        const text = this.base64ToUtf8(base64);
        return this.parseEnvFileText(text);
      }

      if (this.isProbablyBase64(base64OrValue)) {
        const text = this.base64ToUtf8(base64OrValue);
        return this.parseEnvFileText(text);
      }

      const looksLikeEnv = /(^|\n)\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(base64OrValue);
      if (looksLikeEnv) {
        return this.parseEnvFileText(base64OrValue);
      }

      const text = this.base64ToUtf8(base64OrValue);
      return this.parseEnvFileText(text);
    } catch (error) {
      console.error('Failed to parse .env file:', error);
      return new Map();
    }
  }
  
  /**
   * Parse .env file text content
   */
  parseEnvFileText(content: string): Map<string, string> {
    const envVars = new Map<string, string>();
    const lines = content.split(/\r?\n/);

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith('#')) continue;

      const withoutComment = this.stripInlineCommentOutsideQuotes(trimmedLine);
      if (!withoutComment) continue;

      const equalIndex = withoutComment.indexOf('=');
      if (equalIndex > 0) {
        let key = withoutComment.substring(0, equalIndex).trim();
        if (key.startsWith('export ')) key = key.substring('export '.length).trim();

        const rawValue = withoutComment.substring(equalIndex + 1).trim();
        const unquotedValue = rawValue.replace(/^["']|["']$/g, '');
        envVars.set(key, unquotedValue);
      }
    }

    return envVars;
  }
  
  /**
   * Generate .env file content from environment variables map
   */
  generateEnvFile(envVars: Map<string, string>): string {
    const lines: string[] = [];
    for (const [key, value] of Array.from(envVars.entries()).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`${key}=${value}`);
    }
    return lines.join('\n');
  }
  
  /**
   * Convert .env file content to base64 with metadata
   */
  envFileToBase64WithMetadata(content: string, filename = '.env'): string {
    const base64 = this.utf8ToBase64(content);
    return `file:${filename}:content:${base64}`;
  }
  
  private extractComposeProperties(composeData: Record<string, unknown>, services: Record<string, unknown>): ComposeProperties {
    const properties: ComposeProperties = {};
    
    const serviceNames = Object.keys(services);
    if (serviceNames.length > 0) {
      properties.services = serviceNames.join(', ');
    }
    
      const portMappings: string[] = [];
      for (const [serviceName, serviceConfig] of Object.entries(services)) {
        const service = serviceConfig as Record<string, unknown>;
      const ports = service['ports'];
      if (ports && Array.isArray(ports)) {
        for (const portSpec of ports) {
          if (typeof portSpec === 'string') {
            const parts = portSpec.split(':');
            if (parts.length >= 2) {
              const containerPort = parts[parts.length - 1].split('/')[0];
              const hostPort = parts.length > 1 ? parts[parts.length - 2] : parts[0];
              portMappings.push(`${serviceName}:${hostPort}->${containerPort}`);
            }
          } else if (typeof portSpec === 'object' && portSpec.published && portSpec.target) {
            portMappings.push(`${serviceName}:${portSpec.published}->${portSpec.target}`);
          }
        }
      }
    }
    if (portMappings.length > 0) {
      properties.ports = portMappings.join('\n');
    }
    
      const imageTags: string[] = [];
      for (const [serviceName, serviceConfig] of Object.entries(services)) {
        const service = serviceConfig as Record<string, unknown>;
        const image = service['image'];
        if (image && typeof image === 'string') {
          const tag = image.includes(':') ? image.split(':')[1] : 'latest';
          imageTags.push(`${serviceName}:${tag}`);
        }
      }
    if (imageTags.length > 0) {
      properties.images = imageTags.join('\n');
    }
    
    const networks = composeData['networks'];
    if (networks && typeof networks === 'object') {
      const networkKeys = Object.keys(networks);
      if (networkKeys.length > 0) {
        properties.networks = networkKeys.join(', ');
      }
    }
    
    // Extract volumes from all services
    const volumesList: string[] = [];
    const volumeNames = new Set<string>();
    
    for (const [, serviceConfig] of Object.entries(services)) {
      const service = serviceConfig as Record<string, unknown>;
      const serviceVolumes = service['volumes'];
      if (serviceVolumes && Array.isArray(serviceVolumes)) {
        for (const volumeSpec of serviceVolumes) {
          if (typeof volumeSpec !== 'string') {
            continue;
          }
          
          const parts = volumeSpec.split(':');
          if (parts.length < 2) {
            continue;
          }
          
          const hostPath = parts[0];
          const containerPath = parts[1];
          
          if (hostPath && !hostPath.includes('/') && hostPath !== '' && hostPath !== '.') {
            const topLevelVolumes = composeData['volumes'];
            if (topLevelVolumes && typeof topLevelVolumes === 'object' && hostPath in topLevelVolumes) {
              const volumeKey = hostPath;
              volumeNames.add(volumeKey);
              const containerPathNormalized = containerPath.replace(/^\//, '');
              volumesList.push(`${volumeKey}=${containerPathNormalized}`);
            } else {
              const volumeKey = hostPath;
              volumeNames.add(volumeKey);
              const containerPathNormalized = containerPath.replace(/^\//, '');
              volumesList.push(`${volumeKey}=${containerPathNormalized}`);
            }
          } else if (hostPath.startsWith('./')) {
            let relativeName = hostPath.substring(2).replace(/\/$/, '');
            if (!relativeName) {
              relativeName = 'data';
            }
            const volumeKey = relativeName.replace(/\//g, '_');
            const containerPathNormalized = containerPath.replace(/^\//, '');
            volumesList.push(`${volumeKey}=${containerPathNormalized}`);
          } else if (hostPath.startsWith('/')) {
            const pathParts = hostPath.split('/');
            const volumeKey = pathParts[pathParts.length - 1] || 'data';
            const containerPathNormalized = containerPath.replace(/^\//, '');
            volumesList.push(`${volumeKey}=${containerPathNormalized}`);
          } else {
            const volumeKey = hostPath.replace(/\//g, '_').replace(/\./g, '_') || 'data';
            const containerPathNormalized = containerPath.replace(/^\//, '');
            volumesList.push(`${volumeKey}=${containerPathNormalized}`);
          }
        }
      }
    }
    
    const seen = new Set<string>();
    const uniqueVolumes: string[] = [];
    for (const vol of volumesList) {
      const key = vol.split('=')[0];
      if (!seen.has(key)) {
        seen.add(key);
        uniqueVolumes.push(vol);
      }
    }
    
    if (uniqueVolumes.length > 0) {
      properties.volumes = uniqueVolumes.join('\n');
    }

    const commands: string[] = [];
    for (const [serviceName, serviceConfig] of Object.entries(services)) {
      const service = serviceConfig as Record<string, unknown>;
      const command = service['command'];
      if (command) {
        let cmdStr = '';
        if (Array.isArray(command)) {
          cmdStr = command.join(' ');
        } else if (typeof command === 'string') {
          cmdStr = command;
        }
        if (cmdStr) {
          commands.push(`${serviceName}: ${cmdStr}`);
        }
      }
    }
    if (commands.length > 0) {
      properties.command = commands.join('\n');
    }

    const users: string[] = [];
    for (const [serviceName, serviceConfig] of Object.entries(services)) {
      const service = serviceConfig as Record<string, unknown>;
      const user = service['user'];
      if (user) {
        users.push(`${serviceName}: ${user}`);
      }
    }
    if (users.length > 0) {
      properties.user = users.join('\n');
    }
    
    return properties;
  }
  
  private extractEnvironmentVariables(composeData: Record<string, unknown>, services: Record<string, unknown>): string[] {
    const envVars = new Set<string>();
    
    // Extract variable references from all string values
    const extractVarRefs = (obj: unknown): void => {
      if (typeof obj === 'string') {
        const { vars } = this.extractVarRefsFromString(obj);
        for (const v of vars) envVars.add(v);
      } else if (Array.isArray(obj)) {
        for (const item of obj) {
          extractVarRefs(item);
        }
      } else if (obj && typeof obj === 'object') {
        for (const value of Object.values(obj as Record<string, unknown>)) {
          extractVarRefs(value);
        }
      }
    };
    
    // Extract from services
    for (const [, serviceConfig] of Object.entries(services)) {
      const service = serviceConfig as Record<string, unknown>;
      
      // Direct environment variables
      const serviceEnvironment = service['environment'];
      if (serviceEnvironment) {
        if (Array.isArray(serviceEnvironment)) {
          // Format: ["KEY=value", "KEY2=value2"]
          for (const envEntry of serviceEnvironment) {
            if (typeof envEntry === 'string') {
              const equalIndex = envEntry.indexOf('=');
              if (equalIndex > 0) {
                const key = envEntry.substring(0, equalIndex).trim();
                envVars.add(key);
              }
            }
          }
        } else if (typeof serviceEnvironment === 'object') {
          // Format: { KEY: value, KEY2: value2 }
          for (const key of Object.keys(serviceEnvironment as Record<string, unknown>)) {
            envVars.add(key);
          }
        }
      }
      
      // Extract from all service properties
      extractVarRefs(service);
    }
    
    // Extract from top-level x-* extensions (if used)
    if (composeData['x-environment']) {
      extractVarRefs(composeData['x-environment']);
    }
    
    return Array.from(envVars).sort();
  }

  private extractServiceRequiredEnvironmentVariables(serviceConfig: Record<string, unknown>): string[] {
    const required = new Set<string>();

    const extractReq = (obj: unknown): void => {
      if (typeof obj === 'string') {
        const { required: req } = this.extractVarRefsFromString(obj);
        for (const v of req) required.add(v);
      } else if (Array.isArray(obj)) {
        for (const item of obj) extractReq(item);
      } else if (obj && typeof obj === 'object') {
        for (const value of Object.values(obj as Record<string, unknown>)) extractReq(value);
      }
    };

    extractReq(serviceConfig);
    return Array.from(required).sort();
  }

  private extractRequiredEnvironmentVariables(composeData: Record<string, unknown>, services: Record<string, unknown>): string[] {
    const required = new Set<string>();

    const extractReq = (obj: unknown): void => {
      if (typeof obj === 'string') {
        const { required: req } = this.extractVarRefsFromString(obj);
        for (const v of req) required.add(v);
      } else if (Array.isArray(obj)) {
        for (const item of obj) extractReq(item);
      } else if (obj && typeof obj === 'object') {
        for (const value of Object.values(obj as Record<string, unknown>)) extractReq(value);
      }
    };

    for (const [, serviceConfig] of Object.entries(services)) {
      extractReq(serviceConfig);
    }

    if (composeData['x-environment']) {
      extractReq(composeData['x-environment']);
    }

    return Array.from(required).sort();
  }

  public getEffectiveServiceEnvironment(
    serviceConfig: Record<string, unknown>,
    parsedData: ParsedComposeData,
    serviceName: string,
    envFileContent: string
  ): Map<string, string> {
    const effectiveEnvs = new Map<string, string>();
    // Parse env file content - handle both plain text and base64-encoded with metadata
    const envVarsFromFile = this.parseEnvFile(envFileContent);

    const allKnownVars = new Set([
        ...this.extractServiceEnvironmentVariables(serviceConfig),
        ...Object.keys(parsedData.serviceEnvironmentVariableDefaults?.[serviceName] ?? {})
    ]);

    for (const key of allKnownVars) {
        // Priority 1: Value from .env file
        if (envVarsFromFile.has(key)) {
            effectiveEnvs.set(key, envVarsFromFile.get(key)!);
            continue;
        }

        // Priority 2: Default value from compose file (e.g., ${VAR:-default})
        const defaultValue = parsedData.serviceEnvironmentVariableDefaults?.[serviceName]?.[key];
        if (defaultValue !== undefined) {
            effectiveEnvs.set(key, defaultValue);
            continue;
        }

        // Priority 3: Hardcoded value in compose file (e.g., environment: { KEY: value })
        const environment = serviceConfig['environment'];
        if (environment) {
            if (Array.isArray(environment)) {
                for (const envEntry of environment) {
                    if (typeof envEntry === 'string') {
                        const equalIndex = envEntry.indexOf('=');
                        if (equalIndex > 0) {
                            const entryKey = envEntry.substring(0, equalIndex).trim();
                            if (entryKey === key) {
                                const rawValue = envEntry.substring(equalIndex + 1).trim();
                                // Use resolveVariables to handle all patterns: ${VAR}, ${VAR:-default}, $VAR
                                const value = this.resolveVariables(rawValue, envVarsFromFile);
                                effectiveEnvs.set(key, value);
                                break;
                            }
                        }
                    }
                }
            } else if (typeof environment === 'object') {
                const envObj = environment as Record<string, unknown>;
                if (key in envObj) {
                    const rawValue = String(envObj[key] ?? '');
                    // Use resolveVariables to handle all patterns: ${VAR}, ${VAR:-default}, $VAR
                    const value = this.resolveVariables(rawValue, envVarsFromFile);
                    effectiveEnvs.set(key, value);
                }
            }
        }
    }

    // Handle variables referenced in any part of the service but not defined
    const referencedVars = this.extractVarRefsFromString(JSON.stringify(serviceConfig)).vars;
    for(const key of referencedVars) {
        if (!effectiveEnvs.has(key)) {
            effectiveEnvs.set(key, '');
        }
    }

    return effectiveEnvs;
  }

  /**
   * Analyze docker-compose data and detect unsupported/partial features for LXC migration
   */
  detectComposeWarnings(data: ParsedComposeData): IComposeWarning[] {
    const services = data.composeData['services'] as Record<string, Record<string, unknown>> || {};
    const features = this.getUnsupportedFeatureDefinitions();

    return [
      ...this.checkTopLevelFeatures(features, data),
      ...this.checkServiceLevelFeatures(features, services),
    ];
  }

  private getUnsupportedFeatureDefinitions(): {
    key: string;
    id: string;
    title: string;
    description: string;
    category: 'unsupported' | 'partial' | 'manual';
    severity: 'info' | 'warning';
    checkService?: boolean;
  }[] {
    return [
      {
        key: 'depends_on',
        id: 'depends_on',
        title: 'Service Dependencies (depends_on)',
        description: `Service startup dependencies are **not automatically migrated**.

In LXC/Proxmox, you can configure startup order manually:
- **Proxmox GUI**: Datacenter → Options → Start/Shutdown order
- **CLI**: \`pct set <vmid> -startup order=<n>,up=<delay>\`

Example: If service B depends on A, set A with \`order=1\` and B with \`order=2,up=30\` (waits 30s).`,
        category: 'manual',
        severity: 'warning',
        checkService: true
      },
      {
        key: 'ports',
        id: 'ports',
        title: 'Port Mappings (ports)',
        description: `Port mappings work differently in LXC containers.

**Docker**: Maps host ports to container ports (isolation)
**LXC**: Container has its own IP address - services are directly accessible

No port mapping needed. Access services via: \`http://<container-ip>:<port>\``,
        category: 'unsupported',
        severity: 'info',
        checkService: true
      },
      {
        key: 'networks',
        id: 'networks',
        title: 'Custom Networks (networks)',
        description: `Docker custom networks are **not migrated**.

LXC containers use Proxmox network bridges (e.g., \`vmbr0\`).
All containers on the same bridge can communicate directly via their IPs.

For network isolation, use different bridges or VLANs in Proxmox.`,
        category: 'unsupported',
        severity: 'info'
      },
      {
        key: 'healthcheck',
        id: 'healthcheck',
        title: 'Health Checks (healthcheck)',
        description: `Docker health checks are **not migrated** to LXC.

Alternative options:
- Use **systemd** service watchdog (\`WatchdogSec=\`)
- Use **monit** or **supervisord** for process monitoring
- Configure Proxmox **HA** (High Availability) for automatic restart`,
        category: 'unsupported',
        severity: 'warning',
        checkService: true
      },
      {
        key: 'deploy',
        id: 'deploy',
        title: 'Deploy Configuration (deploy)',
        description: `Docker Swarm/Compose deploy settings are **not migrated**.

Resource limits can be set in Proxmox:
- **Memory**: \`pct set <vmid> -memory <MB>\`
- **CPU**: \`pct set <vmid> -cores <n>\`
- **Replicas**: Not supported (deploy multiple containers manually)`,
        category: 'unsupported',
        severity: 'warning',
        checkService: true
      },
      {
        key: 'restart',
        id: 'restart',
        title: 'Restart Policy (restart)',
        description: `Docker restart policies are handled by Proxmox.

Configure in Proxmox:
- **Start at boot**: \`pct set <vmid> -onboot 1\`
- **Protection**: \`pct set <vmid> -protection 1\`

Service-level restart is managed by the init system (OpenRC/systemd) inside the container.`,
        category: 'partial',
        severity: 'info',
        checkService: true
      },
      {
        key: 'cap_add',
        id: 'cap_add',
        title: 'Linux Capabilities (cap_add)',
        description: `Additional Linux capabilities may require LXC configuration.

Common mappings:
- \`SYS_ADMIN\`: May need \`features: nesting=1\`
- \`NET_ADMIN\`: Configure in container options
- \`SYS_PTRACE\`: Add \`lxc.cap.keep: sys_ptrace\`

Check Proxmox container options or edit \`/etc/pve/lxc/<vmid>.conf\`.`,
        category: 'partial',
        severity: 'warning',
        checkService: true
      },
      {
        key: 'privileged',
        id: 'privileged',
        title: 'Privileged Mode (privileged)',
        description: `Privileged containers have security implications.

In Proxmox, unprivileged containers are recommended. If privileged is needed:
- Uncheck "Unprivileged container" during creation
- Or set \`unprivileged: 0\` in container config

**Security note**: Only use privileged mode when absolutely necessary.`,
        category: 'partial',
        severity: 'warning',
        checkService: true
      },
      {
        key: 'devices',
        id: 'devices',
        title: 'Device Mappings (devices)',
        description: `Device passthrough requires manual LXC configuration.

Add to \`/etc/pve/lxc/<vmid>.conf\`:
\`\`\`
lxc.cgroup2.devices.allow: c <major>:<minor> rwm
lxc.mount.entry: /dev/<device> dev/<device> none bind,optional,create=file
\`\`\`

For USB devices, use the Proxvex's USB mapping feature.`,
        category: 'manual',
        severity: 'warning',
        checkService: true
      },
      {
        key: 'sysctls',
        id: 'sysctls',
        title: 'Sysctl Settings (sysctls)',
        description: `Kernel parameters need to be set in LXC config.

Add to \`/etc/pve/lxc/<vmid>.conf\`:
\`\`\`
lxc.sysctl.<key> = <value>
\`\`\`

Example: \`lxc.sysctl.net.ipv4.ip_forward = 1\`

Some sysctls may require privileged containers.`,
        category: 'manual',
        severity: 'warning',
        checkService: true
      },
      {
        key: 'ulimits',
        id: 'ulimits',
        title: 'Resource Limits (ulimits)',
        description: `User limits can be configured inside the container.

Edit \`/etc/security/limits.conf\` in the container:
\`\`\`
<user> soft nofile 65535
<user> hard nofile 65535
\`\`\`

Or use \`prlimit\` for process-specific limits.`,
        category: 'manual',
        severity: 'info',
        checkService: true
      }
    ];
  }

  private checkTopLevelFeatures(
    features: ReturnType<DockerComposeService['getUnsupportedFeatureDefinitions']>,
    data: ParsedComposeData,
  ): IComposeWarning[] {
    const warnings: IComposeWarning[] = [];

    for (const feature of features) {
      // Top-level only: networks (no checkService flag) and any future top-level-only features
      if (!feature.checkService && data.composeData[feature.key]) {
        warnings.push({
          id: feature.id,
          severity: feature.severity,
          category: feature.category,
          feature: feature.key,
          title: feature.title,
          description: feature.description
        });
      }
    }

    // Networks exist at top level (separate from service-level check)
    if (data.composeData['networks']) {
      const networkFeature = features.find(f => f.key === 'networks');
      if (networkFeature && !warnings.some(w => w.id === 'networks')) {
        warnings.push({
          id: networkFeature.id,
          severity: networkFeature.severity,
          category: networkFeature.category,
          feature: networkFeature.key,
          title: networkFeature.title,
          description: networkFeature.description
        });
      }
    }

    return warnings;
  }

  private checkServiceLevelFeatures(
    features: ReturnType<DockerComposeService['getUnsupportedFeatureDefinitions']>,
    services: Record<string, Record<string, unknown>>,
  ): IComposeWarning[] {
    const warnings: IComposeWarning[] = [];

    for (const feature of features) {
      if (!feature.checkService) continue;

      const affectedServices: string[] = [];
      for (const [serviceName, serviceConfig] of Object.entries(services)) {
        if (serviceConfig && serviceConfig[feature.key]) {
          affectedServices.push(serviceName);
        }
      }

      if (affectedServices.length > 0) {
        warnings.push({
          id: feature.id,
          severity: feature.severity,
          category: feature.category,
          feature: feature.key,
          title: feature.title,
          description: feature.description,
          affectedServices
        });
      }
    }

    return warnings;
  }
}
