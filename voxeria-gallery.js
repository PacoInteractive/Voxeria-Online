// ============================================================================
// VOXERIA -- MOD GALLERY (window.VxGallery)
// ----------------------------------------------------------------------------
// A public, browsable list of mods (VXL1- loadout codes: one world-mod plus
// optional custom-block/creature/rule pieces, see voxeria-modding.js) that
// players have published.
//
// Two views: a translucent sidebar next to the main menu showing the five
// newest, and a full gallery modal behind its "See all" button with category
// filters, a world snapshot per entry, and per-entry report / details / play
// buttons.
//
// Self-contained on purpose, same rule as voxeria-arena.js/voxeria-coop-mods.js:
// loads after voxeria-modding.js (mod/loadout code functions) and
// voxeria-menu-worlds.js (VxWorlds), before voxeria-boot.js. Deleting this
// file's <script> tag removes the whole feature; nothing else calls into it.
// ============================================================================
window.VxGallery = (function () {
  const COLLECTION = 'voxeria_gallery';
  const COOLDOWN_COLLECTION = 'voxeria_gallery_cooldown';
  const REPORT_COLLECTION = 'voxeria_gallery_reports';
  const PUBLISH_COOLDOWN_MS = 5 * 60 * 1000;
  const SIDEBAR_LIMIT = 5;    // the sidebar is a teaser, not the gallery
  const FULL_LIMIT = 60;      // one fetch feeds both views; the modal shows all of it

  let cachedEntries = [];
  let extraFieldCount = 0;
  let activeCategory = 'all';
  let reportingEntryId = null;

  // =========================================================================
  // ICONS
  // Own artwork, never system emoji: those render differently on every OS and
  // would sit wrong next to 32x32 block textures. Same recipe as the game's
  // existing drawIcon* set in voxeria-engine.js (flat rectangles, that file's
  // two ink tones, _vxCrispen to burn anti-aliased edges to hard pixels) --
  // authored here rather than added to its VX_ICONS map so deleting this
  // file's script tag still takes the whole feature with it. `terrain` is
  // reused from that map for the World category: it already exists and is
  // exactly the right drawing.
  // =========================================================================
  const INK = typeof VX_ICON_LINE !== 'undefined' ? VX_ICON_LINE : '#e6e6ee';
  const INK_DIM = typeof VX_ICON_DIM !== 'undefined' ? VX_ICON_DIM : '#8f8fa0';

  function drawIconGalleryGrid(cv) {          // "All"
    cv.width = 16; cv.height = 16;
    const c = cv.getContext('2d');
    c.fillStyle = INK;
    c.fillRect(2, 2, 5, 5); c.fillRect(9, 2, 5, 5);
    c.fillRect(2, 9, 5, 5); c.fillRect(9, 9, 5, 5);
  }
  function drawIconGalleryCube(cv) {          // "Blocks"
    cv.width = 16; cv.height = 16;
    const c = cv.getContext('2d');
    c.fillStyle = INK;
    c.fillRect(2, 4, 12, 10);
    c.fillStyle = INK_DIM;
    c.fillRect(4, 2, 12, 2); c.fillRect(14, 4, 2, 10);   // the offset "top/side" faces
  }
  function drawIconGalleryCritter(cv) {       // "Creatures"
    cv.width = 16; cv.height = 16;
    const c = cv.getContext('2d');
    c.fillStyle = INK;
    c.fillRect(3, 5, 10, 7);                              // body
    c.fillRect(4, 12, 2, 2); c.fillRect(10, 12, 2, 2);    // feet
    c.fillRect(4, 3, 2, 2); c.fillRect(10, 3, 2, 2);      // ears
    c.fillStyle = INK_DIM;
    c.fillRect(5, 7, 2, 2); c.fillRect(9, 7, 2, 2);       // eyes
  }
  function drawIconGalleryNodes(cv) {         // "Rules" (the node-graph editor's shape)
    cv.width = 16; cv.height = 16;
    const c = cv.getContext('2d');
    c.fillStyle = INK_DIM;
    c.fillRect(6, 4, 5, 2); c.fillRect(9, 4, 2, 8); c.fillRect(5, 10, 5, 2); // wires
    c.fillStyle = INK;
    c.fillRect(1, 2, 5, 5); c.fillRect(10, 2, 5, 5); c.fillRect(1, 9, 5, 5);
  }
  function drawIconGalleryFlag(cv) {          // report
    cv.width = 16; cv.height = 16;
    const c = cv.getContext('2d');
    c.fillStyle = INK;
    c.fillRect(3, 2, 2, 12);                              // pole
    c.fillRect(5, 3, 8, 5);                               // banner
    c.fillStyle = INK_DIM;
    c.fillRect(5, 8, 6, 2);                               // furled lower edge
  }
  function drawIconGalleryInfo(cv) {          // details
    cv.width = 16; cv.height = 16;
    const c = cv.getContext('2d');
    c.fillStyle = INK;
    c.fillRect(2, 2, 12, 12);
    c.fillStyle = '#14141c';
    c.fillRect(7, 4, 2, 2); c.fillRect(7, 7, 2, 5);       // the "i"
  }
  function drawIconGalleryPlay(cv) {
    cv.width = 16; cv.height = 16;
    const c = cv.getContext('2d');
    c.fillStyle = INK;
    // Stepped triangle, drawn as rows so it stays hard-edged like the rest.
    for (let i = 0; i < 6; i++) c.fillRect(4 + i, 3 + i, 2, 12 - i * 2);
  }

  const GALLERY_ICONS = {
    'gallery-grid': drawIconGalleryGrid, 'gallery-cube': drawIconGalleryCube,
    'gallery-critter': drawIconGalleryCritter, 'gallery-nodes': drawIconGalleryNodes,
    'gallery-flag': drawIconGalleryFlag, 'gallery-info': drawIconGalleryInfo,
    'gallery-play': drawIconGalleryPlay
  };

  // Cards are built fresh on every render, so their canvases can't ride
  // _initVxIcons()'s one-time startup pass over static HTML — each one is
  // drawn on creation instead, the same way the Portal Book handles its own
  // dynamic canvases.
  function paintIcon(cv, name) {
    const fn = GALLERY_ICONS[name] || (typeof VX_ICONS !== 'undefined' ? VX_ICONS[name] : null);
    if (!fn) return;
    fn(cv);
    if (typeof _vxNormalize === 'function') _vxNormalize(cv);
    if (typeof _vxCrispen === 'function') _vxCrispen(cv);
  }
  function iconHtml(name, cls) {
    return '<canvas class="vx-gallery-ico ' + (cls || '') + '" data-gallery-icon="' + name + '"></canvas>';
  }
  function paintIconsIn(root) {
    root.querySelectorAll('canvas[data-gallery-icon]').forEach(cv => paintIcon(cv, cv.dataset.galleryIcon));
  }

  // Auto-derived, never author-chosen: the code itself already says exactly
  // what is in it, so a listing can't be mis-filed (deliberate, see
  // DATEISTRUKTUR.md) and publishing needs no extra field.
  const CATEGORIES = [
    { id: 'all', label: 'All', icon: 'gallery-grid' },
    { id: 'block', label: 'Blocks', icon: 'gallery-cube' },
    { id: 'creature', label: 'Creatures', icon: 'gallery-critter' },
    { id: 'graph', label: 'Rules', icon: 'gallery-nodes' },
    { id: 'world', label: 'World', icon: 'terrain' }
  ];

  const REPORT_REASONS = [
    { id: 'inappropriate', label: 'Inappropriate content' },
    { id: 'spam', label: 'Spam or nonsense' },
    { id: 'broken', label: 'Broken — does not work' },
    { id: 'stolen', label: "Someone else's work" }
  ];

  // -- readiness ------------------------------------------------------------
  // Same idiom as mpOnline() in voxeria-menu-worlds.js: userId/db are only
  // set once initFirebase()'s signInAnonymously() resolves, which happens
  // asynchronously well after this script has finished evaluating.
  function galleryReady() {
    return typeof isMultiplayerActive !== 'undefined' && isMultiplayerActive && !!db && !!userId;
  }
  function galleryCollectionRef() { return collection(db, 'artifacts', appId, 'public', 'data', COLLECTION); }
  function cooldownDocRef() { return doc(db, 'artifacts', appId, 'public', 'data', COOLDOWN_COLLECTION, userId); }

  // -- word filter ------------------------------------------------------------
  // Deliberately basic (Jaylen's own call: a filter, not a review queue).
  // Word-boundary match so a blocked word inside a longer innocent word
  // (e.g. "class") never trips it.
  const BLOCKED_WORDS = [
    'fuck', 'shit', 'bitch', 'cunt', 'nigger', 'nigga', 'faggot', 'retard',
    'hurensohn', 'wichser', 'schlampe', 'fotze', 'arschloch', 'nazi'
  ];
  function containsBlockedWord(s) {
    const lower = String(s || '').toLowerCase();
    return BLOCKED_WORDS.some(w => new RegExp('\\b' + w + '\\b', 'i').test(lower));
  }

  // -- decode / derive ---------------------------------------------------------
  // Memoized on the entry object itself, so re-rendering (sidebar + modal +
  // after a publish) doesn't re-decode every card each time.
  function decodeEntry(entry) {
    if (entry._decoded !== undefined) return entry._decoded;
    entry._decoded = isLoadoutCode(entry.code) ? decodeLoadoutCode(entry.code) : null;
    return entry._decoded;
  }

  // Which categories a loadout belongs to, read straight out of its pieces.
  // 'world' means the mod half actually changes something about the world,
  // rather than being the empty default wrapper a piece-only publish gets.
  function deriveTags(mod, pieceCodes) {
    const tags = [];
    for (const code of pieceCodes || []) {
      const piece = decodeAnyPieceCode(code);
      if (!piece) continue;
      if (piece.kind === 'GRAPH') { if (!tags.includes('graph')) tags.push('graph'); }
      else if (piece.kind === 'CREATURE') { if (!tags.includes('creature')) tags.push('creature'); }
      else if (!tags.includes('block')) tags.push('block');
    }
    try {
      const def = modDefaults();
      const changed = ['world', 'dim', 'visual', 'behavior', 'perks'].some(k =>
        JSON.stringify(mod[k]) !== JSON.stringify(def[k]));
      const gearedUp = Array.isArray(mod.startInventory) && mod.startInventory.length > 0;
      if (changed || gearedUp) tags.push('world');
    } catch (e) { /* an unknown/older mod shape simply gets no world tag */ }
    return tags;
  }

  // What the details button shows. Everything here is read back out of the
  // code, so nothing has to be typed at publish time and nothing can claim to
  // be something it isn't.
  function describeEntry(entry) {
    const loadout = decodeEntry(entry);
    if (!loadout) return 'This entry could not be read.';
    const counts = { BLOCK: 0, CREATURE: 0, GRAPH: 0 };
    const names = [];
    for (const code of loadout.pieceCodes) {
      const piece = decodeAnyPieceCode(code);
      if (!piece) continue;
      const kind = piece.kind === 'GRAPH' || piece.kind === 'CREATURE' ? piece.kind : 'BLOCK';
      counts[kind]++;
      if (piece.name) names.push(piece.name);
    }
    const lines = [];
    const parts = [];
    if (counts.BLOCK) parts.push(counts.BLOCK + (counts.BLOCK === 1 ? ' block' : ' blocks'));
    if (counts.CREATURE) parts.push(counts.CREATURE + (counts.CREATURE === 1 ? ' creature' : ' creatures'));
    if (counts.GRAPH) parts.push(counts.GRAPH + (counts.GRAPH === 1 ? ' rule set' : ' rule sets'));
    lines.push('Contains: ' + (parts.length ? parts.join(', ') : 'world settings only'));
    if (names.length) lines.push('Pieces: ' + names.join(', '));

    const mod = loadout.mod;
    try {
      const def = modDefaults();
      const changed = [];
      if (JSON.stringify(mod.world) !== JSON.stringify(def.world)) changed.push('terrain');
      if (JSON.stringify(mod.dim) !== JSON.stringify(def.dim)) changed.push('gravity/spawns');
      if (JSON.stringify(mod.visual) !== JSON.stringify(def.visual)) changed.push('look');
      if (JSON.stringify(mod.behavior) !== JSON.stringify(def.behavior)) changed.push('behaviour');
      if (JSON.stringify(mod.perks) !== JSON.stringify(def.perks)) changed.push('perks');
      if (changed.length) lines.push('Changes: ' + changed.join(', '));
      if (Array.isArray(mod.startInventory) && mod.startInventory.length) {
        lines.push('Starting kit: ' + mod.startInventory.length + ' stack(s)');
      }
    } catch (e) { /* older mod shape — the counts above are still worth showing */ }
    if (mod.seed) lines.push('Seed: ' + mod.seed);
    lines.push('Published: ' + new Date(entry.createdAt || Date.now()).toLocaleDateString());
    return lines.join('\n');
  }

  // -- fetch / render ---------------------------------------------------------
  let _pollTimer = null;
  function stopPoll() { if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; } }
  function openGallery() {
    const list = document.getElementById('vx-gallery-list');
    if (!list) return;
    if (!galleryReady()) {
      list.innerHTML = '<div class="vx-gallery-hint">Connecting…</div>';
      if (!_pollTimer) {
        // Tied to the menu being on screen rather than to an attempt count,
        // the same way startMpPoll() in voxeria-menu-worlds.js does it: on a
        // machine that never reaches Firebase at all, an uncapped timer would
        // otherwise keep firing for the rest of the session.
        _pollTimer = setInterval(() => {
          const menu = document.getElementById('vx-menu');
          if (!menu || !menu.classList.contains('show')) { stopPoll(); return; }
          if (galleryReady()) { stopPoll(); openGallery(); }
        }, 700);
      }
      return;
    }
    stopPoll();
    fetchGalleryList();
  }

  function fetchGalleryList() {
    // One-shot getDocs, not a live onSnapshot: a listener would replay the
    // stagger-in animation mid-browse the instant someone else publishes,
    // which reads as a glitch rather than a feature. One fetch feeds both the
    // sidebar (first five) and the full modal (all of it).
    return getDocs(query(galleryCollectionRef(), orderBy('createdAt', 'desc'), limitQuery(FULL_LIMIT)))
      .then(snap => {
        cachedEntries = [];
        snap.forEach(d => cachedEntries.push(Object.assign({ id: d.id }, d.data())));
        renderSidebar();
        if (isFullOpen()) renderFullGallery();
      })
      .catch(e => {
        console.error('Voxeria gallery: fetch failed', e);
        const list = document.getElementById('vx-gallery-list');
        if (list) list.innerHTML = '<div class="vx-gallery-hint">Could not load the gallery.</div>';
      });
  }

  function entryTitle(entry) {
    const loadout = decodeEntry(entry);
    return (loadout && loadout.mod.name) || 'Untitled Mod';
  }
  function entryAuthor(entry) {
    const loadout = decodeEntry(entry);
    return (loadout && loadout.mod.author) || 'Anonymous';
  }

  // EVERY field below comes out of a collection any signed-in client can
  // write to (same trust model as voxeria_rooms and the rest of the game's
  // Firestore — the rules check request.auth, not what's in the document).
  // The code itself is safe by construction: it only ever reaches the mod
  // decoders, which checksum it and clamp every field. These three do reach
  // markup, so they get checked here instead of being trusted:
  //
  //   thumb -> an <img src>. A hostile string could otherwise close the
  //            attribute and add its own handler, or smuggle a javascript:
  //            URL. Only a real image data URL is allowed through.
  //   id    -> a data-id attribute, and Firestore document ids are not
  //            guaranteed to be quote-free.
  //   count -> plain text, but a document can just as easily hold a string
  //            with markup in it as a number.
  function safeThumb(entry) {
    const t = entry && entry.thumb;
    return (typeof t === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(t)) ? t : null;
  }
  function safeCount(entry) {
    const n = entry && entry.pieceCount;
    return (typeof n === 'number' && isFinite(n) && n > 0) ? Math.min(99, Math.floor(n)) : 0;
  }
  // The rule pieces inside a listing, in publish order. Drives both whether
  // the "look inside" button appears at all and what it opens: an entry made
  // only of blocks or creatures has no rules to show, and offering a button
  // that then says "nothing here" would be worse than not offering it.
  function entryGraphCodes(entry) {
    const loadout = decodeEntry(entry);
    if (!loadout || !Array.isArray(loadout.pieceCodes)) return [];
    return loadout.pieceCodes.filter(c => typeof isGraphCode === 'function' && isGraphCode(c));
  }

  // Opens the first rule and, when there are more, says so rather than
  // pretending the mod is one rule. One real rule on the board is the whole
  // point; claiming it is the entire mod would not be true.
  function peekGalleryEntry(entry) {
    const codes = entryGraphCodes(entry);
    if (!codes.length) return;
    const note = codes.length > 1
      ? 'This mod has ' + codes.length + ' rules, and this is the first.'
      : '';
    closeFullGallery();
    if (typeof vxOpenGraphInEditor === 'function') vxOpenGraphInEditor(codes[0], note);
  }

  function piecesLabel(entry) {
    const n = safeCount(entry);
    return n ? ' &middot; ' + n + (n === 1 ? ' piece' : ' pieces') : '';
  }

  function renderSidebar() {
    const list = document.getElementById('vx-gallery-list');
    if (!list) return;
    const entries = cachedEntries.slice(0, SIDEBAR_LIMIT);
    if (!entries.length) {
      list.innerHTML = '<div class="vx-gallery-hint">Nothing published yet — be the first.</div>';
      return;
    }
    list.innerHTML = entries.map((entry, i) =>
      '<div class="vx-gallery-entry" style="animation-delay:' + (i * 55) + 'ms">' +
        '<div class="vx-gallery-title">' + escapeHtml(entryTitle(entry)) + '</div>' +
        '<div class="vx-gallery-byline">by ' + escapeHtml(entryAuthor(entry)) + piecesLabel(entry) + '</div>' +
        (decodeEntry(entry)
          ? '<button class="vx-btn primary vx-gallery-play" data-id="' + escapeHtml(entry.id) + '">Play</button>'
          : '<div class="vx-gallery-hint">This entry is corrupted.</div>') +
      '</div>').join('');
    bindPlayButtons(list);
  }

  function bindPlayButtons(root) {
    root.querySelectorAll('.vx-gallery-play').forEach(btn => {
      btn.addEventListener('click', () => {
        const entry = cachedEntries.find(e => e.id === btn.dataset.id);
        if (entry) playGalleryEntry(entry);
      });
    });
  }

  // -- full gallery modal -------------------------------------------------
  function isFullOpen() {
    const m = document.getElementById('vx-gallery-full-modal');
    return !!m && m.classList.contains('open');
  }
  function openFullGallery() {
    const modal = document.getElementById('vx-gallery-full-modal');
    if (!modal) return;
    modal.classList.add('open');
    renderCategoryRow();
    renderFullGallery();
    if (galleryReady() && !cachedEntries.length) fetchGalleryList();
  }
  function closeFullGallery() {
    const modal = document.getElementById('vx-gallery-full-modal');
    if (modal) modal.classList.remove('open');
  }
  function pickCategory(id) {
    activeCategory = id;
    renderCategoryRow();
    renderFullGallery();
  }

  function renderCategoryRow() {
    const row = document.getElementById('vx-gallery-categories');
    if (!row) return;
    row.innerHTML = CATEGORIES.map(cat =>
      '<button class="vx-gallery-cat' + (cat.id === activeCategory ? ' sel' : '') + '" data-cat="' + cat.id + '">' +
        iconHtml(cat.icon) + '<span>' + escapeHtml(cat.label) + '</span>' +
      '</button>').join('');
    paintIconsIn(row);
    row.querySelectorAll('.vx-gallery-cat').forEach(btn => {
      btn.addEventListener('click', () => pickCategory(btn.dataset.cat));
    });
  }

  function renderFullGallery() {
    const grid = document.getElementById('vx-gallery-grid');
    if (!grid) return;
    const entries = activeCategory === 'all'
      ? cachedEntries
      : cachedEntries.filter(e => Array.isArray(e.tags) && e.tags.includes(activeCategory));
    if (!entries.length) {
      // "Nothing published yet" would be a lie while the connection is still
      // coming up — that state has to read as waiting, not as empty.
      const empty = !galleryReady() ? 'Connecting…'
        : cachedEntries.length ? 'Nothing in this category yet.'
        : 'Nothing published yet — be the first.';
      grid.innerHTML = '<div class="vx-gallery-hint">' + empty + '</div>';
      return;
    }
    grid.innerHTML = entries.map((entry, i) => {
      const ok = !!decodeEntry(entry);
      const id = escapeHtml(entry.id);
      const thumb = safeThumb(entry);
      return '<div class="vx-gallery-card" style="animation-delay:' + Math.min(i * 45, 600) + 'ms">' +
        (thumb
          ? '<img class="vx-gallery-thumb" src="' + thumb + '" alt="">'
          : '<div class="vx-gallery-thumb vx-gallery-thumb-empty"></div>') +
        '<div class="vx-gallery-card-title">' + escapeHtml(entryTitle(entry)) + '</div>' +
        '<div class="vx-gallery-byline">by ' + escapeHtml(entryAuthor(entry)) + piecesLabel(entry) + '</div>' +
        '<div class="vx-gallery-card-actions">' +
          '<button class="vx-gallery-act vx-gallery-report" data-id="' + id + '" title="Report this mod">' + iconHtml('gallery-flag') + '</button>' +
          '<button class="vx-gallery-act vx-gallery-details" data-id="' + id + '" title="What is in this mod">' + iconHtml('gallery-info') + '</button>' +
          // Only where there is something to see. The node-graph icon is the
          // one the "Rules" category already uses, so it reads as "the rules
          // of this mod" without a second visual language for the same thing.
          //
          // Shown regardless of world mode, unlike the mod tip in
          // voxeria-modding.js which hides itself where the tools are gated.
          // The difference is who started it: the tip is unasked-for
          // advertising and a dead link would be its own fault, while this is
          // the answer to a deliberate click on one mod. It is also drawn from
          // the menu, where the mode of the world the player is about to start
          // is not decided yet, so hiding it would guess wrong as often as
          // right. A Normal world answers with the existing lock message,
          // which explains the rule instead of leaving a button that does
          // nothing.
          (ok && entryGraphCodes(entry).length
            ? '<button class="vx-gallery-act vx-gallery-peek" data-id="' + id + '" title="Look inside: open the rules of this mod in the editor">' + iconHtml('gallery-nodes') + '</button>'
            : '') +
          (ok
            ? '<button class="vx-gallery-act primary vx-gallery-play" data-id="' + id + '" title="Play this mod">' + iconHtml('gallery-play') + '</button>'
            : '<button class="vx-gallery-act" disabled title="This entry is corrupted">' + iconHtml('gallery-info') + '</button>') +
        '</div>' +
      '</div>';
    }).join('');
    paintIconsIn(grid);
    bindPlayButtons(grid);
    grid.querySelectorAll('.vx-gallery-report').forEach(btn =>
      btn.addEventListener('click', () => openReportModal(btn.dataset.id)));
    grid.querySelectorAll('.vx-gallery-details').forEach(btn =>
      btn.addEventListener('click', () => openDetails(btn.dataset.id)));
    grid.querySelectorAll('.vx-gallery-peek').forEach(btn =>
      btn.addEventListener('click', () => {
        const entry = cachedEntries.find(e => e.id === btn.dataset.id);
        if (entry) peekGalleryEntry(entry);
      }));
  }

  // -- details --------------------------------------------------------------
  function openDetails(entryId) {
    const entry = cachedEntries.find(e => e.id === entryId);
    if (!entry) return;
    const modal = document.getElementById('vx-gallery-details-modal');
    if (!modal) return;
    document.getElementById('vx-gallery-details-title').textContent = entryTitle(entry);
    document.getElementById('vx-gallery-details-body').textContent = describeEntry(entry);
    modal.classList.add('open');
  }
  function closeDetails() {
    const modal = document.getElementById('vx-gallery-details-modal');
    if (modal) modal.classList.remove('open');
  }

  // -- report -----------------------------------------------------------------
  function openReportModal(entryId) {
    const entry = cachedEntries.find(e => e.id === entryId);
    if (!entry) return;
    reportingEntryId = entryId;
    const modal = document.getElementById('vx-gallery-report-modal');
    if (!modal) return;
    document.getElementById('vx-gallery-report-title').textContent = 'Report "' + entryTitle(entry) + '"';
    document.getElementById('vx-gallery-report-err').textContent = '';
    document.getElementById('vx-gallery-report-reasons').innerHTML = REPORT_REASONS.map(r =>
      '<label class="vx-gallery-reason"><input type="checkbox" value="' + r.id + '"> ' + escapeHtml(r.label) + '</label>').join('');
    modal.classList.add('open');
  }
  function closeReportModal() {
    const modal = document.getElementById('vx-gallery-report-modal');
    if (modal) modal.classList.remove('open');
    reportingEntryId = null;
  }
  function submitReport() {
    const err = document.getElementById('vx-gallery-report-err');
    const reasons = Array.from(document.querySelectorAll('#vx-gallery-report-reasons input:checked')).map(i => i.value);
    if (!reasons.length) { err.textContent = 'Pick at least one reason.'; return; }
    if (!galleryReady() || !reportingEntryId) { err.textContent = 'Not connected yet — try again in a moment.'; return; }
    // Doc id is entry+reporter, so re-reporting the same listing overwrites
    // that person's own report instead of stacking duplicates.
    const ref = doc(db, 'artifacts', appId, 'public', 'data', REPORT_COLLECTION, reportingEntryId + '_' + userId);
    setDoc(ref, { entryId: reportingEntryId, reporterUid: userId, reasons: reasons, createdAt: Date.now() })
      .then(() => { closeReportModal(); showNotification('🚩 Thanks — that listing has been reported.'); })
      .catch(e => { console.error('Voxeria gallery: report failed', e); err.textContent = 'Could not send that report — try again.'; });
  }

  // -- publish modal ------------------------------------------------------
  function openPublishModal() {
    const modal = document.getElementById('vx-gallery-publish-modal');
    if (!modal) return;
    document.getElementById('vx-gallery-base-code').value = '';
    document.getElementById('vx-gallery-extra-fields').innerHTML = '';
    document.getElementById('vx-gallery-publish-err').textContent = '';
    extraFieldCount = 0;
    modal.classList.add('open');
  }
  function closePublishModal() {
    const modal = document.getElementById('vx-gallery-publish-modal');
    if (modal) modal.classList.remove('open');
  }
  function addPublishCodeField() {
    if (extraFieldCount >= LOADOUT_MAX_PIECES) return;
    const wrap = document.getElementById('vx-gallery-extra-fields');
    if (!wrap) return;
    const row = document.createElement('div');
    row.className = 'vx-field';
    row.innerHTML = '<label>ADDITIONAL PIECE CODE</label><input class="vx-gallery-extra-code" maxlength="4000" spellcheck="false" autocomplete="off">';
    wrap.appendChild(row);
    extraFieldCount++;
  }

  // Order matters: cheap, local, offline-checkable things first, the one
  // network round-trip (the cooldown read) last — no point spending it on a
  // submission that was always going to be rejected anyway.
  function submitPublish() {
    const errEl = document.getElementById('vx-gallery-publish-err');
    const setErr = (msg) => { errEl.textContent = msg; };
    setErr('');

    const baseRaw = (document.getElementById('vx-gallery-base-code').value || '').trim();
    let mod, pieceCodes = [];
    if (isLoadoutCode(baseRaw)) {
      const decoded = decodeLoadoutCode(baseRaw);
      if (!decoded) return setErr('That loadout code is invalid or corrupted.');
      mod = decoded.mod;
      pieceCodes = decoded.pieceCodes.slice();
    } else if (isModCode(baseRaw)) {
      mod = decodeModCode(baseRaw);
      if (!mod) return setErr('That mod code is invalid or corrupted.');
    } else if (isAnyPieceCode(baseRaw)) {
      // A standalone block/creature/rule-graph code with no mod wrapper --
      // e.g. the Node Graph editor's own "Export" button hands back a bare
      // VXG2- code, never a loadout. Wrap it in a default mod so storage and
      // playGalleryEntry() still only ever deal with one shape (VXL1-).
      const piece = decodeAnyPieceCode(baseRaw);
      if (!piece) return setErr('That code is invalid or corrupted.');
      mod = modDefaults();
      mod.name = piece.name || 'Untitled Mod';
      pieceCodes = [baseRaw];
    } else {
      return setErr('Paste a mod code (MOD1-/VXM3-), a loadout code (VXL1-), or a block/creature/rule code (VXG2-/…) first.');
    }

    const extraInputs = document.querySelectorAll('.vx-gallery-extra-code');
    for (const input of extraInputs) {
      const v = (input.value || '').trim();
      if (!v) continue;
      if (!isAnyPieceCode(v) || !decodeAnyPieceCode(v)) return setErr('One of the additional codes is invalid.');
      if (pieceCodes.length >= LOADOUT_MAX_PIECES) return setErr('Too many pieces — the limit is ' + LOADOUT_MAX_PIECES + '.');
      if (!pieceCodes.includes(v)) pieceCodes.push(v);
    }

    if (containsBlockedWord(mod.name) || containsBlockedWord(mod.author)) {
      return setErr("That mod's name or author isn't allowed here — rename it in the Mod Builder and re-export.");
    }
    if (typeof _bannedUids !== 'undefined' && userId && _bannedUids[userId]) {
      return setErr("You can't publish right now.");
    }
    if (!galleryReady()) return setErr('Not connected yet — try again in a moment.');

    getDoc(cooldownDocRef()).then(snap => {
      const last = snap.exists() ? snap.data().lastPublishAt : 0;
      const remaining = PUBLISH_COOLDOWN_MS - (Date.now() - last);
      if (remaining > 0) { setErr('Please wait ' + Math.ceil(remaining / 60000) + 'm before publishing again.'); return; }

      const code = encodeLoadoutCode(mod, pieceCodes);
      const entryData = {
        code: code,
        authorUid: userId,
        pieceCount: pieceCodes.length,
        tags: deriveTags(mod, pieceCodes),
        // The publisher's own world, exactly the snapshot the Load World
        // tiles already use (captureWorldThumb in voxeria-menu-worlds.js).
        // Null when there's no world to photograph yet, which the card
        // rendering handles with an empty frame.
        thumb: captureGalleryThumb(),
        createdAt: Date.now()
      };
      setDoc(doc(galleryCollectionRef()), entryData)
        .then(() => setDoc(cooldownDocRef(), { lastPublishAt: Date.now() }))
        .then(() => {
          closePublishModal();
          showNotification('✅ Published to the gallery!');
          fetchGalleryList();
        })
        .catch(e => { console.error('Voxeria gallery: publish failed', e); setErr('Publish failed — try again.'); });
    }).catch(e => {
      console.error('Voxeria gallery: cooldown check failed', e);
      setErr('Could not verify cooldown — try again.');
    });
  }

  // VxWorlds keeps captureWorldThumb() private, and it is small enough that
  // reaching for an export would cost more than it saves: a 9x9-block PNG of
  // chunk 0's surface, the same anchor and scale the Load World tiles use, so
  // a gallery card and a save tile read as the same kind of picture.
  const THUMB_CELL = 8, THUMB_BLOCKS = 9;
  function captureGalleryThumb() {
    const savedDim = currentDim;
    try {
      currentDim = 'OVERWORLD';
      const surfaceY = getSurfaceYAt(0, 'OVERWORLD');
      const top = Math.max(0, surfaceY - 3);
      const left = -((THUMB_BLOCKS / 2) | 0);
      const cv = document.createElement('canvas');
      cv.width = cv.height = THUMB_BLOCKS * THUMB_CELL;
      const tctx = cv.getContext('2d');
      tctx.imageSmoothingEnabled = false;
      for (let sx = 0; sx < THUMB_BLOCKS; sx++) {
        for (let sy = 0; sy < THUMB_BLOCKS; sy++) {
          const b = getBlock(left + sx, top + sy);
          const px = sx * THUMB_CELL, py = sy * THUMB_CELL;
          if (_hasBlockTexture(b)) tctx.drawImage(_blockTextures[b], px, py, THUMB_CELL, THUMB_CELL);
          else {
            const bc = b === BLOCKS.AIR ? null : blockColors[b];
            tctx.fillStyle = bc ? bc[0] : '#8fc4ff';
            tctx.fillRect(px, py, THUMB_CELL, THUMB_CELL);
          }
        }
      }
      return cv.toDataURL('image/png');
    } catch (e) {
      return null;
    } finally {
      currentDim = savedDim;
    }
  }

  // -- play -----------------------------------------------------------------
  // The same "start a fresh world from this data" path createWorld() itself
  // uses (VxWorlds.applySave, exported for exactly this — see
  // voxeria-menu-worlds.js), not a second copy of its logic that could drift.
  function playGalleryEntry(entry) {
    const loadout = decodeEntry(entry);
    if (!loadout) { showNotification('⚠️ Could not read this mod.'); return; }

    closeFullGallery();
    if (!activeMod) realInventorySnapshot = JSON.parse(JSON.stringify(inventory));
    activeMod = loadout.mod;
    activeLoadoutPieceCodes = loadout.pieceCodes;
    window._activeModCode = entry.code;
    // Must precede applySave()'s resetGameAndWorld(): that clears every
    // dimension, and the chunks regenerated afterwards read customOreTiers —
    // same ordering requirement applySeedFromUI() follows.
    registerLoadoutPieces(loadout.pieceCodes);

    const seed = String(loadout.mod.seed || entry.code).slice(0, 60) || String(Date.now() % 9999999);
    VxWorlds.applySave({
      id: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: (loadout.mod.name || 'Gallery Mod').slice(0, 30),
      seed: seed, mode: 'explore', arenaWidth: 0,
      player: null, inventory: null, armor: null, edits: []
    }, /* fresh */ true);
    VxWorlds.save();
    showModBanner(loadout.mod);
    if (loadout.skipped) showNotification('⚠️ ' + loadout.skipped + ' piece(s) in that loadout were unreadable and were skipped.');
  }

  // -- wiring -----------------------------------------------------------------
  // Opens the gallery the moment #vx-menu gets its .show class — the same
  // trigger VxWorlds.show()/hide() flip, reached without adding a hook to
  // either of them, so this file stays removable with zero edits elsewhere.
  window.addEventListener('DOMContentLoaded', () => {
    const menu = document.getElementById('vx-menu');
    if (!menu) return;
    const obs = new MutationObserver(() => {
      if (menu.classList.contains('show')) openGallery();
      else closeFullGallery();      // leaving the menu shouldn't leave the modal behind
    });
    obs.observe(menu, { attributes: true, attributeFilter: ['class'] });
    if (menu.classList.contains('show')) openGallery();
  });

  return {
    openPublishModal: openPublishModal,
    closePublishModal: closePublishModal,
    addPublishCodeField: addPublishCodeField,
    submitPublish: submitPublish,
    openFullGallery: openFullGallery,
    closeFullGallery: closeFullGallery,
    closeDetails: closeDetails,
    closeReportModal: closeReportModal,
    submitReport: submitReport
  };
})();
