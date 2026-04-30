# GitHub Actions Runner

Self-hosted GitHub Actions runner deployed as an LXC container by proxvex. The OCI image is built from [`e2e/infrastructure/github-runner/`](../../../e2e/infrastructure/github-runner/) and published as `ghcr.io/proxvex/github-actions-runner` by the `runner-image-publish.yml` workflow.

The container runs as PID 1 (entrypoint: `/entrypoint.sh`). On startup it:

1. Brings up the network and waits for connectivity.
2. Starts `dockerd` in the background (needed for workflows that build images, e.g. `step2b-install-deployer.sh`).
3. Reads the optional `nested_vm_id_ed25519` from `/var/lib/gh-runner-secrets/` and installs it as the SSH identity for nested-VM access.
4. Calls the GitHub API with the configured PAT to fetch a registration token.
5. Configures the runner (`config.sh ... --replace`) and starts it (`run.sh`).

## Required parameters

| Parameter | Description |
|---|---|
| `REPO_URL` | Full repo URL the runner registers against (e.g. `https://github.com/proxvex/proxvex`) |
| `ACCESS_TOKEN` | Fine-grained PAT with `Administration: Read and write` on the repo |

## Optional parameters

| Parameter | Default | Description |
|---|---|---|
| `RUNNER_NAME` | `proxvex-runner` | Display name in GitHub UI |
| `LABELS` | `self-hosted,linux,x64,ubuntupve` | Workflow `runs-on:` matchers |

## Volumes

- `secrets` (`/var/lib/gh-runner-secrets`, mode 0700) — drop a file `nested_vm_id_ed25519` here (private key only) and the entrypoint installs it for outbound SSH to nested VMs. The matching public key must be in the nested VM's `authorized_keys` (handled by `step1-create-vm.sh` when `GH_RUNNER_CTID` matches the runner CT).

## Updating

- Build a new image via the `runner-image-publish.yml` workflow (or manually via the Dockerfile in `e2e/infrastructure/github-runner/`).
- In proxvex: select the application instance → **Reconfigure** → bump `oci_image_tag`.
- Old runner gets `--replace`d on next start; previous registration is removed automatically.

## Memory / disk

Defaults: 8 GB RAM, 16 GB rootfs. The Angular frontend build inside `step2b` was OOM-killed with the typical 2 GB; 6 GB is the practical minimum, 8 GB leaves headroom for parallel npm tasks and dockerd.

## Networking

The container needs nesting=1 to run dockerd (handled via `101-conf-configure-lxc-for-docker.json` in `installation.pre_start`). It must be on the same bridge as ubuntupve so it can resolve the LAN-side hostname for SSH access to the nested VM port-forwards.
