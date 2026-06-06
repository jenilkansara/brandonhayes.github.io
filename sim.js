// Photoelastic polariscope simulation (home page only)
(function () {
  var canvas = document.getElementById("poesim");
  if (!canvas) return;
  var ctx = canvas.getContext("2d");
  var DPR = Math.min(window.devicePixelRatio || 1, 2);
  var W = 0, H = 0;

  // Offscreen buffer for the per-pixel photoelastic field (full-resolution)
  var PS = 1.0;                 // compute scale (pixels) — 1.0 = full CSS resolution
  var off = document.createElement("canvas");
  var offctx = off.getContext("2d");
  var offW = 1, offH = 1, buf = null, u32 = null;
  var BLACK = (255 << 24) >>> 0; // opaque black, little-endian RGBA

  function resize() {
    var r = canvas.getBoundingClientRect();
    W = r.width; H = r.height;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    offW = Math.max(1, Math.round(W * PS));
    offH = Math.max(1, Math.round(H * PS));
    off.width = offW; off.height = offH;
    buf = new Uint8ClampedArray(offW * offH * 4);
    u32 = new Uint32Array(buf.buffer);
  }
  resize();
  // Only re-pour on a real width change (e.g. rotation). Mobile browsers fire
  // resize constantly as the address bar shows/hides — those are height-only and
  // must NOT reset the simulation.
  window.addEventListener("resize", function () {
    var prevW = W;
    resize();
    if (Math.abs(W - prevW) > 40) { parts.length = 0; dragIndex = -1; }
  });

  // --- physics params (soft-disk DEM) ---
  var G = 780;        // gravity
  var K = 1400;       // contact stiffness
  var DAMP = 0.9;     // contact velocity damping
  var WALLR = 0.25;   // wall restitution
  var CAPOV = 8;      // overlap cap for force (stability)
  var VMAX = 820;     // speed clamp
  var gx = 0, gy = G; // gravity vector (G down by default; redirected by phone tilt)
  var parts = [];

  // --- photoelastic rendering params ---
  var Fref = 950;     // force normalisation (lower = chains visible at rest)
  var FR = 1.5;       // fringe gain (fringe orders per unit stress)
  var rMin = 2.2;     // near-contact stress clamp

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function targetN() {
    var rAvg = H * 0.057;
    return clamp(Math.round(W * H * 0.48 / (Math.PI * rAvg * rAvg)), 58, 144);
  }

  function spawn() {
    var r = H * (0.042 + Math.random() * 0.03);
    parts.push({
      x: r + Math.random() * (W - 2 * r),
      y: -r - Math.random() * 160,
      vx: (Math.random() - 0.5) * 30,
      vy: 40 + Math.random() * 60,
      r: r, f: 0, cts: [], entered: false
    });
  }

  var mouse = { x: -1e4, y: -1e4, active: false };
  var dragIndex = -1;
  function ptr(e) { var rct = canvas.getBoundingClientRect(); mouse.x = e.clientX - rct.left; mouse.y = e.clientY - rct.top; mouse.active = true; }
  canvas.addEventListener("pointermove", ptr);
  canvas.addEventListener("pointerdown", function (e) {
    enableTilt();
    ptr(e);
    var best = -1, bd = 1e18;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i], dx = p.x - mouse.x, dy = p.y - mouse.y, d2 = dx * dx + dy * dy;
      if (d2 < p.r * p.r && d2 < bd) { bd = d2; best = i; }
    }
    if (best >= 0) {
      dragIndex = best; parts[best].vx = 0; parts[best].vy = 0;
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {} e.preventDefault();
    }
  });
  function endDrag(e) { dragIndex = -1; if (e && e.pointerId != null) { try { canvas.releasePointerCapture(e.pointerId); } catch (_) {} } }
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("pointerleave", function () { if (dragIndex < 0) { mouse.active = false; mouse.x = -1e4; mouse.y = -1e4; } });

  // --- Gyroscope: tilt the phone to set the gravity direction ---
  // beta = front/back tilt, gamma = left/right tilt. Holding the phone upright
  // (beta ~ 90) gives normal downward gravity; tilting left/right slides grains.
  function onOrient(e) {
    if (e.gamma == null || e.beta == null) return;
    var gr = e.gamma * Math.PI / 180, br = e.beta * Math.PI / 180;
    gx = G * Math.sin(gr);
    gy = G * Math.sin(br);
  }
  var tiltEnabled = false;
  function enableTilt() {
    if (tiltEnabled) return;
    tiltEnabled = true;
    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
      // iOS 13+ requires an explicit permission prompt from a user gesture.
      DeviceOrientationEvent.requestPermission().then(function (state) {
        if (state === "granted") window.addEventListener("deviceorientation", onOrient);
      }).catch(function () {});
    } else if (window.DeviceOrientationEvent) {
      window.addEventListener("deviceorientation", onOrient);
    }
  }
  // iOS is picky about which gesture triggers the permission prompt, so request it
  // from touchend/click as well as pointerdown.
  canvas.addEventListener("click", enableTilt);
  window.addEventListener("touchend", enableTilt);

  function step(dt) {
    var N = targetN(), i, j;
    spawnTimer += dt;
    if (parts.length < N && spawnTimer > 0.06) { spawn(); spawnTimer = 0; }

    for (i = 0; i < parts.length; i++) { parts[i].f = 0; parts[i].cts.length = 0; }

    // gravity; the dragged grain is driven toward the cursor instead of falling
    for (i = 0; i < parts.length; i++) {
      if (i === dragIndex) {
        var gp = parts[i];
        var tvx = (mouse.x - gp.x) / dt, tvy = (mouse.y - gp.y) / dt;
        var ts = Math.hypot(tvx, tvy), VD = 2400;
        if (ts > VD) { tvx *= VD / ts; tvy *= VD / ts; }
        gp.vx = tvx; gp.vy = tvy;
      } else {
        parts[i].vx += gx * dt;
        parts[i].vy += gy * dt;
      }
    }

    // particle-particle contacts (store contact direction + force on each disk)
    for (i = 0; i < parts.length; i++) {
      var a = parts[i];
      for (j = i + 1; j < parts.length; j++) {
        var b = parts[j];
        var dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), rr = a.r + b.r;
        if (d < rr && d > 0.0001) {
          var ov = rr - d, nx = dx / d, ny = dy / d;
          var f = K * Math.min(ov, CAPOV);
          a.vx -= nx * f * dt; a.vy -= ny * f * dt;
          b.vx += nx * f * dt; b.vy += ny * f * dt;
          a.f += f; b.f += f;
          a.cts.push({ ux: nx, uy: ny, f: f });    // outward dir from a toward b
          b.cts.push({ ux: -nx, uy: -ny, f: f });  // outward dir from b toward a
          a.x -= nx * ov * 0.5; a.y -= ny * ov * 0.5;
          b.x += nx * ov * 0.5; b.y += ny * ov * 0.5;
          a.vx *= DAMP; a.vy *= DAMP; b.vx *= DAMP; b.vy *= DAMP;
        }
      }
    }

    // integrate + rectangular walls (left / right / floor) with contact registration
    for (i = 0; i < parts.length; i++) {
      var q = parts[i];
      var sp = Math.hypot(q.vx, q.vy);
      if (i !== dragIndex && sp > VMAX) { q.vx *= VMAX / sp; q.vy *= VMAX / sp; }
      q.x += q.vx * dt; q.y += q.vy * dt;
      var pen, fw;
      if (q.x < q.r) { pen = q.r - q.x; fw = K * Math.min(pen, CAPOV); q.x = q.r; q.vx = -q.vx * WALLR; q.f += fw; q.cts.push({ ux: -1, uy: 0, f: fw }); }
      if (q.x > W - q.r) { pen = q.x - (W - q.r); fw = K * Math.min(pen, CAPOV); q.x = W - q.r; q.vx = -q.vx * WALLR; q.f += fw; q.cts.push({ ux: 1, uy: 0, f: fw }); }
      if (q.y > H - q.r) { pen = q.y - (H - q.r); fw = K * Math.min(pen, CAPOV); if (fw < 300) fw = 300; q.y = H - q.r; q.vy = -q.vy * WALLR; q.vx *= 0.94; q.f += fw; q.cts.push({ ux: 0, uy: 1, f: fw }); }
      // Closed top: a grain pours in from above, then once fully inside the box the
      // ceiling holds it in (so tilting/dragging can't throw grains out the top).
      if (!q.entered && q.y >= q.r) q.entered = true;
      if (q.entered && q.y < q.r) { pen = q.r - q.y; fw = K * Math.min(pen, CAPOV); q.y = q.r; q.vy = -q.vy * WALLR; q.f += fw; q.cts.push({ ux: 0, uy: -1, f: fw }); }
    }

    // Cap only EXCESSIVE penetration of the dragged grain. Grains may still touch
    // and press together (so contacts/chains stay strong and trapped grains can be
    // pulled free), but the held grain can't sink deep into another or tunnel past
    // one wedged in a corner.
    if (dragIndex >= 0 && dragIndex < parts.length) {
      var dgp = parts[dragIndex];
      var maxPen = 0.15 * dgp.r;
      for (var it = 0; it < 3; it++) {
        for (var m = 0; m < parts.length; m++) {
          if (m === dragIndex) continue;
          var o = parts[m];
          var rdx = dgp.x - o.x, rdy = dgp.y - o.y, rdd = Math.hypot(rdx, rdy), sumr = dgp.r + o.r;
          if (rdd < sumr - maxPen && rdd > 0.0001) {
            var push = (sumr - maxPen) - rdd, rnx = rdx / rdd, rny = rdy / rdd;
            dgp.x += rnx * push; dgp.y += rny * push;
          }
        }
        dgp.x = clamp(dgp.x, dgp.r, W - dgp.r);
        dgp.y = clamp(dgp.y, dgp.r, H - dgp.r);
      }
    }
  }

  // Photoelastic isochromatics: superpose the Flamant point-load solution for
  // every contact, draw dark-field fringes I = sin^2(pi*FR*(s1-s2)) over a faint
  // translucent glass body; pure monochrome, additive so overlaps read as glass.
  function draw() {
    u32.fill(BLACK);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i], cts = p.cts, nc = cts.length;
      var cxB = p.x * PS, cyB = p.y * PS, rB = p.r * PS, rW = p.r, invR = 1 / rW;
      var x0 = Math.max(0, Math.floor(cxB - rB)), x1 = Math.min(offW - 1, Math.ceil(cxB + rB));
      var y0 = Math.max(0, Math.floor(cyB - rB)), y1 = Math.min(offH - 1, Math.ceil(cyB + rB));
      for (var py = y0; py <= y1; py++) {
        for (var px = x0; px <= x1; px++) {
          var ddx = (px + 0.5) / PS - p.x;     // pixel position relative to disk centre (world px)
          var ddy = (py + 0.5) / PS - p.y;
          var rn2 = (ddx * ddx + ddy * ddy) * invR * invR;
          if (rn2 > 1) continue;
          // translucent glass body: visible interior, soft bright rim
          var rn = Math.sqrt(rn2);
          var body = 30 + 60 * Math.pow(rn, 6) + 12 * (1 - rn);
          // photoelastic stress field
          var sxx = 0, syy = 0, sxy = 0;
          for (var c = 0; c < nc; c++) {
            var ct = cts[c];
            var rx = ddx - rW * ct.ux;          // pixel relative to the contact point
            var ry = ddy - rW * ct.uy;
            var rd = Math.sqrt(rx * rx + ry * ry); if (rd < rMin) rd = rMin;
            var nnx = rx / rd, nny = ry / rd;
            var cosphi = nnx * (-ct.ux) + nny * (-ct.uy);  // angle to inward load direction
            if (cosphi <= 0) continue;
            var sr = 0.6366 * (ct.f / Fref) * cosphi / rd; // radial stress (2/pi factor)
            sxx += sr * nnx * nnx; syy += sr * nny * nny; sxy += sr * nnx * nny;
          }
          var diff = sxx - syy;
          var delta = Math.sqrt(diff * diff + 4 * sxy * sxy);  // principal stress difference
          var ph = Math.sin(Math.PI * FR * delta); ph = ph * ph;
          var idx = (py * offW + px) * 4;
          var v = buf[idx] + body + ph * 205; if (v > 255) v = 255;
          buf[idx] = v; buf[idx + 1] = v; buf[idx + 2] = v;
        }
      }
    }
    offctx.putImageData(new ImageData(buf, offW, offH), 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, offW, offH, 0, 0, W, H);

    // subtle highlight ring on the grain you're dragging
    if (dragIndex >= 0 && dragIndex < parts.length) {
      var dg = parts[dragIndex];
      ctx.lineWidth = 1.4; ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.beginPath(); ctx.arc(dg.x, dg.y, dg.r + 1.5, 0, 6.283); ctx.stroke();
    }
  }

  var last = performance.now();
  var spawnTimer = 0;
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function frame(now) {
    var dt = (now - last) / 1000; last = now; if (dt > 0.05) dt = 0.05;
    for (var k = 0; k < 2; k++) step(dt / 2);
    draw();
    requestAnimationFrame(frame);
  }

  if (reduce) {
    for (var w = 0; w < 1100; w++) step(0.016);
    draw();
  } else {
    requestAnimationFrame(frame);
  }
})();
