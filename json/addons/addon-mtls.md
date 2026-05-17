# mTLS Client Certificates Addon

Issue per-user **client certificates** for mutual-TLS authentication. Each
certificate is signed by the project root CA (the same CA used by the SSL
addon). The CA private key never leaves the backend — signing happens on the
Hub (or via the Hub API in Spoke mode); the container only receives the
finished, signed material.

## Parameters

### `mtls_cns`

One Common Name (CN) per line. Each line gets its own CA-signed client
certificate. CN characters are restricted to `[A-Za-z0-9._-]`.

Default: a single entry equal to the container hostname.

```
alice
bob
service-account
```

## Output Layout

The addon mounts a managed volume at `/etc/mtls` (mode `0700`) and writes one
subfolder per CN, using Let's-Encrypt-style filenames:

```
/etc/mtls/<CN>/privkey.pem    # client private key (mode 0600)
/etc/mtls/<CN>/cert.pem       # client certificate (clientAuth, CA:FALSE)
/etc/mtls/<CN>/chain.pem      # root CA public certificate
```

Files are owned by the application's effective UID/GID.

## Consuming the Certificates

Point a client at one CN folder. Example (MQTT client connecting to an
mTLS-protected broker):

- key:  `/etc/mtls/<CN>/privkey.pem`
- cert: `/etc/mtls/<CN>/cert.pem`
- CA:   `/etc/mtls/<CN>/chain.pem`

The broker (e.g. eclipse-mosquitto with `require_certificate true` and
`use_identity_as_username true`) maps the certificate CN to the authenticated
username.

## Behaviour Notes

- **Idempotent:** an existing on-disk cert is kept when its identity (CN) still
  matches and it is valid for ≥ 30 days and still verifies against the current
  CA. Otherwise the key+cert pair is rewritten.
- **CA rotation:** if the root CA is regenerated, certificates that no longer
  verify against it are reissued automatically on the next reconfigure.
- The addon is **opt-in per application** via the application's
  `supported_addons`; it does nothing unless explicitly selected.
