// ============================================================================
// VOXERIA -- KOOP-MODS (Modus 2: gemeinsam erkunden UND gemeinsam basteln)
//
// Der Exploration-Modus konnte schon immer Mods bauen -- aber nur fuer einen
// selbst. Wer einen Block malte, sah ihn allein; der Freund im selben Raum
// stand in derselben Welt und sah nichts davon. Diese Datei macht die
// Bastelei zum gemeinsamen Teil: jeder veroeffentlicht seine Werke in den
// Raum, jeder bekommt die der anderen, und man sieht an der FARBE, von wem
// was stammt.
//
// WARUM DAS BEI MINECRAFT WEHTUT UND HIER NICHT
// Modding und Multiplayer sind dort ein Installationsproblem: Forge-Version,
// Server-Version und Client-Version muessen zusammenpassen, sonst fliegt man
// raus. Hier ist ein Mod ein kurzer Textcode, den der Motor aus einem
// geschlossenen Katalog wieder aufbaut (siehe NODE_CATALOG in
// voxeria-modding.js) -- er kann also einfach mitgeschickt werden und laeuft
// beim Empfaenger sofort, ohne Installation und ohne Versionsabgleich.
//
// ── DAS EIGENTLICHE PROBLEM: BLOCK-IDs ──────────────────────────────────────
// Eigene Bloecke bekommen zur Laufzeit Nummern aus einem kleinen reservierten
// Bereich (200..255, siehe CUSTOM_BLOCK_ID_BASE). Diese Nummer ist es, die
// beim Bauen in der Welt landet und ueber Firestore zu den anderen wandert.
// Wuerde jeder Client seine Liste in eigener Reihenfolge anmelden, waere mein
// Block 200 dein Block 203 -- dieselbe Welt saehe fuer jeden anders aus.
//
// Deshalb zwei Regeln, die zusammen dafuer sorgen, dass eine einmal vergebene
// Nummer NIE wieder ihre Bedeutung aendert:
//
//   1. Die Reihenfolge der Autoren ist ANHAENGEND, nicht sortiert. Sie richtet
//      sich nach `since` -- dem Zeitpunkt, an dem jemand in DIESER Welt zum
//      ersten Mal etwas veroeffentlicht hat. Der Wert steht im Dokument des
//      Autors selbst, also rechnen alle dieselbe Reihenfolge aus, und ein
//      spaeter Hinzukommender landet immer hinten. Nach UID zu sortieren waere
//      naheliegend und falsch: ein Beitretender mit kleinerer UID haette sich
//      vor alle anderen geschoben und deren IDs verschoben.
//
//   2. Jeder Autor bekommt einen FESTEN ID-Block von SLOT_SIZE Nummern. Ohne
//      das verschiebt schon das Hinzufuegen eines einzigen Blocks alle
//      Nummern der spaeteren Autoren -- mitten in der Sitzung, waehrend die
//      alten Nummern bereits verbaut in der Welt stehen. Die Luecken werden
//      als `null` an registerCustomBlockPieces uebergeben (siehe den
//      Kommentar zum reservierten Platz dort).
//
// ── WAS GETEILT WIRD UND WAS NICHT ─────────────────────────────────────────
// Bloecke und Kreaturen sind WELT-INHALT: wenn wir uns darueber nicht einig
// sind, stehen wir nicht in derselben Welt. Die laufen immer mit.
// Regeln (Knotengraphen) aendern dagegen, wie sich das Spiel fuer DICH
// anfuehlt -- Schwerkraft, Schaden, was ein Block fallen laesst. Die sind
// deshalb abschaltbar, ohne dass die Welt auseinanderfaellt.
// ============================================================================

window.VxCoopMods = (function () {
  'use strict';

  // 56 IDs (200..255) geteilt durch 8 ergibt sieben Autoren mit je acht
  // eigenen Bloecken. Groessere Scheiben liessen weniger Leute mitbauen,
  // kleinere waeren fuer jemanden, der ernsthaft Bloecke malt, schnell zu eng.
  const SLOT_SIZE = 8;
  const MAX_AUTHORS = Math.floor((255 - 200 + 1) / SLOT_SIZE);
  const PUBLISH_THROTTLE = 2000;

  let authors = {};          // uid -> { uid, name, color, since, pieces: [] }
  let myPieces = [];         // die eigene, zuletzt veroeffentlichte Liste
  let lastPublished = '';    // Signatur, um unnoetige Schreibvorgaenge zu sparen
  let lastPublishAt = 0;
  let mySince = 0;
  let unsub = null;
  let subscribedSeed = null;
  let panelOpen = false;
  let appliedSignature = '';
  let overflowWarned = false;
  let firstSnapshotSeen = false;

  // Voreinstellung an: der Modus heisst "gemeinsam basteln", und die halbe
  // Ueberraschung waere weg, wenn die Regeln der anderen erst nach einem
  // Haken im Menue liefen.
  let runOthersRules = localStorage.getItem('voxeria_coop_rules') !== '0';

  // Nur dort, wo es die Creator-Werkzeuge ueberhaupt gibt. VxWorlds.MODES ist
  // die eine Quelle dafuer (siehe das studio-Flag) -- hier noch einmal eine
  // eigene Liste zu fuehren hiesse, sie beim naechsten neuen Modus zu vergessen.
  function studioMode() {
    if (typeof gameMode === 'undefined') return false;
    const m = window.VxWorlds && window.VxWorlds.MODES && window.VxWorlds.MODES[gameMode];
    return !!(m && m.studio);
  }

  // Doppelte Verneinung, damit hier ein echtes true/false herauskommt und
  // nicht die userId -- die letzte Bedingung einer &&-Kette gibt ihren Wert
  // zurueck, und `isActive()` ist Teil der oeffentlichen Schnittstelle.
  function online() {
    return !!(typeof isMultiplayerActive !== 'undefined' && isMultiplayerActive &&
              typeof db !== 'undefined' && db && typeof userId !== 'undefined' && userId);
  }

  function active() { return studioMode() && online(); }

  // =========================================================================
  // FARBE PRO AUTOR
  // =========================================================================
  // Die Spielerfarbe ist bereits da (player.color, und sie reist im
  // Positions-Dokument mit) -- also DIESELBE Farbe, in der man den Mitspieler
  // ohnehin durch die Welt laufen sieht. Eine zweite, eigens fuer Mods
  // erfundene Farbpalette waere genau die Sorte Zuordnung, die man sich
  // zusaetzlich merken muss.
  function colorOf(uid) {
    if (!uid) return '#8f8fa0';
    const a = authors[uid];
    if (a && a.color) return a.color;
    if (uid === userId && typeof player !== 'undefined' && player.color) return player.color;
    const o = (typeof otherPlayers !== 'undefined') && otherPlayers[uid];
    if (o && o.color) return o.color;
    // Letzter Ausweg: aus der UID abgeleitet, damit ein Autor, dessen
    // Positions-Dokument gerade fehlt, trotzdem eine STABILE Farbe hat statt
    // bei jedem Neuzeichnen eine andere.
    let h = 0;
    for (let i = 0; i < uid.length; i++) h = (h * 31 + uid.charCodeAt(i)) >>> 0;
    return 'hsl(' + (h % 360) + ', 70%, 65%)';
  }

  function nameOf(uid) {
    if (uid === userId) return (window._playerDisplayName || 'You');
    const a = authors[uid];
    if (a && a.name) return String(a.name).slice(0, 14);
    const o = (typeof otherPlayers !== 'undefined') && otherPlayers[uid];
    if (o && o.name) return String(o.name).slice(0, 14);
    return String(uid || '').slice(0, 4).toUpperCase();
  }

  // =========================================================================
  // VEROEFFENTLICHEN
  // =========================================================================

  function modDocRef(uid) {
    return doc(db, 'artifacts', appId, 'public', 'data', 'voxeria_mods', SEED + '_' + uid);
  }

  // Die eigene Bibliothek, so wie sie geteilt wird. Nur aktivierte Stuecke:
  // ein abgeschaltetes Stueck ist im eigenen Spiel aus, und es waere
  // ueberraschend, wenn es bei den anderen trotzdem liefe.
  function myLibrary() {
    if (!window.VxPieces) return [];
    return VxPieces.list()
      .filter(p => p.enabled !== false && p.code)
      .slice(0, SLOT_SIZE * 3)   // Bloecke, Kreaturen und Regeln je eine Scheibe
      .map(p => ({ code: p.code, name: String(p.name || 'Unnamed').slice(0, 24), kind: p.kind }));
  }

  function publish(force) {
    if (!active()) return;
    // NICHTS schreiben, bevor der erste Snapshot da war. Sonst laeuft nach
    // jedem Neuladen dieser Ablauf: mySince ist 0, wir veroeffentlichen mit
    // einem frischen Zeitstempel, landen damit hinter allen anderen -- und
    // unsere eigenen Bloecke bekommen neue IDs, obwohl sich nichts geaendert
    // hat. Genau das, was die feste Reihenfolge verhindern soll. Der Snapshot
    // bringt das gespeicherte `since` zurueck; bis dahin wird gewartet.
    if (!firstSnapshotSeen) return;
    const now = Date.now();
    const lib = myLibrary();
    const sig = lib.map(p => p.code).join('|');
    if (!force && sig === lastPublished) return;
    if (now - lastPublishAt < PUBLISH_THROTTLE) return;
    lastPublishAt = now;
    lastPublished = sig;
    myPieces = lib;

    // `since` wird genau einmal gesetzt und danach nie wieder angefasst --
    // daran haengt die gesamte ID-Stabilitaet (siehe Regel 1 im Dateikopf).
    if (!mySince) mySince = now;

    // Eine leere Bibliothek loescht den Eintrag, statt ein leeres Dokument
    // liegen zu lassen: sonst zaehlte jemand ohne einen einzigen Mod dauerhaft
    // als Autor und verbrauchte eine der sieben ID-Scheiben.
    if (!lib.length) {
      deleteDoc(modDocRef(userId)).catch(() => {});
      return;
    }
    setDoc(modDocRef(userId), {
      seed: rawSeedString, uid: userId,
      name: (window._playerDisplayName || null),
      color: (typeof player !== 'undefined' ? player.color : null),
      since: mySince,
      pieces: lib,
      ts: now
    }).catch(e => console.error('Coop mod publish error:', e));
  }

  // =========================================================================
  // EMPFANGEN UND ANWENDEN
  // =========================================================================

  function subscribe() {
    if (!active()) return;
    if (subscribedSeed === rawSeedString) return;
    unsubscribe();
    subscribedSeed = rawSeedString;
    const q = query(
      collection(db, 'artifacts', appId, 'public', 'data', 'voxeria_mods'),
      where('seed', '==', rawSeedString)
    );
    unsub = onSnapshot(q, (snap) => {
      snap.docChanges().forEach((ch) => {
        const d = ch.doc.data();
        if (!d || !d.uid) return;
        if (ch.type === 'removed') { delete authors[d.uid]; return; }
        authors[d.uid] = d;
        // Das eigene `since` vom Server uebernehmen: nach einem Neuladen ist
        // die lokale Variable weg, und ein neu gesetzter Zeitstempel wuerde
        // einen ans Ende der Reihenfolge schieben -- also die eigenen
        // Block-IDs verschieben, obwohl sich nichts geaendert hat.
        if (d.uid === userId && d.since) mySince = d.since;
      });
      // Erst jetzt darf veroeffentlicht werden (siehe publish): ab hier ist
      // bekannt, ob wir in dieser Welt schon eine Reihenfolge-Position haben.
      firstSnapshotSeen = true;
      applyAll();
      renderPanel();
    }, (e) => console.error('Coop mod sync error:', e));
  }

  function unsubscribe() {
    if (unsub) { unsub(); unsub = null; }
    subscribedSeed = null;
    authors = {};
    appliedSignature = '';
    // Zurueck auf "noch nichts gesehen" -- die neue Welt hat ihre eigene
    // Reihenfolge, und bis deren Snapshot da ist, gilt dasselbe Schreibverbot.
    firstSnapshotSeen = false;
  }

  // Die geteilte Reihenfolge. Jeder Client rechnet sie aus denselben
  // Dokumenten aus und kommt zwingend auf dasselbe Ergebnis -- daran haengt,
  // dass Block-Nummer 207 fuer alle denselben Block meint.
  function orderedAuthors() {
    return Object.values(authors)
      .filter(a => a && Array.isArray(a.pieces) && a.pieces.length)
      // `since` zuerst, UID nur als Stichentscheid fuer den (unwahrscheinlichen)
      // Fall, dass zwei im selben Millisekundenschritt veroeffentlichen.
      .sort((x, y) => (x.since || 0) - (y.since || 0) || (x.uid < y.uid ? -1 : 1));
  }

  // Baut die kombinierte Liste, in der jeder Autor seine feste Scheibe von
  // SLOT_SIZE Block-IDs bekommt. Nicht genutzte Plaetze innerhalb einer
  // Scheibe werden mit `null` aufgefuellt, damit die naechste Scheibe immer an
  // derselben Nummer beginnt -- egal wie viele Bloecke der Autor davor gerade
  // hat. Kreaturen und Regeln haengen ohne Reservierung hinten dran: die
  // vergeben keine Welt-IDs, ihre Reihenfolge kann sich also gefahrlos aendern.
  function buildCombined() {
    const list = orderedAuthors();
    const blockSlots = [];
    const rest = [];
    const owner = { block: {}, other: {} };

    list.slice(0, MAX_AUTHORS).forEach((a, slotIndex) => {
      const blocks = a.pieces.filter(p => p.kind === 'BLOCK');
      for (let i = 0; i < SLOT_SIZE; i++) {
        const p = blocks[i];
        blockSlots.push(p ? p.code : null);
        if (p) owner.block[p.code] = a.uid;
      }
      for (const p of a.pieces) {
        if (p.kind === 'BLOCK') continue;
        if (p.kind === 'GRAPH' && !runOthersRules && a.uid !== userId) continue;
        rest.push(p.code);
        owner.other[p.code] = a.uid;
      }
      void slotIndex;
    });

    if (list.length > MAX_AUTHORS && !overflowWarned) {
      overflowWarned = true;
      // Laut, nicht stillschweigend: die betroffenen Spieler wuerden sonst
      // nur merken, dass ihre Bloecke bei niemandem ankommen.
      showNotification('Only the first ' + MAX_AUTHORS + ' modders in a world can share blocks');
    }

    return { codes: blockSlots.concat(rest), owner: owner };
  }

  let blockOwner = {};      // Block-ID -> uid
  let creatureOwner = {};   // Kreatur-id -> uid
  let graphOwner = {};      // Graph-Name -> uid

  function applyAll() {
    if (!studioMode()) return;
    const built = buildCombined();
    const sig = built.codes.map(c => c === null ? '_' : c).join('|') + '#' + runOthersRules;
    // Neu anmelden ist teuer (jede Blocktextur wird neu gerendert, umherziehende
    // Kreaturen werden entfernt) und laeuft bei jedem Firestore-Ereignis an --
    // also nur, wenn sich wirklich etwas geaendert hat.
    if (sig === appliedSignature) return;
    appliedSignature = sig;

    registerLoadoutPieces(built.codes);
    if (typeof applyActiveRules === 'function') applyActiveRules();

    // Zuordnung erst NACH dem Anmelden aufbauen: vorher steht nicht fest,
    // welcher Code welche Nummer bekommen hat.
    blockOwner = {};
    const src = window.customBlockSource || {};
    for (const id in src) blockOwner[id] = built.owner.block[src[id]] || null;

    creatureOwner = {};
    if (typeof customCreatureTypes !== 'undefined') {
      for (const c of customCreatureTypes) creatureOwner[c.id] = built.owner.other[c.sourceCode] || null;
    }
    graphOwner = {};
    if (typeof activeGraphs !== 'undefined') {
      for (const g of activeGraphs) graphOwner[g.name] = built.owner.other[g.sourceCode] || null;
    }

    if (typeof drawHotbar === 'function') drawHotbar();
  }

  // =========================================================================
  // FRAME-TICK
  // =========================================================================

  function tick() {
    if (!studioMode()) return;
    if (subscribedSeed && subscribedSeed !== rawSeedString) {
      unsubscribe();
      mySince = 0; lastPublished = ''; overflowWarned = false;
    }
    if (!online()) return;
    subscribe();
    publish(false);
  }

  // =========================================================================
  // ANZEIGE
  // =========================================================================

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const KIND_LABEL = { BLOCK: 'Block', CREATURE: 'Creature', GRAPH: 'Rules' };

  function togglePanel(force) {
    const el = document.getElementById('coop-mods-panel');
    if (!el) return;
    panelOpen = (force === undefined) ? !panelOpen : !!force;
    el.classList.toggle('open', panelOpen);
    if (panelOpen) { publish(true); renderPanel(); }
  }

  function renderPanel() {
    if (!panelOpen) return;
    const body = document.getElementById('cm-list');
    const note = document.getElementById('cm-note');
    const toggle = document.getElementById('cm-rules-toggle');
    if (toggle) toggle.checked = runOthersRules;
    if (note) {
      note.textContent = !online() ? 'Offline - only your own mods are running'
        : !studioMode() ? 'This mode has no creator tools'
        : orderedAuthors().length + ' modder(s) in this world';
    }
    if (!body) return;

    const list = orderedAuthors();
    if (!list.length) {
      body.innerHTML = '<div class="cm-empty">Nobody has shared a mod in this world yet. ' +
                       'Anything you build in the Mod Editor shows up here for everyone.</div>';
      return;
    }

    body.innerHTML = list.map(a => {
      const col = colorOf(a.uid);
      const mine = a.uid === userId;
      const rows = a.pieces.map(p => {
        // Regeln, die abgeschaltet sind, werden durchgestrichen statt
        // ausgeblendet -- sonst wirkt es, als haette der Mitspieler sie nie
        // geteilt, und man sucht den Fehler bei ihm.
        const off = p.kind === 'GRAPH' && !runOthersRules && !mine;
        return '<div class="cm-piece' + (off ? ' off' : '') + '">' +
                 '<span class="cm-kind">' + (KIND_LABEL[p.kind] || p.kind) + '</span>' +
                 '<span class="cm-piece-name">' + escapeHtml(p.name) + '</span>' +
               '</div>';
      }).join('');
      return '<div class="cm-author" style="border-left-color:' + escapeHtml(col) + '">' +
               '<div class="cm-author-head">' +
                 '<span class="cm-dot" style="background:' + escapeHtml(col) + '"></span>' +
                 '<span class="cm-author-name" style="color:' + escapeHtml(col) + '">' +
                   escapeHtml(nameOf(a.uid)) + (mine ? ' (you)' : '') + '</span>' +
                 '<span class="cm-count">' + a.pieces.length + '</span>' +
               '</div>' + rows +
             '</div>';
    }).join('');
  }

  function setRunOthersRules(on) {
    runOthersRules = !!on;
    localStorage.setItem('voxeria_coop_rules', runOthersRules ? '1' : '0');
    applyAll();
    renderPanel();
  }

  // =========================================================================
  // MOTOR-WRAPPER
  // =========================================================================
  // Gleiche Begruendung wie in voxeria-arena.js: keine Zeile im Motor aendern,
  // stattdessen umschliessen, was er ohnehin aufruft.

  let hooksInstalled = false;
  function installHooks() {
    if (hooksInstalled) return;
    hooksInstalled = true;

    if (typeof updateGraphRuntime === 'function') {
      const original = updateGraphRuntime;
      window.updateGraphRuntime = function (dt) {
        const r = original(dt);
        try { tick(); } catch (e) { console.warn('Voxeria: coop-mod tick failed', e); }
        return r;
      };
    }

    // Der Block, den man gerade in der Hand haelt, bekommt einen Ring in der
    // Farbe seines Erfinders. Das ist die Attribution IM SPIEL -- ohne sie
    // stuende sie nur in einem Menue, das man beim Bauen nicht offen hat.
    if (typeof drawSelectedBlockPopup === 'function') {
      const original = drawSelectedBlockPopup;
      window.drawSelectedBlockPopup = function () {
        const r = original();
        try { drawAuthorRing(); } catch (e) { /* Anzeige, nie spielentscheidend */ }
        return r;
      };
    }

    // Der Block-Katalog listet nur die eingebauten Bloecke
    // (BLOCK_INVENTORY_SECTIONS ist eine feste Liste). Selbst gemalte Bloecke
    // liegen im Bereich 200..255 und tauchten dort gar nicht auf -- in einem
    // Modus, dessen ganzer Sinn "bau die Welt aus deinen eigenen Bloecken" ist,
    // waeren sie damit unerreichbar.
    if (typeof renderBlockInventory === 'function') {
      const original = renderBlockInventory;
      window.renderBlockInventory = function () {
        const r = original();
        try { appendCustomBlockSection(); } catch (e) { console.warn('Voxeria: custom block section failed', e); }
        return r;
      };
    }

    // Bloecke gibt es bisher nur in Exploration umsonst. Ein Welt-Editor, in
    // dem man das Material erst abbauen muss, waere widersinnig -- zumal die
    // leere Arena gar nichts zum Abbauen enthaelt.
    if (typeof _biSelectBlock === 'function') {
      const original = _biSelectBlock;
      window._biSelectBlock = function (btype) {
        if (typeof gameMode !== 'undefined' && gameMode === 'arena') {
          if (typeof addToInventory === 'function' && addToInventory(btype, 64)) {
            showNotification('Got ' + (blockNames[btype] || 'block') + ' x64');
            if (typeof drawHotbar === 'function') drawHotbar();
          }
          return;
        }
        return original(btype);
      };
    }
  }

  // Haengt einen Abschnitt mit allen selbst gemalten Bloecken an den Katalog.
  // Gespeist aus customBlockSource (ID -> Piece-Code), das die Registrierung
  // in voxeria-modding.js befuellt -- damit stimmt die Zuordnung immer mit den
  // tatsaechlich vergebenen Nummern ueberein, statt sie hier nachzurechnen.
  function appendCustomBlockSection() {
    const body = document.getElementById('bi-body');
    const src = window.customBlockSource || {};
    const ids = Object.keys(src).map(Number).sort((a, b) => a - b);
    if (!body || !ids.length) return;

    const label = document.createElement('div');
    label.className = 'inv-section-label';
    label.textContent = 'Made by players';
    body.appendChild(label);

    const grid = document.createElement('div');
    grid.className = 'inv-grid';
    for (const id of ids) {
      const uid = blockOwner[id] || null;
      const slot = document.createElement('div');
      slot.className = 'inv-slot';
      slot.title = (blockNames[id] || 'Custom block') + (uid ? ' - by ' + nameOf(uid) : '');
      // Der farbige Streifen ist dieselbe Zuordnung wie im Mods-Panel und wie
      // der Ring um den gehaltenen Block: die Spielerfarbe des Erfinders.
      if (uid) slot.style.borderBottom = '3px solid ' + colorOf(uid);
      const mini = document.createElement('canvas');
      if (typeof drawBlockMini === 'function') drawBlockMini(mini, id);
      const name = document.createElement('div');
      name.className = 'inv-slot-name';
      name.textContent = blockNames[id] || '';
      slot.appendChild(mini);
      slot.appendChild(name);
      slot.onclick = () => window._biSelectBlock(id);
      grid.appendChild(slot);
    }
    body.appendChild(grid);
  }

  function drawAuthorRing() {
    if (typeof selectedBlockPopupTimer === 'undefined' || selectedBlockPopupTimer <= 0) return;
    if (selectedBlockPopupBlock === null) return;
    const uid = blockOwner[selectedBlockPopupBlock];
    if (!uid) return;   // kein eigener Block oder unbekannter Autor
    const size = 34;
    const bob = Math.sin(frameCount * 0.08) * 3;
    const px = Math.round(player.x + player.w / 2 - drawCamX);
    const py = Math.round(player.y - 30 + bob - drawCamY);
    // Dieselbe Ein-/Ausblendung wie das Symbol darunter, sonst haengt der Ring
    // sichtbar hinterher.
    const fadeIn = Math.min(1, (SELECTED_BLOCK_POPUP_DURATION - selectedBlockPopupTimer) / 10);
    const fadeOut = Math.min(1, selectedBlockPopupTimer / 30);
    ctx.save();
    ctx.globalAlpha = 0.9 * Math.min(fadeIn, fadeOut);
    ctx.strokeStyle = colorOf(uid);
    ctx.lineWidth = 3;
    ctx.strokeRect(px - size / 2 - 3, py - size / 2 - 3, size + 6, size + 6);
    ctx.restore();
  }

  installHooks();

  return {
    isActive: active,
    colorOf: colorOf,
    nameOf: nameOf,
    blockAuthor: (id) => blockOwner[id] || null,
    creatureAuthor: (id) => creatureOwner[id] || null,
    graphAuthor: (name) => graphOwner[name] || null,
    authorCount: () => orderedAuthors().length,
    togglePanel: togglePanel,
    setRunOthersRules: setRunOthersRules,
    publishNow: () => publish(true),
    unsubscribe: unsubscribe
  };
})();
