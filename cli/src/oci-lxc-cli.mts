#!/usr/bin/env node
import { RemoteCli } from "./cli.mjs";
import { CliApiClient, type OidcCredentials } from "./cli-api-client.mjs";
import { CliError } from "./cli-types.mjs";
import type { CliOptions } from "./cli-types.mjs";

interface ParsedArgs {
  command?: string;
  application?: string;
  task?: string;
  parametersFile?: string;
  // Remote command options
  server?: string;
  ve?: string;
  token?: string;
  insecure?: boolean;
  generateTemplate?: boolean;
  templateOutput?: string;
  quiet?: boolean;
  jsonOutput?: boolean;
  verbose?: boolean;
  timeout?: number;
  enableAddons?: string;
  disableAddons?: string;
  fixturePath?: string;
  oidcIssuer?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
}

function parseArgs(): ParsedArgs {
  const args: ParsedArgs = {};
  const argv = process.argv.slice(2);

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (!arg) {
      i += 1;
      continue;
    }

    if (!args.command && !arg.startsWith("--")) {
      // First non-option argument is the command
      args.command = arg;
      i += 1;
    } else if (args.command === "remote") {
      if (arg === "--server") {
        args.server = argv[i + 1] ?? "";
        i += 2;
      } else if (arg === "--ve") {
        args.ve = argv[i + 1] ?? "";
        i += 2;
      } else if (arg === "--token") {
        args.token = argv[i + 1] ?? "";
        i += 2;
      } else if (arg === "--insecure") {
        args.insecure = true;
        i += 1;
      } else if (arg === "--generate-template") {
        args.generateTemplate = true;
        i += 1;
      } else if (arg === "--quiet") {
        args.quiet = true;
        i += 1;
      } else if (arg === "--verbose" || arg === "-v") {
        args.verbose = true;
        i += 1;
      } else if (arg === "--json") {
        args.jsonOutput = true;
        i += 1;
      } else if (arg === "--timeout") {
        args.timeout = parseInt(argv[i + 1] || "1800", 10);
        i += 2;
      } else if (arg === "--enable-addons") {
        args.enableAddons = argv[i + 1] ?? "";
        i += 2;
      } else if (arg === "--disable-addons") {
        args.disableAddons = argv[i + 1] ?? "";
        i += 2;
      } else if (arg === "--fixture-path") {
        args.fixturePath = argv[i + 1] ?? "";
        i += 2;
      } else if (arg === "--oidc-issuer") {
        args.oidcIssuer = argv[i + 1] ?? "";
        i += 2;
      } else if (arg === "--oidc-client-id") {
        args.oidcClientId = argv[i + 1] ?? "";
        i += 2;
      } else if (arg === "--oidc-client-secret") {
        args.oidcClientSecret = argv[i + 1] ?? "";
        i += 2;
      } else if (!arg.startsWith("--")) {
        if (args.generateTemplate) {
          // generate-template mode: positional args are application, task, [output.json]
          if (!args.application) {
            args.application = arg;
            i += 1;
          } else if (!args.task) {
            args.task = arg;
            i += 1;
          } else if (!args.templateOutput) {
            args.templateOutput = arg;
            i += 1;
          } else {
            i += 1;
          }
        } else {
          // execute mode: single positional arg is parametersFile
          if (!args.parametersFile) {
            args.parametersFile = arg;
            i += 1;
          } else {
            i += 1;
          }
        }
      } else {
        i += 1;
      }
    } else if (args.command === "validate") {
      if (arg === "--server") {
        args.server = argv[i + 1] ?? "";
        i += 2;
      } else if (arg === "--token") {
        args.token = argv[i + 1] ?? "";
        i += 2;
      } else if (arg === "--insecure") {
        args.insecure = true;
        i += 1;
      } else if (arg === "--oidc-issuer") {
        args.oidcIssuer = argv[i + 1] ?? "";
        i += 2;
      } else if (arg === "--oidc-client-id") {
        args.oidcClientId = argv[i + 1] ?? "";
        i += 2;
      } else if (arg === "--oidc-client-secret") {
        args.oidcClientSecret = argv[i + 1] ?? "";
        i += 2;
      } else {
        i += 1;
      }
    } else {
      i += 1;
    }
  }

  return args;
}

async function runRemoteCommand(args: ParsedArgs): Promise<void> {
  const server =
    args.server ||
    process.env.OCI_DEPLOYER_URL ||
    "http://localhost:3080";
  const token = args.token || process.env.OCI_DEPLOYER_TOKEN;

  // Build OIDC credentials from args or env vars
  const oidcIssuer = args.oidcIssuer || process.env.OIDC_ISSUER_URL;
  const oidcClientId = args.oidcClientId || process.env.OIDC_CLI_CLIENT_ID;
  const oidcClientSecret = args.oidcClientSecret || process.env.OIDC_CLI_CLIENT_SECRET;
  let oidcCredentials: OidcCredentials | undefined;
  if (oidcIssuer && oidcClientId && oidcClientSecret) {
    oidcCredentials = { issuerUrl: oidcIssuer, clientId: oidcClientId, clientSecret: oidcClientSecret };
  }

  if (!args.ve) {
    console.error("Error: --ve <host> is required");
    process.exit(1);
  }

  if (args.generateTemplate) {
    // generate-template mode requires application and task as positional args
    if (!args.application) {
      console.error("Error: <application> is required for --generate-template");
      process.exit(1);
    }
    if (!args.task) {
      console.error("Error: <task> is required for --generate-template");
      process.exit(1);
    }
  } else {
    // execute mode requires parametersFile
    if (!args.parametersFile) {
      console.error("Error: <parameters.json> is required");
      process.exit(1);
    }
  }

  const options: CliOptions = {
    server,
    ve: args.ve,
    timeout: args.timeout ?? 1800,
  };
  if (args.application) options.application = args.application;
  if (args.task) options.task = args.task;
  if (args.parametersFile) options.parametersFile = args.parametersFile;
  if (token) options.token = token;
  if (args.insecure) options.insecure = args.insecure;
  if (args.generateTemplate) options.generateTemplate = args.generateTemplate;
  if (args.templateOutput) options.templateOutput = args.templateOutput;
  if (args.quiet) options.quiet = args.quiet;
  if (args.jsonOutput) options.json = args.jsonOutput;
  if (args.verbose) options.verbose = args.verbose;
  if (args.enableAddons) options.enableAddons = args.enableAddons.split(",").filter(Boolean);
  if (args.disableAddons) options.disableAddons = args.disableAddons.split(",").filter(Boolean);
  if (args.fixturePath) options.fixturePath = args.fixturePath;
  if (oidcCredentials) options.oidcCredentials = oidcCredentials;

  const cli = new RemoteCli(options);
  await cli.run();
}

async function runValidateCommand(args: ParsedArgs): Promise<void> {
  const server =
    args.server ||
    process.env.OCI_DEPLOYER_URL ||
    "http://localhost:3080";
  const token = args.token || process.env.OCI_DEPLOYER_TOKEN;

  const oidcIssuer = args.oidcIssuer || process.env.OIDC_ISSUER_URL;
  const oidcClientId = args.oidcClientId || process.env.OIDC_CLI_CLIENT_ID;
  const oidcClientSecret = args.oidcClientSecret || process.env.OIDC_CLI_CLIENT_SECRET;
  let oidcCreds: OidcCredentials | undefined;
  if (oidcIssuer && oidcClientId && oidcClientSecret) {
    oidcCreds = { issuerUrl: oidcIssuer, clientId: oidcClientId, clientSecret: oidcClientSecret };
  }

  const client = new CliApiClient(server, token, args.insecure, undefined, oidcCreds);
  await client.authenticateOidc();

  try {
    const result = await client.getValidation();
    if (result.valid) {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    } else {
      console.error(JSON.stringify(result, null, 2));
      process.exit(1);
    }
  } catch (err) {
    if (err instanceof CliError) {
      throw err;
    }
    throw new CliError(`Validation failed: ${(err as Error).message}`, 1);
  }
}

function printHelp(): void {
  console.log("OCI LXC CLI - Command-line tools for OCI LXC Deployer");
  console.log("");
  console.log("Usage:");
  console.log("  oci-lxc-cli <command> [options]");
  console.log("");
  console.log("Commands:");
  console.log(
    "  remote      Execute a task on a remote deployer instance via HTTP API",
  );
  console.log(
    "  validate    Validate all templates and applications on a remote deployer",
  );
  console.log("");
  console.log("Remote command:");
  console.log(
    "  oci-lxc-cli remote --ve <host> <parameters.json>",
  );
  console.log(
    "  oci-lxc-cli remote --ve <host> --generate-template <application> <task> [output.json]",
  );
  console.log("");
  console.log("  The parameters.json file must contain 'application' and 'task' fields.");
  console.log("");
  console.log("  --server <url>            Backend URL (default: http://localhost:3080, env: OCI_DEPLOYER_URL)");
  console.log("  --ve <host>               Proxmox VE host name (required)");
  console.log("  --token <token>           API token (env: OCI_DEPLOYER_TOKEN)");
  console.log("  --insecure                Skip TLS certificate verification");
  console.log("  --generate-template [f]   Generate parameters.json template and exit");
  console.log("  --enable-addons <ids>     Comma-separated addon IDs to enable (e.g. addon-ssl)");
  console.log("  --disable-addons <ids>    Comma-separated addon IDs to disable");
  console.log("  --verbose, -v             Show full script content in progress output");
  console.log("  --quiet                   Minimal output, final JSON result only");
  console.log("  --json                    All progress as JSON lines");
  console.log("  --timeout <seconds>       Max execution time (default: 1800)");
  console.log("  --fixture-path <dir>      Save HTTP request/response pairs as JSON fixtures");
  console.log("  --oidc-issuer <url>       OIDC issuer URL (env: OIDC_ISSUER_URL)");
  console.log("  --oidc-client-id <id>     OIDC client ID (env: OIDC_CLI_CLIENT_ID)");
  console.log("  --oidc-client-secret <s>  OIDC client secret (env: OIDC_CLI_CLIENT_SECRET)");
  console.log("");
  console.log("Validate command:");
  console.log("  oci-lxc-cli validate [--server <url>]");
  console.log("");
  console.log("Global options:");
  console.log("  --help, -h                Show this help message");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    printHelp();
    process.exit(0);
  }

  const args = parseArgs();

  if (!args.command) {
    printHelp();
    process.exit(1);
  }

  if (args.command === "remote") {
    await runRemoteCommand(args);
  } else if (args.command === "validate") {
    await runValidateCommand(args);
  } else {
    console.error(`Unknown command: ${args.command}`);
    console.error("");
    console.error("Available commands: remote, validate");
    process.exit(1);
  }
}

main().catch((err) => {
  if (err instanceof CliError) {
    console.error(`Error: ${err.message}`);
    process.exit(err.exitCode);
  }
  console.error("Unexpected error:", err?.message || err);
  if (err?.stack) {
    console.error("Stack trace:", err.stack);
  }
  process.exit(1);
});
