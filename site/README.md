# site/

The project landing page — a single self-contained `index.html` (no build step,
no external requests).

- Open it directly in a browser, or serve it statically (e.g. GitHub Pages).
- Fonts (GFS Didot · Instrument Sans · IBM Plex Mono) are subset (latin+greek)
  and embedded as data-URI woff2 inside the `<style id="fonts">` block.
- The 3D hero is raw WebGL (no three.js); the reconnect diorama is a scripted
  DOM state machine. Both respect `prefers-reduced-motion` and the page
  degrades gracefully without WebGL/JS.
- To edit: all CSS/JS is inline in `index.html`.
