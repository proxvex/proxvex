#!/bin/sh
# Write ZITADEL YAML configuration files into the `config` managed volume
# before the LXC (and thus the docker container) starts.
#
# Runs on the PVE host (execute_on: ve). The deployer has already resolved
# the file: references and substituted {{ }} template variables, so the
# *_content parameters arrive as base64 of the final file content.
#
# Three files are written to the `config` volume:
#   zitadel.yaml        - base config (always)
#   zitadel.smtp.yaml   - SMTP overlay if SMTP_PASSWORD set, else comment-only
#   zitadel.init.yaml   - FirstInstance bootstrap config (always at install;
#                          removed later by the hardening step)
#
# Zitadel rejects partial/blank SMTP config in the FirstInstance migration,
# so when SMTP is not configured we deliberately write a comment-only (valid,
# empty) overlay rather than the substituted template with empty values — the
# static --config reference still resolves but contributes no
# SMTPConfiguration key.
#
# upload_pre_start_file (from upload-file-common.sh) skips files that already
# exist, preserving manual edits across reconfigure/upgrade.
set -eu

ZITADEL_YAML_B64="{{ zitadel_yaml_content }}"
ZITADEL_SMTP_YAML_B64="{{ zitadel_smtp_yaml_content }}"
ZITADEL_INIT_YAML_B64="{{ zitadel_init_yaml_content }}"
SMTP_PASSWORD="{{ SMTP_PASSWORD }}"
[ "$SMTP_PASSWORD" = "NOT_DEFINED" ] && SMTP_PASSWORD=""
ZITADEL_MASTERKEY="{{ ZITADEL_MASTERKEY }}"
[ "$ZITADEL_MASTERKEY" = "NOT_DEFINED" ] && ZITADEL_MASTERKEY=""

if [ -z "$SMTP_PASSWORD" ]; then
  echo "SMTP_PASSWORD empty — writing comment-only SMTP overlay" >&2
  ZITADEL_SMTP_YAML_B64=$(printf '# SMTP not configured at install time\n' | base64 | tr -d '\n')
fi

upload_pre_start_file "$ZITADEL_YAML_B64" "config:zitadel.yaml" \
  "ZITADEL config" "{{ hostname }}" "1000" "1001" \
  "{{ mapped_uid }}" "{{ mapped_gid }}" "{{ vm_id }}"

upload_pre_start_file "$ZITADEL_SMTP_YAML_B64" "config:zitadel.smtp.yaml" \
  "ZITADEL SMTP overlay" "{{ hostname }}" "1000" "1001" \
  "{{ mapped_uid }}" "{{ mapped_gid }}" "{{ vm_id }}"

upload_pre_start_file "$ZITADEL_INIT_YAML_B64" "config:zitadel.init.yaml" \
  "ZITADEL init config" "{{ hostname }}" "1000" "1001" \
  "{{ mapped_uid }}" "{{ mapped_gid }}" "{{ vm_id }}"

# Masterkey file for `--masterkeyFile /zitadel/config/masterkey`. Plain file,
# exactly the 32-char key, no trailing newline. NOT removed by hardening
# (needed on every start). Skipped when empty so a bad key file is never
# locked in by upload_pre_start_file's skip-if-exists.
if [ -n "$ZITADEL_MASTERKEY" ]; then
  MASTERKEY_B64=$(printf '%s' "$ZITADEL_MASTERKEY" | base64 | tr -d '\n')
  upload_pre_start_file "$MASTERKEY_B64" "config:masterkey" \
    "ZITADEL masterkey" "{{ hostname }}" "1000" "1001" \
    "{{ mapped_uid }}" "{{ mapped_gid }}" "{{ vm_id }}"
else
  echo "ZITADEL_MASTERKEY empty — masterkey file not written" >&2
fi

# Round-trip compose_file so it is variable-substituted and persisted as the
# canonical compose for the downstream upload step. resolveBase64Inputs
# substitutes {{ }} markers in base64 inputs before this script runs, so
# COMPOSE_FILE_B64 already holds the rendered compose; echoing it back as an
# output (compose_file, default:true in the manifest) makes that the value
# 320-post-upload-docker-compose-files writes. This replaces the implicit
# substitution the removed 160-conf-strip-empty-smtp used to provide for
# Zitadel installs that select no SSL addon.
COMPOSE_FILE_B64="{{ compose_file }}"

if [ "$UPLOAD_FILES_WRITTEN" -gt 0 ]; then
  WROTE=true
else
  WROTE=false
fi

printf '[{"id":"zitadel_yaml_written","value":"%s"},{"id":"compose_file","value":"%s"}]\n' \
  "$WROTE" "$COMPOSE_FILE_B64"
