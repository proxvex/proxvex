# E2E Testing with Proxmox VM

## Implementation Status

| Component | Status | File |
|-----------|--------|------|
| Infrastructure Scripts | Done | `e2e/step0-2-*.sh` |
| Application Loader | Done | `e2e/utils/application-loader.ts` |
| SSH Validator | Done | `e2e/utils/ssh-validator.ts` |
| Install Helper | Done | `e2e/utils/application-install-helper.ts` |
| Test Applications | Done | `e2e/applications/{mosquitto,postgres,node-red}/appconf.json` |
| Playwright Tests | Done | `e2e/tests/application-install.spec.ts` |
| Frontend data-testid | Done | Various frontend components |

## Goal

End-to-end testing with automated VM creation, oci-lxc-deployer installation, and Mosquitto deployment via docker-compose.

## Test Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Development Machine                                                    │
│  └── SSH → pve1.cluster                                                 │
│           └── Step 0: Create custom Proxmox ISO with answer file        │
│           └── Step 1: Create VM (QEMU) with Proxmox ISO                 │
│           └── Step 2: Wait for unattended Proxmox installation          │
│           └── Step 3: Install oci-lxc-deployer                          │
│           └── Step 4: Install Samba addon for local directory           │
│           └── Step 5: Create Mosquitto via docker-compose.yml           │
│           └── Step 6: Upload configuration file                         │
│           └── Step 7: Verify MQTT connection + config                   │
│           └── Step 8: Delete VM                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Step 0: Create Custom Proxmox ISO

Creates a Proxmox ISO with embedded answer file for unattended installation.

### Usage

```bash
# From development machine
./backend/tests/e2e/step0-create-iso.sh pve1.cluster

# The script will:
# 1. Copy necessary files to pve1:/tmp/e2e-iso-build/
# 2. Download Proxmox ISO if not present
# 3. Create answer file with correct apt repository URLs
# 4. Build custom ISO with proxmox-auto-install-assistant
# 5. Move ISO to /var/lib/vz/template/iso/ for easy installation
```

### Files

```
backend/tests/e2e/
├── step0-create-iso.sh          # Main script (runs on dev machine)
├── pve1-scripts/
│   ├── answer-e2e.toml          # Answer file with apt repos + SSH key
│   ├── create-iso.sh            # Runs on pve1 to build ISO
│   └── first-boot.sh            # Configures apt repos on first boot
└── README.md
```

### Answer File Configuration

- **Network**: DHCP during install, then static IP via first-boot.sh
- **Keyboard/Timezone**: German (de)
- **Filesystem**: ext4 on LVM
- **Root Password**: `e2e-test-2024`
- **SSH Keys**: Automatically includes host's SSH key
- **First Boot**: Configures static IP, Proxmox no-subscription repo

### Host-Specific Network Configuration

Each host has its own NAT subnet to avoid IP conflicts when running E2E tests in parallel:

| Host | NAT Subnet | Nested VM IP | Container DHCP Range |
|------|------------|--------------|---------------------|
| pve1.cluster | 10.99.0.0/24 | 10.99.0.10 | 10.99.0.100-200 |
| ubuntupve | 10.99.1.0/24 | 10.99.1.10 | 10.99.1.100-200 |

The scripts automatically detect the target host and use the appropriate subnet.

### Result

ISO at `/var/lib/vz/template/iso/proxmox-ve-e2e-autoinstall.iso`

---

## Step 1: Create Nested Proxmox VM

```bash
./e2e/step1-create-vm.sh ubuntupve
```

Creates a nested Proxmox VM using the custom ISO with:
- Memory: 2048 MB, Cores: 2, Disk: 32 GB
- Network: vmbr1 (NAT bridge)
- Port forwarding: 1008→8006, 1022→22, 3000→3080

## Step 2: Install oci-lxc-deployer

```bash
./e2e/step2-install-deployer.sh
```

Installs oci-lxc-deployer container (VMID 300) with:
- Static IP: 10.0.0.100/24
- API accessible at http://ubuntupve:3080

---

## Generic Application Installation Tests

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Playwright Test                                                        │
│  └── ApplicationInstallHelper (UI Navigation)                           │
│       └── Create Application via wizard                                 │
│       └── Install Application via dialog                                │
│       └── Wait for installation complete                                │
│  └── SSHValidator (Post-Install Validation)                             │
│       └── ssh ubuntupve -p 1022 "pct exec 300 -- <command>"            │
│       └── Validate containers, ports, files, commands                   │
└─────────────────────────────────────────────────────────────────────────┘
```

### File Structure

```
e2e/
├── applications/                    # Test application definitions
│   ├── mosquitto/
│   │   ├── appconf.json            # App config with validation rules
│   │   ├── mosquitto.docker-compose.yml
│   │   └── icon.svg
│   ├── postgres/
│   │   ├── appconf.json
│   │   └── postgres.docker-compose.yml
│   └── node-red/
│       ├── appconf.json
│       └── node-red.docker-compose.yml
├── utils/
│   ├── application-loader.ts       # Loads apps from applications/
│   ├── ssh-validator.ts            # SSH-based validation helper
│   └── application-install-helper.ts # Playwright page object
├── fixtures/
│   └── test-base.ts                # API_URL, SSH_HOST, fixtures
├── tests/
│   └── application-install.spec.ts # Generic installation tests
└── scripts/
    └── snapshot-rollback.sh        # Reset to baseline
```

### appconf.json Schema

Each test application can define validation rules in `appconf.json`:

```typescript
interface AppConf {
  name?: string;
  description?: string;
  tasktype?: 'default' | 'postgres';
  uploadfiles?: UploadFile[];
  validation?: ValidationConfig;
}

interface ValidationConfig {
  waitBeforeValidation?: number;  // Seconds to wait before validation
  containers?: ContainerValidation[];
  ports?: PortValidation[];
  files?: FileValidation[];
  commands?: CommandValidation[];
}

interface ContainerValidation {
  image: string;        // Image name (partial match)
  state?: 'running';
}

interface PortValidation {
  port: number;
  protocol?: 'tcp' | 'udp';
  service?: string;     // For error messages
}

interface FileValidation {
  path: string;
  contentPattern?: string;  // Regex
}

interface CommandValidation {
  command: string;
  expectedExitCode?: number;
  expectedOutput?: string;  // Regex
  description?: string;
}
```

### Example: postgres/appconf.json

```json
{
  "name": "postgres",
  "description": "PostgreSQL database",
  "tasktype": "postgres",
  "validation": {
    "waitBeforeValidation": 30,
    "containers": [
      { "image": "postgres", "state": "running" }
    ],
    "ports": [
      { "port": 5432, "service": "PostgreSQL" }
    ],
    "commands": [
      {
        "command": "docker exec $(docker ps -qf ancestor=postgres) pg_isready",
        "expectedExitCode": 0,
        "description": "PostgreSQL is ready"
      }
    ]
  }
}
```

### Example: mosquitto/appconf.json

```json
{
  "name": "mosquitto",
  "description": "Eclipse Mosquitto MQTT broker",
  "uploadfiles": [
    { "filename": "mosquitto.conf", "destination": "config:mosquitto.conf" }
  ],
  "validation": {
    "waitBeforeValidation": 15,
    "containers": [
      { "image": "eclipse-mosquitto", "state": "running" }
    ],
    "ports": [
      { "port": 1883, "protocol": "tcp", "service": "MQTT" }
    ]
  }
}
```

### Running Tests

```bash
# Run all application installation tests
npx playwright test e2e/tests/application-install.spec.ts

# Run specific application test
npx playwright test -g "install and validate mosquitto"

# Run with headed browser
npx playwright test e2e/tests/application-install.spec.ts --headed

# Debug mode
npx playwright test --debug
```

### Test Flow

1. **beforeEach**: Reset to baseline snapshot via `resetToBaseline()`
2. **Create Application**: Navigate wizard, upload docker-compose, set properties
3. **Install Application**: Click install, wait for completion on monitor page
4. **Validate via SSH**:
   - `ssh ubuntupve -p 1022 "pct exec 300 -- docker ps"` (containers)
   - `ssh ubuntupve -p 1022 "pct exec 300 -- ss -tln"` (ports)
   - `ssh ubuntupve -p 1022 "pct exec 300 -- test -f /path"` (files)
   - Custom validation commands

### SSH Validation Helper

```typescript
const validator = new SSHValidator({
  sshHost: 'ubuntupve',  // or SSH_HOST from fixtures
  sshPort: 1022,         // Port forward to nested PVE
  containerVmId: '300'   // Deployer container ID
});

// Execute command in container
const output = validator.execInContainer('docker ps');

// Run all validations from appconf.json
const results = await validator.runValidations(app.validation);
for (const result of results) {
  expect(result.success, result.message).toBe(true);
}
```

### Frontend data-testid Attributes

For robust UI selectors, use `data-testid` attributes:

| Component | Selector | Element |
|-----------|----------|---------|
| Framework Step | `[data-testid="framework-select"]` | Framework dropdown |
| Framework Step | `[data-testid="docker-compose-upload"]` | File input |
| Properties Step | `[data-testid="app-name-input"]` | Name input |
| Properties Step | `[data-testid="icon-upload"]` | Icon file input |
| Summary Step | `[data-testid="create-application-btn"]` | Create button |
| Navigation | `[data-testid="next-step-btn"]` | Next button |
| Applications | `[data-testid="install-app-btn"]` | Install button |
| Monitor | `[data-testid="installation-success"]` | Success indicator |

---

## Future: GitHub Runner Integration

A GitHub Actions self-hosted runner can be installed as LXC container on pve1.cluster:

```bash
# Create LXC for runner
pct create 200 local:vztmpl/debian-12-standard_12.0-1_amd64.tar.zst \
  --hostname github-runner \
  --memory 2048 \
  --cores 2 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp

# Install runner inside container
# See backend/tests/e2e/README.md for details
```

---

## Accessing App UIs via SSH SOCKS Proxy

Apps are created as separate LXC containers with dynamic DHCP IPs, so direct HTTP access from outside is not possible. An SSH SOCKS proxy solves this.

### 1. Start SOCKS Proxy

```bash
# Keep terminal open (pve1.cluster as example)
ssh -D 1080 -p 1022 root@pve1.cluster -N
```

### 2. Configure Browser

The PAC file `e2e/proxy.pac` routes only container IPs (10.0.0.x) through the proxy.

**Firefox:**
1. `about:preferences` → Search "Proxy"
2. "Settings..." → "Automatic proxy configuration URL"
3. Enter: `file:///PATH/TO/PROJECT/e2e/proxy.pac`

**Chrome:**
```bash
google-chrome --proxy-pac-url="file:///PATH/TO/PROJECT/e2e/proxy.pac"
```

### 3. Find Container IP

```bash
# Show DHCP leases
ssh -p 1022 root@pve1.cluster "cat /var/lib/misc/dnsmasq.leases"

# Example output:
# 1707500000 aa:bb:cc:dd:ee:ff 10.0.0.105 node-red *
```

### 4. Open App in Browser

With active SOCKS proxy and PAC file:
- `http://10.0.0.105:1880` → Node-RED
- `http://10.0.0.106:1883` → Mosquitto Web UI (if available)

### CLI Access (without Proxy)

For CLI tools, continue using SSH directly:

```bash
# Login to container
ssh -p 1022 root@pve1.cluster "lxc-attach -n 105"

# Execute command in container
ssh -p 1022 root@pve1.cluster "pct exec 105 -- curl localhost:1880"
```

---

## References

- [Proxmox Automated Installation](https://pve.proxmox.com/wiki/Automated_Installation)
- [proxmox-auto-install-assistant](https://pve.proxmox.com/wiki/Automated_Installation#Assistant_Tool)
