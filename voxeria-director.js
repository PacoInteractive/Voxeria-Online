// ============================================================================
// VOXERIA -- PITCH DIRECTOR MODE (recording rig, NOT part of the game)
// ----------------------------------------------------------------------------
// Self-contained on purpose, same rule as voxeria-devtools.js: do not fold this
// into the game scripts. Install by adding one <script> tag LAST in index.html
// (after voxeria-boot.js), remove by deleting that tag. It writes nothing to
// localStorage, patches no engine function and leaves no state behind.
//
//   F8  -- Crafting take: drop into the forge dimension, standing at the forge,
//          holding EXACTLY the right materials, timer frozen, UI stripped.
//   F9  -- Virality take: mod code on the clipboard + the "joined via code"
//          arrival beat played on screen.
//   F10 -- Toggle clean-frame mode (everything off except the hotbar).
//   F7  -- Panic: restore all UI and unfreeze. Safe to hit at any time.
//
// Engine globals are reached by bare name on purpose. They are declared with
// let/const at the top level of classic scripts, so they live in the global
// LEXICAL scope and are not properties of window -- `window.currentDim` is
// undefined, but `currentDim` resolves fine through this IIFE's scope chain.
// Existence is probed with `typeof x !== 'undefined'`, which is safe even for
// a name that was never declared.
//
// ---------------------------------------------------------------------------
// !! READ THIS BEFORE RECORDING !!
// The brief asked for "the forge in the LAVA dimension, 8 Obsidian + 1 Ember
// Ore, Obsidian Heat Suit". That combination cannot craft anything:
//
//   FORGE_OUTPUT (voxeria-dimensions-progress.js:1692)
//     GOLD -> armor_lava   (Obsidian Heat Suit)   base OBSIDIAN x8 + EMBER_ORE
//     LAVA -> armor_ocean  (Pressure Diving Suit) base EMBER_ORE x8 + FIRE_CRYSTAL
//
// checkArmorAltar() reads FORGE_OUTPUT[currentDim], so standing in LAVA it is
// looking for a FIRE_CRYSTAL core. 8 Obsidian + 1 Ember Ore placed there does
// nothing at all -- you would build the altar on camera and watch it not fire.
// The Obsidian Heat Suit is forged in GOLD (its own recipe says
// forge: { dim: 'GOLD', name: 'Vulcan-Schmiede' }).
//
// So this rig never hardcodes materials. It reads FORGE_OUTPUT and
// CRAFTING_RECIPES and hands you whatever the chosen dimension actually wants.
// Change TAKE_DIM below to pick the shot; the inventory follows automatically.
// ============================================================================

(function () {
  'use strict';

  // Which dimension the F8 take drops you into. Switch live with
  // VxDirector.setDim('VOID') from the console.
  //   'GOLD'  -> Obsidian Heat Suit  (warm orange forge -- the flagship shot)
  //   'LAVA'  -> Pressure Diving Suit
  //   'OCEAN' -> Void Walker Boots
  //   'VOID'  -> Golden Aegis        (prestige capstone, best payoff visual)
  var TAKE_DIM = 'GOLD';

  // UI hidden for a clean frame. Every id here was checked against index.html
  // -- a typo would silently hide nothing, which you would only notice after
  // recording. The hotbar and #health are deliberately absent: they are what
  // tells a viewer at a glance that this is a game and not a screensaver.
  var HIDE_IDS = [
    'minimap-panel',      // index.html:2222
    'minimap-btn',        // :2047
    'pocket-timer',       // :2221  (also frozen by setFrozen)
    'defense-badge',      // :2020
    'hud-side-actions',   // :2161
    'ocean-oxygen-bar',   // :2223  (NOT 'oxygen-bar')
    // #notification (:2220) is deliberately NOT hidden. It carries the payoff
    // line of both takes -- completeArmorAltar fires
    // "🔥 LAVA-RESISTENZ FREIGESCHALTET!" and the virality take fires
    // "🎮 Joined via mod code!". Hiding it would strip the punchline.
    'chat-wrap',          // :2830  (NOT 'chat-panel')
    'mp-status'           // :2046
  ];
  var HIDE_SELECTORS = [];

  var hidden = [];
  var clean = false;
  var freezeIv = null;
  var badge = null;

  // ── on-screen status (never part of a take -- it fades in 2.2s) ───────────
  function toast(msg) {
    if (!badge) {
      badge = document.createElement('div');
      badge.style.cssText = [
        'position:fixed', 'left:50%', 'top:18px', 'transform:translateX(-50%)',
        'z-index:2147483647', 'pointer-events:none',
        'font:600 13px/1.45 ui-monospace,Consolas,monospace',
        'color:#fff', 'background:rgba(12,14,22,0.92)',
        'border:1px solid rgba(255,255,255,0.18)', 'padding:7px 14px',
        'letter-spacing:0.04em', 'white-space:pre', 'text-align:center',
        'transition:opacity 0.25s ease'
      ].join(';');
      document.body.appendChild(badge);
    }
    badge.textContent = msg;
    badge.style.opacity = '1';
    clearTimeout(badge._t);
    badge._t = setTimeout(function () { badge.style.opacity = '0'; }, 2200);
  }

  // ── clean frame ───────────────────────────────────────────────────────────
  function setClean(on) {
    if (on === clean) return;
    clean = on;
    if (on) {
      hidden = [];
      var els = [];
      HIDE_IDS.forEach(function (id) {
        var e = document.getElementById(id);
        if (e) els.push(e);
      });
      HIDE_SELECTORS.forEach(function (sel) {
        Array.prototype.forEach.call(document.querySelectorAll(sel), function (e) { els.push(e); });
      });
      els.forEach(function (e) {
        // Remember the INLINE value only. Restoring '' hands the element back
        // to its stylesheet rule -- writing 'block'/'flex' here would override
        // CSS that was never ours to override.
        hidden.push({ el: e, prev: e.style.display });
        e.style.display = 'none';
      });
    } else {
      hidden.forEach(function (h) { h.el.style.display = h.prev; });
      hidden = [];
    }
  }

  // ── run freeze ────────────────────────────────────────────────────────────
  // A pocket run collapses on a timer (3 min in GOLD, and OCEAN drains oxygen
  // instead). Nothing ruins a take like the collapse cinematic firing mid-shot,
  // so the rig keeps topping both back up rather than disabling the systems.
  function setFrozen(on) {
    if (freezeIv) { clearInterval(freezeIv); freezeIv = null; }
    if (!on) return;
    freezeIv = setInterval(function () {
      if (typeof pocketActive !== 'undefined' && pocketActive) {
        if (typeof pocketTimer !== 'undefined') pocketTimer = 99999;
        if (typeof playerOxygen !== 'undefined' && typeof OXYGEN_MAX !== 'undefined') {
          playerOxygen = OXYGEN_MAX;
        }
      }
    }, 500);
  }

  // ── F8: the crafting take ─────────────────────────────────────────────────
  function craftingTake() {
    if (typeof FORGE_OUTPUT === 'undefined' || typeof CRAFTING_RECIPES === 'undefined') {
      toast('DIRECTOR: engine not ready'); return;
    }
    var recipeId = FORGE_OUTPUT[TAKE_DIM];
    if (!recipeId) { toast('DIRECTOR: ' + TAKE_DIM + ' forges nothing'); return; }

    var r = null;
    for (var i = 0; i < CRAFTING_RECIPES.length; i++) {
      if (CRAFTING_RECIPES[i].id === recipeId) { r = CRAFTING_RECIPES[i]; break; }
    }
    if (!r) { toast('DIRECTOR: recipe ' + recipeId + ' missing'); return; }

    try {
      // 1. Un-craft it first. checkArmorAltar() bails on recipeOwned(), so on a
      //    second take the altar would silently do nothing. Biggest gotcha when
      //    re-recording -- this is why it is step one.
      craftedArmor.delete(r.dim);
      equippedArmor.delete(r.dim);

      // 2. Enter the dimension the way doTeleport() does it.
      var preX = player.x, preY = player.y;
      currentDim = TAKE_DIM;
      if (typeof markDimVisited === 'function') markDimVisited(TAKE_DIM);
      beginPocketRun(preX, preY);

      // 3. dimForgeX/Y are only set once the landmark chunk generates, and
      //    generation is lazy (getChunk caches per chunk). Reading a block in
      //    that column is what forces buildPocketLandmark -> _stampDimForge.
      if (typeof pocketLandmarkX === 'number') {
        for (var c = -2; c <= 2; c++) getBlock(pocketLandmarkX + c * 16, 40);
      }
      if (dimForgeX === null || dimForgeX === undefined) {
        toast('DIRECTOR: forge chunk not built yet\npress F8 once more');
        return;
      }

      // 4. Stand just left of the forge so it fills the right of frame.
      player.x = (dimForgeX - 3) * TILE;
      player.y = (dimForgeY - 2) * TILE;
      player.vx = 0; player.vy = 0;
      player.facing = 1;
      if (typeof camX !== 'undefined') camX = player.x - (canvas.width >> 1);
      if (typeof camY !== 'undefined') camY = player.y - (canvas.height >> 1);

      // 5. Exact materials, nothing else in the bar. r.mats already states the
      //    real counts (8 outer + 1 core), so it is read rather than assumed.
      for (var s = 0; s < inventory.length; s++) inventory[s] = null;
      Object.keys(r.mats).forEach(function (blockId) {
        addToInventory(parseInt(blockId, 10), r.mats[blockId]);
      });
      if (typeof drawHotbar === 'function') drawHotbar();
      if (typeof updateDefenseBadge === 'function') updateDefenseBadge();

      setFrozen(true);
      setClean(true);

      var names = (typeof blockNames !== 'undefined') ? blockNames : {};
      var parts = Object.keys(r.mats).map(function (b) {
        return r.mats[b] + '× ' + (names[b] || ('#' + b));
      });
      toast('TAKE 1 · ' + TAKE_DIM + ' · ' + r.name + '\n' + parts.join('   +   '));
    } catch (e) {
      console.error('DIRECTOR craftingTake failed:', e);
      toast('DIRECTOR: failed -- see console');
    }
  }

  // ── F9: the virality take ─────────────────────────────────────────────────
  // The pitch beat is "a code goes out, someone is standing in your world".
  // This puts a real, decodable code on the clipboard and plays the RECEIVING
  // half of that beat on screen, so both halves can be filmed in one shot.
  function viralityTake() {
    var code = null;
    if (typeof VxPieces !== 'undefined' && VxPieces.list) {
      var graphs = VxPieces.list('GRAPH') || [];
      // A real saved graph decodes if the publisher pastes it back in -- worth
      // preferring over anything synthetic.
      for (var i = 0; i < graphs.length && !code; i++) {
        if (graphs[i] && graphs[i].code) code = graphs[i].code;
      }
    }
    if (!code && typeof mbCurrentModCode !== 'undefined' && mbCurrentModCode) {
      code = mbCurrentModCode;
    }
    if (!code) {
      toast('DIRECTOR: no mod code found\nbuild one in the Mod Builder first');
      return;
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(function () {
        toast('TAKE 2 · code copied (' + code.length + ' chars)');
      }).catch(function () {
        // Clipboard can still be refused depending on focus/permissions. Fail
        // loudly rather than hand over an empty clipboard mid-recording.
        window.prompt('DIRECTOR -- copy this mod code:', code);
      });
    } else {
      window.prompt('DIRECTOR -- copy this mod code:', code);
    }

    // The arrival beat, slightly delayed so the copy toast is not in frame.
    setTimeout(function () {
      try {
        var px = player.x + player.w / 2;
        var py = player.y + player.h / 2;
        if (window.VxJuice) {
          VxJuice.shake(9, 0.28, { curve: 'punch' });
          VxJuice.burst(px, py, '#8f7cff', 'shockwave', { power: 1.0 });
          VxJuice.burst(px, py, '#c9b8ff', 'sparkle', { count: 16 });
        } else if (typeof screenShake !== 'undefined') {
          screenShake = Math.max(screenShake, 12);
        }
        if (typeof impactFlash !== 'undefined') {
          impactFlash = Math.max(impactFlash, 0.6);
          impactFlashColor = '143,124,255';
        }
        if (typeof playSound === 'function') playSound('portal');
        if (typeof showNotification === 'function') showNotification('🎮 Joined via mod code!');
      } catch (e) {
        console.error('DIRECTOR viralityTake beat failed:', e);
      }
    }, 260);
  }

  // ── keys ──────────────────────────────────────────────────────────────────
  // Capture phase so the engine's own keydown handlers never see these. F7-F10
  // are unbound in the engine today; capture keeps this true even if that
  // changes later.
  function onKey(e) {
    if (e.key === 'F8') { e.preventDefault(); e.stopPropagation(); craftingTake(); }
    else if (e.key === 'F9') { e.preventDefault(); e.stopPropagation(); viralityTake(); }
    else if (e.key === 'F10') {
      e.preventDefault(); e.stopPropagation();
      setClean(!clean);
      toast(clean ? 'CLEAN FRAME · on' : 'CLEAN FRAME · off');
    } else if (e.key === 'F7') {
      e.preventDefault(); e.stopPropagation();
      setClean(false); setFrozen(false);
      toast('DIRECTOR · restored');
    }
  }
  window.addEventListener('keydown', onKey, true);

  // ── uninstall ─────────────────────────────────────────────────────────────
  // Deleting the <script> tag is the intended removal. This makes the rig
  // reversible live, mid-session, without a reload.
  window.VxDirector = {
    setDim: function (d) { TAKE_DIM = d; toast('DIRECTOR · take dim = ' + d); },
    clean: setClean,
    freeze: setFrozen,
    uninstall: function () {
      window.removeEventListener('keydown', onKey, true);
      setClean(false);
      setFrozen(false);
      if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
      delete window.VxDirector;
      console.log('VxDirector uninstalled.');
    }
  };

  console.log('%cVxDirector armed', 'color:#8f7cff;font-weight:bold',
    '\n  F8  crafting take (' + TAKE_DIM + ')' +
    '\n  F9  virality take' +
    '\n  F10 clean frame' +
    '\n  F7  restore');
})();
