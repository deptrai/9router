# 9R MITM Client

Standalone MITM client for 9router — intercept Devin CLI / Windsurf / Copilot / Cursor traffic and forward to remote 9router instance.

## Install

```bash
# Install globally from npm
npm i -g 9r-mitm-client

# Or install from local source
cd mitm-client && npm pack && npm i -g ./9r-mitm-client-*.tgz
```

## Quick Start

```bash
# 1. Generate Root CA and trust it in system keychain
mitm-client setup

# 2. Configure 9router URL and API key
mitm-client config routerUrl http://localhost:20128
mitm-client config apiKey sk-xxxx

# 3. Start MITM server (needs sudo for port 443)
sudo mitm-client start

# 4. Enable DNS redirect for a tool
sudo mitm-client dns-on windsurf
```

Or use the setup wizard for guided first-time setup:

```bash
sudo mitm-client wizard
```

## Commands

| Command | Description |
|---------|-------------|
| `setup` | Generate Root CA + trust in system keychain |
| `start` | Start MITM server on :443 (needs root/sudo) |
| `stop` | Stop running MITM server |
| `status` | Show MITM server + DNS status |
| `dns-on <tool>` | Enable DNS redirect for tool (windsurf\|antigravity\|copilot\|kiro\|cursor) |
| `dns-off <tool>` | Disable DNS redirect for tool |
| `dns-off-all` | Disable all DNS redirects |
| `config <key> [value]` | Get/set config (routerUrl, apiKey, mitmDebug) |
| `config --list` | Show full config |
| `tui` | Interactive terminal UI (start/stop/dns/logs) |
| `logs [tail]` | Show recent MITM logs (or tail -f) |
| `detect-devin` | Auto-detect Devin CLI installation |
| `link-devin` | Link Devin CLI to MITM (backup + modify credentials.toml) |
| `unlink-devin` | Restore Devin CLI credentials from backup |
| `profile add <name> <url> <key>` | Save a config profile |
| `profile list` | List all config profiles |
| `profile use <name>` | Switch active config profile |
| `profile remove <name>` | Remove a config profile |
| `autostart on` | Enable auto-start on boot (launchd/systemd/Task Scheduler) |
| `autostart off` | Disable auto-start on boot |
| `autostart status` | Show auto-start status |
| `wizard` | Interactive setup wizard (CA + config + start + DNS) |
| `uninstall` | Untrust CA + remove DNS + delete data dir |
| `--version` | Show version |
| `help` | Show help |

## Config Profiles

Profiles let you switch between multiple 9router instances:

```bash
# Add a production profile
mitm-client profile add prod http://prod-server:20128 sk-prod-key

# List all profiles
mitm-client profile list

# Switch to production
mitm-client profile use prod

# Switch back to local
mitm-client profile use local

# Remove a profile
mitm-client profile remove prod
```

Profiles are stored in `~/.9r-mitm-client/profiles.json` (mode 0o600).

## Auto-start on Boot

```bash
# Enable auto-start (creates launchd plist on macOS)
mitm-client autostart on

# Check status
mitm-client autostart status

# Disable
mitm-client autostart off
```

On macOS, the launchd plist detects the Node.js path at creation time (`process.execPath`), so it works regardless of how Node was installed (Homebrew, nvm, etc.).

## Devin CLI Integration

```bash
# Detect Devin CLI installation
mitm-client detect-devin

# Link Devin CLI to MITM (backs up credentials.toml)
mitm-client link-devin

# Unlink (restores from backup)
mitm-client unlink-devin
```

## Uninstall

```bash
# Remove CA trust, DNS entries, and data directory
mitm-client uninstall
```

## Development

### Protobuf Sync

Before every release, run the protobuf sync script to prevent drift from the parent `open-sse/utils/` module:

```bash
bash mitm-client/scripts/sync-protobuf.sh
```

This copies `windsurfProtobuf.js` and `windsurfAuth.js` from `open-sse/utils/` and auto-converts ESM imports/exports to CommonJS.

### Package Size

The npm package excludes tests, logs, and backup files via the `files` field in `package.json`. Target size: < 100KB (excluding `node-forge`).

## License

MIT
