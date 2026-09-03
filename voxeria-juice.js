// ============================================================================
// VOXERIA -- JUICE LAYER (shake envelopes, burst presets, UI tweens)
// ----------------------------------------------------------------------------
// ADDITIVE ON PURPOSE. This file adds no second camera and no second particle
// system. It drives the engine's EXISTING `screenShake` global and pushes into
// the engine's EXISTING `particles` array, so:
//   * every one of the ~15 existing `screenShake = Math.max(...)` call sites
//     keeps working untouched, and
//   * removing the single <script> tag removes the whole feature. There is no
//     engine edit to unwind afterwards.
//
// WHY A WRAPPER AND NOT A NEW SYSTEM:
// voxeria-engine.js:1585 already owns `screenShake`, and render() at :8977
// already applies it to drawCamX/drawCamY and decays it (*=0.85 per frame).
// A parallel shake system would fight that one for the same two variables.
// What the engine's version genuinely LACKS is a duration: it is a single
// amplitude that always decays at a fixed rate, so every shake in the game is
// the same ~8-frame snap. This layer adds the missing envelope by re-asserting
// the amplitude each frame with Math.max, which the engine's own decay then
// reads normally. Worst case (if our rAF runs after render) the shake decays
// one frame faster -- it can never break.
//
// Load AFTER voxeria-engine.js. Anywhere before voxeria-boot.js is fine.
// ============================================================================

(function () {
  'use strict';

  // ── Shake channel ─────────────────────────────────────────────────────────
  // Each entry is one active shake. They are combined with max(), not sum:
  // two overlapping shakes should feel like the bigger one, not like an
  // amplitude spike that slams the camera off-screen.
  var shakes = [];
  var running = false;
  var lastT = 0;

  // Envelope shapes, all normalised to progress p in 0..1 -> amplitude 0..1.
  var CURVES = {
    // Instant attack, exponential fall. The "hit" feel -- use for impacts.
    punch: function (p) { return Math.pow(1 - p, 2.2); },
    // Holds most of its amplitude, then drops. Use for sustained events
    // (a forge working, a collapse building) where the shake IS the duration.
    rumble: function (p) { return p < 0.65 ? 1 : Math.pow(1 - (p - 0.65) / 0.35, 1.6); },
    // Ramps UP then falls -- anticipation. Reads as "something is coming".
    swell: function (p) { return p < 0.5 ? Math.pow(p / 0.5, 1.5) : Math.pow(1 - (p - 0.5) / 0.5, 1.4); }
  };

  /**
   * ScreenShake(intensity, duration) -- the requested API.
   * @param {number} intensity peak amplitude in pixels. The engine's own
   *        vocabulary for reference: a block place is 2, a hard fall ~8,
   *        an ore break 8-12, a death 16, an armor craft 22.
   * @param {number} duration seconds. The engine's built-in shake is
   *        effectively ~0.13s; anything above that is new expressive range.
   * @param {object} [opts] { curve: 'punch'|'rumble'|'swell' }
   */
  function shake(intensity, duration, opts) {
    if (!(intensity > 0)) return;
    opts = opts || {};
    shakes.push({
      amp: intensity,
      t: 0,
      dur: Math.max(0.016, duration || 0.15),
      curve: CURVES[opts.curve] || CURVES.punch
    });
    start();
  }

  function tick(now) {
    if (!running) return;
    var dt = lastT ? Math.min(0.05, (now - lastT) / 1000) : 0.016;
    lastT = now;

    var peak = 0;
    for (var i = shakes.length - 1; i >= 0; i--) {
      var s = shakes[i];
      s.t += dt;
      if (s.t >= s.dur) { shakes.splice(i, 1); continue; }
      var a = s.amp * s.curve(s.t / s.dur);
      if (a > peak) peak = a;
    }

    // The one line that couples us to the engine. Math.max means we only ever
    // RAISE the amplitude -- an engine-side shake that is currently bigger
    // than ours is left completely alone.
    if (peak > 0 && typeof screenShake !== 'undefined') {
      screenShake = Math.max(screenShake, peak);
    }

    if (shakes.length) requestAnimationFrame(tick);
    else { running = false; lastT = 0; }
  }

  function start() {
    if (running) return;
    running = true; lastT = 0;
    requestAnimationFrame(tick);
  }

  // ── Particle bursts ───────────────────────────────────────────────────────
  // These build objects in the EXACT shape drawParticles() (engine :6218)
  // already understands -- spark / twinkle / dust / ring. No renderer changes,
  // no new draw pass, and they are culled by the same life counter as
  // everything else, so they cannot leak.

  function rgbOf(color) {
    // Accepts '#rrggbb' or 'r,g,b' and always hands back 'r,g,b', because the
    // engine mixes both conventions (particle .color is a CSS string, but
    // impactFlashColor is a bare triplet).
    if (typeof color !== 'string') return '255,217,122';
    if (color.charAt(0) === '#') {
      var h = color.slice(1);
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      var n = parseInt(h, 16);
      return ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255);
    }
    return color;
  }
  function css(color, a) { return 'rgba(' + rgbOf(color) + ',' + (a === undefined ? 1 : a) + ')'; }

  /**
   * ParticleEmitter(x, y, color, type) -- the requested API.
   * x/y are WORLD PIXELS (tile * TILE), matching what completeArmorAltar
   * already computes as `ax`/`ay`.
   * type: 'forge' | 'impact' | 'sparkle' | 'shockwave'
   * @param {object} [opts] { count, power, gravity }
   */
  function burst(x, y, color, type, opts) {
    if (typeof particles === 'undefined') return;
    opts = opts || {};
    var n = opts.count;
    var power = opts.power || 1;

    if (type === 'shockwave') {
      // The engine's own 'ring' type ignores .color (it is hardcoded white),
      // so a tinted shockwave is drawn as a dense, short-lived ring of sparks
      // travelling outward instead -- same read, and it picks up the realm's
      // palette.
      n = n || 22;
      for (var i = 0; i < n; i++) {
        var a = (i / n) * Math.PI * 2;
        particles.push({
          x: x, y: y,
          vx: Math.cos(a) * 3.4 * power, vy: Math.sin(a) * 3.4 * power * 0.55,
          color: css(color, 0.9), size: 2 + Math.random() * 2,
          life: 16 + (Math.random() * 6 | 0), maxLife: 22, type: 'dust'
        });
      }
      return;
    }

    if (type === 'sparkle') {
      n = n || 10;
      for (var j = 0; j < n; j++) {
        particles.push({
          x: x + (Math.random() - 0.5) * 26, y: y + (Math.random() - 0.5) * 26,
          vx: (Math.random() - 0.5) * 0.7, vy: -0.35 - Math.random() * 0.6,
          color: css(color), size: 3 + Math.random() * 3,
          life: 34 + (Math.random() * 20 | 0), maxLife: 54, type: 'twinkle'
        });
      }
      return;
    }

    if (type === 'impact') {
      n = n || 16;
      for (var k = 0; k < n; k++) {
        var ang = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.1;
        var sp = (1.6 + Math.random() * 3.2) * power;
        particles.push({
          x: x, y: y,
          vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
          color: css(color), size: 2 + Math.random() * 2.5,
          life: 22 + (Math.random() * 14 | 0), maxLife: 36, type: 'spark'
        });
      }
      return;
    }

    // 'forge' -- the layered one. Three populations at three speeds is what
    // separates "a puff of dots" from something that reads as a transformation:
    // fast bright sparks sell the CRACK, slow twinkles sell the MAGIC, and the
    // ground dust sells the WEIGHT.
    n = n || 26;
    for (var s = 0; s < n; s++) {
      var sa = Math.random() * Math.PI * 2;
      var ss = (2.2 + Math.random() * 4.5) * power;
      particles.push({
        x: x, y: y,
        vx: Math.cos(sa) * ss, vy: Math.sin(sa) * ss - 1.2,
        color: css(color), size: 2 + Math.random() * 3,
        life: 26 + (Math.random() * 18 | 0), maxLife: 44, type: 'spark'
      });
    }
    for (var t = 0; t < 12; t++) {
      particles.push({
        x: x + (Math.random() - 0.5) * 40, y: y + (Math.random() - 0.5) * 34,
        vx: (Math.random() - 0.5) * 0.8, vy: -0.4 - Math.random() * 0.8,
        color: css(color), size: 4 + Math.random() * 4,
        life: 44 + (Math.random() * 26 | 0), maxLife: 70, type: 'twinkle'
      });
    }
    for (var d = 0; d < 14; d++) {
      var dir = d < 7 ? -1 : 1;
      particles.push({
        x: x + dir * (4 + Math.random() * 10), y: y + 12 + Math.random() * 6,
        vx: dir * (1.4 + Math.random() * 2.6), vy: -0.15 - Math.random() * 0.5,
        color: 'rgba(220,210,195,0.55)', size: 3 + Math.random() * 3,
        life: 26 + (Math.random() * 16 | 0), maxLife: 42, type: 'dust'
      });
    }
  }

  // ── The armor moment, composed ────────────────────────────────────────────
  // completeArmorAltar (voxeria-dimensions-progress.js:1753) ALREADY does a
  // lot: shake 22, a 16-particle glow burst, a white ring, impactFlash 0.7,
  // a sound and a notification. It is not missing juice -- it is missing
  // STRUCTURE. Everything lands on one single frame, so it reads as one flat
  // bang instead of an event.
  //
  // This spreads the same moment over ~0.9s in three beats, which is what
  // makes it survive being watched at 15fps in a GIF:
  //   0ms   anticipation -- a small swelling rumble, no visuals yet
  //   190ms the hit      -- hard punch shake, shockwave, forge burst
  //   340ms the afterglow-- slow twinkles rising, long soft rumble
  //
  // Call it INSTEAD of nothing (it stacks safely on top of what the engine
  // already fires -- max() everywhere) at the end of completeArmorAltar.
  var FORGE_COLORS = {
    LAVA: '#ff783c', OCEAN: '#5ac8ff', VOID: '#aa78ff', GOLD: '#ffd97a',
    // Added for dimensionShift below, not just the forge -- dimension identity
    // is dimension identity, no reason for a second colour table.
    ERG: '#e8c46e', OVERWORLD: '#9fe6a0'
  };

  function forgeSlam(x, y, dim) {
    var color = FORGE_COLORS[dim] || '#ffd97a';

    // Beat 1 -- anticipation.
    shake(3.5, 0.20, { curve: 'swell' });

    // Beat 2 -- the hit.
    setTimeout(function () {
      shake(15, 0.30, { curve: 'punch' });
      burst(x, y, color, 'shockwave', { power: 1.15 });
      burst(x, y, color, 'forge', { count: 30, power: 1.1 });
      if (typeof impactFlash !== 'undefined') {
        impactFlash = Math.max(impactFlash, 0.55);
        impactFlashColor = rgbOf(color);
      }
    }, 190);

    // Beat 3 -- the afterglow. A long, very low rumble under the twinkles is
    // the part that makes it feel heavy rather than sparkly.
    setTimeout(function () {
      shake(2.2, 0.55, { curve: 'rumble' });
      burst(x, y - 10, color, 'sparkle', { count: 14 });
    }, 340);
  }

  // ── The dimension-shift moment, composed ──────────────────────────────────
  // doTeleport (voxeria-dimensions-progress.js) currently marks entering or
  // leaving a dimension with a flat screenShake=20, a sound, and then clears
  // `particles` on the very next line -- the single most significant moment in
  // the game (you are now somewhere else entirely) gets no visual flourish at
  // all, unlike the forge altar above. Same 3-beat shape as forgeSlam, tuned
  // for a "pulled through" feel rather than a heavy hit: a quick swelling
  // pull, a hard crossing with a colour-coded ring, and a soft settle as the
  // new place loads in. Call AFTER the particle-clearing line, not before --
  // otherwise this burst is exactly what gets wiped.
  function dimensionShift(x, y, dim) {
    var color = FORGE_COLORS[dim] || '#ffffff';

    // Beat 1 -- the pull, as space folds.
    shake(4, 0.14, { curve: 'swell' });

    // Beat 2 -- the crossing.
    setTimeout(function () {
      shake(14, 0.24, { curve: 'punch' });
      burst(x, y, color, 'shockwave', { power: 1.3 });
      burst(x, y, color, 'sparkle', { count: 18 });
      if (typeof impactFlash !== 'undefined') {
        impactFlash = Math.max(impactFlash, 0.45);
        impactFlashColor = rgbOf(color);
      }
    }, 90);

    // Beat 3 -- arrival settles.
    setTimeout(function () {
      shake(3, 0.30, { curve: 'rumble' });
    }, 260);
  }

  // ── UI tweens ─────────────────────────────────────────────────────────────
  // The modal shell is NOT animated here. index.html already tweens it
  // properly: #mod-builder-modal and friends get
  //   transition: opacity .16s ease, transform .16s cubic-bezier(.16,1,.3,1)
  // which is a correct ease-out-expo. Duplicating that in JS would fight the
  // CSS transition for the same property. See the note in the answer for the
  // 3-line CSS fix that gives #mod-editor-modal the same treatment -- that
  // belongs in index.html, not here.
  //
  // What CSS genuinely CANNOT do is this: the node cards (.ng-node) are DOM
  // elements created dynamically by ngRender() (voxeria-modding.js:3890), so
  // there is no static selector to hang a per-child stagger delay on. A
  // cascading reveal is the single most "expensive-looking" thing you can do
  // to a node editor in a GIF, and it needs JS.

  function easeOutExpo(p) { return p === 1 ? 1 : 1 - Math.pow(2, -10 * p); }

  /**
   * Staggered cascade reveal of the node cards. Call right after the editor
   * is shown. Purely cosmetic: it only touches inline transform/opacity and
   * clears them completely when done, so nothing is left on the elements.
   * @param {object} [opts] { stagger, duration, lift }
   */
  function revealNodes(opts) {
    opts = opts || {};
    var stagger = opts.stagger || 32;      // ms between cards
    var duration = opts.duration || 340;   // ms per card
    var lift = opts.lift || 14;            // px it rises from

    var world = document.getElementById('ng-world');
    if (!world) return;
    var nodes = Array.prototype.slice.call(world.querySelectorAll('.ng-node'));
    if (!nodes.length) return;

    // Reveal in reading order (left-to-right, top-to-bottom) rather than DOM
    // order -- the graph reads as a flow, so the animation should follow it.
    nodes.sort(function (a, b) {
      var ax = parseFloat(a.style.left) || 0, bx = parseFloat(b.style.left) || 0;
      var ay = parseFloat(a.style.top) || 0, by = parseFloat(b.style.top) || 0;
      return (ay - by) || (ax - bx);
    });

    nodes.forEach(function (el, i) {
      // Store whatever transform the node already carries -- the editor uses
      // left/top for placement, but a future drag-transform must not be eaten.
      var base = el.style.transform || '';
      el.style.willChange = 'transform, opacity';
      el.style.opacity = '0';

      var startAt = performance.now() + i * stagger;
      (function step(now) {
        if (now < startAt) { requestAnimationFrame(step); return; }
        var p = Math.min(1, (now - startAt) / duration);
        var e = easeOutExpo(p);
        el.style.opacity = String(e);
        el.style.transform = base + ' translateY(' + ((1 - e) * lift).toFixed(2) + 'px)' +
                             ' scale(' + (0.96 + 0.04 * e).toFixed(3) + ')';
        if (p < 1) requestAnimationFrame(step);
        else {
          // Full cleanup -- the element goes back to exactly what it was.
          el.style.transform = base;
          el.style.opacity = '';
          el.style.willChange = '';
        }
      })(performance.now());
    });
  }

  // ── Optional: hitstop ─────────────────────────────────────────────────────
  // Deliberately NOT implemented as a drop-in. Real hitstop means scaling the
  // simulation's dt for a few frames, and the only honest place to do that is
  // inside the engine's own loop -- faking it from outside (toggling `paused`)
  // would also freeze the shake decay and the pocket timer, which is worse
  // than not having it. If you want it, it is one line in the loop where dt is
  // computed:  if (VxJuice.hitstop > 0) { VxJuice.hitstop--; dt *= 0.12; }
  // and this counter is here so that line has something to read.
  var api = {
    shake: shake,
    burst: burst,
    forgeSlam: forgeSlam,
    dimensionShift: dimensionShift,
    revealNodes: revealNodes,
    hitstop: 0,
    _curves: CURVES
  };

  window.VxJuice = api;
})();
