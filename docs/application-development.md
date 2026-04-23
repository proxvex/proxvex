# Application Development Guide

This guide describes how to create applications for Proxvex, focusing on different installation types and best practices.

## Quick Start: Using the Framework (Easiest Method)

The **framework-based approach** is the simplest way to create a new application from a Docker/OCI image. In 90% of cases, you only need:

1. **Docker image name** (e.g., `docker.io/nodered/node-red:latest`)
2. **Volumes** that need to be persisted (e.g., `/data`)
3. **UID/GID** of the user inside the container (e.g., `1000:1000`)


### Use the Web UI to create a new application:

1. **Open the Framework UI** in Proxvex web interface (usually under "Create Application" or "Frameworks")
2. **Select the OCI Image Framework** (`framework-oci-volumes`)
3. **Enter the Docker image name** (e.g., `docker.io/your-org/your-app:latest`)
4. **Fill in parameters**:
   - Many parameters are automatically extracted from the Dockerfile (e.g., ports, environment variables)
   - Review and adjust as needed
5. **Define volumes and UID/GID**:
   - Volumes: Specify which directories need to be persistent (e.g., `data=/data`, `config=/config`)
   - UID/GID: The user ID inside the container (default: `1000:1000`)
   - **Tip**: If unsure, install the application once and inspect the container to see what directories are used and which user runs the process
6. **Save the application**: The result is a complete application definition that can be installed like any other application

**That's it!** The Web UI handles all the complexity of creating the JSON structure and ensures all required fields are filled.

### Why the OCI Image Framework is So Powerful

The OCI Image Framework (`framework-oci-volumes`) is often the only framework you need because:

1. **Universal compatibility**: Works with any Docker/OCI image from Docker Hub, GitHub Container Registry, or private registries
2. **Automatic detection**: Extracts labels from the image
3. **Simple configuration**: Only requires image name, volumes, and UID/GID
4. **Production-ready**: Handles all the complexity of LXC container creation, networking, and storage

**Other frameworks** (like `framework-npm-service`) are specialized for specific use cases (e.g., npm packages) but are rarely needed since most applications are already containerized.

### When Do You Need More?

The framework handles most common cases. You only need custom templates if your application requires:

- **External devices**: Serial ports (`/dev/ttyUSB0`), audio devices, USB devices
- **Special capabilities**: Privileged operations, custom cgroups
- **Custom initialization**: Application-specific setup scripts
- **Complex networking**: Multiple network interfaces, custom firewall rules

For these cases, see the [Custom Templates](#custom-templates) section below.

### Finding Docker Image Information

**Using the Web UI:** The framework UI automatically extracts most information from the Docker image, including ports and environment variables.

**Manual inspection (if needed):**

**UID/GID:** Check the Dockerfile or run:
```sh
docker run --rm your-image id
# Output: uid=1000(node) gid=1000(node) groups=1000(node)
```

**Volumes:** Check the Dockerfile for `VOLUME` directives or documentation:
```dockerfile
VOLUME ["/data", "/config"]
```

**Tip for finding volumes:** If you're unsure which directories need persistence:
1. Install the application once (even without volumes)
2. Use the application (create some data, change settings)
3. Inspect the container: `pct enter <vmid>` and look for directories with user data
4. Re-create the application definition with the correct volumes

### Available Frameworks

- **`framework-oci-volumes`**: **[Recommended]** Base framework for OCI images with volumes (covers 90%+ of use cases)
  - Handles any Docker/OCI image
  - Automatic image download and conversion
  - Volume management and UID/GID mapping
  - **Use this unless you have a specific reason not to**

- **`framework-oci-simple`**: Minimal OCI framework without volumes (rarely needed)
  - Use only for stateless applications

- **`framework-npm-service`**: Node.js applications installed via npm (legacy)
  - Only needed for npm packages that aren't containerized
  - Most Node.js applications are better served by `framework-oci-volumes` with an existing Docker image

**Recommendation**: Start with `framework-oci-volumes` for any new application. It's simple, powerful, and handles almost all use cases.

See [Application Creation with Frameworks](#application-creation-with-frameworks) for more details.

## Table of Contents

- [Directory Structure and Search Order](#directory-structure-and-search-order)
  - [Directory Structure](#directory-structure)
  - [Search Order](#search-order)
  - [Practical Examples](#practical-examples)
  - [Configuration Paths](#configuration-paths)
- [Core Concepts](#core-concepts)
  - [Applications](#applications)
  - [Templates](#templates)
  - [Scripts](#scripts)
  - [How They Work Together](#how-they-work-together)
- [Installation Types](#installation-types)
- [Example Applications](#example-applications)
- [Creating an npm + Service Application](#creating-an-npm--service-application)
  - [Approach 1: Extending an Existing Application (Proxvex Example)](#approach-1-extending-an-existing-application-proxvex-example)
  - [Approach 2: Creating a Standalone Application](#approach-2-creating-a-standalone-application)
  - [Key Parameters Explained](#key-parameters-explained)
  - [Template Execution Order](#step-4-template-execution-order)
  - [Local Path for Development](#step-5-local-path-for-development)
  - [Validation](#step-6-validation)
- [Application Creation with Frameworks](#application-creation-with-frameworks)
  - [What are Frameworks?](#what-are-frameworks)
  - [Framework Structure](#framework-structure)
  - [Creating Applications from Frameworks](#creating-applications-from-frameworks)
  - [Framework-Provided Base Functionality](#framework-provided-base-functionality)
  - [Adding Special Features](#adding-special-features)
  - [Example: Proxvex](#example-proxvex)
- [Template Reference](#template-reference)
  - [Shared Templates](#shared-templates)
  - [Custom Templates](#custom-templates)
- [Web API Notes (Internal)](#web-api-notes-internal)
- [Best Practices](#best-practices)
- [Generating Documentation](#generating-documentation)
- [Next Steps](#next-steps)

## Directory Structure and Search Order

Understanding the directory structure and search order is crucial for developing applications. Proxvex uses a hierarchical search system that allows you to override shared templates and scripts with application-specific or local versions.

### Directory Structure

Proxvex uses two main directory hierarchies:

#### 1. Main Repository (`json/`)

The main repository contains all official applications, shared templates, and scripts:

```
json/
├── applications/
│   ├── node-red/
│   │   ├── application.json
│   │   ├── templates/
│   │   │   ├── set-parameters.json
│   │   │   └── import-flow.json
│   │   ├── scripts/          # Optional: application-specific scripts
│   │   └── icon.svg          # Optional: application icon
│   ├── proxvex/
│   │   ├── application.json
│   │   ├── templates/
│   │   │   └── set-parameters.json
│   │   └── scripts/
│   └── ...
└── shared/
    ├── templates/            # Shared templates used by multiple applications
    │   ├── 010-get-latest-os-template.json
    │   ├── 100-create-configure-lxc.json
    │   ├── 200-start-lxc.json
    │   ├── 340-install-node-application.json
    │   └── ...
    └── scripts/              # Shared scripts used by multiple applications
        ├── create-lxc-container.sh
        ├── install-node-application.sh
        └── ...
```

#### 2. Local/Examples Directory (`examples/` or `local/`)

The local directory allows you to:
- Override shared templates and scripts
- Test new applications without modifying the main repository
- Keep experimental or custom configurations

**Default paths:**
- **Web application**: Uses `examples/` in the current working directory
- **Command line (`exec`)**: Uses `local/json/` in the current working directory

```
examples/                     # or local/json/
├── applications/
│   └── your-custom-app/
│       ├── application.json
│       └── templates/
│           └── set-parameters.json
└── shared/
    ├── templates/            # Override shared templates
    │   └── 305-set-pkg-mirror.json
    └── scripts/              # Override shared scripts
        └── custom-script.sh
```

**Important:** The `examples/shared/` directory is particularly useful for:
- Overriding shared templates (e.g., `305-set-pkg-mirror.json` to use a different package mirror)
- Testing template changes before committing to the main repository
- Providing local customizations that shouldn't be in the main repository

### Search Order

Proxvex searches for files in a specific order, allowing you to override shared resources with application-specific or local versions.

#### Applications

When loading an application, the system searches in this order:

1. **`localPath/applications/<app-name>/application.json`** (e.g., `examples/applications/node-red/application.json`)
2. **`jsonPath/applications/<app-name>/application.json`** (e.g., `json/applications/node-red/application.json`)

**Result:** The first found application is used. Local applications take precedence over repository applications.

#### Templates

When resolving a template reference, the system searches in this order:

1. **Application-specific templates** (in application hierarchy, child to parent):
   - `appPath/templates/<template-name>.json` (current application)
   - `parentAppPath/templates/<template-name>.json` (if using `extends`)
   - ... (continues up the inheritance chain)

2. **Local shared templates:**
   - `localPath/shared/templates/<template-name>.json` (e.g., `examples/shared/templates/305-set-pkg-mirror.json`)

3. **Repository shared templates:**
   - `jsonPath/shared/templates/<template-name>.json` (e.g., `json/shared/templates/010-get-latest-os-template.json`)

**Result:** The first found template is used. Application-specific templates override shared templates, and local shared templates override repository shared templates.

**Example:** If you have:
- `json/shared/templates/305-set-pkg-mirror.json` (repository version)
- `examples/shared/templates/305-set-pkg-mirror.json` (local override)

The local version in `examples/shared/templates/` will be used for all applications.

#### Scripts

When resolving a script reference, the system searches in this order:

1. **Application-specific scripts** (in application hierarchy, child to parent):
   - `appPath/scripts/<script-name>.sh` (current application)
   - `parentAppPath/scripts/<script-name>.sh` (if using `extends`)
   - ... (continues up the inheritance chain)

2. **Local shared scripts:**
   - `localPath/shared/scripts/<script-name>.sh` (e.g., `examples/shared/scripts/custom-script.sh`)

3. **Repository shared scripts:**
   - `jsonPath/shared/scripts/<script-name>.sh` (e.g., `json/shared/scripts/install-node-application.sh`)

**Result:** The first found script is used. Application-specific scripts override shared scripts, and local shared scripts override repository shared scripts.

### Practical Examples

#### Example 1: Override a Shared Template

To override the package mirror template for all applications:

1. Create `examples/shared/templates/305-set-pkg-mirror.json`
2. Modify the template to use your preferred mirror
3. All applications will use your local version instead of the repository version

#### Example 2: Application-Specific Template

To create a template only for your application:

1. Create `examples/applications/your-app/templates/custom-template.json`
2. Reference it in your `application.json`
3. It will only be used by your application

#### Example 3: Extend an Application

When using `extends`, templates are searched in the inheritance chain:

1. Child application templates (`examples/applications/proxvex/templates/`)
2. Parent application templates (`json/applications/node-red/templates/`)
3. Local shared templates (`examples/shared/templates/`)
4. Repository shared templates (`json/shared/templates/`)

This allows child applications to override parent templates while still inheriting others.

### Configuration Paths

The system uses three main path configurations:

- **`jsonPath`**: Main repository path (default: `json/` relative to project root)
- **`localPath`**: Local/experimental path (default: `examples/` for web app, `local/json/` for exec)
- **`schemaPath`**: Schema definitions path (default: `schemas/` relative to project root)

You can override these using the `--local` option:

```bash
# Use custom local directory
proxvex --local ./my-custom-local
```

## Core Concepts

Before diving into application development, it's important to understand the three core building blocks of Proxvex: Applications, Templates, and Scripts.

### Applications

An **Application** is a complete software package that can be installed in an LXC container. It defines:

- **Metadata**: Name, description, icon
- **Installation workflow**: A sequence of templates that define the installation process
- **Parameters**: User-configurable options (e.g., hostname, ports, credentials)
- **Tasks**: Different workflows for different purposes (e.g., `installation`, `backup`, `restore`)

Applications are defined in `application.json` files located in `json/applications/<app-name>/` or `examples/applications/<app-name>/`.

**Key characteristics:**
- Applications can **extend** other applications using `extends`, inheriting all templates from the parent
- Applications define **tasks** (like `installation`) that contain a list of templates to execute
- Applications can override inherited templates by providing their own versions
- Applications can define **parameters** that users configure through the UI

**Example application structure:**
```json
{
  "name": "Node-RED",
  "description": "Flow-based programming tool",
  "icon": "icon.svg",
  "installation": [
    "set-parameters.json",
    "010-get-latest-os-template.json",
    "100-create-configure-lxc.json",
    "340-install-node-application.json",
    "350-create-enable-service.json"
  ]
}
```

### Templates

**Templates** are reusable JSON configuration files that define:
- **Commands** to execute (scripts, shell commands, or nested templates)
- **Parameters** that the template requires or accepts
- **Outputs** that the template produces (used by subsequent templates)
- **Execution context** (where to run: `ve`, `lxc`, or `host:hostname`)
- **Conditional logic** (skip conditions based on missing parameters or set properties)

Templates serve two main purposes:

1. **UI Generation**: Templates define parameters that are automatically presented to users in the web UI. The UI is generated from the parameter definitions in templates, allowing users to configure the installation.

2. **Reusability**: Templates can be shared across multiple applications. For example, `100-create-configure-lxc.json` is used by almost all applications to create and configure the LXC container.

**Template types:**
- **Application-specific templates**: Located in `applications/<app-name>/templates/`, used only by that application
- **Shared templates**: Located in `shared/templates/`, can be used by any application

**Template execution flow:**
1. Template is loaded and validated against the schema
2. Parameters are resolved (from user input, previous templates, or defaults)
3. Commands are executed in order (scripts, shell commands, or nested templates)
4. Outputs are captured and made available to subsequent templates
5. Results are stored in the VM context for later use

**Example template:**
```json
{
  "execute_on": "lxc",
  "name": "Install Node Application",
  "description": "Install a Node.js application globally via npm",
  "parameters": [
    {
      "id": "package",
      "name": "Package name",
      "type": "string",
      "required": true,
      "description": "Name of the npm package to install"
    }
  ],
  "commands": [
    {
      "script": "install-node-application.sh",
      "description": "Install the npm package globally",
      "outputs": ["settings_path"]
    }
  ]
}
```

### Scripts

**Scripts** are shell scripts (POSIX-compliant `/bin/sh`) that perform actual work:
- Installing software packages
- Configuring services
- Creating users and directories
- Setting up file permissions
- Any other system-level operations

Scripts are executed inside LXC containers (when `execute_on: "lxc"`) or on the VE host (when `execute_on: "ve"` or `execute_on: "host:hostname"`).

**Key characteristics:**
- Scripts run in **Alpine Linux** containers, so they must use POSIX-compliant shell syntax
- Scripts can use **template variables** like `{{hostname}}` or `{{vm_id}}` that are replaced before execution
- Scripts must output **JSON to stdout** for outputs (all other output goes to stderr)
- Scripts can access **environment variables** like `$DATA_DIR`, `$HOME_DIR`, `$SECURE_DIR` (from volumes)
- Scripts are referenced in templates via the `script` property

**Script types:**
- **Application-specific scripts**: Located in `applications/<app-name>/scripts/`, used only by that application
- **Shared scripts**: Located in `shared/scripts/`, can be used by any application

**Script execution:**
1. Template variables are replaced with actual values
2. Script is transferred via pipe to the target (container or host) and executed directly
3. Script runs with appropriate permissions
4. stdout is parsed for JSON outputs
5. Outputs are stored and made available to subsequent templates

**Example script structure:**
```bash
#!/bin/sh
# install-node-application.sh
# Installs a Node.js application globally via npm

set -e

PACKAGE="{{package}}"
VERSION="{{version}}"

# Install the package
npm install -g "${PACKAGE}@${VERSION}"

# Output results as JSON (to stdout)
echo "{\"settings_path\": \"/root/.npm-global/lib/node_modules/${PACKAGE}\"}"
```

**Important script rules:**
- All output that should be parsed as JSON must go to **stdout**
- Logs, debug messages, and errors must go to **stderr**
- Never use `2>&1` as it redirects stderr to stdout, violating the JSON-only stdout rule
- Scripts must be idempotent (safe to run multiple times)

### How They Work Together

1. **Application** defines the workflow (which templates to run)
2. **Templates** define the steps (what to do, what parameters are needed)
3. **Scripts** perform the actual work (how to do it)

**Example flow:**
```
Application (node-red)
  └─> Template (340-install-node-application.json)
        └─> Script (install-node-application.sh)
              └─> Executes: npm install -g node-red
                    └─> Outputs: settings_path
                          └─> Used by next template
```

This separation allows:
- **Reusability**: Same script can be used by multiple templates, same template by multiple applications
- **Maintainability**: Update a shared script once, all applications benefit
- **Flexibility**: Applications can override templates, templates can use different scripts
- **UI Generation**: Parameters from templates automatically appear in the web UI

## Installation Types

Proxvex supports several installation types for applications:

1. **npm + service**: Node.js applications installed via npm with an OpenRC/systemd service
2. **python3 + service**: Python applications with an OpenRC/systemd service
3. **package installation**: System packages (APK, DEB, etc.) with optional service enablement

This guide focuses on the **npm + service** installation type. Similar patterns apply to other installation types.

## Example Applications

- **[Proxvex](generated/json/applications/proxvex.md)**: A complete example of an npm-based application with service that extends Node-RED and adds serial device mapping
- **Node-RED**: Base application that Proxvex extends (see [Node-RED Application](generated/json/applications/node-red.md) for reference)

## Creating an npm + Service Application

There are two approaches to creating an npm-based application:

1. **Extend an existing application** (Recommended for similar applications): Inherit templates from a base application and add customizations
2. **Create a standalone application**: Define all templates from scratch

This guide shows both approaches, using Proxvex as an example of extending Node-RED.

### Approach 1: Extending an Existing Application (Proxvex Example)

If your application is similar to an existing npm-based application (like Node-RED), you can extend it to reuse common templates.

#### Step 1: Create Application Directory Structure

Create a directory structure for your application:

```
json/applications/your-app/
├── application.json
├── templates/
│   └── set-parameters.json
└── icon.svg (optional)
```

#### Step 2: Define the Application with `extends`

Create `application.json` that extends a base application (e.g. node-red):

```json
{
  "name": "Your Application",
  "description": "Description of your application",
  "extends": "node-red",
  "installation": [
    {
      "name": "110-map-serial.json",
      "after": "100-create-configure-lxc.json"
    }
  ]
}
```

**Key points:**
- `extends: "node-red"` inherits all templates from the Node-RED application
- You only need to list additional templates or overrides
- Use `before` or `after` to control template execution order
- `set-parameters.json` is inherited but can be overridden by creating your own. In this example, a serial device can be mapped into the lxc-container.

#### Step 3: Create set-parameters.json (Override)

Create your own `set-parameters.json` to override inherited parameters. It's a good idea to copy the set-parameters.json from another similar application:

```json
{
  "name": "Your Application Parameters",
  "description": "Set application-specific parameters for Your Application",
  "parameters": [
    {
      "id": "hostname",
      "name": "OS Hostname",
      "type": "string",
      "default": "your-app",
      "required": true,
      "description": "Hostname for the container"
    },
    {
      "id": "usb_bus_device",
      "name": "USB Serial Port",
      "type": "enum",
      "required": false,
      "enumValuesTemplate": "list-host-usb-serial-ports.json",
      "description": "Select USB serial port to map to the container"
    }
  ],
  "commands": [
    {
      "properties": [
        { "id": "ostype", "value": "alpine" },
        { "id": "command", "value": "your-command" },
        { "id": "package", "value": "your-npm-package" },
        { "id": "volumes", "value": "data=/data\nconfig=/config" },
        { "id": "packages", "value": "nodejs npm git openrc" },
        { "id": "username", "value": "your-app" },
        { "id": "uid", "value": "1000" },
        { "id": "gid", "value": "1000" }
      ]
    }
  ]
}
```

### Approach 2: Creating a Standalone Application

If your application is significantly different, create it from scratch:

#### Step 1: Create Application Directory Structure

Same as Approach 1.

#### Step 2: Define the Application

Create `application.json` with all required templates:

```json
{
  "name": "Your Application",
  "description": "Description of your application",
  "icon": "icon.svg",
  "installation": [
    "set-parameters.json",
    "010-get-latest-os-template.json",
    "100-create-configure-lxc.json",
    "200-start-lxc.json",
    "210-wait-for-container-ready.json",
    "305-set-pkg-mirror.json",
    "330-install-packages.json",
    "340-install-node-application.json",
    "350-create-enable-service.json"
  ]
}
```

#### Step 3: Create set-parameters.json

Create a complete `set-parameters.json` with all required properties:

```json
{
  "name": "Set Parameters",
  "description": "Set application-specific parameters",
  "parameters": [
    {
      "id": "hostname",
      "name": "Hostname",
      "type": "string",
      "default": "your-app",
      "required": true,
      "description": "Hostname for the container"
    },
    {
      "id": "http_port",
      "name": "HTTP Port",
      "type": "string",
      "default": "8080",
      "required": false,
      "advanced": true,
      "description": "Port number for HTTP server"
    }
  ],
  "commands": [
    {
      "properties": [
        { "id": "ostype", "value": "alpine" },
        { "id": "packages", "value": "nodejs npm" },
        { "id": "command", "value": "your-command" },
        { "id": "command_args", "value": "--port {{http_port}}" },
        { "id": "package", "value": "your-npm-package" },
        { "id": "volumes", "value": "data=your-app" },
        { "id": "username", "value": "your-app" },
        { "id": "uid", "value": "1000" },
        { "id": "gid", "value": "1000" }
      ]
    }
  ]
}
```

### Key Parameters Explained

#### `volumes`

The `volumes` parameter defines mount points for persistent data storage. **This is critical for system upgrades**: LXC containers should not store application data inside the container filesystem. Instead, data should be stored on the host and mounted into the container.

Format: `key=value` pairs separated by spaces, where:
- `key`: The mount point name (used as a variable like `$DATA_DIR`)
- `value`: The directory name on the host (under `/var/lib/proxvex/data/`)

Example: `data=proxvex` creates:
- Host path: `/var/lib/proxvex/data/proxvex/`
- Container mount: Available as `$DATA_DIR` in scripts

**Why volumes are important:**
- Containers can be easily recreated during system upgrades
- Data persists independently of container lifecycle
- Backup and restore is simplified (only need to backup host directories)
- Multiple containers can share data if needed

#### Service User and Permissions

##### Running as Non-Root (Recommended)

For most applications, the service should run as a non-root user. You must set `username`, `uid`, and `gid`:

```json
{
  "id": "username",
  "value": "your-app"
},
{
  "id": "uid",
  "value": "1000"
},
{
  "id": "gid",
  "value": "1000"
}
```

**Important:** When using non-root, you must explicitly set `uid` and `gid`. If left empty, the system will use defaults (root/0), which defeats the purpose of running as non-root.

The `350-create-enable-service.json` template will:
- Create the user with the specified UID/GID if it doesn't exist
- Set up proper file ownership for volumes
- Create and enable the service

##### Running as Root (Required for Privileged Ports)

If your application needs to bind to ports < 1024 (e.g., HTTP port 80, HTTPS port 443), it must run as root:

```json
{
  "id": "username",
  "value": "root"
},
{
  "id": "uid",
  "value": "0"
},
{
  "id": "gid",
  "value": "0"
}
```

**Security Considerations:**
- Running services as root increases the attack surface within the LXC container
- If the service is compromised, an attacker gains root access **inside the container**
- **Important:** The LXC container itself runs unprivileged and has no elevated permissions on the host system
- The application is responsible for its own security within the container
- Use root only when absolutely necessary (e.g., for privileged ports)
- Consider using a reverse proxy (running as root) that forwards to your application on a non-privileged port

### Step 4: Template Execution Order

The installation templates are executed in this order:

1. **set-parameters.json**: Defines and sets default parameters
2. **010-get-latest-os-template.json**: Gets the latest OS template version
3. **100-create-configure-lxc.json**: Creates and configures the LXC container
   - Additional templates can be inserted here using `before` or `after` (e.g., `110-map-serial.json`)
4. **200-start-lxc.json**: Starts the container
5. **210-wait-for-container-ready.json**: Waits for container to be ready
6. **305-set-pkg-mirror.json**: Configures package mirror (Alpine Linux)
7. **330-install-packages.json**: Installs system packages (nodejs, npm, etc.)
8. **340-install-node-application.json**: Installs the npm package (or custom installation templates)
9. **350-create-enable-service.json**: Creates and enables the service

**For extended applications:** Templates from the base application are executed first, then your custom templates are inserted according to `before`/`after` directives.

### Step 5: Local Path for Development

During development, you can use a local directory instead of the main `json/` directory:

1. Create your application in a local directory (e.g., `local/json/applications/your-app/`)
2. Use the `--local` option when running Proxvex:
   ```bash
   proxvex --local ./local
   ```

The local directory structure should mirror the main `json/` directory:
```
local/
└── json/
    ├── applications/
    │   └── your-app/
    └── shared/
        └── templates/
```

**Benefits of local path:**
- Test changes without modifying the main repository
- Keep experimental applications separate
- Easy to validate before committing

### Step 6: Validation

Before committing your application, validate it:

```bash
cd backend
npm run build
cd ..
backend/dist/proxvex.mjs validate
```

This will:
- Validate all JSON schemas
- Check for duplicate template names in tasks
- Check for duplicate output/property IDs
- Verify all referenced scripts exist
- Check for missing required parameters

**Always validate before committing!**

## Application Creation with Frameworks

Frameworks provide a streamlined way to create new applications by offering a pre-configured base with common functionality. They eliminate the need to manually set up container creation, volume mounting, service management, and user management for each new application.

### What are Frameworks?

Frameworks are simplified application definitions that:
- **Extend a base application**: Frameworks must extend an existing "empty" base application that provides the core templates
- **Define properties**: Frameworks specify which parameters from the base application should be exposed and configurable
- **No templates**: Frameworks don't define their own templates - they inherit all templates from the base application
- **No description**: Frameworks are implementation details, not user-facing applications

Frameworks are located in `json/frameworks/` and follow a simple structure:

```json
{
  "name": "npm-nodejs",
  "extends": "npm-nodejs",
  "properties": [
    "hostname",
    "ostype",
    "packages",
    "command",
    "command_args",
    "package",
    "owned_paths",
    "uid",
    "group",
    "username",
    "volumes"
  ]
}
```

### Framework Structure

A framework JSON file contains:

- **`name`** (required): Display name for the framework
- **`extends`** (required): Reference to the base application (e.g., `"npm-nodejs"` or `"local:npm-nodejs"`)
- **`properties`** (required): Array of parameter IDs that should be exposed. Each property can be:
  - A simple string: `"hostname"` - parameter is required
  - An object with `id` and `default: true`: `{"id": "hostname", "default": true}` - parameter has a default value
- **`icon`** (optional): Icon filename (defaults to `"icon.png"`)

### Creating Applications from Frameworks

You can create applications from frameworks using the web interface or programmatically:

1. **Select a framework**: Choose a framework that matches your application type (e.g., `npm-nodejs` for Node.js applications)
2. **Configure application properties**: Provide name, ID, description, and optional icon
3. **Set parameter values**: Configure all framework-defined parameters
4. **Create the application**: The system automatically generates:
   - `application.json` with proper `extends` and template list
   - `{applicationId}-parameters.json` template with all parameter values
   - Application directory structure

The generated application will:
- Extend the same base application as the framework
- Include all templates from the base application
- Have a prepended `{applicationId}-parameters.json` template that sets all configured parameters

### Framework-Provided Base Functionality

Frameworks provide a solid foundation for common application needs:

#### Container Creation
- Automatic LXC container creation and configuration
- OS template selection and setup
- Network configuration

#### Volume Mounting
- Persistent data storage via volume mounts
- Automatic path ownership configuration
- Volume management

#### Service Creation
- Systemd service setup
- Service user configuration
- Automatic service start/stop handling

#### User Management
- Non-root user creation
- UID/GID configuration
- Group assignment
- Home directory setup

These core features are handled by shared templates in the base application, so you don't need to configure them manually for each new application.

### Adding Special Features

While frameworks provide the essential base functionality, you can easily add specialized features to applications created from frameworks. Common additions include:

- **USB device sharing**: Map USB devices to containers
- **Serial port access**: Grant access to serial devices
- **Additional volumes**: Mount extra storage locations
- **Custom scripts**: Add application-specific setup or configuration scripts
- **Environment variables**: Configure runtime environment
- **Network ports**: Expose additional network ports

#### Example: Proxvex

The `proxvex` application demonstrates how to add special features to a framework-based application:

```json
{
  "name": "Proxvex Gateway",
  "description": "Proxvex Gateway from Modbus RTU/TCP to MQTT and vice versa",
  "extends": "node-red",
  "installation": [
    {
      "name": "110-map-serial.json",
      "after": "100-create-configure-lxc.json"
    }
  ]
}
```

This application:
1. **Extends `node-red`**: Inherits all base functionality (container, volumes, service, user management)
2. **Adds serial device mapping**: Includes `110-map-serial.json` template to enable USB/serial device access
3. **Minimal configuration**: Only needs to specify the additional template, everything else comes from the base

To add similar features to your framework-based application:

1. **Create or use an existing template**: For serial devices, use `110-map-serial.json` from shared templates
2. **Add to installation list**: Include the template in your `application.json` with proper ordering (using `before`/`after` directives)
3. **Configure parameters**: If the template requires parameters, add them to your `set-parameters.json` or the generated `{applicationId}-parameters.json`

**Note**: Frameworks focus on common, reusable functionality. Specialized features like USB device sharing are intentionally left out of frameworks to keep them simple and focused. They can always be added later to individual applications as needed.

## Template Reference

### Shared Templates

Most applications use shared templates from `json/shared/templates/`:

- **010-get-latest-os-template.json**: Gets latest OS template version
- **100-create-configure-lxc.json**: Creates and configures LXC container
- **200-start-lxc.json**: Starts the container
- **210-wait-for-container-ready.json**: Waits for container readiness
- **305-set-pkg-mirror.json**: Configures Alpine package mirror
- **330-install-packages.json**: Installs system packages
- **340-install-node-application.json**: Installs npm package globally
- **350-create-enable-service.json**: Creates and enables OpenRC/systemd service

### Custom Templates

You can create custom templates for application-specific tasks:

```json
{
  "execute_on": "lxc",
  "name": "Custom Task",
  "description": "Description of what this template does",
  "parameters": [
    {
      "id": "param1",
      "name": "Parameter 1",
      "type": "string",
      "required": true,
      "description": "Description of parameter"
    }
  ],
  "commands": [
    {
      "script": "your-script.sh",
      "description": "What the script does",
      "outputs": ["output1", "output2"]
    }
  ]
}
```

## Web API Notes (Internal)

The Web UI uses a small set of internal endpoints. These are not part of the public API surface, but they are useful to know when integrating custom tooling.

### Unresolved Parameters

`GET /api/unresolved-parameters/:application/:task/:veContext`

- `task` is a required **client-generated identifier** (typically a UUID). It is used for request grouping/traceability and can be any non-empty string.
- The backend currently resolves parameters from the **installation** task regardless of the value in `task`.

### Execution Task Behavior

- VE execution is hard-coded to use the **installation** task.
- Other task types are ignored by the Web UI execution flow.

## Best Practices

1. **Always use volumes for persistent data**: Never store application data in the container filesystem
2. **Run services as non-root when possible**: Only use root for privileged ports (< 1024). Remember that containers run unprivileged and have no elevated permissions on the host
3. **Use meaningful parameter names**: Make it clear what each parameter does
4. **Provide sensible defaults**: Users should be able to install with minimal configuration
5. **Mark advanced parameters**: Use `"advanced": true` for parameters most users won't need
6. **Validate before committing**: Always run `proxvex validate` before committing
7. **Document your application**: Add clear descriptions to help users understand parameters
8. **Test with local path**: Use `--local` during development to test changes safely
9. **Consider security within the container**: Applications running as root inside the container are responsible for their own security. The container itself has no elevated permissions on the host system

## Generating Documentation

To generate documentation for all applications and templates:

```bash
cd backend
npm run build
cd ..
backend/dist/proxvex.mjs updatedoc
```

This will generate documentation in `docs/generated/`:
- Application documentation: `docs/generated/json/applications/<app-name>.md`
- Template documentation: `docs/generated/json/shared/<template-name>.md`

To generate documentation for a specific application:

```bash
backend/dist/proxvex.mjs updatedoc node-red
```

## Next Steps

- Review the [Proxvex application](generated/json/applications/proxvex.md) as a complete example of an npm-based application
- Check the [Node-RED application](generated/json/applications/node-red.md) to see how applications can be extended using `extends`
- Explore other applications in `json/applications/` for more examples
- Read the [Template Documentation](generated/json/shared/) for detailed information about shared templates

---

## Command Line Usage

Proxvex can be used via command line to execute tasks for applications.

### Start Web Application

Start the web application server (default behavior when no command is specified):

```sh
proxvex [options]
```

**Options:**
- `--local <path>`: Path to the local data directory (default: `examples` in current working directory)
- `--secretsFilePath <path>`: Path to the secrets file for encryption/decryption

**Examples:**
```sh
proxvex
proxvex --local ./my-local
proxvex --local ./my-local --secretsFilePath ./secrets.txt
```

### Execute Tasks

Execute a task for a specific application:

```sh
proxvex exec <application> <task> <parameters file> [options]
```

**Arguments:**
- `<application>`: Name of the application to execute the task for
- `<task>`: Task type to execute. Valid values:
  - `installation`: Install the application
  - `backup`: Backup the application
  - `restore`: Restore the application
  - `uninstall`: Uninstall the application
  - `update`: Update the application
  - `upgrade`: Upgrade the application
  - `webui`: Open web UI for the application
- `<parameters file>`: Path to the JSON file containing task parameters

**Options:**
- `--local <path>`: Path to the local data directory (default: `local` in current working directory)
- `--secretsFilePath <path>`: Path to the secrets file for encryption/decryption
- `--restartInfoFile <path>`: Path to the restart info JSON file (used for resuming interrupted tasks)

**Examples:**
```sh
# Install Node-RED
proxvex exec node-red installation ./params.json

# Install with custom local directory
proxvex exec node-red installation ./params.json --local ./my-local

# Backup with secrets file
proxvex exec node-red backup ./backup-params.json --secretsFilePath ./secrets.txt

# Resume interrupted task
proxvex exec node-red installation ./params.json --restartInfoFile ./restart-info.json
```

### Generate Documentation

Generate documentation for applications and templates:

```sh
proxvex gendoc [options]
```

**Options:**
- `--local <path>`: Path to the local data directory (default: `local` in current working directory)
- `--secretsFilePath <path>`: Path to the secrets file for encryption/decryption

**Examples:**
```sh
proxvex gendoc
proxvex gendoc --local ./my-local
```

### Validate Templates

Validate application templates against JSON schemas:

```sh
proxvex validate [options]
```

**Options:**
- `--local <path>`: Path to the local data directory (default: `local` in current working directory)

**Examples:**
```sh
proxvex validate
proxvex validate --local ./my-local
```

### Help

Display help information:

```sh
proxvex --help
# or
proxvex -h
```

### Parameters File Format

The parameters file is a JSON file that contains the input values required for executing a task. It must be a JSON array where each element is an object with `name` and `value` properties.

**Format:**
```json
[
  {
    "name": "parameter_name",
    "value": "parameter_value"
  },
  {
    "name": "another_parameter",
    "value": 123
  },
  {
    "name": "boolean_parameter",
    "value": true
  }
]
```

**Properties:**
- **`name`** (string, required): The name/ID of the parameter as defined in the application templates
- **`value`** (string | number | boolean, required): The value for the parameter

**Finding Required Parameters:**
1. **Use the Web UI**: Shows all required and optional parameters with descriptions
2. **Check application templates**: Look in `json/applications/<application-name>/`
3. **Run without parameters file**: Proxvex will output a template with all required parameter names

**Example for installing Node-RED:**
```json
[
  {
    "name": "hostname",
    "value": "node-red"
  },
  {
    "name": "vm_id",
    "value": 100
  },
  {
    "name": "static_ip",
    "value": "192.168.1.100/24"
  },
  {
    "name": "gateway",
    "value": "192.168.1.1"
  }
]
```
