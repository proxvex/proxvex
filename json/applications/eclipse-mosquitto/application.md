# Eclipse Mosquitto

MQTT broker for IoT messaging, supporting MQTT, MQTTS, and WebSocket protocols.

## Installation

### Key Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `hostname` | `eclipse-mosquitto` | Container hostname |
| `volumes` | `config=mosquitto/config` | Configuration directory |

The container runs as UID 1883 (mosquitto user).

## Configuration

### mosquitto.conf

Upload your `mosquitto.conf` file during installation. The file is placed at `/mosquitto/config/mosquitto.conf` inside the container.

Minimal configuration for unauthenticated MQTT:

```
listener 1883
allow_anonymous true
```

### TLS Configuration

Enable the `addon-ssl` addon (mode: `certs`) to provision certificates. Certificate files are placed at `/mosquitto/config/certs/` with ownership `1883:1883`.

Example `mosquitto.conf` for MQTTS:

```
listener 8883
certfile /mosquitto/config/certs/cert.pem
cafile /mosquitto/config/certs/chain.pem
keyfile /mosquitto/config/certs/privkey.pem
allow_anonymous true
```

Available certificate files:

| File | Path |
|------|------|
| Server certificate | `/mosquitto/config/certs/cert.pem` |
| CA certificate | `/mosquitto/config/certs/chain.pem` |
| Private key | `/mosquitto/config/certs/privkey.pem` |

### Updating mosquitto.conf

The upload only runs during installation. To change the configuration after deployment, edit the file directly in the volume on the PVE host and restart the container.

## Ports

| Port | Protocol | Description |
|------|----------|-------------|
| 1883 | TCP | MQTT |
| 8883 | TCP | MQTTS (TLS) |
| 9001 | TCP | MQTT over WebSocket |

## Upgrade

Pulls new Mosquitto image. Configuration volume is preserved.
