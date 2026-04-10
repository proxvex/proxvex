# npm/Node.js Framework

Base framework for deploying Node.js applications via npm in LXC containers on Proxmox VE.

This is not a standalone application — other applications extend this framework via `"extends": "npm-nodejs"` in their `application.json`.

## How It Works

1. Creates an LXC container with the selected OS template
2. Installs Node.js and npm from the distribution package manager
3. Runs `npm install` for the application
4. Creates a systemd service to run the application

## Key Parameters

| Parameter | Description |
|-----------|-------------|
| `hostname` | Container hostname |
| `npm_package` | npm package name to install |
| `ostype` | Base OS template |
