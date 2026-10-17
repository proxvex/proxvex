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
# extra_envs overlays envs: keys here override/extend the base envs block.
# Lets CLI/production set individual env vars without restating the whole
# envs string (the frontend edits the full string directly, so this channel
# is CLI-only in practice). Empty / NOT_DEFINED → no-op.
extra_envs_str = """{{ extra_envs }}"""
# Init wrapper written by 109-host-install-init-wrapper (low ports for
# non-root apps, per-netns sysctls, IPv6 token).
INIT_WRAPPER = "/usr/local/sbin/proxvex-init"

# 109 decides whether the wrapper is needed and possible (root apps need no
# port change, distroless images have no shell) and reports it here. Only
# wrap the init when the wrapper file was actually written.
init_wrapper_installed = "{{ init_wrapper_installed }}"
use_init_wrapper = init_wrapper_installed.strip() == "true"

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

# Merge base envs with the extra_envs overlay (overlay keys win).
def merged_envs():
    merged = parse_envs(envs_str)
    overlay = parse_envs(extra_envs_str)
    if overlay:
        for key, value in overlay.items():
            action = "Override" if key in merged else "Add"
            print(f"{action} env from extra_envs: {key}={value}", file=sys.stderr)
        merged.update(overlay)
    return merged

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

# The wrapper writes /proc/sys, which only root may do. Proxmox derives
# lxc.init.uid/gid/groups from the image's User (nginx-unprivileged: 101), so
# PID 1 — and with it the wrapper — would start unprivileged and every sysctl
# write would silently fail. When the wrapper is used, move the user from the
# LXC config to the wrapper (`--as UID:GID:GROUPS`): init starts as root, the
# wrapper sets the sysctls and drops to that user right before exec.
def init_user_lines(lines):
    found = {}
    for line in lines:
        m = re.match(r'^lxc\.init\.(uid|gid|groups):\s*(.*)$', line.strip())
        if m:
            found[m.group(1)] = m.group(2).strip()
    return found

wrapper_cmd = INIT_WRAPPER
if use_init_wrapper:
    init_user = init_user_lines(new_lines)
    uid = init_user.get("uid", "")
    if uid and uid != "0":
        gid = init_user.get("gid", "") or uid
        groups = ",".join(g for g in re.split(r"[,\s]+", init_user.get("groups", "")) if g)
        wrapper_cmd = f"{INIT_WRAPPER} --as {uid}:{gid}:{groups}"
        new_lines = [l for l in new_lines if not re.match(r'^lxc\.init\.(uid|gid|groups):', l.strip())]
        print(f"Init wrapper runs as root and drops to uid {uid}:{gid} (groups '{groups}'); removed lxc.init.uid/gid/groups", file=sys.stderr)

# 2. Handle initial_command with substitution
if initial_command and initial_command != "NOT_DEFINED":
    env_dict = merged_envs()

    # Perform substitution
    # Use safe_substitute to avoid errors if a variable is missing
    # But shell style might use ${VAR} which Template supports
    try:
        # Template uses ${VAR} or $VAR
        template = string.Template(initial_command)
        resolved_command = template.safe_substitute(env_dict)
        
        # The app is PID 1, so per-netns sysctls (ip_unprivileged_port_start,
        # ip_forward, ...) cannot be set from inside before it starts. When the
        # deploy asks for any, 109-host-install-init-wrapper put /usr/local/
        # sbin/proxvex-init into the rootfs: it sets them and execs the real
        # command. Prepending it here keeps the original argv intact.
        if use_init_wrapper:
            resolved_command = f"{wrapper_cmd} {resolved_command}"

        # Remove existing init command lines first, otherwise a second run
        # (upgrade, reconfigure) appends a duplicate. Both spellings: the key
        # is written as lxc.init.cmd, older configs may carry lxc.init_cmd.
        new_lines = [
            line for line in new_lines
            if not (line.strip().startswith("lxc.init_cmd:") or line.strip().startswith("lxc.init.cmd:"))
        ]

        new_lines.append(f"lxc.init.cmd: {resolved_command}\n")
        print(f"Set lxc.init.cmd: {resolved_command}", file=sys.stderr)
        
    except Exception as e:
        print(f"Error substituting variables in command: {e}", file=sys.stderr)

# 2b. Without initial_command the container starts the image's own command,
# which Proxmox keeps in the `entrypoint:` key. Prepend the init wrapper there
# (once — the guard keeps a re-run from stacking it).
elif use_init_wrapper:
    wrapped_ep = False
    for i, line in enumerate(new_lines):
        if line.strip().startswith("entrypoint:"):
            ep_value = line.split(":", 1)[1].strip()
            if INIT_WRAPPER not in ep_value:
                new_lines[i] = f"entrypoint: {wrapper_cmd} {ep_value}\n"
                print(f"Wrapped entrypoint with init wrapper: {ep_value}", file=sys.stderr)
            wrapped_ep = True
            break
    if not wrapped_ep:
        print("Warning: init wrapper requested but no entrypoint found — sysctls will not be applied", file=sys.stderr)

# 3. Handle environment variables
# Set lxc.environment entries from envs (+ extra_envs overlay), removing
# lxc.environment.runtime duplicates
env_dict = merged_envs()
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
