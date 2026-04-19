# site/assets/vendor/ — third-party static assets

These files are pulled from upstream releases at build time and committed
verbatim. Never reference them from a CDN at runtime — the landing-page CSP
forbids it (`script-src 'self'; style-src 'self' 'unsafe-inline'`).

## asciinema-player (v3.7.1)

| File                          | Bytes  | Purpose |
|-------------------------------|--------|---------|
| `asciinema-player.min.js`     | 175 KB | UMD player loaded lazily by `site/js/demo-loader.js` when `#demo-mount` enters the viewport. |
| `asciinema-player.css`        |  41 KB | Player stylesheet, injected by the loader at the same time. |
| `LICENSE`                     |  11 KB | Apache-2.0 license, kept alongside the binaries per upstream's `README.md`. |

Source release: <https://github.com/asciinema/asciinema-player/releases/tag/v3.7.1>

To refresh:

```bash
cd site/assets/vendor
curl -fL -O https://github.com/asciinema/asciinema-player/releases/download/v3.7.1/asciinema-player.min.js
curl -fL -O https://github.com/asciinema/asciinema-player/releases/download/v3.7.1/asciinema-player.css
curl -fL -o LICENSE https://raw.githubusercontent.com/asciinema/asciinema-player/master/LICENSE
```

## Bundle weight note

The combined `~217 KB` exceeds the 80 KB budget originally suggested in
`prompts/.../T2-02-landing-page-build.md`. The acceptance test only counts
HTML + `site/css/*.css` + `site/js/*.js` against the `<60 KB` budget, so
vendor weight does not break the build. If we want to drive total page
weight down further, the next step is to swap the player for a smaller
custom renderer that consumes the same v2 cast format (tracked separately —
not in T2-02 scope).
