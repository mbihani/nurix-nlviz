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
/* Applied by the fit script to the body-level ancestor of fitted content. */
.nlviz-fill { flex: 1 1 auto !important; min-height: 0 !important; position: relative !important; }
.nlviz-scroll { overflow: auto !important; }
.nlviz-scroll > table { width: 100%; }
table { max-width: 100%; }
`;

/**
 * Suppresses the generated document's own H1–H6 title. Used by pinned cards and
 * the expand modal, where the surrounding chrome already shows the question — so
 * the in-iframe heading is a redundant second header stealing chart height.
 */
const HIDE_TITLE_STYLE = `
body > h1, body > h2, body > h3, body > h4, body > h5, body > h6,
body > header > h1, body > header > h2, body > header > h3,
body > header > h4, body > header > h5, body > header > h6,
body > div:first-child > h1:only-child, body > div:first-child > h2:only-child,
body > div:first-child > h3:only-child, body > div:first-child > h4:only-child,
body > div:first-child > h5:only-child, body > div:first-child > h6:only-child,
body > [data-nlviz-prose-scroll] > h1:first-child,
body > [data-nlviz-prose-scroll] > h2:first-child,
body > [data-nlviz-prose-scroll] > h3:first-child,
body > [data-nlviz-prose-scroll] > h4:first-child,
body > [data-nlviz-prose-scroll] > h5:first-child,
body > [data-nlviz-prose-scroll] > h6:first-child {
  display: none !important;
}
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
    function mutableContainers(value, seen) {
      if (!value || typeof value !== 'object') return value;
      var proto = Object.getPrototypeOf(value);
      var isArray = Array.isArray(value);
      if (!isArray && proto !== Object.prototype && proto !== null) return value;
      seen = seen || new WeakMap();
      if (seen.has(value)) return seen.get(value);
      var copy = isArray ? [] : Object.create(proto);
      seen.set(value, copy);
      Reflect.ownKeys(value).forEach(function (key) {
        if (isArray && key === 'length') return;
        Object.defineProperty(copy, key, {
          value: mutableContainers(value[key], seen),
          writable: true,
          enumerable: Object.prototype.propertyIsEnumerable.call(value, key),
          configurable: true
        });
      });
      return copy;
    }
    function requiresMutableContainers(value, seen) {
      if (!value || typeof value !== 'object') return false;
      var proto = Object.getPrototypeOf(value);
      if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return false;
      seen = seen || new WeakSet();
      if (seen.has(value)) return false;
      seen.add(value);
      if (!Object.isExtensible(value)) return true;
      var keys = Reflect.ownKeys(value);
      for (var i = 0; i < keys.length; i++) {
        var descriptor = Object.getOwnPropertyDescriptor(value, keys[i]);
        if (descriptor && 'value' in descriptor) {
          if (descriptor.writable === false) return true;
          if (requiresMutableContainers(descriptor.value, seen)) return true;
        }
      }
      return false;
    }
    function Wrapped(item, cfg) {
      var chartCfg = cfg;
      // Configs may be frozen, sealed, null-prototype, or expose non-writable
      // options. A failed fit patch must never prevent chart construction.
      try {
        if (cfg && typeof cfg === 'object') {
          if (requiresMutableContainers(cfg)) chartCfg = mutableContainers(cfg);
          chartCfg.options = chartCfg.options || {};
          chartCfg.options.responsive = true;
          chartCfg.options.maintainAspectRatio = false;
        }
      } catch (e) {
        // Chart.js normalizes config/data/datasets/options in place. Rebuild all
        // plain object/array containers as writable, while retaining functions,
        // canvases, typed arrays, plugin instances and other identity leaves.
        try {
          chartCfg = mutableContainers(cfg);
          chartCfg.options = chartCfg.options || {};
          chartCfg.options.responsive = true;
          chartCfg.options.maintainAspectRatio = false;
        } catch (cloneError) {
          chartCfg = cfg;
        }
      }
      var inst;
      try {
        inst = new C(item, chartCfg);
      } catch (constructError) {
        // Last resort: never let our clone be the reason a viable original
        // config blanks. If the original also throws, it failed independently.
        if (chartCfg === cfg) throw constructError;
        inst = new C(item, cfg);
      }
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

  function scrollTarget(el) {
    var bc = bodyChild(el);
    if (!bc) return null;
    if (bc.tagName === 'TABLE') {
      var wrapper = document.createElement('div');
      wrapper.setAttribute('data-nlviz-table-scroll', '');
      bc.parentNode.insertBefore(wrapper, bc);
      wrapper.appendChild(bc);
      return wrapper;
    }
    return bc;
  }

  function fitNonCanvasContent() {
    var existing = document.querySelector('[data-nlviz-prose-scroll]');
    if (existing) {
      existing.classList.add(FILL, SCROLL);
      return;
    }
    var wrapper = document.createElement('div');
    wrapper.setAttribute('data-nlviz-prose-scroll', '');
    var children = Array.prototype.slice.call(document.body.childNodes);
    var first = null;
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      if (child.nodeType === 1 && /^(SCRIPT|STYLE|LINK)$/i.test(child.nodeName)) continue;
      if (child.nodeType === 3 && !child.textContent.trim()) continue;
      if (!first) first = child;
    }
    if (!first) return;
    document.body.insertBefore(wrapper, first);
    for (var j = 0; j < children.length; j++) {
      var node = children[j];
      if (node === wrapper) continue;
      if (node.nodeType === 1 && /^(SCRIPT|STYLE|LINK)$/i.test(node.nodeName)) continue;
      if (node.nodeType === 3 && !node.textContent.trim()) continue;
      wrapper.appendChild(node);
    }
    wrapper.classList.add(FILL, SCROLL);
  }

  function fit() {
    if (!document.body) return;
    var canvases = document.getElementsByTagName('canvas');
    var prose = document.querySelector('[data-nlviz-prose-scroll]');
    if (canvases.length && prose) prose.classList.remove(FILL, SCROLL);
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
      var bc = scrollTarget(tables[j]);
      if (bc) { bc.classList.add(FILL); bc.classList.add(SCROLL); }
    }
    if (!canvases.length && !tables.length) fitNonCanvasContent();
  }

  function schedule() { fit(); setTimeout(fit, 0); setTimeout(fit, 120); setTimeout(fit, 500); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', schedule);
  } else {
    schedule();
  }
  window.addEventListener('load', schedule);

  // Charts are often appended after a slow CDN load. Observe for the iframe's
  // full lifetime; childList-only observation avoids loops from class/style fits.
  try {
    var mo = new MutationObserver(fit);
    var start = function () { if (document.body) mo.observe(document.body, { childList: true, subtree: true }); };
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
  } catch (e) {}
  try {
    var ro = new ResizeObserver(fit);
    ro.observe(document.documentElement);
  } catch (e) {}
})();
`;

/** Find the end of a real opening <head> tag without matching HTML comments,
 * raw-text script/style contents, or quoted attribute values. */
function realHeadEnd(html: string): number {
  const lower = html.toLowerCase();
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) return -1;
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    let cursor = lt + 1;
    if (html[cursor] === '/' || html[cursor] === '!' || html[cursor] === '?') cursor += 1;
    while (/\s/.test(html[cursor] ?? '')) cursor += 1;
    const nameStart = cursor;
    while (/[a-z0-9:-]/i.test(html[cursor] ?? '')) cursor += 1;
    const name = lower.slice(nameStart, cursor);
    let quote = '';
    while (cursor < html.length) {
      const char = html[cursor];
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        cursor += 1;
        break;
      }
      cursor += 1;
    }
    const closing = html[lt + 1] === '/';
    if (!closing && name === 'head') return cursor;
    if (!closing && (name === 'script' || name === 'style')) {
      const close = lower.indexOf(`</${name}`, cursor);
      if (close < 0) return -1;
      i = close;
      continue;
    }
    i = Math.max(cursor, lt + 1);
  }
  return -1;
}

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

  const at = realHeadEnd(html);
  if (at >= 0) {
    return html.slice(0, at) + payload + html.slice(at);
  }

  // With no real head, prepend. The HTML parser hoists style/script into head,
  // and insertion is guaranteed to precede every CDN script in the document.
  return payload + html;
}
