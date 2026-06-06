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

  // --- physics params (soft-disk DEM, spring-dashpot contacts) ---
  var G = 1350;       // gravity magnitude (px/s^2)
  var KN = 3200;      // contact stiffness (lower = squishier)
  var CN = 26;        // contact normal damping (controls bounce / restitution)
  var MU = 0.22;      // Coulomb friction at contacts
  var AIR = 0.9985;   // very light air drag so motion eventually settles
  var EWALL = 0.34;   // wall restitution (bounce off the box)
  var WFRIC = 0.92;   // tangential retention at walls
  var VMAX = 3200;    // safety speed clamp
  var VD = 3400;      // drag follow speed
  var SUB = 5;        // physics substeps per animation frame
  var gx = 0, gy = G; // gravity vector (G down by default; redirected by phone tilt)
  var parts = [];

  // --- photoelastic rendering params ---
  var Fref = 2600;    // force normalisation (lower = chains brighter)
  var FR = 1.5;       // fringe gain (fringe orders per unit stress)
  var rMin = 2.2;     // near-contact stress clamp

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function targetN() {
    var rAvg = H * 0.057;
    return clamp(Math.round(W * H * 0.48 / (Math.PI * rAvg * rAvg)), 58, 144);
  }

  function spawn() {
    var r = H * (0.042 + Math.random() * 0.03);
    var rel = r / (H * 0.057);       // size relative to the average grain
    parts.push({
      x: r + Math.random() * (W - 2 * r),
      y: -r - Math.random() * 160,
      vx: (Math.random() - 0.5) * 30,
      vy: 40 + Math.random() * 60,
      r: r, m: rel * rel, f: 0, cts: [], entered: false   // mass ~ area
    });
  }

  var mouse = { x: -1e4, y: -1e4, active: false };
  var dragIndex = -1;
  function ptr(e) { var rct = canvas.getBoundingClientRect(); mouse.x = e.clientX - rct.left; mouse.y = e.clientY - rct.top; mouse.active = true; }
  canvas.addEventListener("pointermove", ptr);
  canvas.addEventListener("pointerdown", function (e) {
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
    gx = G * Math.sin(e.gamma * Math.PI / 180);
    gy = G * Math.sin(e.beta * Math.PI / 180);
  }
  if (typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function") {
    // iOS: the permission prompt only appears from a click on a real button.
    var banner = document.getElementById("banner");
    var tb = document.createElement("button");
    tb.className = "tilt-btn";
    tb.type = "button";
    tb.textContent = "Enable tilt";
    if (banner) banner.appendChild(tb);
    tb.addEventListener("click", function (ev) {
      ev.stopPropagation();
      DeviceOrientationEvent.requestPermission().then(function (state) {
        if (state === "granted") window.addEventListener("deviceorientation", onOrient);
        tb.remove();
      }).catch(function () { tb.remove(); });
    });
  } else if (window.DeviceOrientationEvent) {
    // Android and others: no prompt required.
    window.addEventListener("deviceorientation", onOrient);
  }

  function step(dt) {
    var N = targetN(), i, j;
    spawnTimer += dt;
    if (parts.length < N && spawnTimer > 0.06) { spawn(); spawnTimer = 0; }

    for (i = 0; i < parts.length; i++) { parts[i].f = 0; parts[i].cts.length = 0; }

    // external acceleration: gravity/tilt for free grains; the dragged grain is
    // velocity-driven toward the cursor.
    for (i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (i === dragIndex) {
        var tvx = (mouse.x - p.x) / dt, tvy = (mouse.y - p.y) / dt, ts = Math.hypot(tvx, tvy);
        if (ts > VD) { tvx *= VD / ts; tvy *= VD / ts; }
        p.vx = tvx; p.vy = tvy;
      } else {
        p.vx = (p.vx + gx * dt) * AIR;
        p.vy = (p.vy + gy * dt) * AIR;
      }
    }

    // particle-particle contacts: linear spring-dashpot (normal) + Coulomb friction
    // (tangential). Forces divide by mass so larger grains push smaller ones.
    for (i = 0; i < parts.length; i++) {
      var a = parts[i];
      for (j = i + 1; j < parts.length; j++) {
        var b = parts[j];
        var dx = b.x - a.x, dy = b.y - a.y, rr = a.r + b.r;
        if (dx > rr || dx < -rr || dy > rr || dy < -rr) continue;
        var d2 = dx * dx + dy * dy;
        if (d2 >= rr * rr || d2 < 1e-6) continue;
        var d = Math.sqrt(d2), nx = dx / d, ny = dy / d, ov = rr - d;
        var rvx = b.vx - a.vx, rvy = b.vy - a.vy;
        var vn = rvx * nx + rvy * ny;            // relative normal velocity (+ = separating)
        var Fn = KN * ov - CN * vn;              // spring + dashpot
        if (Fn < 0) Fn = 0;                       // contacts push only, never stick
        var vtx = rvx - vn * nx, vty = rvy - vn * ny, vtm = Math.hypot(vtx, vty);
        var ftx = 0, fty = 0;
        if (vtm > 1e-4) { var Ft = MU * Fn; ftx = -Ft * vtx / vtm; fty = -Ft * vty / vtm; }
        var Fx = nx * Fn + ftx, Fy = ny * Fn + fty;
        a.vx -= Fx * dt / a.m; a.vy -= Fy * dt / a.m;
        b.vx += Fx * dt / b.m; b.vy += Fy * dt / b.m;
        var fc = KN * ov;                         // elastic compression for the fringes
        a.f += fc; b.f += fc;
        a.cts.push({ ux: nx, uy: ny, f: fc });
        b.cts.push({ ux: -nx, uy: -ny, f: fc });
      }
    }

    // integrate + box walls (left / right / floor / closed top)
    for (i = 0; i < parts.length; i++) {
      var q = parts[i];
      if (i !== dragIndex) {
        var sp = Math.hypot(q.vx, q.vy);
        if (sp > VMAX) { q.vx *= VMAX / sp; q.vy *= VMAX / sp; }
      }
      q.x += q.vx * dt; q.y += q.vy * dt;
      var pen, fw;
      if (q.x < q.r) { pen = q.r - q.x; q.x = q.r; if (q.vx < 0) q.vx = -q.vx * EWALL; q.vy *= WFRIC; fw = KN * pen; if (fw < 240) fw = 240; q.f += fw; q.cts.push({ ux: -1, uy: 0, f: fw }); }
      else if (q.x > W - q.r) { pen = q.x - (W - q.r); q.x = W - q.r; if (q.vx > 0) q.vx = -q.vx * EWALL; q.vy *= WFRIC; fw = KN * pen; if (fw < 240) fw = 240; q.f += fw; q.cts.push({ ux: 1, uy: 0, f: fw }); }
      if (q.y > H - q.r) { pen = q.y - (H - q.r); q.y = H - q.r; if (q.vy > 0) q.vy = -q.vy * EWALL; q.vx *= WFRIC; fw = KN * pen; if (fw < 300) fw = 300; q.f += fw; q.cts.push({ ux: 0, uy: 1, f: fw }); }
      // Closed top: a grain pours in from above, then once fully inside the box the
      // ceiling holds it in (so tilting/dragging can't throw grains out the top).
      if (!q.entered && q.y >= q.r) q.entered = true;
      if (q.entered && q.y < q.r) { pen = q.r - q.y; q.y = q.r; if (q.vy < 0) q.vy = -q.vy * EWALL; q.vx *= WFRIC; fw = KN * pen; if (fw < 240) fw = 240; q.f += fw; q.cts.push({ ux: 0, uy: -1, f: fw }); }
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
    var dt = (now - last) / 1000; last = now; if (dt > 0.045) dt = 0.045;
    for (var k = 0; k < SUB; k++) step(dt / SUB);
    draw();
    requestAnimationFrame(frame);
  }

  if (reduce) {
    for (var w = 0; w < 2600; w++) step(0.004);
    draw();
  } else {
    requestAnimationFrame(frame);
  }
})();
