// Flame Graph & pprof Viewer by Zovo: the canvas flame graph renderer. Used by the viewer, the Pro diff panel and the
// exported HTML report. It draws flat pre-order arrays (frame, depth, x, w): one bar per call path. Rows are drawn
// only where they are on screen (the canvas stays the size of the window and the scroll area holds a spacer), so a
// stack 2,000 frames deep or a profile with a million bars scrolls like a short one.
(function (root) {
  'use strict';
  var ROW = 18;

  function hash(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  // Warm colors for code, cooler for runtime and library frames, gray for synthetic frames such as (idle).
  function colorOf(name, file) {
    var h = hash(name || '');
    var n = name || '';
    if (n.charAt(0) === '(' || n.charAt(0) === '[') return 'hsl(220,6%,' + (58 + (h % 10)) + '%)';
    var f = file || '';
    if (/^node:|^internal\/|^runtime[./]|^runtime$/.test(f) || /^runtime\.|^syscall\.|^internal\//.test(n)) return 'hsl(' + (190 + (h % 30)) + ',45%,' + (55 + ((h >> 8) % 12)) + '%)';
    if (/node_modules|\/pkg\/mod\/|site-packages|vendor\//.test(f)) return 'hsl(' + (40 + (h % 18)) + ',70%,' + (54 + ((h >> 8) % 10)) + '%)';
    return 'hsl(' + (h % 38) + ',' + (68 + ((h >> 8) % 20)) + '%,' + (55 + ((h >> 16) % 10)) + '%)';
  }
  function diffColor(d, max) {
    if (!(max > 0) || Math.abs(d) < max * 0.02) return 'hsl(220,5%,72%)';
    var t = Math.min(1, Math.abs(d) / max);
    var light = 86 - Math.round(t * 36);
    return d > 0 ? 'hsl(2,78%,' + light + '%)' : 'hsl(214,78%,' + light + '%)';
  }

  /**
   * opts: { scroller (element with overflow auto), canvas, spacer, onHover(node, clientX, clientY), onSelect(node),
   *         onOpen(node), labelOf(node) }
   */
  function FlameView(opts) {
    this.o = opts;
    this.scroller = opts.scroller; this.canvas = opts.canvas; this.spacer = opts.spacer;
    this.ctx = this.canvas.getContext('2d');
    this.data = null; this.orientation = 'flame';
    this.vx0 = 0; this.vx1 = 1; this.selected = -1; this.hover = -1;
    this.match = null; this.highlightFrame = -1; this.diff = null; this.diffMax = 0;
    this.drawn = 0; this.lastFont = '';
    var self = this;
    this._raf = 0;
    this.scroller.addEventListener('scroll', function () { self.request(); });
    this._bindMouse();
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(function () { self.resize(); }).observe(this.scroller);
  }
  FlameView.prototype.request = function () {
    var self = this;
    if (this._raf) return;
    this._raf = (root.requestAnimationFrame || setTimeout)(function () { self._raf = 0; self.draw(); });
  };
  /** d: { frame, depth, x, w }, names, files, total; extra: { diff (per node), diffMax } */
  FlameView.prototype.setData = function (d, names, files, extra) {
    this.data = d; this.names = names; this.files = files || [];
    var n = d.frame.length, maxD = 0, i;
    for (i = 0; i < n; i++) if (d.depth[i] > maxD) maxD = d.depth[i];
    this.maxDepth = maxD;
    var count = new Int32Array(maxD + 2);
    for (i = 0; i < n; i++) count[d.depth[i] + 1]++;
    for (i = 1; i < count.length; i++) count[i] += count[i - 1];
    var start = count.slice(0, maxD + 1), fill = start.slice(), byDepth = new Int32Array(n);
    for (i = 0; i < n; i++) byDepth[fill[d.depth[i]]++] = i;
    // rows are in x order already (pre-order); keep them sorted in case a caller passes another order
    for (var dd = 0; dd <= maxD; dd++) {
      var a = start[dd], b = dd + 1 <= maxD ? start[dd + 1] : n, sorted = true;
      for (i = a + 1; i < b; i++) if (d.x[byDepth[i]] < d.x[byDepth[i - 1]]) { sorted = false; break; }
      if (!sorted) { var part = Array.prototype.slice.call(byDepth.subarray(a, b)); part.sort(function (p, q) { return d.x[p] - d.x[q]; }); byDepth.set(part, a); }
    }
    this.rowStart = start; this.byDepth = byDepth;
    this.total = d.w[0] || 1;
    this.vx0 = 0; this.vx1 = this.total;
    this.selected = -1; this.hover = -1; this.highlightFrame = -1;
    this.diff = extra && extra.diff ? extra.diff : null; this.diffMax = extra && extra.diffMax || 0;
    this.layout(true);
  };
  FlameView.prototype.rowsOf = function (depth) {
    var a = this.rowStart[depth], b = depth + 1 <= this.maxDepth ? this.rowStart[depth + 1] : this.data.frame.length;
    return [a, b];
  };
  FlameView.prototype.contentHeight = function () { return this.data ? (this.maxDepth + 1) * ROW + 6 : 0; };
  FlameView.prototype.layout = function (scrollHome) {
    if (!this.data) return;
    this.resize();
    if (scrollHome) this.scroller.scrollTop = this.orientation === 'flame' ? this.scroller.scrollHeight : 0;
    this.request();
  };
  FlameView.prototype.resize = function () {
    var dpr = root.devicePixelRatio || 1;
    var w = Math.max(50, this.scroller.clientWidth), h = Math.max(50, this.scroller.clientHeight);
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    }
    this.cssW = w; this.cssH = h; this.dpr = dpr;
    // the canvas is sticky at the top of the scroll area; the spacer makes up the rest of the content height
    if (this.data) this.spacer.style.height = Math.max(0, this.contentHeight() - h) + 'px';
    this.request();
  };
  FlameView.prototype.setOrientation = function (o) {
    if (o === this.orientation) return;
    var fromBottom = this.scroller.scrollHeight - this.scroller.clientHeight - this.scroller.scrollTop;
    this.orientation = o;
    this.scroller.scrollTop = o === 'flame' ? this.scroller.scrollHeight - this.scroller.clientHeight - fromBottom : fromBottom;
    this.request();
  };
  /** y of a depth row inside the content (before scrolling). */
  /** Scroll position used for drawing: 0 whenever the whole graph fits (a stale scrollTop after a resize is ignored). */
  FlameView.prototype.scrollY = function () { return this.contentHeight() <= (this.cssH || 0) ? 0 : this.scroller.scrollTop; };
  FlameView.prototype.pad = function () { return this.orientation === 'flame' ? Math.max(0, (this.cssH || 0) - this.contentHeight()) : 0; };
  FlameView.prototype.rowY = function (depth) {
    return (this.orientation === 'flame' ? (this.maxDepth - depth) * ROW : depth * ROW) + 3 + this.pad();
  };
  FlameView.prototype.setMatch = function (fn) {
    // fn(frameIndex) -> bool, or null for no search
    if (!this.data) { this.match = null; return 0; }
    if (!fn) { this.match = null; this.request(); return 0; }
    var names = this.names, nf = names.length, m = new Uint8Array(nf + 1);
    for (var f = 0; f < nf; f++) m[f] = fn(f) ? 1 : 0;
    this.match = m;
    // share of the total covered by matching bars (nested matches counted once)
    var d = this.data, n = d.frame.length, covered = 0, stackDepth = -1;
    for (var i = 1; i < n; i++) {
      if (stackDepth >= 0 && d.depth[i] <= stackDepth) stackDepth = -1;
      if (stackDepth < 0 && d.frame[i] >= 0 && m[d.frame[i]]) { covered += d.w[i]; stackDepth = d.depth[i]; }
    }
    this.request();
    return covered / this.total;
  };
  FlameView.prototype.setHighlightFrame = function (f) { this.highlightFrame = f; this.request(); };
  FlameView.prototype.zoomTo = function (i) {
    if (!this.data || i < 0) return;
    var d = this.data;
    this.vx0 = d.x[i]; this.vx1 = d.x[i] + Math.max(d.w[i], this.total * 1e-9);
    this.selected = i;
    // keep the zoomed bar on screen
    var y = this.rowY(d.depth[i]);
    if (y < this.scroller.scrollTop || y + ROW > this.scroller.scrollTop + this.scroller.clientHeight) this.scroller.scrollTop = Math.max(0, y - this.scroller.clientHeight / 2);
    this.request();
  };
  FlameView.prototype.reset = function () { this.vx0 = 0; this.vx1 = this.total; this.selected = -1; this.request(); };
  FlameView.prototype.zoomed = function () { return this.vx0 > 0 || this.vx1 < this.total; };
  FlameView.prototype.zoomAt = function (cssX, factor) {
    var span = this.vx1 - this.vx0, at = this.vx0 + (cssX / this.cssW) * span;
    var ns = Math.min(this.total, Math.max(this.total * 1e-7, span * factor));
    var a = at - (cssX / this.cssW) * ns;
    a = Math.max(0, Math.min(this.total - ns, a));
    this.vx0 = a; this.vx1 = a + ns; this.request();
  };
  FlameView.prototype.pan = function (cssDx) {
    var span = this.vx1 - this.vx0, dx = (cssDx / this.cssW) * span;
    var a = Math.max(0, Math.min(this.total - span, this.vx0 + dx));
    this.vx0 = a; this.vx1 = a + span; this.request();
  };
  /** Bar under a point of the canvas (CSS px), or -1. */
  FlameView.prototype.hit = function (cx, cy) {
    if (!this.data) return -1;
    var y = cy + this.scrollY() - 3 - this.pad();
    var depth = this.orientation === 'flame' ? this.maxDepth - Math.floor(y / ROW) : Math.floor(y / ROW);
    if (depth < 0 || depth > this.maxDepth) return -1;
    var x = this.vx0 + (cx / this.cssW) * (this.vx1 - this.vx0);
    var r = this.rowsOf(depth), d = this.data, by = this.byDepth, lo = r[0], hi = r[1] - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1, i = by[mid];
      if (d.x[i] + d.w[i] <= x) lo = mid + 1; else if (d.x[i] > x) hi = mid - 1; else return i;
    }
    return -1;
  };
  /** Screen rectangle (client px) of a bar, for tests and the gate. */
  FlameView.prototype.rectOf = function (i) {
    var d = this.data, sc = this.cssW / (this.vx1 - this.vx0);
    var b = this.canvas.getBoundingClientRect();
    return { x: b.left + (d.x[i] - this.vx0) * sc, y: b.top + this.rowY(d.depth[i]) - this.scrollY(), w: d.w[i] * sc, h: ROW - 1 };
  };
  FlameView.prototype.labelOf = function (i) {
    var f = this.data.frame[i];
    if (this.o.labelOf) return this.o.labelOf(i, f);
    return f < 0 ? 'all' : this.names[f];
  };
  FlameView.prototype.draw = function () {
    var ctx = this.ctx, d = this.data;
    if (!d) return;
    var dpr = this.dpr || 1, W = this.cssW, H = this.cssH;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var cs = root.getComputedStyle ? root.getComputedStyle(this.scroller) : null;
    var bg = (cs && cs.getPropertyValue('--vscode-editor-background').trim()) || '#1e1e1e';
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    var family = (cs && cs.getPropertyValue('--vscode-font-family').trim()) || 'system-ui, sans-serif';
    var font = '11px ' + family;
    ctx.font = font; ctx.textBaseline = 'middle';
    var charW = this._charW && this.lastFont === font ? this._charW : (this._charW = ctx.measureText('abcdefghijklmnopqrstuvwxyzABCDEF').width / 32, this.lastFont = font, this._charW);
    var sc = W / (this.vx1 - this.vx0), top = this.scrollY(), drawn = 0;
    var m = this.match, hf = this.highlightFrame, diff = this.diff;
    var pad = this.pad();
    var first = this.orientation === 'flame' ? this.maxDepth - Math.floor((top + H - pad) / ROW) - 1 : Math.floor(top / ROW) - 1;
    var last = this.orientation === 'flame' ? this.maxDepth - Math.floor((top - pad) / ROW) + 1 : Math.floor((top + H) / ROW) + 1;
    first = Math.max(0, first); last = Math.min(this.maxDepth, last);
    var by = this.byDepth;
    for (var depth = first; depth <= last; depth++) {
      var y = this.rowY(depth) - top;
      var r = this.rowsOf(depth), lo = r[0], hi = r[1] - 1, startIdx = r[1];
      // first bar that ends after vx0
      while (lo <= hi) { var mid = (lo + hi) >> 1; if (d.x[by[mid]] + d.w[by[mid]] <= this.vx0) lo = mid + 1; else { startIdx = mid; hi = mid - 1; } }
      var lastPx = -10;
      for (var k = startIdx; k < r[1]; k++) {
        var i = by[k];
        if (d.x[i] >= this.vx1) break;
        var px = (d.x[i] - this.vx0) * sc, pw = d.w[i] * sc;
        if (px < 0) { pw += px; px = 0; }
        if (px + pw > W) pw = W - px;
        if (pw < 0.6) { if (px - lastPx < 1) continue; pw = 0.6; }
        lastPx = px + pw;
        var f = d.frame[i];
        var name = f < 0 ? 'all' : this.names[f];
        var faded = (m && f >= 0 && !m[f]) || (m && f < 0) || (hf >= 0 && f !== hf);
        ctx.fillStyle = faded ? 'rgba(128,128,128,0.28)' : diff ? diffColor(diff[i], this.diffMax) : f < 0 ? 'hsl(220,8%,62%)' : colorOf(name, this.files[f]);
        ctx.fillRect(px, y, Math.max(0.6, pw - (pw > 3 ? 1 : 0)), ROW - 1);
        drawn++;
        if (i === this.selected || i === this.hover) { ctx.strokeStyle = i === this.selected ? '#ffffff' : 'rgba(255,255,255,0.7)'; ctx.lineWidth = i === this.selected ? 2 : 1; ctx.strokeRect(px + 0.5, y + 0.5, Math.max(1, pw - 1), ROW - 2); }
        if (pw > 26) {
          var label = this.labelOf(i), max = Math.floor((pw - 6) / charW);
          if (max > 1) {
            if (label.length > max) label = label.slice(0, Math.max(1, max - 1)) + '…';
            ctx.fillStyle = faded ? 'rgba(200,200,200,0.55)' : '#111';
            ctx.fillText(label, px + 3, y + ROW / 2);
          }
        }
      }
    }
    this.drawn = drawn;
    this.canvas.setAttribute('data-drawn', String(drawn));
    if (this.o.onDraw) this.o.onDraw(drawn);
  };
  FlameView.prototype._bindMouse = function () {
    var self = this, cv = this.canvas, down = null, dragged = false;
    function pos(e) { var b = cv.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; }
    cv.addEventListener('mousemove', function (e) {
      var p = pos(e);
      if (down) {
        var dx = p.x - down.x;
        if (Math.abs(dx) > 3 || dragged) { dragged = true; self.pan(-(p.x - down.lx)); down.lx = p.x; return; }
      }
      var i = self.hit(p.x, p.y);
      if (i !== self.hover) { self.hover = i; self.request(); }
      cv.style.cursor = i >= 0 ? 'pointer' : 'default';
      if (self.o.onHover) self.o.onHover(i, e.clientX, e.clientY);
    });
    cv.addEventListener('mouseleave', function () { if (self.hover !== -1) { self.hover = -1; self.request(); } if (self.o.onHover) self.o.onHover(-1, 0, 0); });
    cv.addEventListener('mousedown', function (e) { if (e.button !== 0) return; var p = pos(e); down = { x: p.x, lx: p.x }; dragged = false; });
    root.addEventListener('mouseup', function (e) {
      if (!down) return;
      var wasDrag = dragged; down = null; dragged = false;
      if (wasDrag || e.target !== cv) return;
      var p = pos(e), i = self.hit(p.x, p.y);
      if (i < 0) return;
      if ((e.altKey || e.metaKey || e.ctrlKey) && self.o.onOpen) { self.o.onOpen(i); return; }
      if (i === 0) self.reset(); else self.zoomTo(i);
      if (self.o.onSelect) self.o.onSelect(i);
    });
    cv.addEventListener('dblclick', function (e) { var p = pos(e), i = self.hit(p.x, p.y); if (i >= 0 && self.o.onOpen) self.o.onOpen(i); });
    cv.addEventListener('wheel', function (e) {
      var p = pos(e);
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); self.zoomAt(p.x, Math.exp(e.deltaY * 0.0025)); return; }
      var dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      if (dx && self.zoomed()) { e.preventDefault(); self.pan(dx); }
    }, { passive: false });
  };

  root.ZovoFlame = { FlameView: FlameView, colorOf: colorOf, diffColor: diffColor, hash: hash, ROW: ROW };
})(typeof window !== 'undefined' ? window : globalThis);
