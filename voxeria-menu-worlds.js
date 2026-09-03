// ============================================================================
// VOXERIA -- MAIN MENU + NAMED WORLD SAVES (window.VxWorlds)
// Self-contained on purpose: the matching style + markup live in index.html.
// ============================================================================

// =========================================================================
// STAGE 1 - NAMED WORLD SAVES, and STAGE 2 - THE MENU THAT DRIVES THEM
//
// WHY A DIFF AND NOT THE BLOCK MATRIX
// A chunk is CHUNK_W * WORLD_H = 32 * 120 = 3840 bytes, and the overworld is
// endless. Storing the matrix would blow through localStorage's ~5MB after a
// few hundred chunks of walking, for data that is almost entirely reproducible:
// the terrain is a pure function of the seed. So a save holds the SEED plus
// only the blocks the player actually changed. A freshly explored world is a
// few hundred bytes; it grows with what you build, not with how far you walk.
// That is also why IndexedDB is not needed yet.
//
// WHAT HAPPENS WHEN STORAGE DOES RUN OUT
// It is not enough that this is unlikely. Everything below is built so that
// the worst case is "this save did not go through and you were told", never
// "your world is gone". Three rules, and each one closes a hole that was
// open before:
//
//   * Nothing here refuses a save on its own guess. localStorage does not
//     publish its limit, so a hand-picked ceiling can only be wrong in one of
//     two directions, and one of them throws away a save the browser would
//     have accepted. The browser decides; we handle the refusal.
//   * The index is written under the same protection as the world. It is the
//     only map from a save to the menu, so an unwritten index is a world that
//     exists in storage and nowhere on screen. That reads as total loss even
//     though every byte is still there.
//   * The player is warned while saving still WORKS, and is pointed at the
//     one escape that does not touch localStorage at all: exporting the world
//     to a file.
//
// WHY POCKET DIMENSIONS ARE NOT SAVED
// resetGameAndWorld() and endPocketRun() both clear dimensions[dim] outright -
// a pocket run is designed to be thrown away, and losing its loot on failure is
// the actual game mechanic. Persisting them would quietly undo that, so only
// OVERWORLD edits are recorded.
// =========================================================================
window.VxWorlds = (function () {
  const SAVE_VERSION = 1;
  const INDEX_KEY = 'voxeria_worlds';
  const WORLD_PREFIX = 'voxeria_world_';
  // No BYTE_BUDGET any more, on purpose. The old one rejected a save at 4M
  // characters, but localStorage counts UTF-16, so on Chrome's ~5MB wall that
  // is roughly 2.6M characters: the guard sat ABOVE the real limit and never
  // fired. Every real failure went through setItem's exception instead. A
  // number that cannot be right is worse than no number.
  //
  // These two are only for the EARLY WARNING, which is advice rather than a
  // decision, so being approximate is fine. WARN_CHARS is deliberately well
  // under any browser's wall, and the scan behind it is skipped entirely
  // until one world alone is big enough for the question to be real.
  const WARN_CHARS = 1800000;
  const SCAN_ABOVE = 300000;

  // Each mode carries one half of what Voxeria is. Normal is the guided run:
  // the Portal Book, the dimension ladder, forge-gated armor — a fixed route
  // with a fixed world. Exploration is the open half, and the creator tools
  // belong to it, because a world you are free to rewrite is the point of that
  // half and a distraction from the other one.
  //
  // `studio` gates every creator surface at once: the five menu buttons, the
  // panel on the new-world screen, and the modding tip. applyModeGating() and
  // studioAllowed() below are the only two readers.
  const MODES = {
    // `permadeath` used to be a third Hardcore mode's defining feature, but
    // nothing ever read the flag — dying there behaved exactly like Normal.
    // The mode is gone rather than left as a promise the game never kept.
    explore:  { label: 'Exploration', portalBook: false, studio: true  },
    normal:   { label: 'Normal',      portalBook: true,  studio: false },
    // Arena gab es schon, aber NUR ueber "Multiplayer-Raum hosten". Dabei
    // laeuft ein Match seit jeher auch allein (siehe den Offline-Zweig in
    // VxArena.startMatch), und die Bauphase ist genau das, was man zum Testen
    // eigener Minispielregeln braucht. Als eigener Weltmodus ist sie deshalb
    // hier, damit man ein Feld bauen und seine Regeln ausprobieren kann, ohne
    // vorher jemanden einladen zu muessen.
    //
    // `studio: true`, weil ohne die Werkzeuge der halbe Sinn fehlt: eine Arena
    // ohne eigene Regeln ist nur ein leerer Kasten.
    arena:    { label: 'Arena',       portalBook: false, studio: true  }
  };

  // Every button, panel and prompt that leads into the creator tools. Listed
  // once here so a new entry point is gated by adding one id rather than by
  // remembering all the places this rule is enforced.
  const STUDIO_BUTTON_IDS = ['mod-creator-btn', 'mod-editor-btn', 'my-mod-btn'];

  let pendingMode = 'explore';

  // ---- index -------------------------------------------------------------
  function readIndex() {
    try { return JSON.parse(localStorage.getItem(INDEX_KEY)) || []; }
    catch (e) { return []; }
  }
  // Returns whether it got through. Every caller has to care: the index is
  // what the Load menu reads, so a world whose index entry did not land is
  // invisible even though its data is safely in storage. This used to throw,
  // and the throw travelled out of save() into the autosave interval, the
  // visibilitychange handler and beforeunload alike.
  function writeIndex(list) {
    try {
      localStorage.setItem(INDEX_KEY, JSON.stringify(list));
      return true;
    } catch (e) {
      console.warn('Voxeria: could not write the world index', e);
      return false;
    }
  }

  // What we occupy, counted the way localStorage counts: in characters, keys
  // included. There is no API for how much room is left, so this measures our
  // own footprint instead of guessing at the wall.
  function storageChars() {
    let n = 0;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        n += k.length + (localStorage.getItem(k) || '').length;
      }
    } catch (e) { return 0; }
    return n;
  }

  // ---- save health -------------------------------------------------------
  // Saving fails for as long as storage stays full, and the autosave retries
  // every 20 seconds. Saying so every 20 seconds would bury the one sentence
  // that matters under two hundred copies of itself, so each state is
  // announced once, at the moment it changes.
  let saveBroken = false;
  let warnedNearFull = false;

  function reportSaveFailed() {
    if (saveBroken) return;
    saveBroken = true;
    showNotification('Could not save: browser storage is full. Your world is still open and playable, but new progress is no longer being written. Open the menu and use "Export current world" to keep it as a file.');
  }
  function reportSaveWorking() {
    if (!saveBroken) return;
    saveBroken = false;
    showNotification('Saving works again.');
  }
  // Runs only after a save that actually succeeded, so the advice arrives
  // while there is still something the player can do about it.
  function warnIfNearlyFull(payloadChars) {
    if (warnedNearFull || payloadChars < SCAN_ABOVE) return;
    if (storageChars() < WARN_CHARS) return;
    warnedNearFull = true;
    showNotification('This world is getting large and browser storage is running low. Use "Export current world" in the menu to keep a copy as a file.');
  }

  // ---- thumbnail -----------------------------------------------------------
  // A 9x9-block snapshot for the Load World tiles. Anchored on chunk 0 rather
  // than wherever the player happens to be standing: it is always generated
  // (spawn lives there) and, per the world generator, deliberately kept plain
  // (see DATEISTRUKTUR.md) — so every world gets a consistent preview instead
  // of one that depends on the last spot the player walked to.
  // currentDim is pinned to OVERWORLD for the duration so a save made from
  // inside a pocket dimension still previews the surface world, not whatever
  // dimension happens to be current — same swap-and-restore getSurfaceYAt
  // itself already uses, just held open across the whole capture.
  const THUMB_CELL = 8;   // px per block — same scale drawMinimap() uses
  const THUMB_BLOCKS = 9;
  function captureWorldThumb() {
    const savedDim = currentDim;
    try {
      currentDim = 'OVERWORLD';
      const anchorX = 0;
      const surfaceY = getSurfaceYAt(anchorX, 'OVERWORLD');
      // A few rows of sky above the surface so the tile reads as "standing on
      // the ground", not "looking at a wall of dirt" — the whole point of
      // anchoring on the surface at all.
      const top = Math.max(0, surfaceY - 3);
      const left = anchorX - ((THUMB_BLOCKS / 2) | 0);

      const cv = document.createElement('canvas');
      cv.width = cv.height = THUMB_BLOCKS * THUMB_CELL;
      const tctx = cv.getContext('2d');
      tctx.imageSmoothingEnabled = false;
      for (let sx = 0; sx < THUMB_BLOCKS; sx++) {
        for (let sy = 0; sy < THUMB_BLOCKS; sy++) {
          const b = getBlock(left + sx, top + sy);
          const px = sx * THUMB_CELL, py = sy * THUMB_CELL;
          if (_hasBlockTexture(b)) {
            tctx.drawImage(_blockTextures[b], px, py, THUMB_CELL, THUMB_CELL);
          } else if (b === BLOCKS.AIR) {
            tctx.fillStyle = '#8fc4ff'; // above ground here is sky, not cave — unlike the minimap's fallback
            tctx.fillRect(px, py, THUMB_CELL, THUMB_CELL);
          } else {
            const bc = blockColors[b];
            tctx.fillStyle = bc ? bc[0] : '#8fc4ff';
            tctx.fillRect(px, py, THUMB_CELL, THUMB_CELL);
          }
        }
      }
      return cv.toDataURL('image/png');
    } catch (e) {
      return null; // e.g. called before the world generator has spawned anything yet
    } finally {
      currentDim = savedDim;
    }
  }

  // ---- save --------------------------------------------------------------
  function serialize() {
    // worldEdits is keyed "x,y" -> block id; flattened to a plain triple array
    // because that is roughly half the JSON of an object per entry.
    const edits = [];
    worldEdits.forEach((type, key) => {
      const c = key.indexOf(',');
      edits.push([+key.slice(0, c), +key.slice(c + 1), type]);
    });
    return {
      v: SAVE_VERSION,
      id: currentWorldId,
      name: currentWorldName,
      seed: rawSeedString,
      mode: gameMode,
      // Nur fuer Arena-Welten belegt. Ohne dieses Feld waere eine lokal
      // gespeicherte Arena nach dem Laden anders breit als beim Bauen -- und
      // damit waere alles, was am Rand steht, in der Wand oder im Leeren.
      arenaWidth: (window.VxArena ? VxArena.worldWidth() : 0),
      savedAt: Date.now(),
      player: { x: player.x, y: player.y, health: player.health, color: player.color },
      inventory: inventory,
      armor: { crafted: [...craftedArmor], equipped: [...equippedArmor] },
      edits: edits,
      // Minimap fog-of-war — OVERWORLD only (pocket dimensions are thrown away
      // every run regardless, see exploredCells above). Packed as "cx,cy"
      // strings same as the runtime Set, one entry per MINIMAP_CELL cell
      // explored rather than per tile.
      exploredOverworld: [...exploredCells.OVERWORLD],
      minimapCell: MINIMAP_CELL
    };
  }

  // `thumb` defaults to true for every explicit/manual save. The periodic
  // autosave below passes false: canvas.toDataURL('image/png') is a genuine
  // synchronous PNG-encode, not just pixel pushing, and paying that cost
  // every 20s regardless of whether anything on-screen changed was landing
  // as a real, repeatable hitch during play. The thumbnail still gets
  // refreshed whenever it actually matters — tab-hidden, beforeunload, and
  // leaving the world — just not on every routine tick.
  function save(thumb) {
    if (thumb === undefined) thumb = true;
    // currentWorldId is the only gate. Checking gameState === 'PLAYING' here
    // looked safer but silently broke world creation: resetGameAndWorld() puts
    // the game back into 'INTRO', so the save() right after createWorld() did
    // nothing and a brand-new world stayed missing from the load list until the
    // first autosave twenty seconds later - or forever, if the tab was closed.
    if (!currentWorldId) return false;            // still on the menu, nothing to write
    let payload;
    try { payload = JSON.stringify(serialize()); }
    catch (e) { console.warn('Voxeria: could not serialise world', e); return false; }

    // Read first, write second. Whether this world is already in the index
    // decides what a later failure has to undo, and asking afterwards would
    // be asking about a state we just changed.
    const list = readIndex();
    const row = list.find(w => w.id === currentWorldId);
    const isNew = !row;
    const key = WORLD_PREFIX + currentWorldId;

    // No size check of our own: see WARN_CHARS above for why a hand-picked
    // ceiling could only ever refuse saves the browser would have accepted.
    try {
      localStorage.setItem(key, payload);
    } catch (e) {
      reportSaveFailed();
      return false;
    }

    const meta = { id: currentWorldId, name: currentWorldName, mode: gameMode, seed: rawSeedString, savedAt: Date.now() };
    // Only overwrite a stored thumb on success — a transient capture failure
    // (e.g. autosave firing a frame before spawn finished) should never wipe
    // out a perfectly good thumbnail from a previous save.
    if (thumb) {
      const capturedThumb = captureWorldThumb();
      if (capturedThumb) meta.thumb = capturedThumb;
    }
    if (row) Object.assign(row, meta); else list.push(meta);

    if (!writeIndex(list)) {
      // The thumbnail is the only large thing in the index and it is pure
      // decoration. A tile without a picture beats a world missing from the
      // list, so it is the first thing to go rather than the last.
      if (meta.thumb || (row && row.thumb)) {
        delete meta.thumb;
        if (row) delete row.thumb;
        if (writeIndex(list)) { reportSaveWorking(); return true; }
      }
      // Still no index. For a world that was already listed this is survivable:
      // its entry still points at the data we just wrote, and only savedAt is
      // stale. A BRAND NEW world has nothing pointing at it, so leaving the
      // payload behind would burn the very space that is running out on
      // something no screen can ever show.
      if (isNew) { try { localStorage.removeItem(key); } catch (e) {} }
      reportSaveFailed();
      return false;
    }

    reportSaveWorking();
    warnIfNearlyFull(payload.length);
    return true;
  }

  // ---- load --------------------------------------------------------------
  // `fresh` is set only by createWorld(). A saved world carries its own
  // inventory/player/armor, so loading one always overwrites those; a brand
  // new world has nothing to carry, and the fields below simply used to be
  // left alone — which meant the new world silently inherited whatever the
  // PREVIOUS world happened to leave in them.
  function applySave(data, fresh) {
    currentWorldId = data.id;
    currentWorldName = data.name;
    gameMode = MODES[data.mode] ? data.mode : 'normal';
    rawSeedString = data.seed;
    // SEED muss mit rawSeedString mitwandern. Ueberall sonst im Motor stehen
    // die beiden Zuweisungen direkt beieinander (applySeedFromUI,
    // startFreshWorld, die beiden Mod-Pfade) -- hier fehlte die zweite, und
    // eine benannte Welt lief damit unter der SEED-Nummer der VORIGEN Welt.
    //
    // Das war nicht kosmetisch: resetGameAndWorld() gleich darunter abonniert
    // 'voxeria_world_' + SEED, und setBlockAndBroadcast schreibt dorthin. Mit
    // veralteter Nummer landeten die Bauten einer privaten Welt in der
    // Sammlung einer anderen -- im Normalfall der oeffentlichen Wochenwelt,
    // aus der dann auch fremde Bloecke zurueckkamen. Dieselbe Nummer steuert
    // ausserdem pocketRunRef(), also welche Koop-Dives man geteilt bekommt.
    SEED = seedToNumber(rawSeedString);
    // Vor resetGameAndWorld(): das erzeugt die Welt neu, und ab dem ersten
    // Chunk steht die Weltart fest. Eine spaeter gesetzte Breite kaeme fuer
    // die bereits generierten Waende zu spaet.
    if (window.VxArena) VxArena.setWorldWidth(gameMode === 'arena' ? (data.arenaWidth || 128) : 0);

    // Rebuild terrain from the seed first; this clears every dimension map, so
    // it has to happen before the edits are replayed on top.
    resetGameAndWorld();

    worldEdits.clear();
    if (Array.isArray(data.edits)) {
      for (const e of data.edits) {
        // localSetBlock pulls the owning chunk into existence on demand, so
        // replaying an edit for a chunk that has not been generated yet works
        // without any explicit pre-generation pass.
        localSetBlock(e[0], e[1], e[2], 'OVERWORLD');
        worldEdits.set(e[0] + ',' + e[1], e[2]);
      }
    }
    if (data.player) {
      player.x = data.player.x; player.y = data.player.y;
      player.health = data.player.health || maxHealth;
      if (data.player.color) player.color = data.player.color;
    }
    if (data.inventory && data.inventory.length) inventory = normalizeInventory(data.inventory);
    else if (fresh) {
      // Inventory is stored PER WORLD (see serialize), unlike armor, which is
      // deliberately global forever-progress and stays untouched here.
      // resetGameAndWorld() leaves the hotbar alone on purpose so a plain seed
      // change doesn't cost you your items — correct there, wrong here: a new
      // world is a new run and starts from the default kit.
      // A mod's own startInventory is applied inside resetGameAndWorld() and
      // outranks that kit, so don't undo it.
      const modGaveInventory = !!(activeMod && Array.isArray(activeMod.startInventory)
        && activeMod.startInventory.some(it => it && Number.isInteger(it.block) && blockNames[it.block]));
      if (!modGaveInventory) inventory = makeStartingInventory();
      // The pre-mod stash belongs to the world it was taken in. Left set, it
      // would be restored into THIS world the moment the player leaves the mod.
      realInventorySnapshot = null;
    }
    if (data.armor) {
      craftedArmor = new Set(data.armor.crafted || []);
      equippedArmor = new Set(data.armor.equipped || []);
      applyArmorStatBonuses();
    }
    // resetGameAndWorld() above already cleared every exploredCells set for
    // the fresh world being switched to; repopulate OVERWORLD's from the save.
    // Older saves used a coarser 8×8 fog grid. Those keys cannot be safely
    // interpreted as 4×4 coordinates, so they begin with fresh fog instead
    // of revealing the wrong places on the detailed map.
    exploredCells.OVERWORLD = new Set(
      data.minimapCell === MINIMAP_CELL && Array.isArray(data.exploredOverworld)
        ? data.exploredOverworld : []
    );
    _minimapLastCell = null; // force a redraw against the newly-loaded fog
    // The pre-existing sessionStorage resume would otherwise fire a moment
    // later and stomp the position we just restored.
    _sessionResumeAttempted = true;
    drawHealth(); drawHotbar(); applyModeGating(); updateWorldLabel();
    hide();
  }

  // The HUD readout that replaced the editable seed box. Shows the world you
  // chose, and falls back to the raw seed for a multiplayer room, where the
  // seed IS the room code and there is no named save behind it.
  function updateWorldLabel() {
    const el = document.getElementById('vx-world-label');
    if (!el) return;
    el.textContent = inRoomNow() ? rawSeedString : (currentWorldName || rawSeedString);
    el.title = 'Seed: ' + rawSeedString;
  }

  function load(id) {
    const raw = localStorage.getItem(WORLD_PREFIX + id);
    if (!raw) { showNotification('That save could not be found'); return; }
    let data;
    try { data = JSON.parse(raw); }
    catch (e) { showNotification('That save is corrupted'); return; }
    applySave(data);
    showNotification('Loaded: ' + data.name);
  }

  function remove(id) {
    localStorage.removeItem(WORLD_PREFIX + id);
    writeIndex(readIndex().filter(w => w.id !== id));
    // Space just came free, so the "running low" advice has earned the right
    // to be said again if it ever applies a second time.
    warnedNearFull = false;
    renderList();
  }

  // ---- mode gating -------------------------------------------------------
  // Exploration reuses the existing Portal Book rather than a separate code path:
  // the dimensions, their hazards and the collapse timer are untouched, the
  // button that reaches them is simply not offered.
  function applyModeGating() {
    const cfg = MODES[gameMode] || MODES.normal;
    const pb = document.getElementById('portal-book-btn');
    if (pb) pb.style.display = cfg.portalBook ? '' : 'none';
    for (const id of STUDIO_BUTTON_IDS) {
      const el = document.getElementById(id);
      if (el) el.style.display = cfg.studio ? '' : 'none';
    }
    // Hiding the buttons only stops the NEXT click. A designer already on
    // screen when the player loads a Normal world would otherwise stay open
    // and fully usable over it.
    if (!cfg.studio && typeof window.vxCloseCreatorModals === 'function') window.vxCloseCreatorModals();
    document.body.dataset.vxMode = gameMode;

    // Normal mode moves #health down to sit above #hotbar (see the CSS next
    // to body[data-vx-mode="normal"] #health in index.html) rather than
    // leaving it at the top of #info-bar like every other mode. A CSS
    // position alone cannot do that move: #info-bar has backdrop-filter,
    // which makes IT the containing block for any fixed/absolute descendant,
    // so #health has to actually leave the DOM subtree #info-bar's filter
    // applies to. Reparented here (not left a one-way move) so switching
    // back out of Normal -- joining another room, loading a different save
    // -- restores it to #info-bar's flow instead of leaving a stray node
    // sitting over the canvas in a mode that never asked for it.
    const healthEl = document.getElementById('health');
    const hotbarEl = document.getElementById('hotbar');
    const infoBarEl = document.getElementById('info-bar');
    if (healthEl && hotbarEl && infoBarEl) {
      if (gameMode === 'normal') {
        if (healthEl.parentElement !== hotbarEl.parentElement) hotbarEl.parentElement.insertBefore(healthEl, hotbarEl);
      } else if (healthEl.parentElement !== infoBarEl) {
        infoBarEl.insertBefore(healthEl, infoBarEl.firstChild);
      }
    }

    hideEmptyMenuSections();
  }

  // Ein Abschnittstitel ueber null Eintraegen ist schlimmer als gar keiner.
  // Das passiert regelmaessig: "Play" verliert im Arena- und Exploration-Modus
  // das Portal-Buch, "Create" verliert im Normal-Modus alle fuenf Eintraege.
  //
  // Geprueft wird die TATSAECHLICHE Sichtbarkeit ueber offsetParent, nicht das
  // inline gesetzte style.display: zwei der Eintraege sind zusaetzlich per
  // "display:none !important" aus einem <style>-Block ausgeblendet (siehe
  // #temp-disabled-buttons in index.html), und deren inline-Stil steht auf ''.
  // Wer nur den inline-Wert liest, haelt sie faelschlich fuer sichtbar.
  function hideEmptyMenuSections() {
    const panel = document.getElementById('game-menu-panel');
    if (!panel) return;
    // offsetParent ist null, solange das Panel selbst zu ist. Dann ist die
    // Messung wertlos, also erst beim Oeffnen erneut laufen (siehe
    // toggleGameMenu in voxeria-engine.js, das applyModeGating nicht ruft --
    // deshalb wird hier zusaetzlich beim Oeffnen nachgezogen).
    const open = panel.classList.contains('open');
    panel.querySelectorAll('.gm-section').forEach(sec => {
      sec.style.display = '';
      if (!open) return;
      const items = [...sec.children].filter(el => !el.classList.contains('gm-label'));
      const anyVisible = items.some(el => el.offsetParent !== null);
      if (!anyVisible) sec.style.display = 'none';
    });
  }
  window.vxHideEmptyMenuSections = hideEmptyMenuSections;

  // The single answer to "may the creator tools be opened right now". Hiding
  // the buttons is the visible half of the rule — the modding file asks this
  // before opening anything, so a path that bypasses a button (the modding
  // tip's link, a tile on the studio panel) lands on the same answer.
  //
  // Which mode counts depends on what the player is looking at. On the
  // new-world screen they are choosing a mode for a world that does not exist
  // yet, so the pending choice governs — otherwise creating an Exploration
  // world while a Normal one happened to be loaded would hide the studio panel
  // and refuse its own tiles. Anywhere else, the running world's mode is what
  // matters.
  // All three screens of the create-a-world flow count: the mode picker and
  // the two mode screens that follow it. The Exploration screen in particular
  // MUST count, or its own creator tools would be gated by whatever mode
  // happened to be loaded before rather than by the one being chosen.
  function onNewWorldView() {
    const menu = document.getElementById('vx-menu');
    if (!menu || !menu.classList.contains('show')) return false;
    return ['new', 'explore', 'normal'].some(v => {
      const el = document.getElementById('vx-view-' + v);
      return !!el && el.style.display !== 'none';
    });
  }
  // "Is a world running right now?" A multiplayer room is one, even though it
  // deliberately has NO named save behind it (see _leaveNamedWorldForRoom in
  // voxeria-engine.js). Checking `currentWorldId` alone mistakes a running room
  // for "still on the menu", and then the creator tools are gated by the mode
  // pre-selected in the menu instead of the room's, and "Back to Game" is
  // missing.
  function inRoomNow() {
    return typeof ROOM_PREFIX === 'string' && String(rawSeedString || '').startsWith(ROOM_PREFIX);
  }
  function worldRunning() { return !!currentWorldId || inRoomNow(); }

  function studioAllowed() {
    const mode = onNewWorldView() ? pendingMode : (worldRunning() ? gameMode : pendingMode);
    return !!(MODES[mode] || MODES.normal).studio;
  }
  window.vxStudioAllowed = studioAllowed;

  // ---- create ------------------------------------------------------------
  function createWorld() {
    const nameEl = document.getElementById('vx-new-name');
    const seedEl = document.getElementById('vx-new-seed');
    const err = document.getElementById('vx-new-err');
    const name = (nameEl.value || '').trim() || 'My World';
    if (readIndex().some(w => w.name.toLowerCase() === name.toLowerCase())) {
      err.textContent = 'A world with that name already exists.';
      return;
    }
    err.textContent = '';
    const seed = (seedEl.value || '').trim() || ('vx-' + Math.random().toString(36).slice(2, 10));
    // Die Breite gehoert zur WELT, nicht zur Sitzung: applySave liest sie beim
    // Laden wieder heraus (siehe VxArena.setWorldWidth dort), damit eine
    // gespeicherte Arena beim naechsten Oeffnen dieselbe Groesse hat.
    const isArena = pendingMode === 'arena';
    // Der Bauplan ersetzt die schmale Startplattform durch ein fertiges
    // Baufeld -- ueber genau die Bearbeitungsliste, die ein Speicherstand
    // beim Laden ohnehin abspielt (siehe applySave weiter unten), kein
    // zweiter Mechanismus.
    const templateEdits = (isArena && typeof ARENA_TEMPLATES !== 'undefined' && ARENA_TEMPLATES[pendingArenaTemplate])
      ? ARENA_TEMPLATES[pendingArenaTemplate].build(pendingArenaWidth)
      : [];
    applySave({
      id: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: name, seed: seed, mode: pendingMode,
      arenaWidth: isArena ? pendingArenaWidth : 0,
      player: null, inventory: null, armor: null, edits: templateEdits
    }, /* fresh */ true);
    save();
    showNotification('New world: ' + name + ' (' + MODES[pendingMode].label + ')');
  }

  // Picking a mode is now a step, not a toggle: each mode has a screen of its
  // own and that is where its world gets started. Selecting one here and
  // leaving the player on the same page was what buried Exploration's creator
  // tools at the bottom of a form.
  function pickMode(m) {
    pendingMode = m;
    document.querySelectorAll('#vx-view-new .vx-mode').forEach(el => {
      el.classList.toggle('sel', el.dataset.mode === m);
    });
    view(m === 'explore' ? 'explore' : m === 'arena' ? 'arena' : 'normal');
  }

  // Die Breitenwahl auf dem SOLO-Arena-Bildschirm. Eigene Zeile, aber dieselbe
  // Liste und dieselbe gemerkte Breite wie beim Hosten, damit beide Wege nicht
  // unterschiedliche Groessen anbieten koennen.
  function renderSoloWidthRow() {
    const row = document.getElementById('vx-arena-width-row');
    if (!row || !window.VxArena) return;
    row.innerHTML = VxArena.WIDTHS.map(w =>
      '<div class="vx-seg-opt' + (w.blocks === pendingArenaWidth ? ' sel' : '') + '" ' +
      'onclick="VxWorlds.pickArenaWidth(' + w.blocks + ')">' +
      escapeHtml(w.label) + '</div>').join('');
  }

  // Welcher Bauplan eine frisch erstellte Solo-Arena bekommt, statt der
  // schmalen Startplattform. Nur auf dem Solo-Bildschirm -- ein gehosteter
  // Raum hat kein Verfahren, um vorgefertigte Bloecke in sein geteiltes
  // Firestore-Dokument zu schreiben, das waere eine eigene Erweiterung.
  let pendingArenaTemplate = 'empty';

  function renderArenaTemplateRow() {
    const row = document.getElementById('vx-arena-template-row');
    if (!row || typeof ARENA_TEMPLATES === 'undefined') return;
    row.innerHTML = Object.keys(ARENA_TEMPLATES).map(key =>
      '<div class="vx-seg-opt' + (key === pendingArenaTemplate ? ' sel' : '') + '" ' +
      'onclick="VxWorlds.pickArenaTemplate(\'' + key + '\')">' +
      escapeHtml(ARENA_TEMPLATES[key].label) + '</div>').join('');
  }

  function pickArenaTemplate(key) {
    if (!ARENA_TEMPLATES[key]) return;
    pendingArenaTemplate = key;
    renderArenaTemplateRow();
  }

  // ---- Creator Studio invitation ----------------------------------------
  // On the new-world screen, for the modes whose `studio` flag allows it —
  // Exploration today. It briefly showed in every mode, to stop the game's
  // most distinctive feature hiding behind a choice players make without
  // reading it; the invitation is worth keeping, but Normal is the guided run
  // and the creator tools are not part of it.

  // The rule tile has no pixel art to show, so it borrows the game's own icon
  // renderer (VX_ICONS) rather than inventing a second glyph system. Puzzle,
  // not star: it is the same icon the Mod Editor wears everywhere else it
  // appears (the menu entry, its own header), so a star here would be pointing
  // at the wrong thing.
  function studioDrawRuleTile() {
    const cv = document.getElementById('vx-studio-art-rule');
    if (!cv || typeof VX_ICONS === 'undefined' || !VX_ICONS.puzzle) return;
    // The drawIcon* functions take a canvas and size it themselves (16px), so
    // it gets its own buffer and is blitted up to the tile, pixels intact.
    const tmp = document.createElement('canvas');
    VX_ICONS.puzzle(tmp);
    const c = cv.getContext('2d');
    c.clearRect(0, 0, cv.width, cv.height);
    c.imageSmoothingEnabled = false;
    c.drawImage(tmp, 0, 0, cv.width, cv.height);
  }

  function vxStudioRefresh() {
    const panel = document.getElementById('vx-studio');
    if (!panel || typeof VxPieces === 'undefined') return;
    const nB = VxPieces.list('BLOCK').length, nC = VxPieces.list('CREATURE').length, nG = VxPieces.list('GRAPH').length;
    const total = nB + nC + nG;

    const have = document.getElementById('vx-studio-have');
    have.innerHTML = total
      ? 'Ready for this world: <b>' + nB + '</b> block' + (nB === 1 ? '' : 's') +
        ' &middot; <b>' + nC + '</b> creature' + (nC === 1 ? '' : 's') +
        ' &middot; <b>' + nG + '</b> mod' + (nG === 1 ? '' : 's')
      : 'Nothing made yet &mdash; it takes about a minute.';

    studioDrawRuleTile();
  }

  // No collapsed state any more: the panel has the Exploration screen to
  // itself, so there is nothing for it to be in the way of.
  function vxStudioSetVisible(on) {
    const panel = document.getElementById('vx-studio');
    if (!panel) return;
    panel.classList.toggle('show', !!on);
    if (on) vxStudioRefresh();
  }

  // Opens a designer straight from the menu. The designer modals live in the
  // game's DOM behind this overlay, so they carry a z-index above it (see the
  // designer CSS) and simply sit on top; closing one drops the player back
  // here with the panel refreshed to include whatever they just made.
  function openStudio(kind) {
    const open = {
      BLOCK: window.toggleBlockDesigner,
      CREATURE: window.toggleCreatureDesigner,
      GRAPH: window.toggleModEditor,
      // Optional on purpose: voxeria-terminal.js is one <script> tag, and
      // removing it must leave this button inert rather than throwing.
      TERMINAL: window.toggleWorldTerminal
    }[kind];
    if (typeof open === 'function') open();
    else if (typeof showNotification === 'function') {
      showNotification('That tool is not available in this build.');
    }
  }
  window.vxStudioRefresh = vxStudioRefresh;

  // ---- import / export ---------------------------------------------------
  function exportCurrent() {
    const err = document.getElementById('vx-opts-err');
    if (!currentWorldId) { err.textContent = 'No world is currently loaded.'; return; }
    err.textContent = '';
    const blob = new Blob([JSON.stringify(serialize(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (currentWorldName || 'voxeria-world').replace(/[^a-z0-9_-]+/gi, '_') + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importFile(file) {
    const err = document.getElementById('vx-opts-err');
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try { data = JSON.parse(reader.result); }
      catch (e) { err.textContent = 'That is not a valid JSON file.'; return; }
      if (!data || typeof data.seed !== 'string' || !Array.isArray(data.edits)) {
        err.textContent = 'That file is not a Voxeria save.';
        return;
      }
      if (data.v > SAVE_VERSION) {
        err.textContent = 'That save was made by a newer version of the game.';
        return;
      }
      // Always a fresh id, so importing your own export twice makes two worlds
      // instead of silently overwriting the one you are playing.
      data.id = 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      data.name = (data.name || 'Import') + ' (Import)';
      err.textContent = '';
      applySave(data);
      save();
      showNotification('Imported: ' + data.name);
    };
    reader.readAsText(file);
  }

  // ---- multiplayer -------------------------------------------------------
  // Both entry points delegate to the game's existing room functions rather
  // than re-implementing them: those already handle the Firestore room
  // document, the seed switch and the abandoned-seed cleanup, and duplicating
  // any of that here would be a second source of truth to keep in step.
  function mpOnline() {
    return (typeof isMultiplayerActive !== 'undefined') && isMultiplayerActive && !!db && !!userId;
  }

  // The Firebase sign-in carries on asynchronously while the menu is already
  // up. Anyone opening the multiplayer screen right after launch therefore saw
  // "Offline", and because that screen never refreshed itself, it stayed that
  // way even after the connection came up a second later. Host Room then
  // created the local fallback world instead of a room: from the player's side,
  // "the button does nothing".
  //
  // So the status is kept up to date for as long as the screen is open.
  let mpPoll = null;
  function stopMpPoll() { if (mpPoll) { clearInterval(mpPoll); mpPoll = null; } }
  function startMpPoll() {
    stopMpPoll();
    mpPoll = setInterval(() => {
      const view = document.getElementById('vx-view-mp');
      const menu = document.getElementById('vx-menu');
      const visible = menu && menu.classList.contains('show') && view && view.style.display !== 'none';
      if (!visible) { stopMpPoll(); return; }
      if (mpOnline()) { stopMpPoll(); refreshMpView(); }
    }, 700);
  }

  function refreshMpView() {
    const state = document.getElementById('vx-mp-state');
    if (!mpOnline()) {
      state.textContent = 'Connecting…';
      document.getElementById('vx-mp-err').textContent =
        'Still connecting. Hosting and joining need a moment.';
      startMpPoll();
      return;
    }
    stopMpPoll();
    document.getElementById('vx-mp-err').textContent = '';
    state.textContent = inRoomNow() ? ('In room ' + rawSeedString) : 'Connected';
  }

  // Der Modus eines Raums wird HIER gewaehlt, nicht beim Anlegen einer lokalen
  // Welt: er gilt fuer alle, die beitreten, und Arena braucht zusaetzlich eine
  // Breite, auf die sich alle einigen muessen. `hostRoom` oeffnet deshalb nur
  // noch den Auswahl-Bildschirm; erstellt wird der Raum erst in
  // confirmHostRoom().
  let pendingHostMode = 'explore';
  let pendingArenaWidth = 128;

  function hostRoom() { view('host'); }

  function pickHostMode(m) {
    pendingHostMode = m;
    document.querySelectorAll('#vx-view-host .vx-mode').forEach(el => {
      el.classList.toggle('sel', el.dataset.mode === m);
    });
    // Die Breite gibt es nur bei Arena -- die anderen beiden Modi erzeugen
    // eine endlose Welt, fuer die "wie breit?" keine Bedeutung hat.
    const widthBox = document.getElementById('vx-host-width');
    if (widthBox) widthBox.style.display = (m === 'arena') ? '' : 'none';
    if (m === 'arena') renderWidthRow();
  }

  function renderWidthRow() {
    const row = document.getElementById('vx-host-width-row');
    if (!row || !window.VxArena) return;
    row.innerHTML = VxArena.WIDTHS.map(w =>
      '<div class="vx-seg-opt' + (w.blocks === pendingArenaWidth ? ' sel' : '') + '" ' +
           'onclick="VxWorlds.pickArenaWidth(' + w.blocks + ')">' +
        escapeHtml(w.label) + '<span class="vx-seg-sub">' + w.blocks + ' blocks</span>' +
      '</div>'
    ).join('');
  }

  function pickArenaWidth(n) {
    pendingArenaWidth = n;
    // Beide Zeilen aktualisieren: welche gerade sichtbar ist, entscheidet der
    // Bildschirm, und die jeweils andere findet ihr Element schlicht nicht.
    renderWidthRow();
    renderSoloWidthRow();
  }

  // ASYNC, because createRoom() now waits for the room to be registered and
  // can let that fail. The screen is only closed once the room really exists;
  // `hide()` used to run unconditionally, so a failed creation looked exactly
  // like a successful one.
  async function confirmHostRoom() {
    const err = document.getElementById('vx-host-err');
    if (err) err.textContent = '';
    const isArena = pendingHostMode === 'arena';
    const btn = document.querySelector('#vx-view-host .vx-btn.primary');

    // Save first, switch the mode second: serialize() writes gameMode and the
    // arena width along with everything else, so saving AFTER the switch would
    // stamp the room's mode onto the private world last played.
    if (typeof window._flushWorldBeforeLeaving === 'function') window._flushWorldBeforeLeaving();

    // Modus und Breite MUESSEN stehen, bevor die Welt erzeugt wird:
    // createRoom() -> applySeedFromUI() -> resetGameAndWorld() -> getChunk(),
    // und ab dem ersten Chunk ist die Weltart festgelegt.
    gameMode = MODES[pendingHostMode] ? pendingHostMode : 'explore';
    if (window.VxArena) VxArena.setWorldWidth(isArena ? pendingArenaWidth : 0);
    applyModeGating();

    // Wait briefly for the sign-in instead of dropping straight into the
    // offline fallback world. Pressing the button in the first seconds after
    // launch otherwise hit exactly the window in which `db` is still null, and
    // produced a local world although a room was wanted and the connection came
    // up a blink later.
    let online = mpOnline();
    if (!online && typeof waitForDb === 'function') {
      if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }
      await waitForDb(5000);
      if (btn) { btn.disabled = false; btn.textContent = 'Create Room'; }
      online = mpOnline();
    }
    if (online && typeof createRoom === 'function') {
      // A double-click on "Create Room" would otherwise create two rooms, the
      // first of which is orphaned immediately, and the code the host reads out
      // may then be the wrong one.
      if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
      let code = null;
      try { code = await createRoom(gameMode, isArena ? pendingArenaWidth : 0); }
      finally { if (btn) { btn.disabled = false; btn.textContent = 'Create Room'; } }
      if (!code) {
        if (err) err.textContent = 'The room could not be created. Check your connection and try again.';
        return;
      }
      refreshMpView();
      updateWorldLabel();
      hide();
      return;
    }

    // Offline-Notfall: statt einer Fehlermeldung eine LOKALE Welt in genau
    // demselben Modus. Bauen und Ausprobieren geht damit auch ohne Netz --
    // geteilt wird, sobald wieder Verbindung besteht. Das arenaWidth-Feld im
    // Speicherformat sorgt dafuer, dass sie beim Laden dieselbe Breite behaelt.
    const name = (isArena ? 'Arena ' : 'Room ') + new Date().toLocaleDateString();
    let unique = name, n = 2;
    while (readIndex().some(w => w.name.toLowerCase() === unique.toLowerCase())) unique = name + ' (' + (n++) + ')';
    applySave({
      id: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: unique,
      seed: 'local-' + Math.random().toString(36).slice(2, 10),
      mode: pendingHostMode,
      arenaWidth: isArena ? pendingArenaWidth : 0,
      player: null, inventory: null, armor: null, edits: []
    }, /* fresh */ true);
    save();
    showNotification('Offline - created a local ' + MODES[pendingHostMode].label + ' world instead');
  }

  // ASYNC as well, and that is the actual bug being fixed here.
  // `joinRoomByCode(code)` used to be started and `hide()` called in the same
  // breath: the menu closed while the room lookup was still running (up to six
  // seconds of waiting for the sign-in), the player saw the old world, which
  // then jumped over without warning, and if the room did not exist at all they
  // were left sitting in an empty world with no hint of why.
  //
  // Now the screen stays up until the result is in, and a failure shows as text
  // underneath instead of as a closed menu.
  async function joinRoom() {
    const field = document.getElementById('vx-mp-code');
    const err = document.getElementById('vx-mp-err');
    const btn = document.getElementById('vx-mp-join-btn');
    const code = (field.value || '').trim().toUpperCase();
    if (!code) { err.textContent = 'Enter a room code first.'; return; }
    if (typeof joinRoomByCode !== 'function') {
      err.textContent = 'Multiplayer is not available right now.';
      return;
    }
    err.textContent = 'Looking for that room…';
    if (btn) { btn.disabled = true; btn.textContent = 'Joining…'; }
    let res;
    try {
      // joinRoomByCode reads the room document and sets mode and width BEFORE
      // it applies the seed; otherwise the guest generates ordinary terrain
      // while the host is standing in an empty arena.
      res = await joinRoomByCode(code);
    } catch (e) {
      console.error('Voxeria: join failed unexpectedly', e);
      res = { ok: false, message: 'Something went wrong while joining.' };
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Join Room'; }
    }
    if (!res || !res.ok) {
      err.textContent = (res && res.message) || 'That room could not be joined.';
      return;
    }
    err.textContent = '';
    field.value = '';
    updateWorldLabel();
    hide();
  }

  // ---- menu views --------------------------------------------------------
  function view(which) {
    for (const v of ['root', 'new', 'explore', 'normal', 'arena', 'load', 'mp', 'host', 'opts']) {
      const el = document.getElementById('vx-view-' + v);
      if (el) el.style.display = (v === which) ? '' : 'none';
    }
    if (which === 'load') renderList();
    if (which === 'mp') refreshMpView();
    if (which === 'host') pickHostMode(pendingHostMode);
    if (which === 'arena') { renderSoloWidthRow(); renderArenaTemplateRow(); }
    // The name/seed form is one element shared by both mode screens, parked
    // outside them until one is showing. Moved rather than duplicated so
    // createWorld() keeps reading a single #vx-new-name and the two screens
    // cannot drift apart.
    const setup = document.getElementById('vx-world-setup');
    const slot = document.querySelector('#vx-view-' + which + ' .vx-setup-slot');
    if (setup && slot && setup.parentNode !== slot) slot.appendChild(setup);
    // The studio panel belongs to the Exploration screen, and only in a mode
    // that allows the creator tools at all.
    vxStudioSetVisible(which === 'explore' && studioAllowed());
    // Only offer "back to game" once a world is actually running, otherwise the
    // button would dismiss the menu onto an empty session.
    const resume = document.getElementById('vx-resume');
    if (resume) resume.style.display = worldRunning() ? '' : 'none';
  }

  function renderList() {
    const host = document.getElementById('vx-world-list');
    const list = readIndex().sort((a, b) => b.savedAt - a.savedAt);
    if (!list.length) {
      host.innerHTML = '<div class="vx-empty">No saved worlds yet.</div>';
      return;
    }
    host.innerHTML = list.map(w => {
      const full = escapeHtml((MODES[w.mode] || {}).label || w.mode) +
        ' &middot; Seed ' + escapeHtml(w.seed) + ' &middot; ' + new Date(w.savedAt).toLocaleString();
      const thumb = w.thumb
        ? '<img class="vx-world-thumb" src="' + w.thumb + '" alt="" title="' + full + '">'
        : '<div class="vx-world-thumb vx-world-thumb-empty" title="' + full + '"></div>';
      return (
        '<div class="vx-world-tile">' +
          '<div class="vx-world-tile-body" onclick="VxWorlds.load(\'' + w.id + '\')">' +
            thumb +
            '<div class="vx-world-tile-name">' + escapeHtml(w.name) + '</div>' +
            '<div class="vx-world-tile-meta">' + escapeHtml((MODES[w.mode] || {}).label || w.mode) +
              ' &middot; ' + new Date(w.savedAt).toLocaleDateString() + '</div>' +
          '</div>' +
          '<button class="vx-del" title="Delete" onclick="VxWorlds.confirmRemove(\'' + w.id + '\')">X</button>' +
        '</div>'
      );
    }).join('');
  }

  function confirmRemove(id) {
    const w = readIndex().find(x => x.id === id);
    if (!w) return;
    if (confirm('Delete world "' + w.name + '" permanently?')) remove(id);
  }

  // The menu is not an overlay ON the game — while it is up the game is fully
  // stopped. The class the game loop and the music both look at is set here,
  // so the order matters: add it BEFORE stopping the music, remove it BEFORE
  // starting it, otherwise the guards inside the engine see the old state.
  function show() {
    document.getElementById('vx-menu').classList.add('show');
    // #vx-menu's own background is a translucent scrim now, not a solid
    // fill (see index.html) -- drawMenuPanorama() in voxeria-engine.js paints
    // real terrain onto the game canvas behind it. That canvas was always
    // there, previously just hidden behind the opaque menu; its OWN HUD
    // chrome (hearts, hotbar, the X/Y/biome bar, the minimap) would now show
    // through too if left alone, so it rides its own class rather than the
    // player's F4 "hide UI" preference (body.vx-hide-ui / toggleUIVisibility
    // in voxeria-engine.js), which this must not read or overwrite.
    document.body.classList.add('vx-menu-open');
    if (typeof window.vxStopBgMusic === 'function') window.vxStopBgMusic();
    view('root');
  }
  function hide() {
    document.getElementById('vx-menu').classList.remove('show');
    document.body.classList.remove('vx-menu-open');
    if (typeof window.vxStartBgMusic === 'function') window.vxStartBgMusic();
    // rAF-driven; without this the studio tile animation would keep ticking
    // behind a running world for the rest of the session.
    vxStudioSetVisible(false);
  }

  // ---- wiring ------------------------------------------------------------
  window.addEventListener('DOMContentLoaded', () => {
    document.getElementById('vx-import-file').addEventListener('change', ev => {
      if (ev.target.files && ev.target.files[0]) importFile(ev.target.files[0]);
      ev.target.value = '';
    });
    // NOT the full show() here on purpose. The very first time the page
    // loads, gameState "INTRO" (introKind "BOOT" — see voxeria-engine.js)
    // plays a one-off scene on the game canvas itself before the menu is
    // allowed to appear; updateAndDrawIntro() calls the real show() once
    // that finishes. Only the HUD-hiding half of show() happens here, so the
    // real game's hearts/hotbar/etc. don't flash behind that scene in the
    // meantime -- #vx-menu itself stays un-.show'd until the scene is done.
    document.body.classList.add('vx-menu-open');
    // Independent last-resort net, completely decoupled from the game engine:
    // before this existed, show() ran unconditionally right here, so the menu
    // always came up no matter what else on the page failed. Making it wait
    // for the BOOT scene traded that guarantee away -- if requestAnimationFrame
    // (gameLoop) never even gets its first call (e.g. initFirebase() in
    // voxeria-boot.js throwing synchronously, which real itch.io hosting can
    // trigger: the game runs inside a sandboxed iframe there, and Firebase's
    // storage/network access from a third-party iframe context is a known
    // failure mode), nothing else was left to ever show #vx-menu again -- a
    // permanently black page with no error the player could see. This timer
    // doesn't know or care why the engine didn't make it; it only checks
    // whether the menu is already open, and force-shows it if not. Reads the
    // DOM directly rather than calling window.vxMenuIsOpen() -- if
    // voxeria-engine.js is exactly what failed to finish executing, that
    // function might not even exist yet, and this net has to work regardless.
    // Longer than BOOT's own 12s worst-case (INTRO_BOOT_MAX_MS in
    // voxeria-engine.js) so a slow-but-working scene isn't cut off by its own
    // safety net.
    setTimeout(() => {
      const m = document.getElementById('vx-menu');
      if (m && !m.classList.contains('show')) show();
    }, 15000);
  });

  // Autosave. 20s is a compromise: frequent enough that a crash costs little,
  // rare enough that stringifying the edit map never lands in a frame budget
  // often. Skips the thumbnail (see save()'s `thumb` param) — that part is a
  // real PNG encode, not cheap enough to repeat every 20s of live play. Also
  // saved (with a thumb this time) when the tab is hidden, which is when a
  // phone browser is most likely to kill the page outright, and when leaving
  // is a natural moment to pay a one-off cost rather than a recurring one.
  setInterval(() => { save(false); }, 20000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
  window.addEventListener('beforeunload', () => { save(); });

  return {
    view: view, pickMode: pickMode, createWorld: createWorld, openStudio: openStudio,
    load: load, confirmRemove: confirmRemove,
    exportCurrent: exportCurrent, save: save,
    hostRoom: hostRoom, joinRoom: joinRoom,
    pickHostMode: pickHostMode, pickArenaWidth: pickArenaWidth, pickArenaTemplate: pickArenaTemplate, confirmHostRoom: confirmHostRoom,
    show: show, hide: hide, applyModeGating: applyModeGating,
    // Exposed for voxeria-gallery.js: playing a gallery entry needs the exact
    // same "start a fresh world from this data" path createWorld() itself
    // uses, rather than a second, drift-prone copy of it.
    applySave: applySave,
    MODES: MODES
  };
})();

