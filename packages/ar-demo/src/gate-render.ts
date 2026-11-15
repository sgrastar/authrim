/**
 * Canvas 2D composition of the gate scene as JavaScript source (shipped inside /assets/wait.js).
 * Dark photograph + lit photograph through feathered light masks, flame flipbook on top, and the
 * near view blended in over the far view. No backticks, dollar-brace or backslashes in here.
 */
export const GATE_RENDER_JS = `function createRenderer(canvas, geo, imgs) {
  var ctx = canvas.getContext('2d');
  var m = document.createElement('canvas');
  var n = document.createElement('canvas');
  var mctx = m.getContext('2d');
  var nctx = n.getContext('2d');
  if (!ctx || !mctx || !nctx) return null;
  var W = 0;
  var H = 0;
  var F = geo.camera.fixedPoint;
  var NR = geo.far.nearRect;
  var STEADY = 0.92;
  var SN = geo.camera.stationScales[3];

  var feather = document.createElement('canvas');
  feather.width = 256;
  feather.height = 171;
  (function () {
    var f = feather.getContext('2d');
    f.fillStyle = '#fff';
    f.fillRect(0, 0, 256, 171);
    f.globalCompositeOperation = 'destination-in';
    var gx = f.createLinearGradient(0, 0, 256, 0);
    gx.addColorStop(0, 'rgba(0,0,0,0)');
    gx.addColorStop(0.05, 'rgba(0,0,0,1)');
    gx.addColorStop(0.95, 'rgba(0,0,0,1)');
    gx.addColorStop(1, 'rgba(0,0,0,0)');
    f.fillStyle = gx;
    f.fillRect(0, 0, 256, 171);
    var gy = f.createLinearGradient(0, 0, 0, 171);
    gy.addColorStop(0, 'rgba(0,0,0,0)');
    gy.addColorStop(0.05, 'rgba(0,0,0,1)');
    gy.addColorStop(0.95, 'rgba(0,0,0,1)');
    gy.addColorStop(1, 'rgba(0,0,0,0)');
    f.fillStyle = gy;
    f.fillRect(0, 0, 256, 171);
  })();

  function resize() {
    var cssW = canvas.clientWidth;
    var cssH = canvas.clientHeight;
    if (!cssW || !cssH) return false;
    var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    var w = Math.min(Math.round(cssW * dpr), 1600);
    var h = Math.round((w * cssH) / cssW);
    if (w !== W || h !== H) {
      W = w;
      H = h;
      canvas.width = w;
      canvas.height = h;
      m.width = w;
      m.height = h;
      n.width = w;
      n.height = h;
    }
    return true;
  }

  // Where the far image lies on the canvas at magnification s. It covers the canvas, except on
  // tall screens, where it is never magnified beyond 53 % visible width (the fires stay in view);
  // the near view still covers the screen at the gate (m grows to the cover size on arrival).
  function view(s) {
    var cover = Math.max(W, 1.5 * H);
    var base = Math.min(cover, 1.875 * W);
    var w = Math.min(1, Math.max(0, (s - 1.8) / (SN - 1.8)));
    var m = 1 + (cover / base - 1) * w * w * (3 - 2 * w);
    var iw = base * s * m;
    var cx = F[0] + (0.5 - F[0]) / s;
    var cy = F[1] + (0.5 - F[1]) / s;
    return { dx: W / 2 - cx * iw, dy: H / 2 - cy * ((iw * 2) / 3), dw: iw, dh: (iw * 2) / 3 };
  }

  function blit(c, img, r) {
    var x0 = Math.max(0, r.dx);
    var y0 = Math.max(0, r.dy);
    var x1 = Math.min(W, r.dx + r.dw);
    var y1 = Math.min(H, r.dy + r.dh);
    if (x1 <= x0 || y1 <= y0) return;
    var iw = img.naturalWidth;
    var ih = img.naturalHeight;
    c.drawImage(img, ((x0 - r.dx) / r.dw) * iw, ((y0 - r.dy) / r.dh) * ih, ((x1 - x0) / r.dw) * iw, ((y1 - y0) / r.dh) * ih, x0, y0, x1 - x0, y1 - y0);
  }

  function rnd(k) {
    var x = Math.sin(k * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  function flicker(phi, t, still) {
    if (still) return 1;
    var step = t / 120;
    var k = Math.floor(step);
    var f = step - k;
    var noise = rnd(k + phi * 7) * (1 - f) + rnd(k + 1 + phi * 7) * f;
    return 1 + (0.05 * Math.sin(2 * Math.PI * 1.7 * (t / 1000) + phi) + 0.03 * Math.sin(2 * Math.PI * 4.3 * (t / 1000) + 2 * phi) + 0.02 * (noise * 2 - 1)) / STEADY;
  }

  /** Fires of one picture placed on the screen. 'list' is geometry, 'r' the image rect. */
  function place(list, r, scene, clock, still) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var g = list[i];
      var st = scene.fires[g.pair];
      if (!st) continue;
      var phi = (g.pair.charCodeAt(1) || 0) * 1.7 + (g.side === 'right' ? 0.9 : 0);
      var fl = flicker(phi, clock, still);
      out.push({
        id: g.id, pair: g.pair, right: g.side === 'right', phi: phi,
        x: r.dx + g.x * r.dw, y: r.dy + g.y * r.dh,
        radius: g.radius * r.dw * (1 + (fl - 1) * 0.6),
        fw: g.flameWidth * r.dw, fh: g.flameHeight * r.dw * (2 / 3),
        i: st.i * fl, sprite: st.sprite
      });
    }
    return out;
  }

  function layer(t, dark, lit, r, fires, allLit) {
    blit(t, dark, r);
    var any = false;
    for (var i = 0; i < fires.length; i++) if (fires[i].i > 0.02) any = true;
    if (!any || !lit) return;
    mctx.globalCompositeOperation = 'source-over';
    mctx.clearRect(0, 0, W, H);
    mctx.globalCompositeOperation = 'lighter';
    if (allLit) {
      mctx.fillStyle = 'rgba(255,255,255,0.85)';
      mctx.fillRect(0, 0, W, H);
    }
    for (i = 0; i < fires.length; i++) {
      var f = fires[i];
      if (f.i <= 0.02) continue;
      var a = Math.min(1, f.i);
      var g = mctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.radius);
      g.addColorStop(0, 'rgba(255,255,255,' + a + ')');
      g.addColorStop(0.3, 'rgba(255,255,255,' + a * 0.82 + ')');
      g.addColorStop(0.55, 'rgba(255,255,255,' + a * 0.6 + ')');
      g.addColorStop(0.8, 'rgba(255,255,255,' + a * 0.22 + ')');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      mctx.fillStyle = g;
      mctx.fillRect(f.x - f.radius, f.y - f.radius, f.radius * 2, f.radius * 2);
    }
    // The baked flame of a fire that is not burning yet is hidden again (feathered ellipse).
    mctx.globalCompositeOperation = 'destination-out';
    for (i = 0; i < fires.length; i++) {
      var u = fires[i];
      var cut = 1 - Math.min(1, u.i * 1.5);
      if (cut < 0.02) continue;
      var rx = Math.max(2, u.fw * 1.1);
      var ry = Math.max(2, u.fh * 0.62);
      mctx.save();
      mctx.translate(u.x, u.y - u.fh * 0.5);
      mctx.scale(1, ry / rx);
      var e = mctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      e.addColorStop(0, 'rgba(0,0,0,' + cut + ')');
      e.addColorStop(0.65, 'rgba(0,0,0,' + cut + ')');
      e.addColorStop(1, 'rgba(0,0,0,0)');
      mctx.fillStyle = e;
      mctx.fillRect(-rx, -rx, rx * 2, rx * 2);
      mctx.restore();
    }
    mctx.globalCompositeOperation = 'source-in';
    blit(mctx, lit, r);
    mctx.globalCompositeOperation = 'source-over';
    t.drawImage(m, 0, 0);
  }

  function flames(c, fires, clock, alpha) {
    if (!imgs.flame || alpha <= 0.01) return;
    c.globalCompositeOperation = 'lighter';
    for (var i = 0; i < fires.length; i++) {
      var f = fires[i];
      if (f.i < 0.05 || f.sprite <= 0.02 || f.fw < 6) continue;
      // fh is the measured flame box height (flameHeight is relative to the image HEIGHT);
      // the flame fills 0.775 of a flipbook cell, drawn 10 % above the photographed one.
      var size = ((f.fh * 1.1) / 0.775) * f.sprite;
      var frame = (Math.floor(clock / 71.4) + (f.pair.charCodeAt(1) || 0) * 3 + (f.right ? 5 : 0)) % 16;
      for (var k = 0; k < 2; k++) {
        var fr = (frame + k * 8) % 16;
        c.globalAlpha = Math.min(1, f.i) * (k ? 0.4 : 0.8) * alpha;
        c.save();
        c.translate(f.x, f.y);
        if (k) c.scale(-1, 1);
        c.drawImage(imgs.flame, (fr % 4) * 256, Math.floor(fr / 4) * 256, 256, 256, -size / 2, -size * 0.875, size, size);
        c.restore();
      }
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
  }

  return {
    resize: resize,
    /** scene: { scale, blend, fires }, clock in ms, still: no flicker, no flame sprites. */
    draw: function (scene, clock, still) {
      if (!imgs.dark || !resize()) return false;
      var far = view(scene.scale);
      var wantNear = scene.blend > 0.001 && imgs.nearDark;
      var nr = null;
      if (wantNear) {
        nr = { dx: far.dx + NR.x * far.dw, dy: far.dy + NR.y * far.dh, dw: NR.width * far.dw, dh: NR.height * far.dh };
      }
      var covers = nr && nr.dx <= 0.5 && nr.dy <= 0.5 && nr.dx + nr.dw >= W - 0.5 && nr.dy + nr.dh >= H - 0.5;
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, W, H);
      var farFires = place(geo.far.fires, far, scene, clock, still);
      if (!(covers && scene.blend >= 0.999)) {
        layer(ctx, imgs.dark, imgs.farLit, far, farFires, false);
        if (!still) flames(ctx, farFires, clock, 1);
      }
      // Tall screens: the far image does not reach the top and bottom edges; fade them out.
      var fade = far.dh * 0.14;
      ctx.globalCompositeOperation = 'destination-out';
      if (far.dy > 0.5) {
        var gt = ctx.createLinearGradient(0, far.dy, 0, far.dy + fade);
        gt.addColorStop(0, 'rgba(0,0,0,1)');
        gt.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gt;
        ctx.fillRect(0, far.dy, W, fade);
      }
      if (far.dy + far.dh < H - 0.5) {
        var gb = ctx.createLinearGradient(0, far.dy + far.dh, 0, far.dy + far.dh - fade);
        gb.addColorStop(0, 'rgba(0,0,0,1)');
        gb.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gb;
        ctx.fillRect(0, far.dy + far.dh - fade, W, fade);
      }
      ctx.globalCompositeOperation = 'source-over';
      if (wantNear) {
        var nf = place(geo.near.fires, nr, scene, clock, still);
        var all = true;
        for (var i = 0; i < nf.length; i++) if (nf[i].i < 0.9) all = false;
        if (covers && scene.blend >= 0.999) {
          layer(ctx, imgs.nearDark, imgs.nearLit, nr, nf, all);
          if (!still) flames(ctx, nf, clock, 1);
        } else {
          nctx.globalCompositeOperation = 'source-over';
          nctx.clearRect(0, 0, W, H);
          layer(nctx, imgs.nearDark, imgs.nearLit, nr, nf, all);
          if (!still) flames(nctx, nf, clock, 1);
          nctx.globalCompositeOperation = 'destination-in';
          nctx.drawImage(feather, nr.dx, nr.dy, nr.dw, nr.dh);
          nctx.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = scene.blend;
          ctx.drawImage(n, 0, 0);
          ctx.globalAlpha = 1;
        }
      }
      return true;
    }
  };
}
`;
