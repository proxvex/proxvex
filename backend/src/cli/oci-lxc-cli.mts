#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RemoteCli } from "./cli.mjs";
import { CliError } from "./cli-types.mjs";
import type { CliOptions } from "./cli-types.mjs";
import {
  validateAllJson,
  ValidationError,
} from "../validateAllJson.mjs";
import { DocumentationGenerator } from "../documentation-generator.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";

interface ParsedArgs {
  command?: string;
  localPath?: string;
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

    // Global options
    if (arg === "--local") {
      const value = argv[i + 1];
      if (value && !value.startsWith("--")) {
        args.localPath = path.isAbsolute(value)
          ? value
          : path.join(process.cwd(), value);
        i += 2;
      } else {
        args.localPath = path.join(process.cwd(), "local");
        i += 1;
      }
    } else if (!args.command && !arg.startsWith("--")) {
      // First non-option argument is the command
      args.command = arg;
      i += 1;
    } else if (args.command === "updatedoc") {
      if (!args.application && !arg.startsWith("--")) {
        args.application = arg;
        i += 1;
      } else {
        i += 1;
      }
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
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          args.templateOutput = next;
          i += 2;
        } else {
          i += 1;
        }
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
      } else if (!arg.startsWith("--")) {
        // Positional args: application, task, parametersFile
        if (!args.application) {
          args.application = arg;
          i += 1;
        } else if (!args.task) {
          args.task = arg;
          i += 1;
        } else if (!args.parametersFile) {
          args.parametersFile = arg;
          i += 1;
        } else {
          i += 1;
        }
      } else {
        i += 1;
      }
    } else {
      i += 1;
    }
  }

  return args;
}

async function runValidateCommand(localPath?: string): Promise<void> {
  try {
    await validateAllJson(localPath);
    process.exit(0);
  } catch (err) {
    if (err instanceof ValidationError) {
      process.exit(1);
    }
    throw err;
  }
}

async function runUpdatedocCommand(
  applicationName?: string,
  localPathArg?: string,
): Promise<void> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // From cli/ in dist, go up to dist (backend root), then up to workspace root
  const backendRoot = path.resolve(__dirname, "../..");
  const projectRoot = path.resolve(backendRoot, "..");
  const schemaPath = path.join(projectRoot, "schemas");
  const jsonPath = path.join(projectRoot, "json");
  const localPath = localPathArg || path.join(projectRoot, "local", "json");

  console.log(
    "Validating all JSON files before generating documentation...\n",
  );
  try {
    await validateAllJson(localPathArg);
  } catch (err) {
    if (err instanceof ValidationError) {
      process.exit(1);
    }
    throw err;
  }
  console.log(
    "\n✓ Validation successful. Proceeding with documentation generation...\n",
  );

  PersistenceManager.initialize(
    localPath,
    path.join(localPath, "storagecontext.json"),
    path.join(localPath, "secret.txt"),
  );

  const generator = new DocumentationGenerator(jsonPath, localPath, schemaPath);
  await generator.generateDocumentation(applicationName);
  console.log("\n✓ Documentation generation completed!");
}

async function runRemoteCommand(args: ParsedArgs): Promise<void> {
  const server =
    args.server ||
    process.env.OCI_DEPLOYER_URL ||
    "http://localhost:3080";
  const token = args.token || process.env.OCI_DEPLOYER_TOKEN;

  if (!args.ve) {
    console.error("Error: --ve <host> is required");
    process.exit(1);
  }
  if (!args.application) {
    console.error("Error: <application> is required");
    process.exit(1);
  }
  if (!args.task) {
    console.error("Error: <task> is required");
    process.exit(1);
  }

  const options: CliOptions = {
    server,
    ve: args.ve,
    application: args.application,
    task: args.task,
    timeout: args.timeout ?? 1800,
  };
  if (args.parametersFile) options.parametersFile = args.parametersFile;
  if (token) options.token = token;
  if (args.insecure) options.insecure = args.insecure;
  if (args.generateTemplate) options.generateTemplate = args.generateTemplate;
  if (args.templateOutput) options.templateOutput = args.templateOutput;
  if (args.quiet) options.quiet = args.quiet;
  if (args.jsonOutput) options.json = args.jsonOutput;
  if (args.verbose) options.verbose = args.verbose;

  const cli = new RemoteCli(options);
  await cli.run();
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
    "  validate    Validate all templates, applications and frameworks against their schemas",
  );
  console.log(
    "  updatedoc   Generate or update documentation for applications and templates",
  );
  console.log("");
  console.log("Remote command:");
  console.log(
    "  oci-lxc-cli remote --ve <host> <application> <task> [parameters.json]  (defaults used if omitted)",
  );
  console.log(
    "  oci-lxc-cli remote --ve <host> <application> <task> --generate-template [output.json]",
  );
  console.log("");
  console.log("  --server <url>            Backend URL (default: http://localhost:3080, env: OCI_DEPLOYER_URL)");
  console.log("  --ve <host>               Proxmox VE host name (required)");
  console.log("  --token <token>           API token (env: OCI_DEPLOYER_TOKEN)");
  console.log("  --insecure                Skip TLS certificate verification");
  console.log("  --generate-template [f]   Generate parameters.json template and exit");
  console.log("  --verbose, -v             Show full script content in progress output");
  console.log("  --quiet                   Minimal output, final JSON result only");
  console.log("  --json                    All progress as JSON lines");
  console.log("  --timeout <seconds>       Max execution time (default: 1800)");
  console.log("");
  console.log("Validate command:");
  console.log("  oci-lxc-cli validate [--local <path>]");
  console.log("");
  console.log("Updatedoc command:");
  console.log("  oci-lxc-cli updatedoc [application] [--local <path>]");
  console.log("");
  console.log("Global options:");
  console.log("  --local <path>            Path to the local data directory");
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

  if (args.command === "validate") {
    const localPath =
      args.localPath || path.join(process.cwd(), "examples");
    await runValidateCommand(localPath);
  } else if (args.command === "updatedoc") {
    const localPath =
      args.localPath || path.join(process.cwd(), "examples");
    await runUpdatedocCommand(args.application, localPath);
  } else if (args.command === "remote") {
    await runRemoteCommand(args);
  } else {
    console.error(`Unknown command: ${args.command}`);
    console.error("");
    console.error("Available commands: remote, validate, updatedoc");
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
