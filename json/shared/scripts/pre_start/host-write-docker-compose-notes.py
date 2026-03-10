#!/usr/bin/env python3
# host-write-docker-compose-notes.py
# Writes the LXC container notes/description for docker-compose apps.
# Uses lxc-notes-common.py library for shared functions.
#
# Differences from standard notes:
# - No "LXC template" line (Alpine OS template is not useful info)
# - No "Log file" line (logs come from docker-compose, not console)
# - Link text: "Logs" (generic, auto-detected by log viewer)

# Template variables (will be replaced by backend)
VMID = "{{ vm_id }}"
APP_ID_RAW = "{{ application_id }}"
APP_NAME_RAW = "{{ application_name }}"
VERSION_RAW = "{{ oci_image_tag }}"
DEPLOYER_URL_RAW = "{{ deployer_base_url }}"
VE_CONTEXT_RAW = "{{ ve_context_key }}"
HOSTNAME_RAW = "{{ hostname }}"
ICON_BASE64 = "{{ icon_base64 }}"
ICON_MIME_TYPE = "{{ icon_mime_type }}"
USERNAME_RAW = "{{ username }}"
UID_RAW = "{{ uid }}"
GID_RAW = "{{ gid }}"
STACK_NAME_RAW = "{{ stack_name }}"


def build_notes(include_icon):
    app_id = normalize_value(APP_ID_RAW)
    app_name = normalize_value(APP_NAME_RAW)
    version = normalize_value(VERSION_RAW)
    deployer_url = normalize_value(DEPLOYER_URL_RAW)
    ve_context = normalize_value(VE_CONTEXT_RAW)
    icon_base64 = normalize_value(ICON_BASE64)
    icon_mime_type = normalize_value(ICON_MIME_TYPE)
    username = normalize_value(USERNAME_RAW)
    uid = normalize_value(UID_RAW)
    gid = normalize_value(GID_RAW)
    stack_name = normalize_value(STACK_NAME_RAW)

    lines = build_hidden_markers(
        VMID, app_id=app_id, app_name=app_name, version=version,
        deployer_url=deployer_url, ve_context=ve_context,
        icon_base64=icon_base64, icon_mime_type=icon_mime_type,
        username=username, uid=uid, gid=gid, stack_name=stack_name,
    )

    lines += build_visible_header(
        app_id=app_id, app_name=app_name, oci_image_tag=version,
        icon_base64=icon_base64, icon_mime_type=icon_mime_type,
        include_icon=include_icon,
    )

    lines += build_links_section(VMID, deployer_url, ve_context, link_text="Logs")

    return "\n".join(lines)


def main():
    notes_with_icon = build_notes(include_icon=True)
    notes_without_icon = build_notes(include_icon=False)
    write_notes(VMID, notes_with_icon, notes_without_icon)


if __name__ == "__main__":
    main()
