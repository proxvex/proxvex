"""LXC Notes Common Library.

Shared functions for writing LXC container notes/description.
Used by host-write-lxc-notes.py and host-write-docker-compose-notes.py.

This is a library - import and use the functions, do not execute directly.
Libraries must NOT contain {{ }} template variables.
"""

import subprocess
import sys
import json

PVE_DESCRIPTION_LIMIT = 8192


def not_defined(val):
    """Check if a template variable was not set (replaced with NOT_DEFINED or empty)."""
    return val == "NOT_DEFINED" or val == ""


def normalize_value(raw):
    """Return empty string if value is not defined, otherwise return as-is."""
    return "" if not_defined(raw) else raw


def strip_oci_prefix(oci_image_raw):
    """Strip docker:// or oci:// prefix from OCI image string for display."""
    for prefix in ["docker://", "oci://"]:
        if oci_image_raw.startswith(prefix):
            return oci_image_raw[len(prefix):]
    return oci_image_raw


def build_hidden_markers(vmid, oci_image_visible="", app_id="", app_name="",
                         version="", deployer_url="", ve_context="",
                         icon_base64="", icon_mime_type="",
                         username="", uid="", gid="",
                         is_deployer=False, stack_name=""):
    """Build hidden HTML comment markers for machine parsing."""
    lines = []
    lines.append("<!-- oci-lxc-deployer:managed -->")
    if is_deployer:
        lines.append("<!-- oci-lxc-deployer:deployer-instance -->")
    if oci_image_visible:
        lines.append("<!-- oci-lxc-deployer:oci-image %s -->" % oci_image_visible)
    if app_id:
        lines.append("<!-- oci-lxc-deployer:application-id %s -->" % app_id)
    if app_name:
        lines.append("<!-- oci-lxc-deployer:application-name %s -->" % app_name)
    if version:
        lines.append("<!-- oci-lxc-deployer:version %s -->" % version)
    if deployer_url and ve_context:
        lines.append("<!-- oci-lxc-deployer:log-url %s/logs/%s/%s -->" % (deployer_url, ve_context, vmid))
    if icon_base64 and icon_mime_type:
        lines.append("<!-- oci-lxc-deployer:icon-url data:%s;base64,... -->" % icon_mime_type)
    if username:
        lines.append("<!-- oci-lxc-deployer:username %s -->" % username)
    if uid:
        lines.append("<!-- oci-lxc-deployer:uid %s -->" % uid)
    if gid:
        lines.append("<!-- oci-lxc-deployer:gid %s -->" % gid)
    if stack_name:
        lines.append("<!-- oci-lxc-deployer:stack-name %s -->" % stack_name)
    return lines


def build_visible_header(app_id="", app_name="", oci_image_tag="",
                         icon_base64="", icon_mime_type="", include_icon=True):
    """Build visible Markdown header: title with version tag, icon."""
    lines = []
    header_name = app_name if app_name else app_id if app_id else "Container"
    if oci_image_tag:
        lines.append("# %s (%s)" % (header_name, oci_image_tag))
    else:
        lines.append("# %s" % header_name)

    if include_icon and icon_base64 and icon_mime_type:
        icon_alt = app_name if app_name else app_id
        lines.append('<img src="data:%s;base64,%s" width="16" height="16" alt="%s"/>' % (icon_mime_type, icon_base64, icon_alt))

    return lines


def build_links_section(vmid, deployer_url, ve_context, link_text="Logs"):
    """Build the Links section with log viewer link and managed-by footer."""
    if not deployer_url or not ve_context:
        return []
    lines = []
    lines.append("")
    lines.append("**Links**")
    lines.append("- [%s](%s/logs/%s/%s)" % (link_text, deployer_url, ve_context, vmid))

    if deployer_url:
        lines.append("Managed by [oci-lxc-deployer](%s/)." % deployer_url)

    return lines


def write_notes(vmid, notes_content_with_icon, notes_content_without_icon):
    """Write notes to LXC container via pct set, handling size limits and JSON output."""
    notes_content = notes_content_with_icon
    if len(notes_content) > PVE_DESCRIPTION_LIMIT:
        print("Notes exceed %d chars (%d), omitting inline icon" % (PVE_DESCRIPTION_LIMIT, len(notes_content)), file=sys.stderr)
        notes_content = notes_content_without_icon

    try:
        result = subprocess.run(
            ["pct", "set", vmid, "--description", notes_content],
            capture_output=True,
            text=True
        )
        if result.returncode != 0:
            print("Warning: pct set failed: %s" % result.stderr, file=sys.stderr)
        else:
            print("Notes written for container %s" % vmid, file=sys.stderr)
    except Exception as e:
        print("Warning: Failed to write notes: %s" % e, file=sys.stderr)

    print(json.dumps({"id": "notes_written", "value": "true"}))
