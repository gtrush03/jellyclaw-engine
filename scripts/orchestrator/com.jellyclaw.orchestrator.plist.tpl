<?xml version="1.0" encoding="UTF-8"?>
<!--
  com.jellyclaw.orchestrator — macOS launchd agent template for the
  jc-orchestrator tmux supervision session.

  This is a TEMPLATE. Copy it to ~/Library/LaunchAgents/ and adjust paths
  before loading. `{{REPO_ROOT}}` below must be replaced with the absolute
  path to your jellyclaw-engine checkout.

  Install:
    REPO="/Users/gtrush/Downloads/jellyclaw-engine"
    sed "s|{{REPO_ROOT}}|${REPO}|g" \
      "${REPO}/scripts/orchestrator/com.jellyclaw.orchestrator.plist.tpl" \
      > ~/Library/LaunchAgents/com.jellyclaw.orchestrator.plist
    launchctl load -w ~/Library/LaunchAgents/com.jellyclaw.orchestrator.plist

  Uninstall:
    launchctl unload ~/Library/LaunchAgents/com.jellyclaw.orchestrator.plist
    rm ~/Library/LaunchAgents/com.jellyclaw.orchestrator.plist

  Restart:
    launchctl kickstart -k gui/$(id -u)/com.jellyclaw.orchestrator

  Logs:
    tail -f /tmp/jellyclaw-orchestrator.log
    tail -f /tmp/jellyclaw-orchestrator.err.log

  Notes:
    - LaunchAgent (per-user), not LaunchDaemon.
    - Uses /bin/bash -lc so interactive shell profile (homebrew PATH, nvm) is loaded.
      tmux and node must be resolvable via that PATH.
    - KeepAlive with ThrottleInterval=30 → if spawn.sh crashes, relaunches after 30s.
    - spawn.sh is idempotent — running at load when the session already exists is a no-op.
-->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.jellyclaw.orchestrator</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-lc</string>
        <string>exec {{REPO_ROOT}}/scripts/orchestrator/spawn.sh</string>
    </array>

    <key>WorkingDirectory</key>
    <string>{{REPO_ROOT}}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>30</integer>

    <key>ProcessType</key>
    <string>Interactive</string>

    <key>StandardOutPath</key>
    <string>/tmp/jellyclaw-orchestrator.log</string>

    <key>StandardErrorPath</key>
    <string>/tmp/jellyclaw-orchestrator.err.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>AUTOBUILD_ROOT</key>
        <string>{{REPO_ROOT}}</string>
    </dict>
</dict>
</plist>
