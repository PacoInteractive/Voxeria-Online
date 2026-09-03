// ============================================================================
// VOXERIA -- ARENA MODE: der eigene Welt-Editor
//
// Arena ist keine normale Welt mit einem markierten Ausschnitt, sondern eine
// EIGENE WELTART: ein leerer, seitlich begrenzter Kasten in selbst gewaehlter
// Breite, den die Spieler von Null auf bebauen -- mit selbst gemalten Bloecken
// und selbst gebauten Regeln. Erreichbar ueber Hauptmenue -> Multiplayer ->
// Host Room, wo der Gastgeber Modus und Breite festlegt.
//
// Die Aufgabenteilung:
//   voxeria-dimensions-progress.js  erzeugt die leere Welt (generateArenaChunk)
//   voxeria-modding.js              liefert die Regel-Knoten (NODE_CATALOG)
//   voxeria-engine.js               traegt Modus + Breite im Raum-Dokument
//   diese Datei                     das Match: Phasen, Uhr, Punkte, Reset
//
// WARUM DAS SPIELFELD KEINE EIGENE GRENZE MEHR BRAUCHT
// Frueher war die Arena ein markiertes Rechteck, dessen Rand ueber einen
// Wrapper um isInRange() erzwungen wurde. Das ist weg: die Welt IST das
// Spielfeld, und ihre Raender sind unzerstoerbare Waende aus echtem Terrain.
// Eine physische Wand gilt von sich aus fuer alles -- Kollision, Abbauen,
// Fluessigkeiten, Kreaturen -- ohne dass eine einzige dieser Stellen davon
// wissen muss. Die Region wird nur noch aus der Breite ABGELEITET.
//
// WARUM EINE EIGENE DATEI, DIE NICHTS AM MOTOR AENDERT
// Statt neue Aufrufstellen in voxeria-engine.js zu schreiben, werden hier --
// genau wie installGraphHooks() es vormacht -- Funktionen umschlossen, die der
// Motor ohnehin schon aufruft:
//   updateGraphRuntime -> unser Frame-Tick (liegt im !paused-Block der Schleife)
//   findSafeSpawnX     -> in einer leeren Welt findet die normale Spawn-Suche
//                         nichts und durchsucht dabei hunderte Chunks; im
//                         Arena-Modus liefert der Wrapper direkt die Plattform.
//
// WARUM ES KEINEN ECHTEN SERVER GIBT
// Der Multiplayer hier ist bewusst serverlos: der Seed IST der Raum (siehe
// voxeria-engine.js, Abschnitt ROOMS). Firestore ist ein Dokumentspeicher,
// kein Spielserver -- 10 Schreibvorgaenge pro Sekunde fuer Positionen sind
// bereits das Budget. Deshalb simuliert weiterhin jeder Client selbst, und
// geteilt wird nur das, worueber sich alle einig sein MUESSEN: Phase, Uhr,
// Punkte. Das ist dasselbe Muster, mit dem die Koop-Dives schon arbeiten
// (_sharedRun in voxeria-dimensions-progress.js).
// ============================================================================

window.VxArena = (function () {
  'use strict';

  // =========================================================================
  // KONSTANTEN
  // =========================================================================

  // Obergrenze fuer einen gespeicherten Snapshot. Das Spielfeld wird beim
  // Rundenstart Kachel fuer Kachel gesichert, damit die naechste Runde auf
  // demselben Bau startet -- MAX_W deckt die groesste waehlbare Breite ab
  // (siehe ARENA_WIDTHS), MAX_H die volle Welthoehe. Der Deckel bleibt stehen,
  // weil loadSnapshot() damit einen offensichtlich kaputten Eintrag erkennt.
  const MAX_W = 512;
  const MAX_H = 120;

  const COUNTDOWN_MS = 5000;
  const ENDED_MS = 10000;
  const DEFAULT_ROUND_S = 120;

  // Wie lange ein Host stumm sein darf, bevor ihn jemand anderes ersetzt.
  // Bewusst dieselbe Schwelle, die drawOtherPlayers fuer "ist der noch da?"
  // benutzt -- zwei verschiedene Zahlen fuer dieselbe Frage waeren eine
  // Fehlerquelle, die sich erst im vollen Raum zeigt.
  const STALE_MS = 8000;
  const HEARTBEAT_MS = 3000;

  // =========================================================================
  // ZUSTAND
  // =========================================================================

  let match = null;         // das geteilte Match-Dokument (oder null)
  let scores = {};          // uid -> { name, color, score, team, ts }
  let phase = 'build';      // 'build' | 'countdown' | 'running' | 'ended'
  let isHost = false;
  let myScore = 0;
  let myTeam = 0;

  let lastHeartbeat = 0;
  let lastHudDraw = 0;
  let lastScorePush = 0;
  let scoreDirty = false;
  let matchUnsub = null;
  let scoreUnsub = null;
  let subscribedSeed = null;
  let panelOpen = false;
  // War die Arena im LETZTEN tick() noch aktiv? Der Uebergang von true auf
  // false ist der einzige Moment, in dem tick() trotz des fruehen Ausstiegs
  // unten noch einmal renderHud() aufrufen muss -- sonst bleibt das HUD auf
  // dem Stand seines letzten Bildes eingefroren stehen, wenn eine neue,
  // nicht-Arena-Welt geladen wird: renderHud() selbst wuerde sich korrekt
  // verstecken, wird aber nie wieder aufgerufen, weil tick() ab dann sofort
  // zurueckkehrt.
  let wasActive = false;

  // ── Bauphase: Kreativ-Werkzeuge ──────────────────────────────────────────
  // Die Arena war bisher eine reine Stein-Plattform im Nichts, auf der man mit
  // genau den Werkzeugen bauen musste, die auch in der normalen Welt gelten:
  // erst abbauen, dann in die Hotbar, dann platzieren. Fuer einen Modus, dessen
  // einziger Zweck das schnelle Bauen und Ausprobieren ist, war das genau die
  // Reibung, die ihn unbrauchbar gemacht hat. Alle fuenf Stuecke unten beheben
  // das, ausschliesslich waehrend der Bauphase (phase === 'build'):
  //   * Flug statt Schwerkraft (siehe der updatePlayer-Ersatz weiter unten)
  //   * Sofortiges Abbauen und Platzieren statt Halte-Ladezeit
  //   * Unbegrenzte Reichweite, statt in der Naehe der Plattform bauen zu muessen
  //   * Unbegrenzt viele Bloecke, statt sie erst finden zu muessen
  // Ausserhalb der Bauphase (Countdown/laufende Runde/Ende) gilt wieder die
  // normale Physik -- ein echtes Match soll sich wie ein Minispiel anfuehlen,
  // nicht wie ein Kreativmodus.
  const ARENA_INF_COUNT = 999;
  // Neun Faecher, damit das zehnte frei bleibt fuer alles, was ausserhalb
  // dieser Liste gefunden oder gebraucht wird.
  const ARENA_BUILD_PALETTE = [BLOCKS.STONE, BLOCKS.DIRT, BLOCKS.GRASS, BLOCKS.WOOD,
                               BLOCKS.PLANKS, BLOCKS.LOG, BLOCKS.GLASS, BLOCKS.SAND, BLOCKS.TORCH];
  // Welcher SEED die Palette schon bekommen hat. Einmal pro Welt, nicht jeden
  // Frame neu: sonst ueberschriebe das staendig, was der Spieler gerade selbst
  // in der Hotbar einraeumt oder wegwirft.
  let paletteGrantedForSeed = null;
  function grantBuildPalette() {
    if (typeof inventory === 'undefined') return;
    ARENA_BUILD_PALETTE.forEach((block, i) => { inventory[i] = { block, count: ARENA_INF_COUNT }; });
    if (typeof drawHotbar === 'function') drawHotbar();
  }

  // Gegenstueck zu grantBuildPalette: unendliche Baubloecke ins gewertete
  // Match mitzunehmen waere sinnlos, es gibt sie ja nur unbegrenzt zum Bauen.
  // paletteGrantedForSeed wird mit zurueckgesetzt, damit tick() sie beim
  // naechsten Betreten der Bauphase (nach dieser Runde) wieder vergibt.
  function clearBuildPalette() {
    if (typeof inventory === 'undefined') return;
    for (let i = 0; i < ARENA_BUILD_PALETTE.length; i++) inventory[i] = null;
    paletteGrantedForSeed = null;
    if (typeof drawHotbar === 'function') drawHotbar();
  }

  // Beim Phasenwechsel genau einmal feuern, nicht in jedem Frame, in dem die
  // Phase zufaellig noch dieselbe ist.
  let lastSeenPhase = null;

  function active() { return typeof gameMode !== 'undefined' && gameMode === 'arena'; }

  // Online = wir koennen ueberhaupt teilen. Offline ist Arena trotzdem
  // spielbar (Solo-Testlauf im eigenen Browser), nur eben ohne Mitspieler --
  // deshalb faellt hier alles auf "ich bin selbst der Host" zurueck, statt den
  // Modus zu sperren.
  function online() {
    return typeof isMultiplayerActive !== 'undefined' && isMultiplayerActive &&
           typeof db !== 'undefined' && db && typeof userId !== 'undefined' && userId;
  }

  // =========================================================================
  // SPIELFELD
  // =========================================================================

  // Das Spielfeld wird ABGELEITET, nicht mehr markiert: es ist schlicht die
  // ganze Arena-Welt. Deren Breite legt der Gastgeber beim Erstellen des Raums
  // fest und sie reist im Raum-Dokument mit (arenaWorldWidth, deklariert in
  // voxeria-dimensions-progress.js), also rechnen alle Mitspieler dasselbe
  // Rechteck aus, ohne dass es jemand teilen muesste.
  //
  // Frueher gab es hier Ecken-Markierung, eine gespeicherte Region und einen
  // Wrapper um isInRange(). Das ist alles entfallen -- die Weltraender sind
  // jetzt unzerstoerbare Waende aus echtem Terrain und brauchen keine
  // nachgebaute Regel, die dasselbe noch einmal behauptet.
  function region() {
    const w = (typeof arenaWorldWidth !== 'undefined') ? arenaWorldWidth : 0;
    if (!w) return null;
    return { x0: 0, y0: 0, x1: w - 1, y1: WORLD_H - 1 };
  }

  function inRegion(wx, wy) {
    const r = region();
    if (!r) return true;
    return wx >= r.x0 && wx <= r.x1 && wy >= r.y0 && wy <= r.y1;
  }

  // =========================================================================
  // SPIELFELD SICHERN UND ZURUECKSETZEN
  // =========================================================================
  // Damit eine zweite Runde auf demselben Bau startet, wird das Feld beim
  // Rundenstart gesichert und danach wiederhergestellt.
  //
  // WARUM DER SNAPSHOT NICHT GETEILT WIRD
  // Naheliegend waere, ihn in ein Firestore-Dokument zu legen und an alle zu
  // verteilen. Das ist unnoetig: vor Rundenstart haben ohnehin alle denselben
  // Weltzustand -- das Terrain ist eine reine Funktion des Seeds, und jede
  // Bauaenderung ist bereits ueber voxeria_world_<SEED> bei allen angekommen.
  // Also sichert JEDER Client lokal, und die Wiederherstellung passiert ohne
  // eine einzige Netzwerkrunde -- sofort sichtbar, statt nach 200ms Latenz.
  //
  // Einig werden alle trotzdem: der Host schreibt am Rundenende zusaetzlich
  // die veraenderten Kacheln in die normale Welt-Collection zurueck. Das ist
  // dieselbe Leitung, ueber die jede andere Bauaenderung schon laeuft, also
  // bekommt sie auch jemand mit, der erst spaeter dazukommt oder neu laedt.
  // Der Host tut das beim Uebergang "ended -> build", nicht sofort beim
  // Rundenende: die zehn Sekunden Siegerehrung dazwischen sind genau das
  // Fenster, in dem noch unterwegs befindliche Bauaenderungen eintrudeln.

  let snapshot = null;     // { x0, y0, x1, y1, bytes: Uint8Array }
  let snapshotSeed = null; // fuer welche Welt der geladene Snapshot gilt

  // Lauflaengenkodierung ueber ganze Bytes -- Blockkennungen gehen bis 255
  // (siehe CUSTOM_BLOCK_ID_MAX), passen also nicht in die 4 Bit, mit denen
  // _packPixelsRLE in voxeria-modding.js arbeitet. Gleiche Bauform, breitere
  // Werte. Ein Spielfeld ist ueberwiegend Luft und Stein in langen Baendern,
  // deshalb schrumpft das hier typischerweise um ein Vielfaches.
  function packRegion(bytes) {
    let bin = '';
    let run = 0, cur = bytes[0] || 0;
    for (let i = 0; i < bytes.length; i++) {
      const v = bytes[i];
      if (v === cur && run < 255) { run++; continue; }  // 255: der Zaehler ist ein Byte
      bin += String.fromCharCode(run, cur);
      cur = v; run = 1;
    }
    if (run) bin += String.fromCharCode(run, cur);
    return bin;
  }

  function unpackRegion(bin, out) {
    let p = 0;
    for (let i = 0; i + 1 < bin.length; i += 2) {
      const count = bin.charCodeAt(i), val = bin.charCodeAt(i + 1);
      for (let n = 0; n < count && p < out.length; n++) out[p++] = val;
    }
    return p;
  }

  // Liest die Overworld AUSDRUECKLICH, statt getBlock() zu nehmen. getBlock
  // liest currentDim -- stuende der Spieler beim Sichern in einer Dimension,
  // saehe der Snapshot deren Bloecke und wuerde beim Zuruecksetzen fremdes
  // Terrain in die Arena stanzen. Der Arena-Modus hat zwar kein Portal-Buch,
  // aber das ist eine Konfiguration und keine Garantie.
  function overworldBlock(x, y) {
    if (y < 0 || y >= WORLD_H) return BLOCKS.AIR;
    const cx = Math.floor(x / CHUNK_W);
    let lx = x % CHUNK_W;
    if (lx < 0) lx += CHUNK_W;
    return getChunk(cx, 'OVERWORLD')[y * CHUNK_W + lx];
  }

  function captureSnapshot() {
    const r = region();
    if (!r) return;
    const w = r.x1 - r.x0 + 1, h = r.y1 - r.y0 + 1;
    const bytes = new Uint8Array(w * h);
    let p = 0;
    // Zeilenweise (y aussen, x innen) -- restoreSnapshot laeuft in derselben
    // Reihenfolge, und die beiden duerfen nie auseinanderlaufen.
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) bytes[p++] = overworldBlock(x, y);
    }
    snapshot = { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, bytes: bytes };
    persistSnapshot();
  }

  // writeThrough: nur der Host. Alle anderen stellen rein lokal wieder her --
  // sonst schreiben acht Clients dieselbe Kachel acht Mal.
  function restoreSnapshot(writeThrough) {
    if (!snapshot) return 0;
    // In einer Dimension zu stehen hiesse, setBlock() wuerde dort hineinschreiben
    // statt in die Overworld. Dann lieber gar nicht: der Host schreibt die
    // Wiederherstellung ohnehin in die Welt-Collection, und die kommt an,
    // sobald der Spieler zurueck ist.
    if (typeof currentDim !== 'undefined' && currentDim !== 'OVERWORLD') return 0;
    let changed = 0, p = 0;
    for (let y = snapshot.y0; y <= snapshot.y1; y++) {
      for (let x = snapshot.x0; x <= snapshot.x1; x++) {
        const want = snapshot.bytes[p++];
        if (overworldBlock(x, y) === want) continue;
        changed++;
        // Beide Wege pflegen worldEdits mit (siehe recordWorldEdit), damit ein
        // Speicherstand nach der Runde das aufgeraeumte Feld enthaelt und nicht
        // das zerlegte.
        if (writeThrough) setBlockAndBroadcast(x, y, want);
        else setBlock(x, y, want);
      }
    }
    return changed;
  }

  function resetArena(announce) {
    const n = restoreSnapshot(isHost && online());
    if (announce && n > 0) showNotification('Arena reset - ' + n + ' blocks restored');
    else if (announce) showNotification('Nothing to restore');
    return n;
  }

  // Der Snapshot ueberlebt einen Seitenneuladen. Das ist kein Multiplayer-
  // Feature, sondern eins fuers Basteln: wer allein an seinem Minispiel
  // schraubt, laedt staendig neu und haette sonst nach jedem Neuladen ein
  // Feld, das sich nicht mehr zuruecksetzen laesst.
  function snapKey() { return 'voxeria_arena_snap_' + SEED; }

  // Die Region wird NICHT mehr gespeichert -- sie faellt aus der Weltbreite,
  // und die kommt beim Beitreten aus dem Raum-Dokument bzw. beim lokalen
  // Speicherstand aus dessen arenaWidth-Feld.

  function persistSnapshot() {
    if (!snapshot) return;
    try {
      const payload = JSON.stringify({
        x0: snapshot.x0, y0: snapshot.y0, x1: snapshot.x1, y1: snapshot.y1,
        d: _pieceB64url(packRegion(snapshot.bytes))
      });
      // localStorage ist im ganzen Projekt knapp (VxWorlds warnt schon bei 4MB).
      // Ein Feld, das sich nicht komprimieren laesst, wandert lieber gar nicht
      // hinein, als den Speicherstand des Spielers zu verdraengen -- im
      // Arbeitsspeicher liegt es ohnehin.
      if (payload.length > 300000) return;
      localStorage.setItem(snapKey(), payload);
    } catch (e) { /* voll oder gesperrt -- der Snapshot lebt im RAM weiter */ }
  }

  function loadSnapshot() {
    try {
      const raw = localStorage.getItem(snapKey());
      if (!raw) return;
      const d = JSON.parse(raw);
      if (!d || typeof d.x0 !== 'number') return;
      const w = d.x1 - d.x0 + 1, h = d.y1 - d.y0 + 1;
      if (w <= 0 || h <= 0 || w > MAX_W || h > MAX_H) return;
      const bytes = new Uint8Array(w * h);
      const filled = unpackRegion(_pieceB64urlDecode(d.d), bytes);
      // Ein abgeschnittener Eintrag wird verworfen statt halb benutzt: das
      // Feld halb zurueckzusetzen waere schlimmer als es stehen zu lassen.
      if (filled !== bytes.length) return;
      snapshot = { x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1, bytes: bytes };
    } catch (e) { /* unlesbar -- dann eben kein Snapshot */ }
  }

  // =========================================================================
  // MATCH-DOKUMENT
  // =========================================================================
  // Ein Dokument pro Welt haelt alles, worueber sich die Spieler einig sein
  // muessen: Phase, Startzeit, Rundenlaenge, Sieger. Geschrieben wird es nur
  // vom Host.
  //
  // Das Spielfeld steht bewusst NICHT mehr darin -- es faellt aus der Breite
  // der Welt, und die steht schon im Raum-Dokument (siehe createRoom). Zwei
  // Dokumente, die dieselbe Zahl tragen, koennten auseinanderlaufen.

  function matchRef() {
    return doc(db, 'artifacts', appId, 'public', 'data', 'voxeria_arenas', String(SEED));
  }

  function scoreRef(uid) {
    return doc(db, 'artifacts', appId, 'public', 'data', 'voxeria_arena_players', SEED + '_' + uid);
  }

  // Wer ist Host? Bewusst ABGELEITET statt beansprucht: die kleinste UID unter
  // allen, die gerade in dieser Welt stehen. Damit braucht die Wahl keinen
  // Schreibvorgang und keine Transaktion, und zwei Clients koennen sich nicht
  // gegenseitig ueberschreiben -- sie rechnen dasselbe Ergebnis aus.
  //
  // Faellt der Host aus, verschwindet seine UID aus otherPlayers und der
  // naechstkleinere uebernimmt von selbst, ohne Uebergabeprotokoll. Kurz
  // uneinige Sichten sind harmlos: beide wuerden dasselbe Dokument mit
  // derselben Phase schreiben.
  function computeHost() {
    if (!online()) return true;
    const now = Date.now();
    let best = userId;
    for (const id in otherPlayers) {
      const p = otherPlayers[id];
      if (!p || now - (p.ts || 0) > STALE_MS) continue;
      if (id < best) best = id;
    }
    return best === userId;
  }

  function subscribe() {
    if (!active() || !online()) return;
    if (subscribedSeed === rawSeedString) return;
    unsubscribe();
    subscribedSeed = rawSeedString;

    matchUnsub = onSnapshot(matchRef(), (snap) => {
      const d = snap.exists() ? snap.data() : null;
      if (!d) { match = null; return; }
      match = d;
      applyPhase(d.phase || 'build');
    }, (e) => console.error('Arena match sync error:', e));

    const q = query(
      collection(db, 'artifacts', appId, 'public', 'data', 'voxeria_arena_players'),
      where('seed', '==', rawSeedString)
    );
    scoreUnsub = onSnapshot(q, (snap) => {
      snap.docChanges().forEach((ch) => {
        const d = ch.doc.data();
        if (!d || !d.uid) return;
        if (ch.type === 'removed') { delete scores[d.uid]; return; }
        scores[d.uid] = d;
      });
      renderScoreboard();
    }, (e) => console.error('Arena score sync error:', e));
  }

  function unsubscribe() {
    // Das eigene Punktedokument mitnehmen. Ohne das bleibt fuer JEDE Arena,
    // die jemals jemand betreten hat, ein Dokument pro Spieler liegen -- und
    // zwar dauerhaft, denn niemand raeumt es je wieder auf. Genau die Sorte
    // Muell, gegen die cleanupAbandonedSeed fuer die Weltdaten geschrieben
    // wurde. sortedScores() blendet veraltete Eintraege zwar aus, aber das ist
    // Kosmetik in der Anzeige und keine Loeschung.
    //
    // Nur das eigene: ein Client, der fremde Dokumente aufraeumt, wuerde
    // jemandem die Punkte wegnehmen, der nur kurz die Verbindung verloren hat.
    if (subscribedSeed && typeof db !== 'undefined' && db && typeof userId !== 'undefined' && userId) {
      const seedAtLeave = subscribedSeed;
      deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'voxeria_arena_players',
                    seedToNumber(seedAtLeave) + '_' + userId)).catch(() => {});
    }
    if (matchUnsub) { matchUnsub(); matchUnsub = null; }
    if (scoreUnsub) { scoreUnsub(); scoreUnsub = null; }
    subscribedSeed = null;
    scores = {};
    match = null;
  }

  function writeMatch(patch) {
    if (!online()) return;
    const base = match || { seed: rawSeedString, phase: 'build', roundS: DEFAULT_ROUND_S, round: 0 };
    const next = Object.assign({}, base, patch, { seed: rawSeedString, host: userId, hostTs: Date.now() });
    match = next;
    setDoc(matchRef(), next).catch(e => console.error('Arena match write error:', e));
  }

  // =========================================================================
  // PUNKTE
  // =========================================================================
  // Jeder Spieler schreibt AUSSCHLIESSLICH sein eigenes Dokument. Das ist der
  // Grund, warum die Punkte nicht im Match-Dokument stehen: ein gemeinsames
  // Dokument, in das acht Clients gleichzeitig schreiben, verliert bei jedem
  // Rennen Punkte (letzter Schreibvorgang gewinnt und ueberschreibt alles
  // andere). Getrennte Dokumente koennen sich nicht gegenseitig ueberschreiben,
  // und der Host liest am Ende einfach alle und kuert den Sieger -- dasselbe
  // Muster, das voxeria_players fuer Positionen schon benutzt.

  function addScore(n) {
    if (!active() || phase !== 'running') return;
    myScore += n;
    if (myScore < 0) myScore = 0;
    scoreDirty = true;
    // Sofort lokal sichtbar, statt erst wenn der naechste Schreibvorgang
    // zurueckkommt -- ein Punkt, der eine halbe Sekunde spaeter erscheint,
    // fuehlt sich wie ein verschluckter Treffer an.
    if (userId && scores[userId]) scores[userId].score = myScore;
    renderScoreboard();
  }

  function pushScore(now) {
    if (!online()) return;
    // Gedrosselt aus demselben Grund wie der Positions-Sync: ein Minispiel,
    // das pro Treffer schreibt, verbrennt bei schneller Punktevergabe das
    // Schreibbudget der ganzen Welt.
    if (!scoreDirty || now - lastScorePush < 500) return;
    lastScorePush = now;
    scoreDirty = false;
    setDoc(scoreRef(userId), {
      seed: rawSeedString, uid: userId,
      name: (window._playerDisplayName || null),
      color: (typeof player !== 'undefined' ? player.color : null),
      score: myScore, team: myTeam, ts: Date.now()
    }).catch(() => {});
  }

  function resetScores() {
    myScore = 0;
    scoreDirty = true;
    for (const id in scores) scores[id].score = 0;
    renderScoreboard();
  }

  function sortedScores() {
    const list = [];
    const now = Date.now();
    for (const id in scores) {
      const s = scores[id];
      if (!s) continue;
      // Alte Eintraege einer laengst verlassenen Welt wuerden sonst ewig auf
      // der Tafel stehen bleiben -- die Dokumente ueberleben die Sitzung.
      if (id !== userId && now - (s.ts || 0) > 60000) continue;
      list.push(s);
    }
    if (userId && !scores[userId]) {
      list.push({ uid: userId, name: window._playerDisplayName || null, score: myScore, team: myTeam });
    }
    list.sort((a, b) => (b.score || 0) - (a.score || 0));
    return list;
  }

  // =========================================================================
  // PHASEN
  // =========================================================================

  // Der EINE Trichter, durch den jeder Phasenwechsel laeuft -- egal ob ihn
  // dieser Client ausgeloest hat oder ob er ueber das Match-Dokument
  // hereinkam. Genau deshalb haengen Sichern und Zuruecksetzen hier und nicht
  // in startMatch()/backToBuild(): dort haengten sie nur beim Host, und alle
  // anderen bekaemen nie einen eigenen Snapshot.
  function applyPhase(next) {
    if (next === phase) return;
    const prev = phase;
    phase = next;

    // Sichern beim Betreten des Countdowns: da ist die Bauphase vorbei und
    // noch nichts kaputt.
    if (prev === 'build' && next === 'countdown') { captureSnapshot(); clearBuildPalette(); }

    // Zuruecksetzen auf JEDEM Rueckweg ins Bauen, nicht nur nach der
    // Siegerehrung. Aus 'ended' ist es der normale Rundenabschluss -- bewusst
    // erst hier und nicht schon beim Rundenende, sonst verschwaende das Feld
    // unter dem Sieger, waehrend alle noch auf die Tabelle schauen.
    //
    // Aus 'running'/'countdown' kommt "Match beenden". Ohne diesen Zweig
    // bliebe das Feld nach einem Abbruch zerlegt stehen, UND der naechste
    // captureSnapshot() oben wuerde genau diesen zerlegten Stand als neuen
    // Ausgangspunkt sichern -- der urspruengliche Bau waere damit endgueltig
    // weg. Aus 'countdown' ist es ein Leerlauf (der Snapshot ist keine Sekunde
    // alt und nichts hat sich geaendert), aber ein billiger.
    if (prev !== 'build' && next === 'build') resetArena(false);

    renderHud();
    renderPanel();
  }

  // Weltwechsel: ALLES, was zur alten Welt gehoert, muss weg. Ohne das nimmt
  // ein Spieler, der mitten in einer Runde ins Hauptmenue geht und eine neue
  // Welt betritt, die alte Phase mit -- und steht dann in einer frischen
  // Arena, in der sich keine Runde starten laesst, weil intern noch
  // 'countdown' steht. Die Region wird nicht zurueckgesetzt: sie faellt aus
  // arenaWorldWidth, das beim Weltwechsel ohnehin neu gesetzt wird.
  //
  // Wird aus tick() UND aus startMatch() gerufen. Der zweite Aufruf ist die
  // Absicherung gegen eine Reihenfolge: laeuft der erste Tick der neuen Welt
  // erst NACH dem Rundenstart, wuerde dieser Block das eben gestartete Match
  // wieder auf 'build' zuruecksetzen. Im laufenden Spiel tickt die Schleife
  // laengst, bevor jemand den Knopf drueckt -- aber darauf soll sich das hier
  // nicht verlassen muessen.
  function syncWorld() {
    if (snapshotSeed === rawSeedString) return;
    snapshotSeed = rawSeedString;
    snapshot = null;
    match = null;
    phase = 'build';
    lastSeenPhase = null;   // nicht 'build': sonst feuert der erste echte
                            // Phasenwechsel der neuen Welt kein Ereignis
    scores = {};
    myScore = 0;
    myTeam = 0;
    loadSnapshot();
  }

  function startMatch() {
    if (!active()) return;
    syncWorld();
    if (!region()) { showNotification('This world has no arena bounds'); return; }
    if (phase !== 'build' && phase !== 'ended') { showNotification('A match is already running'); return; }
    const roundS = readRoundLength();
    resetScores();
    if (online()) {
      writeMatch({ phase: 'countdown', startTs: Date.now(), roundS: roundS, winner: null,
                   round: ((match && match.round) || 0) + 1 });
    } else {
      match = { phase: 'countdown', startTs: Date.now(), roundS: roundS, round: 1 };
    }
    applyPhase('countdown');
  }

  function endMatch(reason) {
    if (!active() || (phase !== 'running' && phase !== 'countdown')) return;
    const board = sortedScores();
    const winner = board.length ? board[0] : null;
    if (online()) {
      writeMatch({ phase: 'ended', endedTs: Date.now(),
                   winner: winner ? { uid: winner.uid, name: winner.name || null, score: winner.score || 0 } : null });
    } else if (match) {
      match.phase = 'ended'; match.endedTs = Date.now();
      match.winner = winner ? { uid: winner.uid, name: winner.name || null, score: winner.score || 0 } : null;
    }
    applyPhase('ended');
    if (reason) showNotification(reason);
  }

  // Manueller Abbruch zum Testen: ein Mod-Ersteller, der nur pruefen will, ob
  // eine Regel ueberhaupt feuert, soll nicht die volle Rundenlaenge absitzen
  // muessen. Geht direkt zurueck zum Bauen statt ueber die Siegerehrung --
  // die ist fuer einen echten Rundenabschluss gedacht, nicht fuer "Abbrechen".
  function stopMatch() {
    if (!active() || (phase !== 'running' && phase !== 'countdown')) return;
    if (online()) writeMatch({ phase: 'build', winner: null });
    else if (match) match.phase = 'build';
    applyPhase('build');
    showNotification('⏹️ Match stopped');
  }

  function backToBuild() {
    if (online()) writeMatch({ phase: 'build', winner: null });
    else if (match) match.phase = 'build';
    applyPhase('build');
  }

  function readRoundLength() {
    const el = document.getElementById('arena-round-len');
    const v = el ? parseInt(el.value, 10) : DEFAULT_ROUND_S;
    if (!isFinite(v)) return DEFAULT_ROUND_S;
    return Math.max(30, Math.min(900, v));
  }

  // Verbleibende Sekunden -- IMMER aus startTs der Wanduhr gerechnet, nie aus
  // einem eigenen Zaehler. Damit laeuft die Runde fuer alle gleich schnell,
  // auch wenn ein Client ruckelt, das Tab in den Hintergrund wandert oder
  // jemand das Pausenmenue oeffnet (die Spielschleife haelt dann an, die
  // Wanduhr nicht). Ein Frame-Zaehler waere hier eine offene Tuer.
  function remainingS() {
    if (!match || !match.startTs) return 0;
    const roundS = match.roundS || DEFAULT_ROUND_S;
    if (phase === 'countdown') {
      return Math.max(0, (COUNTDOWN_MS - (Date.now() - match.startTs)) / 1000);
    }
    return Math.max(0, roundS - (Date.now() - match.startTs - COUNTDOWN_MS) / 1000);
  }

  // =========================================================================
  // FRAME-TICK
  // =========================================================================

  function tick(now) {
    if (!active()) {
      // Genau EIN Aufruf beim Uebergang, nicht bei jedem inaktiven Frame:
      // renderHud() versteckt das HUD selbst korrekt (siehe dort), es musste
      // nur nach dem Verlassen der Arena noch einmal aufgerufen werden.
      if (wasActive) { wasActive = false; renderHud(); }
      return;
    }
    wasActive = true;

    if (phase === 'build' && paletteGrantedForSeed !== SEED) {
      grantBuildPalette();
      paletteGrantedForSeed = SEED;
    }

    // Bewusst NICHT in subscribe(): das laeuft nur online, und der
    // Solo-Bastler, fuer den der gespeicherte Snapshot ueberhaupt da ist,
    // erreicht es damit nie.
    syncWorld();
    subscribe();
    isHost = computeHost();

    if (online() && now - lastHeartbeat > HEARTBEAT_MS) {
      lastHeartbeat = now;
      pushScore(Date.now());
      // Der Host haelt das Dokument frisch, damit ein spaet Beitretender die
      // laufende Runde sieht, statt ein Dokument, das seit Minuten still ist.
      if (isHost && match && phase !== 'build') writeMatch({});
    }
    pushScore(Date.now());

    // Phasenwechsel treibt NUR der Host. Wuerde jeder Client selbst
    // weiterschalten, saehe ein Spieler mit 200ms mehr Latenz die Runde
    // frueher enden als der Rest -- und schriebe dann seinen eigenen Sieger
    // ins gemeinsame Dokument.
    if (isHost && match) {
      if (phase === 'countdown' && Date.now() - match.startTs >= COUNTDOWN_MS) {
        if (online()) writeMatch({ phase: 'running' });
        else match.phase = 'running';
        applyPhase('running');
        // Das onMatchStart-Ereignis feuert bewusst NICHT hier, sondern unten im
        // Phasenvergleich -- sonst bekaeme der Host es zweimal (einmal aus
        // diesem Zweig, einmal aus dem Vergleich) und jede Regel, die zum
        // Rundenstart etwas austeilt, teilte beim Host doppelt aus.
      } else if (phase === 'running' && remainingS() <= 0) {
        endMatch(null);
      } else if (phase === 'ended' && match.endedTs && Date.now() - match.endedTs > ENDED_MS) {
        backToBuild();
      }
    }

    // Auch ohne Host-Rolle muessen die lokalen Regeln erfahren, dass die Runde
    // begonnen hat -- der Zustand kommt ueber das Dokument herein, das
    // Ereignis feuert hier.
    if (phase !== lastSeenPhase) {
      if (lastSeenPhase !== null) {
        if (phase === 'running') fireArena('onMatchStart', {});
        if (phase === 'ended') fireArena('onMatchEnd', {});
      }
      lastSeenPhase = phase;
      renderHud();
    }

    // Die Uhr braucht keine 60 Aktualisierungen pro Sekunde -- sie zeigt
    // ganze Sekunden. Jeder Frame waere ein DOM-Schreibvorgang samt
    // Layoutneuberechnung fuer ein Bild, das sich 59-mal nicht aendert.
    if (now - lastHudDraw > 200) { lastHudDraw = now; renderHud(); }
  }

  // Bruecke zum Knoten-System. Die Arena-Ereignisse laufen durch dieselbe
  // fireGraphEvent-Maschine wie jedes andere Mod-Ereignis -- die Regeln eines
  // Minispiels sind damit gewoehnliche Knotenketten, keine zweite Sprache.
  function fireArena(type, ctx) {
    if (typeof fireGraphEvent === 'function') fireGraphEvent(type, ctx || {});
  }

  // Hier stand einmal das Zeichnen der Spielfeldgrenze: eine pulsierende
  // Umrandung samt Eckwinkeln und einer Abdunklung von allem ausserhalb.
  // Das ist ersatzlos entfallen -- die Grenze der Arena ist jetzt eine echte,
  // unzerstoerbare Wand aus Bedrock, die der normale Welt-Renderer ohnehin
  // zeichnet. Eine zweite, darueber gemalte Linie wuerde dieselbe Information
  // ein zweites Mal behaupten und bei jeder Abweichung luegen.

  // =========================================================================
  // HUD + PANEL
  // =========================================================================

  function fmtTime(s) {
    const t = Math.max(0, Math.ceil(s));
    return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
  }

  function renderHud() {
    const hud = document.getElementById('arena-hud');
    if (!hud) return;
    if (!active()) { hud.classList.remove('show'); return; }
    hud.classList.add('show');

    const phaseEl = document.getElementById('arena-phase');
    const timeEl = document.getElementById('arena-time');
    if (phaseEl) {
      phaseEl.textContent = phase === 'build' ? 'BUILD'
                          : phase === 'countdown' ? 'GET READY'
                          : phase === 'running' ? 'ROUND ' + ((match && match.round) || 1)
                          : 'FINISHED';
      phaseEl.dataset.phase = phase;
    }
    if (timeEl) {
      timeEl.textContent = (phase === 'build') ? 'building'
                         : (phase === 'ended') ? (match && match.winner ? 'winner: ' + shortName(match.winner) : 'no winner')
                         : fmtTime(remainingS());
    }
    renderScoreboard();
  }

  function shortName(s) {
    if (!s) return '???';
    if (s.name) return String(s.name).slice(0, 12);
    if (s.uid === userId) return 'You';
    return String(s.uid || '').slice(0, 4).toUpperCase();
  }

  function renderScoreboard() {
    const el = document.getElementById('arena-scores');
    if (!el || !active()) return;
    if (phase === 'build') { el.innerHTML = ''; return; }
    const board = sortedScores().slice(0, 6);
    el.innerHTML = board.map((s, i) =>
      '<div class="arena-score-row' + (s.uid === userId ? ' me' : '') + '">' +
        '<span class="asr-rank">' + (i + 1) + '</span>' +
        '<span class="asr-name">' + escapeHtml(shortName(s)) + '</span>' +
        '<span class="asr-pts">' + (s.score || 0) + '</span>' +
      '</div>'
    ).join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function togglePanel(force) {
    const el = document.getElementById('arena-panel');
    if (!el) return;
    panelOpen = (force === undefined) ? !panelOpen : !!force;
    el.classList.toggle('open', panelOpen);
    if (panelOpen) renderPanel();
  }

  function renderPanel() {
    if (!panelOpen) return;
    const info = document.getElementById('arena-region-info');
    const startBtn = document.getElementById('arena-start-btn');
    const r = region();
    if (info) {
      info.textContent = r
        ? (r.x1 - r.x0 + 1) + ' blocks wide, ' + (r.y1 - r.y0 + 1) + ' tall'
        : 'This world has no arena bounds';
    }
    if (startBtn) {
      startBtn.disabled = !r || (phase !== 'build' && phase !== 'ended');
      startBtn.textContent = phase === 'running' || phase === 'countdown' ? 'Match running' : 'Start match';
    }
    const resetBtn = document.getElementById('arena-reset-btn');
    if (resetBtn) {
      // Es gibt erst nach der ersten Runde etwas zurueckzusetzen. Ein Knopf,
      // der vorher da ist und nichts tut, liest sich als kaputt.
      resetBtn.disabled = !snapshot || phase === 'running' || phase === 'countdown';
    }
    const stopBtn = document.getElementById('arena-stop-btn');
    if (stopBtn) {
      // Nur sichtbar, waehrend es ueberhaupt etwas zu beenden gibt -- sonst
      // steht ein toter Knopf permanent neben "Start match" herum.
      stopBtn.style.display = (phase === 'running' || phase === 'countdown') ? '' : 'none';
    }
    const hostEl = document.getElementById('arena-host-note');
    if (hostEl) {
      hostEl.textContent = !online() ? 'Offline - solo test run'
                         : isHost ? 'You are running this match'
                         : 'Another player is running this match';
    }
  }

  // =========================================================================
  // MOTOR-WRAPPER
  // =========================================================================
  // Siehe Kopf der Datei: klassische Scripts teilen einen globalen Scope, eine
  // top-level `function foo()` ist also eine Eigenschaft des globalen Objekts.
  // Wird sie neu zugewiesen, landen ALLE bestehenden Aufrufstellen im Motor
  // beim Wrapper -- ohne eine Zeile in voxeria-engine.js zu aendern. Dass
  // dieses File nach dem Motor geladen wird, garantiert, dass die Originale
  // hier schon existieren.

  let hooksInstalled = false;
  function installHooks() {
    if (hooksInstalled) return;
    hooksInstalled = true;

    // Frame-Tick. updateGraphRuntime liegt im !paused-Block der Spielschleife,
    // also genau dort, wo Spielzustand fortgeschrieben werden darf.
    if (typeof updateGraphRuntime === 'function') {
      const original = updateGraphRuntime;
      window.updateGraphRuntime = function (dt) {
        const r = original(dt);
        try { tick(performance.now()); }
        catch (e) { console.warn('Voxeria: arena tick failed', e); }
        return r;
      };
    }

    // Spawn. Die normale Suche taugt fuer eine leere Welt nicht: sie laeuft
    // ueber bis zu 160 Chunks in beide Richtungen und prueft jede Spalte auf
    // begehbaren Boden. In der Arena gibt es genau eine Plattform und sonst
    // Luft -- die Suche wuerde also hunderte leere Chunks erzeugen, nichts
    // finden (Bedrock zaehlt nicht als Spawn-Boden) und am Ende auf x=0
    // zurueckfallen, wo der Spieler in der Wand steht.
    //
    // Der Wrapper liefert stattdessen direkt die Mitte, wo die Plattform
    // liegt. getSurfaceYAt() findet dort dann von selbst die richtige Hoehe,
    // weil die Plattform aus STONE besteht und damit als Boden zaehlt.
    if (typeof findSafeSpawnX === 'function') {
      const original = findSafeSpawnX;
      window.findSafeSpawnX = function () {
        if (active() && typeof arenaWorldWidth !== 'undefined' && arenaWorldWidth > 0) {
          return Math.floor(arenaWorldWidth / 2);
        }
        return original();
      };
    }

    // Flug waehrend der Bauphase. Ersetzt updatePlayer komplett statt es zu
    // umschliessen: Schwerkraft, Sprung und Kollisionsaufloesung liegen in
    // EINER Funktion hintereinander, ein Aufruf-vorher-oder-nachher haette
    // also mitten in fremder Physik ansetzen muessen. Wiederverwendet werden
    // trotzdem dieselben resolveCollisionX/Y wie das Original, damit man an
    // Waenden und der Plattform weiterhin abprallt statt hindurchzufliegen --
    // kein Geisterflug, nur keine Schwerkraft.
    // Deutlich schneller als Laufen (Flug soll sich kraftvoll anfuehlen, nicht
    // wie Schweben), mit einer Anlaufzeit statt einem harten Umschalten
    // zwischen 0 und Vollgeschwindigkeit -- genau das "Saftige", das vorher
    // fehlte. FLY_EASE ist bewusst hoch: das Anlaufen soll sich in unter einer
    // halben Sekunde anfuehlen, nicht traege.
    const FLY_SPEED = playerSpeed * 2.4;
    const FLY_EASE = 0.32;
    // Nur beim WECHSEL von "steht" zu "steigt/sinkt" ausgeloest (Flanken-
    // Erkennung), nicht in jedem Frame, in dem die Taste weiter haelt -- sonst
    // waere jeder einzelne Frame ein neuer "Abheben"-Moment.
    let wasFlyingUp = false, wasFlyingDown = false;
    if (typeof updatePlayer === 'function') {
      const original = updatePlayer;
      window.updatePlayer = function (dt) {
        if (!(active() && phase === 'build')) { wasFlyingUp = wasFlyingDown = false; return original(dt); }
        if (typeof player === 'undefined') return original(dt);
        // Erste Zeile wie im Original: waehrend der Sterbe-/Respawn-Sequenz
        // gehoert der Spieler nicht sich selbst. Ohne das fliegt er mitten in
        // der eigenen Todesexplosion weiter.
        if (typeof deathPending !== 'undefined' && deathPending) return;
        if (player.frozenTimer > 0) { player.frozenTimer -= dt; return; }
        if (player.goldFrozenTimer > 0) { player.goldFrozenTimer -= dt; return; }
        if (keys[keyBinds.left] || keys['arrowleft']) player.vx = -playerSpeed;
        else if (keys[keyBinds.right] || keys['arrowright']) player.vx = playerSpeed;
        else player.vx *= Math.pow(0.7, dt);

        const up = keys[keyBinds.jump] || keys['arrowup'] || keys['w'];
        const down = keys['s'] || keys['arrowdown'];
        const targetVy = up ? -FLY_SPEED : down ? FLY_SPEED : 0;
        // Angenaehert statt gesetzt: dieselbe Anlauf-/Bremskurve, die die
        // horizontale Bewegung ueberall im Spiel schon hat (siehe player.vx
        // oben), nur senkrecht. Das gibt dem Flug Gewicht, ohne traege zu wirken.
        player.vy += (targetVy - player.vy) * Math.min(1, FLY_EASE * dt);

        // Abheben: derselbe Stauch-Streck-Effekt wie beim Sprung, dazu ein
        // Sound und eine kleine Schuetteler, damit der Moment einen Schlag hat.
        if (up && !wasFlyingUp) {
          player.scaleX = 0.55; player.scaleY = 1.55;
          playSound('jump');
          screenShake = Math.max(screenShake, 3);
          spawnPlayerDustPuffBurst(player.x + player.w/2, player.y + player.h);
        }
        if (down && !wasFlyingDown) {
          player.scaleX = 1.25; player.scaleY = 0.8;
        }
        wasFlyingUp = up; wasFlyingDown = down;

        // Schubduese: ein staendiger, aber duenn gestreuter Partikel-Strahl
        // unter den Fuessen waehrend des Steigens, damit sich Fliegen wie ein
        // andauernder Vorgang anfuehlt statt wie eine reine Positionsaenderung.
        if (up && Math.random() < 0.5 * dt) {
          spawnPlayerDustPuff(player.x + player.w/2, player.y + player.h);
        }

        player.x += player.vx * dt; resolveCollisionX();
        player.y += player.vy * dt; resolveCollisionY();
        // Derselbe Sicherheitsnetz-Wert wie im Original: langes Sinken am
        // Plattformrand vorbei soll zurueckholen statt endlos ins Leere zu fallen.
        if (player.y > WORLD_H * TILE) { player.y = -100; player.vy = 0; }

        // Ablaufende Zaehler, die sonst NUR im Original heruntergezaehlt
        // werden. Weil dieser Ersatz die Funktion komplett ersetzt, standen
        // sie in der Bauphase still -- und ein Zaehler, der stillsteht, bleibt
        // fuer immer ueber null:
        //   * placeAnim/mineAnim steuern die Arm-Pose. Beim Bauen wird
        //     pausenlos platziert und abgebaut, der Spieler klebte also schon
        //     nach dem ersten Block dauerhaft in der Platzier-Pose.
        //   * die drei Flash-Zaehler faerben den Bildschirm. Tut eine Regel
        //     dem Spieler in der Bauphase weh, bliebe das Rot fuer immer.
        // Reine Zaehler ohne Nebenwirkung, deshalb ist das Verdoppeln hier
        // ungefaehrlich. Die Rang-Buffs (Haste, Luck, Reach, Hazard) bleiben
        // bewusst aussen vor: die zaehlen ihr Ende mit Meldung und HUD-Update
        // herunter, und das gehoert nicht in eine zweite Kopie.
        if (player.placeAnimTimer > 0) player.placeAnimTimer -= dt;
        if (player.mineAnimTimer > 0) player.mineAnimTimer -= dt;
        if (typeof damageFlashTimer !== 'undefined' && damageFlashTimer > 0) damageFlashTimer -= dt;
        if (typeof healFlashTimer !== 'undefined' && healFlashTimer > 0) healFlashTimer -= dt;
        if (typeof outOfRangeFlashTimer !== 'undefined' && outOfRangeFlashTimer > 0) outOfRangeFlashTimer -= dt;

        // Kamera-Nachfuehrung. Das Original erledigt das am Ende SEINES
        // updatePlayer -- weil dieser Ersatz die Funktion komplett ersetzt
        // statt sie zu umschliessen, lief camX/camY hier bisher nie mit, und
        // der Spieler flog beim schnellen Bau-Flug einfach aus dem sichtbaren
        // Bereich hinaus. Dieselbe Formel wie im Original, damit sich das
        // Verhalten nicht unterscheidet, sobald ein Match startet.
        const tcamX = player.x - (COLS >> 1) * TILE;
        const tcamY = player.y - (ROWS >> 1) * TILE;
        camX += (tcamX - camX) * (1 - Math.pow(0.80, dt));
        camY += (tcamY - camY) * (1 - Math.pow(0.80, dt));
        camY = Math.max(-ROWS * TILE, Math.min(camY, (WORLD_H - ROWS + 4) * TILE));
      };
    }

    // Sofortiges Abbauen. _holdRequiredMs liefert die Ladezeit in Millisekunden
    // fuer updateMiningHold; auf 0 gesetzt bricht ein Block beim allerersten
    // Frame, in dem die Maustaste haelt (positive Millisekunden geteilt durch 0
    // ergibt Infinity, auf 1 gekappt -- siehe dort).
    if (typeof _holdRequiredMs === 'function') {
      const original = _holdRequiredMs;
      window._holdRequiredMs = function (hardness) {
        if (active() && phase === 'build') return 0;
        return original(hardness);
      };
    }

    // Unbegrenzte Reichweite. isInRange ist die einzige Stelle, an der Mining,
    // Platzieren UND der Ausser-Reichweite-Hinweis nachsehen -- ein Wrapper
    // hier reicht deshalb fuer alle drei zugleich, statt jede Aufrufstelle
    // einzeln aufzuweichen.
    if (typeof isInRange === 'function') {
      const original = isInRange;
      window.isInRange = function (wx, wy) {
        if (active() && phase === 'build') return true;
        return original(wx, wy);
      };
    }

    // Sofortiges Platzieren. PLACE_HOLD_MS ist eine Konstante, laesst sich
    // also anders als _holdRequiredMs nicht von aussen auf 0 setzen -- deshalb
    // hier keine Ladezeit, sondern derselbe Ziel-Test wie im Original
    // (platzierbarer Untergrund, in Reichweite) direkt gefolgt vom Platzieren.
    if (typeof updatePlaceHold === 'function') {
      const original = updatePlaceHold;
      window.updatePlaceHold = function (now) {
        if (!(active() && phase === 'build')) return original(now);
        if (!placeActive) return;
        if (player.frozenTimer > 0 || player.goldFrozenTimer > 0) { _cancelPlaceCharge(); return; }
        const item = inventory[selectedSlot];
        if (!item || item.count <= 0) { _cancelPlaceCharge(); return; }
        const { wx, wy } = getMouseWorldCoords();
        const b = getBlock(wx, wy);
        const placeable = b===BLOCKS.AIR||b===BLOCKS.WATER||b===BLOCKS.BG_PLANKS||b===BLOCKS.FLOWER||b===BLOCKS.PORTAL;
        if (!placeable || !isInRange(wx, wy)) return;
        executePlace(wx, wy);
        spawnPlaceJuice(wx, wy, item.block);
        paintPlaceMode = true; paintLastX = wx; paintLastY = wy;
        placeWx = placeWy = null; placeProgressMs = 0;
      };
    }

    // Unbegrenzter Vorrat. executePlace zaehlt intern herunter (bis hin zum
    // Leeren des ganzen Hotbar-Faches); hier wird nach jedem Platzieren wieder
    // aufgefuellt, egal ob der Zaehler nur sank oder das Fach ganz leer wurde.
    if (typeof executePlace === 'function') {
      const original = executePlace;
      window.executePlace = function (wx, wy) {
        if (!(active() && phase === 'build')) return original(wx, wy);
        const held = inventory[selectedSlot] ? inventory[selectedSlot].block : null;
        original(wx, wy);
        if (held !== null) {
          if (inventory[selectedSlot]) inventory[selectedSlot].count = ARENA_INF_COUNT;
          else inventory[selectedSlot] = { block: held, count: ARENA_INF_COUNT };
          if (typeof drawHotbar === 'function') drawHotbar();
        }
      };
    }

    // Die leere Arena-Leinwand braucht keinen Hoehlenhintergrund: drawCaveBackground
    // haengt seine Starthoehe an getBiomeHeight(), das fuer die Arena nichts
    // Sinnvolles liefert (sie hat keine echte Gelaendehoehe), und malte dadurch
    // die dunkle Hoehlenwand-Textur ueber praktisch die ganze Plattform herum
    // und darunter -- das "Nichts" sah aus wie eine steinerne Hoehle statt wie
    // leerer Raum. Gilt fuer die GANZE Arena (jede Phase), nicht nur die
    // Bauphase: das Nichts soll auch waehrend eines laufenden Matches leer bleiben.
    if (typeof drawCaveBackground === 'function') {
      const original = drawCaveBackground;
      window.drawCaveBackground = function () {
        if (active()) return;
        return original();
      };
    }
  }

  installHooks();

  // Beim Schliessen des Tabs dasselbe wie beim Weltwechsel: das eigene
  // Punktedokument geht mit. Spiegelt _leaveMultiplayer in voxeria-engine.js,
  // das fuer das Positions-Dokument genau dies tut -- inklusive pagehide,
  // weil beforeunload auf Mobilgeraeten oft nicht mehr feuert.
  function leaveArena() {
    if (!subscribedSeed) return;
    if (typeof db === 'undefined' || !db || typeof userId === 'undefined' || !userId) return;
    try {
      deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'voxeria_arena_players',
                    seedToNumber(subscribedSeed) + '_' + userId)).catch(() => {});
    } catch (e) { /* best effort -- der Tab geht ohnehin zu */ }
  }
  window.addEventListener('beforeunload', leaveArena);
  window.addEventListener('pagehide', leaveArena);

  // =========================================================================
  // MODUS-REGISTRIERUNG
  // =========================================================================
  // Der Modus wird in die exportierte MODES-Tabelle von voxeria-menu-worlds.js
  // hineingeschrieben, statt sie dort zu erweitern -- so bleibt alles, was
  // Arena ausmacht, in dieser einen Datei. `studio: true`, weil die Regeln
  // eines Minispiels im Knoten-Editor entstehen: ohne die Creator-Werkzeuge
  // waere der Modus ein Spielfeld ohne Spiel.
  // `roomOnly` unterscheidet Arena von den anderen beiden: der Modus wird beim
  // Erstellen eines Raums gewaehlt, nicht beim Anlegen einer lokalen Welt --
  // er braucht eine Breite, die alle Mitspieler teilen. Der Neue-Welt-Bildschirm
  // liest das Flag und blendet ihn aus, statt eine zweite Modus-Liste zu fuehren.
  if (window.VxWorlds && window.VxWorlds.MODES) {
    window.VxWorlds.MODES.arena = { label: 'Arena', portalBook: false, studio: true, roomOnly: true };
  }

  // Die waehlbaren Breiten. Vielfache von CHUNK_W (32), damit an den Raendern
  // keine halben Chunks entstehen und die Wand genau auf einer Chunk-Grenze
  // sitzt.
  const ARENA_WIDTHS = [
    { label: 'Small',  blocks: 64 },
    { label: 'Medium', blocks: 128 },
    { label: 'Large',  blocks: 256 }
  ];

  // Setzt die Weltbreite. MUSS laufen, BEVOR die Welt erzeugt wird
  // (resetGameAndWorld -> getChunk), sonst generiert der erste Chunk noch mit
  // der alten Breite und die Waende stehen an der falschen Stelle.
  function setWorldWidth(w) {
    const n = parseInt(w, 10);
    arenaWorldWidth = (isFinite(n) && n > 0) ? Math.max(32, Math.min(MAX_W, n)) : 0;
    return arenaWorldWidth;
  }

  return {
    // Zustand, den die Knoten-Aktionen lesen/schreiben
    isActive: active,
    phase: () => phase,
    isHost: () => isHost,
    region: region,
    inRegion: inRegion,
    addScore: addScore,
    getScore: () => myScore,
    // "Fuehre ich?" heisst hier: niemand hat MEHR als ich. Gleichstand zaehlt
    // also fuer beide als Fuehrung -- die Alternative waere, dass bei 0:0 zu
    // Rundenbeginn niemand fuehrt, was jede Regel der Form "solange du fuehrst"
    // im ersten Moment der Runde ins Leere laufen liesse.
    isLeading: () => {
      const board = sortedScores();
      if (!board.length) return true;
      return (board[0].score || 0) <= myScore;
    },
    setTeam: (t) => { myTeam = t | 0; scoreDirty = true; },
    getTeam: () => myTeam,
    // Mannschaftspunkte sind bewusst kein eigener Zaehler: sie sind einfach die
    // Summe der Einzelpunkte aller Mitglieder, dieselben Zahlen, die die Tafel
    // ohnehin schon synchron haelt. Kein zweiter Schreibpfad, also auch keine
    // Moeglichkeit, dass Team- und Einzelsumme je auseinanderlaufen.
    teamScore: (t) => {
      const team = t | 0;
      return sortedScores().reduce((sum, s) => (((s.team | 0) === team) ? sum + (s.score || 0) : sum), 0);
    },
    // "Fuehrt mein Team?" derselbe Gleichstand-zaehlt-als-Fuehrung-Gedanke wie
    // isLeading, nur ueber Mannschaftssummen. Spieler ohne Mannschaft (team 0)
    // bilden dabei ganz normal ihre eigene "Mannschaft 0".
    isTeamLeading: () => {
      const board = sortedScores();
      if (!board.length) return true;
      const totals = {};
      for (const s of board) { const t = s.team | 0; totals[t] = (totals[t] || 0) + (s.score || 0); }
      const mine = totals[myTeam] || 0;
      for (const t in totals) { if (Number(t) !== myTeam && totals[t] > mine) return false; }
      return true;
    },
    // Die Mannschaft eines ANDEREN Spielers, nach seiner UID. Die Mod-Regeln
    // lesen sie ueber den Live-Wert "nearest player team"; die Position kommt
    // aus voxeria_players, die Mannschaft steht aber im Punktedokument, also
    // muss die Zuordnung hier passieren und nicht dort.
    //
    // 0 fuer jeden, der noch kein Punktedokument hat: das ist genau der Wert,
    // auf dem auch myTeam startet, ein Vergleich "gleiche Mannschaft" ist damit
    // vor der Mannschaftswahl fuer alle wahr statt fuer niemanden.
    teamOf: (uid) => { const s = scores[uid]; return s ? (s.team | 0) : 0; },
    playerCount: () => sortedScores().length,
    // Die fertige Rangliste, damit die Mod-Karte "Show the scoreboard" sie
    // anzeigen kann, ohne die Punkte ein zweites Mal zu synchronisieren. Eine
    // Kopie, keine Referenz: eine Regel soll die Tafel lesen koennen, aber
    // nicht in sie hineinschreiben -- Punkte vergibt ausschliesslich addScore.
    board: () => sortedScores().map(s => ({
      uid: s.uid, name: s.name || null, score: s.score | 0, team: s.team | 0
    })),

    // Weltbreite -- gesetzt vom Host beim Erstellen des Raums und von jedem
    // Beitretenden aus dem Raum-Dokument (siehe joinRoomByCode).
    WIDTHS: ARENA_WIDTHS,
    setWorldWidth: setWorldWidth,
    worldWidth: () => (typeof arenaWorldWidth !== 'undefined' ? arenaWorldWidth : 0),

    // UI
    startMatch: startMatch,
    endMatch: endMatch,
    stopMatch: stopMatch,
    togglePanel: togglePanel,
    resetArena: () => resetArena(true),
    hasSnapshot: () => !!snapshot,

    // Lebenszyklus
    subscribe: subscribe,
    unsubscribe: unsubscribe
  };
})();
