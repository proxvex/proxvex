#!/bin/sh
# List all USB input devices (keyboard/mouse) on the VE host that are not already mapped to running LXC containers
#
# This script lists all USB input devices by:
# 1. Scanning /sys/class/input for input devices
# 2. Matching devices to USB bus:device identifiers
# 3. Checking which devices are already mapped to running containers
# 4. Formatting as JSON array for enumValues
#
# Output format: JSON array of objects with name and value fields
# Example: [{"name":"USB Keyboard","value":"1:2"}, ...]
#
# Library: usb-device-common.sh (automatically prepended)
#
# Output: JSON to stdout (errors to stderr)
exec >&2

set -e

# USB input devices are optional. A headless host has no /sys/class/input
# — that's not an error, just nothing to enumerate. Emit an empty list so
# enum-resolution succeeds and the deploy proceeds.
if [ ! -d "/sys/class/input" ]; then
  echo "Note: /sys/class/input missing — no USB input devices on this host." >&2
  printf '[]'
  exit 0
fi

FIRST=true
printf '['

# Process all input devices
for INPUT_DEVICE in /sys/class/input/event*; do
  [ ! -e "$INPUT_DEVICE" ] && continue
  
  DEVICE_NAME=$(basename "$INPUT_DEVICE")
  
  # Find vendor/product ID from class device using library function
  if ! find_vendor_product_from_class_device "input" "$DEVICE_NAME"; then
    continue
  fi
  
  # Find USB device by vendor/product ID using library function
  if ! find_usb_device_by_vendor_product "$VENDOR_ID" "$PRODUCT_ID" "$DEVICE_NAME" "input/input*/event*"; then
    continue
  fi
  
  # Skip if device is already mapped to a running container
  if is_usb_device_mapped_in_running_containers "$USB_BUS" "$USB_DEVICE"; then
    continue
  fi
  
  # Get lsusb description using library function
  USB_INFO=$(get_lsusb_description "$USB_BUS" "$USB_DEVICE" || echo "")
  
  # Create name
  if [ -n "$USB_INFO" ] && [ "$USB_INFO" != "" ]; then
    NAME_TEXT="$USB_INFO"
  elif [ -n "$VENDOR_ID" ] && [ -n "$PRODUCT_ID" ]; then
    NAME_TEXT="ID ${VENDOR_ID}:${PRODUCT_ID}"
  else
    NAME_TEXT="$DEVICE_NAME"
  fi
  
  # Format and output JSON entry using library function
  format_json_device_entry "$NAME_TEXT" "${USB_BUS}:${USB_DEVICE}" "$FIRST"
  FIRST=false
done

printf ']'
exit 0

