# Dashboard Screenshots

Capture these after every significant UI change. They feed the README, release
notes, and the landing-page hero strip.

## Setup

1. Boot the dashboard (`./start.sh`).
2. Quit every other app that can show a notification (menubar, Slack, etc.).
3. Set your display to its native resolution and 100% scaling.
4. Hide the cursor when possible: `defaults write com.apple.screencapture showsCursor -bool false` then `killall SystemUIServer`.
5. Optionally dim the menu bar with a full-screen window behind the capture region.

All paths below are relative to this file. Write output to `dashboard/docs/img/`
(create the directory on first run).

## Screenshots to capture

| # | Name                         | Description                                                          |
|---|------------------------------|----------------------------------------------------------------------|
| 1 | `01-dashboard-overview.png`  | Full dashboard, midway through phase 7, prompt selected              |
| 2 | `02-phase-list.png`          | Close-up of sidebar with mix of complete / in-progress / pending     |
| 3 | `03-prompt-viewer.png`       | A rendered prompt with Shiki syntax highlighting visible             |
| 4 | `04-progress-bar.png`        | Progress bar crop at ~62%, milestone dots visible                    |
| 5 | `05-keyboard-help.png`       | `?` overlay open over a blurred dashboard                            |
| 6 | `06-search-active.png`       | PromptSearch with a query typed, status chip active                  |
| 7 | `07-live-indicator.png`      | Top-right LIVE badge, tooltip showing "Last update: 3s ago"          |
| 8 | `08-empty-state.png`         | "Select a prompt" empty state in the detail pane                     |
| 9 | `09-skeleton.png`            | Page load skeleton (trigger by throttling network in devtools)       |
| 10| `10-toast.png`               | Copy-success toast bottom-right                                      |

## macOS capture commands

Full screen:

```bash
screencapture -x -t png "dashboard/docs/img/01-dashboard-overview.png"
```

Timed capture (5s delay to arrange state):

```bash
screencapture -T 5 -x -t png "dashboard/docs/img/05-keyboard-help.png"
```

Rectangle by coordinates (x, y, w, h). Replace the numbers with your
dashboard window bounds:

```bash
# e.g. dashboard window at (200, 120) sized 1440x900
screencapture -R 200,120,1440,900 -x -t png "dashboard/docs/img/01-dashboard-overview.png"
```

Interactive region (draw with crosshair):

```bash
screencapture -i -t png "dashboard/docs/img/04-progress-bar.png"
```

Single window (click to pick, shadow stripped):

```bash
screencapture -w -o -t png "dashboard/docs/img/03-prompt-viewer.png"
```

## Post-processing

- Resize each to 2560px wide max for README embeds:
  `sips -Z 2560 dashboard/docs/img/*.png`
- Convert to `.webp` only for marketing pages; keep `.png` in the repo.
- Never apply filters beyond a subtle drop-shadow if used on a landing page.
  Marketing chrome (shadows, device frames) belongs in the marketing repo,
  not in `dashboard/docs/img/`.

## Caption template (for README)

```md
![Jellyclaw dashboard overview](dashboard/docs/img/01-dashboard-overview.png)

*Jellyclaw Engine — phase 7 of 20, 63 prompts tracked, live SSE feed from
the local backend.*
```

## Checklist before committing

- [ ] No cursor visible
- [ ] No notifications, badges, or unread counts in menubar
- [ ] Dashboard data shows realistic content (not placeholder / "Loading…")
- [ ] Aspect ratio consistent across set (all 16:10 or all 16:9)
- [ ] File sizes under 800 KB each (re-export with `sips` if larger)
