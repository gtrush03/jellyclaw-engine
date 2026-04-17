# Installing Jellyclaw

Three installation paths are available depending on your needs:

## npm (Recommended for developers)

```bash
npm install -g @jellyclaw/engine
```

This installs the CLI tools (`jellyclaw`, `jellyclaw-serve`, `jellyclaw-daemon`) globally.

### Requirements

- Node.js >= 20.6
- macOS, Linux, or Windows with WSL

### Verify installation

```bash
jellyclaw --version
jellyclaw doctor
```

## Homebrew (macOS)

```bash
brew tap gtrush/jellyclaw
brew install jellyclaw
```

This installs the pre-built, signed universal binary.

### Requirements

- macOS Monterey (12.0) or later
- Homebrew

### Verify installation

```bash
jellyclaw --version
jellyclaw doctor
```

## DMG Download (macOS)

1. Download the latest DMG from [GitHub Releases](https://github.com/gtrush03/jellyclaw-engine/releases)
2. Open the DMG and drag Jellyclaw to Applications
3. Open Jellyclaw from Applications

The DMG includes a signed, notarized, universal binary that runs on both Intel and Apple Silicon Macs.

## Post-installation

After installing, run the health check to verify your setup:

```bash
jellyclaw doctor
```

This validates:
- Node.js version
- Runtime environment
- Directory permissions (~/.jellyclaw/)
- API key configuration
- MCP server connectivity

### Setting up your API key

Jellyclaw requires an Anthropic API key:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

Add this to your shell profile (`~/.bashrc`, `~/.zshrc`, etc.) for persistence.

## Upgrading

### npm

```bash
npm update -g @jellyclaw/engine
```

### Homebrew

```bash
brew upgrade jellyclaw
```

### DMG

Download the latest DMG and replace the existing application.

## Troubleshooting

Run `jellyclaw doctor --json` for machine-readable diagnostics.

Common issues:

| Issue | Solution |
|-------|----------|
| Node version too old | `nvm install 20` or `brew install node@20` |
| Permission denied on ~/.jellyclaw | `chmod 700 ~/.jellyclaw` |
| Missing API key | Set `ANTHROPIC_API_KEY` environment variable |
