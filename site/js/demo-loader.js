// site/js/demo-loader.js
// Lazy-loads asciinema-player when #demo-mount scrolls into view.
// Falls back to a static frame if the player asset is missing or the user
// prefers reduced motion. No external CDN — all paths are same-origin.
(() => {
  const mount = document.getElementById('demo-mount');
  if (!mount) return;
  const cast = mount.dataset.demoSrc;
  const poster = mount.dataset.demoPoster;
  const playerJs = mount.dataset.playerSrc;
  const playerCss = mount.dataset.playerCss;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const renderPoster = (msg) => {
    mount.replaceChildren();
    if (poster) {
      const img = new Image();
      img.src = poster;
      img.alt = 'jellyclaw TUI session — first frame';
      img.width = 960; img.height = 540;
      img.decoding = 'async';
      img.className = 'static-fallback';
      mount.append(img);
    }
    if (msg) mount.dataset.state = msg;
  };

  if (reduced || !cast || !playerJs) { renderPoster('error'); return; }

  const loadPlayer = () => {
    mount.dataset.state = 'loading';
    if (playerCss) {
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = playerCss;
      document.head.append(link);
    }
    const script = document.createElement('script');
    script.src = playerJs; script.defer = true;
    script.onload = () => {
      try {
        delete mount.dataset.state;
        mount.replaceChildren();
        // eslint-disable-next-line no-undef
        AsciinemaPlayer.create(cast, mount, { autoPlay: true, loop: true, speed: 1.2, idleTimeLimit: 1.5, theme: 'jellyclaw' });
      } catch (err) { renderPoster('error'); }
    };
    script.onerror = () => renderPoster('error');
    document.head.append(script);
  };

  if (!('IntersectionObserver' in window)) { loadPlayer(); return; }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { io.disconnect(); loadPlayer(); break; }
  }, { rootMargin: '200px' });
  io.observe(mount);
})();
