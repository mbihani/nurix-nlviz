/**
 * Client-side chrome injected into every Claude-generated chart document before
 * it is handed to `<iframe srcDoc>`.
 *
 * Why client-side: pinned charts store their HTML in Lakebase, so charts pinned
 * before this existed must be fixed at render time, not at generation time.
 *
 * Two mechanisms, because CSS alone is not enough for Chart.js:
 *  1. CSS pins the document to the iframe viewport and makes the canvas wrapper
 *     flex-fill the space left by the heading.
 *  2. A script wraps the `Chart` constructor to force
 *     `responsive: true, maintainAspectRatio: false`. Chart.js writes the canvas
 *     size as an inline style, and with `maintainAspectRatio: true` it derives
 *     height from width — so it will overflow a short box no matter what the CSS
 *     says. The option has to be patched.
 *
 * Tables are the documented exception: they may scroll inside their own wrapper
 * while the page itself never does.
 */

const FIT_STYLE = `
html, body {
  margin: 0 !important;
  padding: 0 !important;
  width: 100% !important;
  height: 100% !important;
  max-height: 100% !important;
  overflow: hidden !important;
  background: transparent !important;
}
*, *::before, *::after { box-sizing: border-box; }
body { display: flex !important; flex-direction: column !important; }
body > * { flex: 0 0 auto; min-width: 0; }
h1, h2, h3, h4, h5, h6 { margin: 0 0 4px !important; line-height: 1.25 !important; }
p { margin: 0 0 4px !important; }
canvas { display: block !important; max-width: 100% !important; }
/* Applied by the fit script to the body-level ancestor of a canvas/table. */
.nlviz-fill { flex: 1 1 auto !important; min-height: 0 !important; position: relative !important; }
.nlviz-scroll { overflow: auto !important; }
table { max-width: 100%; }
`;

/**
 * Suppresses the generated document's own H1–H6 title. Used by pinned cards and
 * the expand modal, where the surrounding chrome already shows the question — so
 * the in-iframe heading is a redundant second header stealing chart height.
 */
const HIDE_TITLE_STYLE = `
body > h1, body > h2, body > h3, body > h4, body > h5, body > h6 { display: none !important; }
`;

const FIT_SCRIPT = `
(function () {
  var FILL = 'nlviz-fill', SCROLL = 'nlviz-scroll';

  // Force Chart.js to fill its container instead of holding an aspect ratio.
  // Trapped via a property setter so it applies no matter when the CDN bundle
  // assigns window.Chart, and before any generated code constructs a chart.
  var real;
  function wrap(C) {
    if (!C || C.__nlvizWrapped) return C;
    try {
      C.defaults.responsive = true;
      C.defaults.maintainAspectRatio = false;
    } catch (e) {}
    function Wrapped(item, cfg) {
      if (cfg && typeof cfg === 'object') {
        cfg.options = cfg.options || {};
        cfg.options.responsive = true;
        cfg.options.maintainAspectRatio = false;
      }
      var inst = new C(item, cfg);
      // The wrapper class may land after construction; re-measure once.
      setTimeout(function () { try { inst.resize(); } catch (e) {} }, 0);
      return inst;
    }
    Wrapped.prototype = C.prototype;
    try { Object.setPrototypeOf(Wrapped, C); } catch (e) {}
    Wrapped.__nlvizWrapped = true;
    return Wrapped;
  }
  try {
    Object.defineProperty(window, 'Chart', {
      configurable: true,
      get: function () { return real; },
      set: function (v) { real = wrap(v); }
    });
  } catch (e) {}

  function bodyChild(el) {
    while (el && el.parentElement && el.parentElement !== document.body) el = el.parentElement;
    return el && el.parentElement === document.body ? el : null;
  }

  function fit() {
    if (!document.body) return;
    var canvases = document.getElementsByTagName('canvas');
    for (var i = 0; i < canvases.length; i++) {
      var n = canvases[i].parentElement;
      while (n && n !== document.body) {
        n.style.minHeight = '0';
        if (n.parentElement === document.body) n.classList.add(FILL);
        else n.style.height = '100%';
        n = n.parentElement;
      }
    }
    // Tables are allowed to scroll — give them a scrolling wrapper instead of
    // letting them push the page past the viewport.
    var tables = document.getElementsByTagName('table');
    for (var j = 0; j < tables.length; j++) {
      var bc = bodyChild(tables[j]);
      if (bc) { bc.classList.add(FILL); bc.classList.add(SCROLL); }
    }
  }

  function schedule() { fit(); setTimeout(fit, 0); setTimeout(fit, 120); setTimeout(fit, 500); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', schedule);
  } else {
    schedule();
  }
  window.addEventListener('load', schedule);

  // Charts are often appended by a script that runs after our injection.
  try {
    var mo = new MutationObserver(fit);
    var start = function () { if (document.body) mo.observe(document.body, { childList: true, subtree: true }); };
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
    setTimeout(function () { try { mo.disconnect(); } catch (e) {} }, 4000);
  } catch (e) {}
})();
`;

/**
 * Inject the fit chrome into a generated chart document.
 *
 * The payload goes at the very start of `<head>` so the Chart trap is installed
 * before the Chart.js CDN tag runs. The CSS wins over the document's own styles
 * through `!important` rather than through ordering.
 */
export function withFittedChrome(html: string, opts: { hideTitle?: boolean } = {}): string {
  if (!html) return html;

  const css = opts.hideTitle ? FIT_STYLE + HIDE_TITLE_STYLE : FIT_STYLE;
  const payload = `<style id="nlviz-fit">${css}</style><script>${FIT_SCRIPT}</script>`;

  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch?.index !== undefined) {
    const at = headMatch.index + headMatch[0].length;
    return html.slice(0, at) + payload + html.slice(at);
  }

  // No <head> — inject after <html> (the browser hoists it) or prepend.
  const htmlMatch = html.match(/<html[^>]*>/i);
  if (htmlMatch?.index !== undefined) {
    const at = htmlMatch.index + htmlMatch[0].length;
    return html.slice(0, at) + payload + html.slice(at);
  }

  return payload + html;
}
