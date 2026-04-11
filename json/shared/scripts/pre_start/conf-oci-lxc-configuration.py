#!/usr/bin/env python3
import os
import re
import string
import sys

# Get parameters
vm_id = "{{ vm_id }}"
hostname = "{{ hostname }}"
initial_command = """{{ initial_command }}"""
wait_for_network = """{{ wait_for_network }}"""
envs_str = """{{ envs }}"""

if not vm_id or vm_id == "NOT_DEFINED":
    print("Error: vm_id is not set", file=sys.stderr)
    sys.exit(1)

config_file = f"/etc/pve/lxc/{vm_id}.conf"
log_dir = "/var/log/lxc"
log_file = f"{log_dir}/{hostname}-{vm_id}.log"

if not os.path.exists(config_file):
    print(f"Error: Configuration file {config_file} not found", file=sys.stderr)
    sys.exit(1)

# Function to parse envs string into a dictionary
def parse_envs(envs_content):
    env_dict = {}
    if not envs_content or envs_content == "NOT_DEFINED":
        return env_dict
        
    for line in envs_content.split('\n'):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        
        # Split by first equals sign
        if '=' in line:
            key, value = line.split('=', 1)
            key = key.strip()
            # Remove quotes if present
            value = value.strip()
            if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
                value = value[1:-1]
            env_dict[key] = value
    return env_dict

# 1. Handle lxc.console.logpath
if not os.path.exists(log_dir):
    try:
        os.makedirs(log_dir)
        print(f"Created log directory: {log_dir}", file=sys.stderr)
    except OSError as e:
        print(f"Error creating log directory: {e}", file=sys.stderr)

# Read config file
try:
    with open(config_file, 'r') as f:
        lines = f.readlines()
except IOError as e:
    print(f"Error reading config file: {e}", file=sys.stderr)
    sys.exit(1)

# Check and update/append logfile
logfile_found = False
new_lines = []
for line in lines:
    if line.strip().startswith("lxc.console.logfile:"):
        new_lines.append(f"lxc.console.logfile: {log_file}\n")
        logfile_found = True
    else:
        new_lines.append(line)

if not logfile_found:
    new_lines.append(f"lxc.console.logfile: {log_file}\n")

print(f"Set lxc.console.logfile: {log_file}", file=sys.stderr)

# 2. Handle initial_command with substitution
if initial_command and initial_command != "NOT_DEFINED":
    env_dict = parse_envs(envs_str)
    
    # Perform substitution
    # Use safe_substitute to avoid errors if a variable is missing
    # But shell style might use ${VAR} which Template supports
    try:
        # Template uses ${VAR} or $VAR
        template = string.Template(initial_command)
        resolved_command = template.safe_substitute(env_dict)
        
        # Check if we should append or replace (usually append for init_cmd is fine if it wasn't there)
        # But if we run this script multiple times, we might duplicate.
        # Let's remove existing init_cmd lines first to be safe/idempotent
        new_lines = [line for line in new_lines if not line.strip().startswith("lxc.init_cmd:")]
        
        new_lines.append(f"lxc.init.cmd: {resolved_command}\n")
        print(f"Set lxc.init.cmd: {resolved_command}", file=sys.stderr)
        
    except Exception as e:
        print(f"Error substituting variables in command: {e}", file=sys.stderr)

# 3. Handle environment variables
# Set lxc.environment entries from envs, removing lxc.environment.runtime duplicates
env_dict = parse_envs(envs_str)
if env_dict:
    # Collect existing lxc.environment keys (preserve user-created entries)
    existing_env_keys = set()
    for line in new_lines:
        m = re.match(r'^lxc\.environment:\s*([^=]+)=', line.strip())
        if m:
            existing_env_keys.add(m.group(1))

    env_count = 0
    env_skipped = 0
    env_runtime_removed = 0
    for key, value in env_dict.items():
        if key in existing_env_keys:
            print(f"Skipping {key} - environment variable already exists", file=sys.stderr)
            env_skipped += 1
            continue

        # Remove matching lxc.environment.runtime entry (user value takes precedence)
        runtime_pattern = re.compile(rf'^lxc\.environment\.runtime:\s*{re.escape(key)}=')
        before_len = len(new_lines)
        new_lines = [line for line in new_lines if not runtime_pattern.match(line.strip())]
        if len(new_lines) < before_len:
            print(f"Removed runtime default for {key} (user value takes precedence)", file=sys.stderr)
            env_runtime_removed += 1

        new_lines.append(f"lxc.environment: {key}={value}\n")
        print(f"Set environment variable {key}={value}", file=sys.stderr)
        env_count += 1

    print(f"Set {env_count} environment variable(s) (skipped {env_skipped}, replaced {env_runtime_removed} runtime defaults)", file=sys.stderr)

# 4. Optionally wrap entrypoint to wait for network before starting.
# Only applied when wait_for_network=true (set in application properties).
# Most OCI images don't need this — only apps that connect to external
# services at startup (e.g. Gitea → PostgreSQL).
needs_network_wait = wait_for_network and wait_for_network.strip().lower() == "true"
if needs_network_wait:
    NETWORK_WAIT = 'i=0; while [ $i -lt 30 ]; do grep -q "00000000" /proc/net/route 2>/dev/null && break; i=$((i+1)); sleep 1; done; '
    final_lines = []
    wrapped = False
    for line in new_lines:
        if line.strip().startswith("entrypoint:") and NETWORK_WAIT not in line:
            ep_value = line.split(":", 1)[1].strip()
            escaped_ep = ep_value.replace("'", "'\\''")
            wrapped_ep = f"entrypoint: /bin/sh -c '{NETWORK_WAIT}exec {escaped_ep}'\n"
            final_lines.append(wrapped_ep)
            print(f"Wrapped entrypoint with network-wait: {ep_value}", file=sys.stderr)
            wrapped = True
        else:
            final_lines.append(line)
    new_lines = final_lines
    if not wrapped:
        print("No entrypoint found to wrap (skipping network-wait)", file=sys.stderr)
else:
    print("Network-wait disabled (wait_for_network not set)", file=sys.stderr)

# Write back config
try:
    with open(config_file, 'w') as f:
        f.writelines(new_lines)
except IOError as e:
    print(f"Error writing config file: {e}", file=sys.stderr)
    sys.exit(1)
