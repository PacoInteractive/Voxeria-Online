// ============================================================================
// VOXERIA -- DIMENSIONS & PROGRESSION
// ----------------------------------------------------------------------------
// Everything about the pocket dimensions, and about what the player keeps:
//
//   * POCKET DIMENSIONS     - dimension table, entry/exit, collapse timer, oxygen
//   * POCKET-DIM GENERATION - bounded terrain + the one guaranteed landmark
//   * RUN LIFECYCLE         - starting, surviving and ending a dive (incl. co-op)
//   * PORTAL BOOK UI        - the in-game menu you travel from
//   * DIMENSION FORGES      - the per-realm armor monument
//   * PROGRESS SAVE         - permanent progress + session resume
//
// Loaded after voxeria-engine.js, so every engine helper (BLOCKS, player,
// setBlockAndBroadcast, showNotification, ...) is already available here.
// ============================================================================

// =========================================================
// POCKET DIMENSIONS — bounded, timed, single-landmark instances
// ---------------------------------------------------------
// The original portal dimensions used to be infinite chunk worlds sharing the
// overworld's terrain engine. They are now bounded "pocket runs": each entry
// clears and re-generates the dimension fresh (per-visit nonce), the playable
// area is walled off to ~POCKET_INTERIOR_W blocks, exactly ONE guaranteed
// landmark structure spawns, and a collapse timer counts down. When it hits
// zero a sandstorm "kills" the player: only the loot gathered THIS run is lost,
// the Portal Book's unlock progress is untouched, and the entry portal is
// consumed. Dying by any other hazard inside a pocket does the same thing.
// =========================================================
// Prototype: The Erg is intentionally the only reachable extraction dimension.
// The legacy branches below remain in source for now, but no portal, book entry
// or teleport can reach them. This keeps the prototype reversible.
const POCKET_DIMS = new Set(["ERG"]);

// Bei der Engine anmelden, was sie ueber diese Dimensionen wissen muss. Der
// Startwert ist derselbe, den pocketSeedOffset hat, bevor irgendein Lauf
// begonnen hat: damit ist der Hash-Schluessel schon vor dem ersten Betreten
// exakt derselbe wie frueher, als die Engine POCKET_DIMS selbst abfragte.
function _publishPocketSalt() {
  for (const d of POCKET_DIMS) DIM_SEED_SALT[d] = pocketSeedOffset;
}
for (const d of POCKET_DIMS) EPHEMERAL_DIMS.add(d);
const POCKET_LEFT = 4;                                    // first playable column (bedrock/void wall to its left)
const POCKET_INTERIOR_W = 320;                            // ten whole 32-block chunks; reads as the requested ~300-block run
const POCKET_RIGHT = POCKET_LEFT + POCKET_INTERIOR_W - 1; // last playable column
const POCKET_MAX_CX = Math.floor(POCKET_RIGHT / CHUNK_W); // last chunk index that still contains playable ground
const POCKET_ENTRY_X = Math.floor((POCKET_LEFT + POCKET_RIGHT) / 2); // player lands here (dead center)
const POCKET_LANDMARK_MARGIN = 16;      // landmark never sits flush against a wall
const POCKET_LANDMARK_MIN_DIST = 90;    // landmark is never placed within this many blocks of the player's landing spot
const POCKET_DURATION = 10800;   // 3 minutes at ~60fps (dt units)
const POCKET_DURATION_GOLD = 10800; // 3 minutes — same as the other three
const POCKET_WARN_AT = 600;      // last 10s: timer blinks red
const POCKET_COLLAPSE_LEN = 260; // ~4.3s staged catastrophe (buildup -> climax) before the player is hurled out
let pocketActive = false;        // inside a live pocket run
let pocketTimer = 0;             // counts down from POCKET_DURATION
let pocketSeedOffset = 0;        // per-visit nonce -> a different layout every entry
_publishPocketSalt();
let pocketLandmarkX = 0;         // world-X anchor of this run's single guaranteed structure
// Dimension forge — every pocket dimension now has exactly ONE forge, built
// beside its landmark (see buildPocketLandmark). It crafts the armor for the
// NEXT dimension in the survival chain (see FORGE_OUTPUT): you can only survive
// dimension N+1 by first forging its armor in dimension N. Null whenever not
// inside a live pocket run. Position is purely where the monument stands — it
// marks the realm, it isn't interacted with (see updateDimForge).
let dimForgeX = null, dimForgeY = null;
let pocketEntryInventory = null; // inventory snapshot restored on collapse/death (this-run loot is the delta that gets lost)
let pocketReturn = { x: 0, y: 0 };// overworld position to drop the player back at on exit
let pocketCollapsing = false;    // catastrophe cinematic playing out
let pocketCollapseTimer = 0;     // counts down through the cinematic
let pocketCollapseData = null;   // scratch state for the staged collapse cinematic (per-dimension)
let pocketShockwave = 0;         // 0..1 decaying ring-burst pulse, drawn by drawPocketCollapseOverlay

// =========================================================
// ARENA-WELT — die leere Leinwand des Arena-Modus
// =========================================================
// Der Arena-Modus ist keine normal generierte Welt mit einem markierten
// Ausschnitt, sondern eine eigene Weltart: ein leerer, seitlich begrenzter
// Kasten, den die Spieler von Null auf bebauen. Kein Biom, kein Erz, keine
// Hoehle, kein Dorf -- deshalb steigt getChunk() hier vor der gesamten
// Overworld-Generierung aus.
//
// Begrenzt wird ueber BLOCKINHALT, nicht ueber Index-Pruefungen -- exakt so,
// wie es die Pocket-Dimensionen oben schon machen: ausserhalb der Breite wird
// der Chunk voll Bedrock gefuellt. Der Vorteil gegenueber einer Abfrage in
// getBlock/localSetBlock ist, dass die Wand von sich aus fuer ALLES gilt --
// Kollision, Abbauen, Fluessigkeiten, Kreaturen -- ohne dass eine einzige
// dieser Stellen davon wissen muesste.
//
// Die Breite kommt vom Host und reist im Raum-Dokument mit (siehe createRoom),
// damit jeder Mitspieler dieselben Wandpositionen errechnet. 0 heisst
// "keine Arena-Welt".
let arenaWorldWidth = 0;
// Die Startplattform. Ohne sie faende der Spieler in einer leeren Welt keinen
// Boden und fiele beim Betreten sofort bis auf den Bedrock durch.
// Bewusst aus STONE: isValidSpawnGround() akzeptiert Bedrock NICHT, eine
// Plattform aus Bedrock waere also unbetretbar fuer die Spawn-Suche.
const ARENA_PLATFORM_Y = 72;        // Zeile, auf der die Plattform liegt
const ARENA_PLATFORM_HALF = 5;      // Halbe Breite -> 11 Bloecke insgesamt
const ARENA_DEFAULT_WIDTH = 128;

function arenaCenterX() { return Math.floor(arenaWorldWidth / 2); }

// Fuellt einen Chunk der Arena-Welt. Gleiche Bauform wie generatePocketChunk:
// erst die Grenzfaelle als ganze Bedrock-Flaechen, dann die Innenspalten.
function generateArenaChunk(cx, chunk) {
  const w = arenaWorldWidth > 0 ? arenaWorldWidth : ARENA_DEFAULT_WIDTH;
  const maxCx = Math.floor((w - 1) / CHUNK_W);
  // Ganz ausserhalb: eine massive Wand, kein Spielfeld. Der Chunk wird
  // trotzdem erzeugt und gespeichert -- er ist nur zu 100% Bedrock.
  if (cx < 0 || cx > maxCx) { chunk.fill(BLOCKS.BEDROCK); return; }

  const cxLeft = cx * CHUNK_W;
  const platL = arenaCenterX() - ARENA_PLATFORM_HALF;
  const platR = arenaCenterX() + ARENA_PLATFORM_HALF;

  for (let i = 0; i < CHUNK_W; i++) {
    const wx = cxLeft + i;
    // Randspalten innerhalb eines teilweise gueltigen Chunks: dieselbe Wand,
    // nur spaltenweise. Das ist der Fall, wenn die gewaehlte Breite kein
    // Vielfaches von CHUNK_W ist.
    if (wx < 0 || wx >= w) {
      for (let y = 0; y < WORLD_H; y++) chunk[y * CHUNK_W + i] = BLOCKS.BEDROCK;
      continue;
    }
    for (let y = 0; y < WORLD_H; y++) {
      let b = BLOCKS.AIR;
      if (y === WORLD_H - 1) b = BLOCKS.BEDROCK;                       // Boden
      else if (y === ARENA_PLATFORM_Y && wx >= platL && wx <= platR) b = BLOCKS.STONE;
      chunk[y * CHUNK_W + i] = b;
    }
  }
}

// ── Bau-Vorlagen ─────────────────────────────────────────────────────────
// Ohne das begann jede Arena mit der schmalen, elf Bloecke breiten Start-
// plattform von oben, und alles Weitere -- ein durchgehender Boden, Waende,
// eine Strecke -- war Handarbeit. Fuer einen Modus, dessen eigentlicher Sinn
// das Bauen von REGELN ist, war das die falsche Stelle fuer zehn Minuten
// Bodenverlegung.
//
// Jede Vorlage liefert ihre Bloecke als Liste [x, y, Blocktyp], im selben
// Format wie worldEdits sie ohnehin schon speichert (siehe applySave() in
// voxeria-menu-worlds.js). Kein zweites Speicherformat, kein "lade ein
// statisches Chunk-Array" -- die Vorlage wird beim Erstellen einmal in genau
// die Bearbeitungsliste geschrieben, die ein geladener Speicherstand sowieso
// abspielt.
//
// Als FUNKTION statt als fest verdrahtetes Array: die Feldbreite steht erst
// beim Erstellen fest (der Spieler waehlt sie auf demselben Bildschirm), eine
// Vorlage muss sich also nach der tatsaechlich gewaehlten Breite richten
// statt nur fuer eine einzige Groesse zu passen.
const ARENA_TEMPLATES = {
  empty: {
    label: 'Empty Grid',
    // Durchgehender Glasboden ueber die volle Breite, mit einem Steinblock
    // alle zehn Felder als Lineal -- ein einfarbiger Boden liesse sich sonst
    // nicht auf einen Blick abmessen.
    build(width) {
      const centerX = Math.floor(width / 2);
      const half = Math.max(1, Math.floor(width / 2) - 1);
      const edits = [];
      for (let dx = -half; dx <= half; dx++) {
        edits.push([centerX + dx, ARENA_PLATFORM_Y, (dx % 10 === 0) ? BLOCKS.STONE : BLOCKS.GLASS]);
      }
      return edits;
    }
  },
  dome: {
    label: 'PvP Dome',
    // Ein geschlossener Raum: Boden, zwei Seitenwaende, eine Decke. Bewusst
    // auf 48 Felder gedeckelt, unabhaengig von der gewaehlten Feldbreite --
    // eine 128 Felder breite, voll ummauerte Kuppel waere grossenteils leerer
    // Innenraum, kein PvP-Feld.
    build(width) {
      const centerX = Math.floor(width / 2);
      const half = Math.floor(Math.min(width - 4, 48) / 2);
      const roomH = 18;
      const edits = [];
      for (let dx = -half; dx <= half; dx++) {
        edits.push([centerX + dx, ARENA_PLATFORM_Y, BLOCKS.STONE]); // Boden, voll belegt
        for (let dy = -roomH; dy < 0; dy++) {
          const isWall = dx === -half || dx === half;
          const isCeil = dy === -roomH;
          if (isWall || isCeil) edits.push([centerX + dx, ARENA_PLATFORM_Y + dy, BLOCKS.STONE]);
        }
      }
      return edits;
    }
  },
  race: {
    label: 'Race Track',
    // Ein niedriger Tunnel ueber die VOLLE Breite -- hier darf es lang sein,
    // das ist der ganze Zweck einer Strecke. Boden und Decke, offen an
    // beiden Enden.
    build(width) {
      const centerX = Math.floor(width / 2);
      const half = Math.max(1, Math.floor(width / 2) - 1);
      const tubeH = 4;
      const edits = [];
      for (let dx = -half; dx <= half; dx++) {
        edits.push([centerX + dx, ARENA_PLATFORM_Y, BLOCKS.STONE]);
        edits.push([centerX + dx, ARENA_PLATFORM_Y - tubeH, BLOCKS.STONE]);
      }
      return edits;
    }
  }
};

// =========================================================
// OCEAN DIMENSION OXYGEN — Ocean is the one pocket dimension that does NOT
// run the collapse timer above (see the currentDim === "OCEAN" branches in
// beginPocketRun/updatePocketDimension/endPocketRun): instead of a fixed
// countdown, survival is an ongoing oxygen meter. playerOxygen counts DOWN
// from OXYGEN_MAX, depleting on its own while unprotected. The Pressure
// Diving Suit is deliberately NOT full immunity here (unlike every other
// dimension's hazard, and unlike admin/potion immunity, which still fully
// stop it — see isHazardProtected() usages elsewhere) — equipped, it only
// cuts the drain rate by OXYGEN_ARMOR_MULT, so you survive dramatically
// longer but the meter still eventually empties if you never leave. No
// refill mechanic exists (no Ocean equivalent of a "safe surface tile") —
// the suit's slowdown is the only lever against the clock.
// =========================================================
const OXYGEN_MAX = 100;
const OXYGEN_DEPLETE_RATE = 100 / 1800; // unarmored: empty in ~30s
const OXYGEN_ARMOR_MULT = 0.12;         // Diving Suit equipped: ~88% slower, not zero — empty in ~4-8min instead
let playerOxygen = OXYGEN_MAX;    // OXYGEN_MAX..0
let playerDrowning = false;       // guards the drown-and-die sequence from firing more than once


// =========================================================
// POCKET-DIMENSION GENERATION
// Bounded terrain (walled to [POCKET_LEFT..POCKET_RIGHT]) with a per-visit
// salted seed, plus exactly ONE guaranteed landmark structure per run. Called
// from getChunk for any of the four POCKET_DIMS.
// =========================================================
// Salted seed number — shifts the sine-noise phase so each visit's layout is
// different, while staying stable across all chunks of a single run.
function pocketSN() { return SEED + pocketSeedOffset * 0.6180339887; }
// Per-dim surface/floor lines — shared by the column filler AND the landmark
// placer so a structure always sits exactly on the terrain it's built into.
function goldSurfaceY(wx) { const SN = pocketSN(); return Math.floor(48 + Math.sin(wx*0.09 + SN)*7 + Math.cos(wx*0.05 + SN*1.7)*4); }
function oceanFloorY(wx)  { const SN = pocketSN(); return Math.floor(70 + Math.sin(wx*0.06 + SN)*8 + Math.cos(wx*0.035 + SN*2.1)*5); }
function lavaCeilY(wx)    { const SN = pocketSN(); return Math.floor(16 + Math.sin(wx*0.07 + SN*3)*6 + Math.cos(wx*0.045 + SN)*4); }
function lavaFloorY(wx)   { const SN = pocketSN(); return Math.floor(82 + Math.sin(wx*0.08 + SN*2)*6 + Math.cos(wx*0.05 + SN*4)*4); }
// Wider, gentler wavelength than the other three profiles — rolling dunes
// rather than jagged hills or a cavern ceiling.
function ergDuneY(wx)     { const SN = pocketSN(); return Math.floor(50 + Math.sin(wx*0.035 + SN)*12 + Math.cos(wx*0.017 + SN*1.4)*7); }

function isPocketInteriorX(wx) { return wx >= POCKET_LEFT && wx <= POCKET_RIGHT; }

// Fills `chunk` (a CHUNK_W×WORLD_H Uint8Array) for the current pocket dimension.
// Columns outside the playable band — and any chunk fully outside chunks 0..2 —
// become solid bedrock walls the player can't escape through.
function generatePocketChunk(cx, chunk) {
  // Whole chunk is off to the side of the pocket → solid wall.
  if (cx < 0 || cx > POCKET_MAX_CX) { chunk.fill(BLOCKS.BEDROCK); return; }
  const dim = currentDim;
  for (let i = 0; i < CHUNK_W; i++) {
    const wx = cx * CHUNK_W + i;
    // Edge columns inside a border chunk → wall.
    if (!isPocketInteriorX(wx)) {
      for (let y = 0; y < WORLD_H; y++) chunk[y * CHUNK_W + i] = BLOCKS.BEDROCK;
      continue;
    }
    if (dim === "GOLD") {
      const sy = goldSurfaceY(wx);
      for (let y = 0; y < WORLD_H; y++) {
        const idx = y * CHUNK_W + i;
        if (y === WORLD_H - 1) chunk[idx] = BLOCKS.BEDROCK;
        else if (y >= sy) {
          // Obsidian + Ember Ore veins added alongside the classic Gold Ore/
          // Rainbow Ore terrain — the Vulcan-Schmiede's Lava-armor recipe
          // needs both, and it only exists here in the Gold Dimension.
          const r = seededRandom('g-deep', wx, y);
          chunk[idx] = r < 0.006 ? BLOCKS.RAINBOW_ORE
                     : r < 0.05  ? BLOCKS.EMBER_ORE
                     : r < 0.13  ? BLOCKS.OBSIDIAN
                     : BLOCKS.GOLD_ORE;
        } else chunk[idx] = BLOCKS.AIR;
      }
    } else if (dim === "OCEAN") {
      const floorY = oceanFloorY(wx);
      for (let y = 0; y < WORLD_H; y++) {
        const idx = y * CHUNK_W + i;
        if (y === WORLD_H - 1) chunk[idx] = BLOCKS.BEDROCK;
        else if (y > floorY) {
          const r = seededRandom('o-deep', wx, y);
          chunk[idx] = r < 0.012 ? BLOCKS.EMBER_ORE : BLOCKS.OCEAN_STONE;
        } else if (y === floorY) chunk[idx] = BLOCKS.OCEAN_STONE;
        else chunk[idx] = BLOCKS.DEEP_WATER;
      }
    } else if (dim === "LAVA") {
      const ceilY = lavaCeilY(wx);
      const floorY = lavaFloorY(wx);
      for (let y = 0; y < WORLD_H; y++) {
        const idx = y * CHUNK_W + i;
        if (y === 0 || y === WORLD_H - 1) chunk[idx] = BLOCKS.BEDROCK;
        else if (y < ceilY) chunk[idx] = BLOCKS.MAGMA;
        else if (y > floorY) {
          const r = seededRandom('l-deep', wx, y);
          chunk[idx] = r < 0.015 ? BLOCKS.FIRE_CRYSTAL : (r < 0.04 ? BLOCKS.EMBER_ORE : BLOCKS.MAGMA);
        } else if (y === floorY) chunk[idx] = BLOCKS.MAGMA;
        else if (y > floorY - 3) chunk[idx] = BLOCKS.LAVA;
        else chunk[idx] = BLOCKS.AIR;
      }
    } else if (dim === "VOID") { // empty sky; floating islands are added in decoratePocketChunk
      for (let y = 0; y < WORLD_H; y++) chunk[y * CHUNK_W + i] = BLOCKS.AIR;
    } else { // ERG — rolling dunes: loose sand on top, packed sandstone deeper down
      const duneY = ergDuneY(wx);
      for (let y = 0; y < WORLD_H; y++) {
        const idx = y * CHUNK_W + i;
        if (y === WORLD_H - 1) chunk[idx] = BLOCKS.BEDROCK;
        else if (y >= duneY + 4) chunk[idx] = BLOCKS.ERG_SANDSTONE;
        else if (y >= duneY) chunk[idx] = BLOCKS.ERG_SAND;
        else chunk[idx] = BLOCKS.AIR;
      }
    }
  }
}

// Scatter decorations across a pocket chunk's interior columns, then — if this
// chunk owns the run's landmark anchor — build the single guaranteed structure.
function decoratePocketChunk(cx) {
  if (cx < 0 || cx > POCKET_MAX_CX) return;
  const dim = currentDim;
  const base = cx * CHUNK_W;

  if (dim === "OCEAN") {
    for (let i = 0; i < CHUNK_W; i++) {
      const wx = base + i;
      if (!isPocketInteriorX(wx)) continue;
      const floorY = oceanFloorY(wx);
      const r = seededRandom('coral', wx);
      if (r < 0.18) {
        const coralH = 1 + seededInt(0, 3, 'coral-h', wx);
        for (let dy = 1; dy <= coralH; dy++) localSetBlock(wx, floorY - dy, BLOCKS.CORAL, dim);
      } else if (r < 0.30) {
        localSetBlock(wx, floorY - 1, BLOCKS.KELP, dim);
      }
      if (seededRandom('lantern', wx) < 0.05) localSetBlock(wx, floorY - 1, BLOCKS.SEA_LANTERN, dim);
    }
  } else if (dim === "LAVA") {
    for (let i = 0; i < CHUNK_W; i++) {
      const wx = base + i;
      if (!isPocketInteriorX(wx)) continue;
      if (seededRandom('pillar', wx) < 0.10) {
        const floorY = lavaFloorY(wx);
        const pillarH = 3 + seededInt(0, 8, 'pillar-h', wx);
        for (let dy = 1; dy <= pillarH; dy++) localSetBlock(wx, floorY - dy - 4, BLOCKS.OBSIDIAN, dim);
      }
    }
  } else if (dim === "VOID") {
    const islandCount = 2 + seededInt(0, 2, 'v-isl', cx);
    for (let k = 0; k < islandCount; k++) {
      const iw = 4 + seededInt(0, 8, 'vi-w', cx, k);
      const ix = base + seededInt(2, CHUNK_W - 6, 'vi-x', cx, k);
      if (ix < POCKET_LEFT || ix + iw > POCKET_RIGHT) continue;
      const iy = seededInt(28, 82, 'vi-y', cx, k);
      const ih = 2 + seededInt(0, 2, 'vi-h', cx, k);
      for (let dx = 0; dx < iw; dx++) {
        for (let dy = 0; dy < ih; dy++) {
          const bt = dy === 0 ? BLOCKS.VOID_STONE
                   : (seededRandom('void-ore', cx, k, dx, dy) < 0.08 ? BLOCKS.VOID_ORE : BLOCKS.VOID_STONE);
          localSetBlock(ix + dx, iy + dy, bt, dim);
        }
        if (seededRandom('stardust', cx, k, dx) < 0.35) localSetBlock(ix + dx, iy - 1, BLOCKS.STAR_DUST, dim);
      }
      if (seededRandom('ether', cx, k) < 0.5) {
        const exx = ix + seededInt(1, iw - 2, 'ether-x', cx, k);
        const eh = 2 + seededInt(0, 4, 'ether-h', cx, k);
        for (let dy = 1; dy <= eh; dy++) localSetBlock(exx, iy - dy, BLOCKS.ETHER_CRYSTAL, dim);
      }
    }
  } else if (dim === "ERG") {
    // "Sometimes" a small half-crumbled cactus-wood ruin, separate from the
    // one guaranteed landmark below (see buildPocketLandmark's ERG case).
    if (seededRandom('erg-ruin', cx) < 0.22) {
      const rx = base + seededInt(6, CHUNK_W - 12, 'erg-ruin-x', cx);
      if (isPocketInteriorX(rx) && isPocketInteriorX(rx + 4)) buildErgRuin(rx, cx);
    }
  }

  // The one guaranteed landmark — only the chunk containing its anchor builds it.
  if (Math.floor(pocketLandmarkX / CHUNK_W) === cx) buildPocketLandmark(dim);
}

// A small scattered ruin — five uneven cactus-wood pillars poking out of the
// dune it's half-buried in, so it reads as crumbled rather than a neat box.
function buildErgRuin(rx, seed) {
  const groundY = ergDuneY(rx);
  const heights = [2, 4, 3, 4, 2];
  for (let dx = 0; dx < heights.length; dx++) {
    const h = heights[dx] - seededInt(0, 1, 'erg-ruin-wear', seed, dx);
    for (let dy = 0; dy < h; dy++) localSetBlock(rx + dx, groundY - 1 - dy, BLOCKS.ERG_CACTUS, "ERG");
  }
}

// Stamps a small 3-wide altar (the dimension's forge) at column fx, resting on
// groundY, and records it as this run's single forge (dimForgeX/dimForgeY). The
// core block on top is the visual "brazier" the hologram floats above, showing
// which piece this realm makes. It is a landmark only — the armor itself is
// built by placing the altar pattern anywhere in the dimension (see
// ARMOR_PATTERN). Which armor that is depends purely on the current dimension
// (see FORGE_OUTPUT), not on anything built here.
function _stampDimForge(fx, groundY, dim, baseBlock, coreBlock, glowBlock) {
  localSetBlock(fx-1, groundY,   baseBlock, dim);
  localSetBlock(fx,   groundY,   baseBlock, dim);
  localSetBlock(fx+1, groundY,   baseBlock, dim);
  localSetBlock(fx-1, groundY-1, baseBlock, dim);
  localSetBlock(fx+1, groundY-1, baseBlock, dim);
  localSetBlock(fx,   groundY-1, coreBlock, dim); // the brazier / interact point
  localSetBlock(fx-1, groundY-2, glowBlock, dim);
  localSetBlock(fx+1, groundY-2, glowBlock, dim);
  dimForgeX = fx; dimForgeY = groundY - 1;
}

// Builds this run's single signature structure at pocketLandmarkX plus the
// dimension's ONE forge (see _stampDimForge / the survival chain in
// CRAFTING_RECIPES). Each landmark is guaranteed to be worth the timed risk:
// it always contains the dimension's signature rare plus a Rainbow Ore. Blocks
// may straddle a chunk boundary — localSetBlock routes each into the right chunk.
function buildPocketLandmark(dim) {
  const ax = pocketLandmarkX;
  if (dim === "GOLD") {
    // Floating gold temple (same look as the classic Gold structure).
    const x0 = ax - 5;
    let sy = goldSurfaceY(ax) - 1; // rest it just on top of the golden ground
    for (let dx = -2; dx < 13; dx++) for (let dy = 0; dy < 4; dy++) localSetBlock(x0+dx, sy+dy, BLOCKS.GOLD_BRICK, dim);
    for (let dx = 0; dx <= 10; dx += 5) for (let dy = 1; dy <= 5; dy++) localSetBlock(x0+dx, sy-dy, BLOCKS.YELLOW_LIMESTONE, dim);
    for (let dx = -1; dx < 12; dx++) localSetBlock(x0+dx, sy-6, BLOCKS.GOLD_BRICK, dim);
    for (let dx = 0; dx < 11; dx++) localSetBlock(x0+dx, sy-7, BLOCKS.GOLD_BRICK, dim);
    for (let dx = 2; dx < 9; dx++) localSetBlock(x0+dx, sy-8, BLOCKS.GOLD_BRICK, dim);
    localSetBlock(x0+5, sy-1, BLOCKS.DIAMOND_ORE, dim);
    localSetBlock(x0+5, sy-2, BLOCKS.DIAMOND_DYNAMITE, dim);
    localSetBlock(x0+1, sy-3, BLOCKS.TORCH, dim);
    localSetBlock(x0+9, sy-3, BLOCKS.TORCH, dim);
    localSetBlock(x0+7, sy-8, BLOCKS.RAINBOW_ORE, dim);
    // ── Vulcan-Schmiede — forges the Lava armor from Obsidian & Ember Ore.
    _stampDimForge(ax - 14, goldSurfaceY(ax - 14) - 1, dim, BLOCKS.OBSIDIAN, BLOCKS.FIRE_CRYSTAL, BLOCKS.TORCH);
  } else if (dim === "OCEAN") {
    // Sunken temple on the seafloor.
    const x0 = ax - 3;
    const tY = oceanFloorY(ax);
    for (let dx = -1; dx <= 7; dx++) localSetBlock(x0+dx, tY, BLOCKS.OBSIDIAN, dim);
    for (let dy = 1; dy <= 5; dy++) { localSetBlock(x0, tY-dy, BLOCKS.OBSIDIAN, dim); localSetBlock(x0+6, tY-dy, BLOCKS.OBSIDIAN, dim); }
    for (let dx = -1; dx <= 7; dx++) { if (dx !== 2) localSetBlock(x0+dx, tY-5, BLOCKS.OBSIDIAN, dim); }
    for (let dx = 1; dx <= 5; dx++) for (let dy = 1; dy <= 4; dy++) localSetBlock(x0+dx, tY-dy, BLOCKS.DEEP_WATER, dim);
    localSetBlock(x0-1, tY-6, BLOCKS.CORAL, dim);
    localSetBlock(x0+6, tY-6, BLOCKS.CORAL, dim);
    localSetBlock(x0+1, tY-4, BLOCKS.SEA_LANTERN, dim);
    localSetBlock(x0+5, tY-4, BLOCKS.SEA_LANTERN, dim);
    localSetBlock(x0+2, tY-1, BLOCKS.EMBER_ORE, dim);
    localSetBlock(x0+4, tY-1, BLOCKS.EMBER_ORE, dim);
    localSetBlock(x0+3, tY-1, BLOCKS.DIAMOND_ORE, dim);
    localSetBlock(x0+3, tY-2, BLOCKS.RAINBOW_ORE, dim); // guaranteed jackpot
    // ── Abgrund-Altar — forges the Void armor from Coral & Kelp.
    _stampDimForge(ax - 12, oceanFloorY(ax - 12), dim, BLOCKS.OBSIDIAN, BLOCKS.SEA_LANTERN, BLOCKS.SEA_LANTERN);
  } else if (dim === "LAVA") {
    // Sealed obsidian vault above the lava pool.
    const floorY = lavaFloorY(ax);
    const vW = 7, vH = 5;
    const x0 = ax - 3;
    const vBottom = Math.min(floorY - 5, WORLD_H - 7);
    const vY = vBottom - (vH - 1);
    for (let dx = 1; dx < vW-1; dx++) for (let dy = 1; dy < vH-1; dy++) localSetBlock(x0+dx, vY+dy, BLOCKS.AIR, dim);
    for (let dx = 0; dx < vW; dx++) { localSetBlock(x0+dx, vY, BLOCKS.OBSIDIAN, dim); localSetBlock(x0+dx, vY+vH-1, BLOCKS.OBSIDIAN, dim); }
    for (let dy = 0; dy < vH; dy++) { localSetBlock(x0, vY+dy, BLOCKS.OBSIDIAN, dim); localSetBlock(x0+vW-1, vY+dy, BLOCKS.OBSIDIAN, dim); }
    localSetBlock(x0, vY, BLOCKS.CINDER_BLOCK, dim);
    localSetBlock(x0+vW-1, vY, BLOCKS.CINDER_BLOCK, dim);
    localSetBlock(x0, vY+vH-1, BLOCKS.CINDER_BLOCK, dim);
    localSetBlock(x0+vW-1, vY+vH-1, BLOCKS.CINDER_BLOCK, dim);
    localSetBlock(x0+1, vY+1, BLOCKS.TORCH, dim);
    localSetBlock(x0+vW-2, vY+1, BLOCKS.TORCH, dim);
    localSetBlock(x0+2, vY+vH-2, BLOCKS.FIRE_CRYSTAL, dim);
    localSetBlock(x0+3, vY+vH-2, BLOCKS.FIRE_CRYSTAL, dim);
    localSetBlock(x0+4, vY+vH-2, BLOCKS.EMBER_ORE, dim);
    localSetBlock(x0+3, vY+1, BLOCKS.RAINBOW_ORE, dim); // guaranteed jackpot
    // ── Flut-Altar — forges the Ocean armor from Ember Ore & Fire Crystal.
    // Sits on a small obsidian platform floating a few blocks above the lava.
    _stampDimForge(ax - 12, lavaFloorY(ax - 12) - 4, dim, BLOCKS.OBSIDIAN, BLOCKS.FIRE_CRYSTAL, BLOCKS.TORCH);
  } else if (dim === "ERG") {
    // A larger, mostly-intact desert ruin — cactus-wood walls around a hollow
    // sunken courtyard. No forge here yet: The Erg doesn't produce armor in
    // the survival chain (see FORGE_OUTPUT), so none is stamped.
    const x0 = ax - 5;
    const groundY = ergDuneY(ax);
    for (let dx = 0; dx < 11; dx++) localSetBlock(x0 + dx, groundY - 1, BLOCKS.ERG_CACTUS, dim);
    for (let dy = 1; dy <= 5; dy++) {
      localSetBlock(x0, groundY - 1 - dy, BLOCKS.ERG_CACTUS, dim);
      localSetBlock(x0 + 10, groundY - 1 - dy, BLOCKS.ERG_CACTUS, dim);
    }
    for (let dx = 2; dx < 9; dx++) localSetBlock(x0 + dx, groundY - 6, BLOCKS.ERG_CACTUS, dim);
    for (let dx = 1; dx < 10; dx++) for (let dy = 1; dy <= 4; dy++) localSetBlock(x0 + dx, groundY - 1 - dy, BLOCKS.AIR, dim);
    localSetBlock(x0 + 5, groundY - 2, BLOCKS.TORCH, dim);
  } else { // VOID — a floating star ruin
    const cy = 48;
    const w = 11;
    const x0 = ax - 5;
    for (let dx = 0; dx < w; dx++) localSetBlock(x0+dx, cy, BLOCKS.VOID_STONE, dim);
    for (let dx = 2; dx < w-2; dx++) localSetBlock(x0+dx, cy+1, BLOCKS.VOID_ORE, dim);
    for (let dy = 1; dy <= 4; dy++) { localSetBlock(x0, cy-dy, BLOCKS.VOID_GLASS, dim); localSetBlock(x0+w-1, cy-dy, BLOCKS.VOID_GLASS, dim); }
    for (let dx = 0; dx < w; dx++) localSetBlock(x0+dx, cy-5, BLOCKS.VOID_GLASS, dim);
    for (let dy = 1; dy <= 3; dy++) { localSetBlock(x0+3, cy-dy, BLOCKS.ETHER_CRYSTAL, dim); localSetBlock(x0+w-4, cy-dy, BLOCKS.ETHER_CRYSTAL, dim); }
    localSetBlock(x0+2, cy-1, BLOCKS.STAR_DUST, dim);
    localSetBlock(x0+w-3, cy-1, BLOCKS.STAR_DUST, dim);
    localSetBlock(x0+5, cy-1, BLOCKS.RAINBOW_ORE, dim); // guaranteed jackpot
    localSetBlock(x0+4, cy-1, BLOCKS.VOID_ORE, dim);
    localSetBlock(x0+6, cy-1, BLOCKS.VOID_ORE, dim);
    // ── Ur-Altar — the prestige forge; makes the Golden Aegis from Void Ore &
    // Star Dust. Its own floating void-stone platform left of the star ruin.
    _stampDimForge(ax - 14, cy, dim, BLOCKS.VOID_STONE, BLOCKS.ETHER_CRYSTAL, BLOCKS.VOID_GLASS);
  }
}

// Gold Dimension watchtower, per Blockanordnung.txt: an 11-wide, 9-tall
// tapered obelisk (three separate feet at the base, a single Rainbow Ore
// tip) — built once flanking each side of the return portal on entry.
// 'R' = Rainbow Ore, 'G' = Gold Ore, '.' = leave whatever's already there.
const GOLD_WATCHTOWER_GRID = [
  ['.','.','.','.','.','R','.','.','.','.','.'],
  ['.','.','.','.','G','G','G','.','.','.','.'],
  ['.','.','.','.','G','G','G','.','.','.','.'],
  ['.','.','.','.','G','G','G','.','.','.','.'],
  ['.','.','.','.','G','G','G','.','.','.','.'],
  ['.','.','.','.','G','G','G','.','.','.','.'],
  ['.','.','.','G','G','G','G','G','.','.','.'],
  ['.','G','G','G','G','G','G','G','G','G','.'],
  ['G','.','.','.','.','G','.','.','.','.','G'],
];
function buildGoldWatchtower(ax) {
  const groundY = goldSurfaceY(ax) - 1; // rest its feet just on top of the golden ground
  const x0 = ax - 5; // grid col 5 (the tip / center foot) lands on ax
  const rows = GOLD_WATCHTOWER_GRID.length;
  for (let r = 0; r < rows; r++) {
    const row = GOLD_WATCHTOWER_GRID[r];
    const wy = groundY - (rows - 1 - r);
    for (let c = 0; c < row.length; c++) {
      if (row[c] === '.') continue;
      localSetBlock(x0 + c, wy, row[c] === 'R' ? BLOCKS.RAINBOW_ORE : BLOCKS.GOLD_ORE, "GOLD");
    }
  }
}

// getChunk() ist nach voxeria-worldgen.js gezogen, zusammen mit der
// Hoehenkurve und dem Dichtefeld, die es liest. generatePocketChunk,
// decoratePocketChunk und generateArenaChunk (weiter oben in dieser Datei)
// werden von dort aufgerufen und sind hier geblieben.



function checkPortal(wx, wy) {
  // Check all portal recipes in a 3x3 area around the placed block
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    let cx2 = wx+dx, cy2 = wy+dy;
    const center = getBlock(cx2, cy2);

    // ── The Erg: Grass centre, four Dirt blocks. Deliberately cheap so the
    // prototype can be exercised immediately in a fresh world. ──
    if (center === BLOCKS.GRASS) {
      if (getBlock(cx2-1,cy2) === BLOCKS.DIRT && getBlock(cx2+1,cy2) === BLOCKS.DIRT &&
          getBlock(cx2,cy2-1) === BLOCKS.DIRT && getBlock(cx2,cy2+1) === BLOCKS.DIRT) {
        activatePortal(cx2, cy2, 'ERG', '🏜️ Sandportal geöffnet — der Sturm wartet nicht!');
        return;
      }
    }
  }
}

const PORTAL_BURST_COLORS = { ERG:'#e8c468', OVERWORLD:'#8fe08f' };
function activatePortal(cx2, cy2, targetDim, msg) {
  // targetDim rides along with each block broadcast, so portalDestinations
  // ends up populated for every player, not just the one who built it.
  setBlockAndBroadcast(cx2, cy2, BLOCKS.PORTAL, targetDim);
  setBlockAndBroadcast(cx2-1, cy2, BLOCKS.PORTAL, targetDim);
  setBlockAndBroadcast(cx2+1, cy2, BLOCKS.PORTAL, targetDim);
  setBlockAndBroadcast(cx2, cy2-1, BLOCKS.PORTAL, targetDim);
  setBlockAndBroadcast(cx2, cy2+1, BLOCKS.PORTAL, targetDim);
  spawnPortalOpenBurst(cx2*TILE+TILE/2, cy2*TILE+TILE/2, PORTAL_BURST_COLORS[targetDim] || '#c99bff', false);
  showNotification(msg); screenShake = 15;
}


// =========================================================
// POCKET-DIMENSION RUN LIFECYCLE
// =========================================================
let pocketMeteor = null;         // the single giant meteor during a GOLD collapse
let pocketShowerMeteors = [];    // smaller meteors during the GOLD collapse's buildup phase

// Picks the landmark's anchor X for this run. Always at least
// POCKET_LANDMARK_MIN_DIST blocks from POCKET_ENTRY_X (where the player lands),
// so the structure is never a trivial few steps from the portal — the player
// has to actually explore the bounded pocket to find it.
function pickPocketLandmarkX() {
  const lo = POCKET_LEFT + POCKET_LANDMARK_MARGIN;
  const hi = POCKET_RIGHT - POCKET_LANDMARK_MARGIN;
  const leftRange = [lo, POCKET_ENTRY_X - POCKET_LANDMARK_MIN_DIST];
  const rightRange = [POCKET_ENTRY_X + POCKET_LANDMARK_MIN_DIST, hi];
  const ranges = [leftRange, rightRange].filter(r => r[1] >= r[0]);
  if (!ranges.length) return seededInt(lo, hi, 'pk-landmark'); // pocket too small for the margin — fall back to full range
  const chosen = ranges.length === 2 ? (seededRandom('pk-side') < 0.5 ? ranges[0] : ranges[1]) : ranges[0];
  return seededInt(chosen[0], chosen[1], 'pk-landmark');
}

// =========================================================
// SHARED POCKET RUNS — co-op dimension dives
// =========================================================
// A pocket run used to be strictly per-player: your own random layout, your
// own countdown, even if a friend followed you through the same portal one
// second later. One document per (world, dimension) turns it into a run you
// share — same layout, same clock, same collapse. Whoever enters first opens
// it; anyone arriving inside POCKET_JOIN_WINDOW drops into that run instead of
// generating a private one. After the window closes the next player starts a
// fresh run, so a stale document can never strand someone in a dead dive.
const POCKET_JOIN_WINDOW = 15000;
let _pocketRuns = {};     // dim -> run document for the current world
let _pocketUnsub = null;
let _sharedRun = null;    // the run WE are currently in, if it's a shared one

function pocketRunRef(dim) {
  return doc(db, 'artifacts', appId, 'public', 'data', 'voxeria_pockets', SEED + '_' + dim);
}

function subscribePocketRuns() {
  if (!db || !isMultiplayerActive) return;
  if (_pocketUnsub) { _pocketUnsub(); _pocketUnsub = null; }
  _pocketRuns = {};
  const q = query(collection(db, 'artifacts', appId, 'public', 'data', 'voxeria_pockets'), where('seed', '==', rawSeedString));
  _pocketUnsub = onSnapshot(q, (snap) => {
    snap.docChanges().forEach((ch) => {
      const d = ch.doc.data();
      if (!d || !d.dim) return;
      if (ch.type === 'removed') { delete _pocketRuns[d.dim]; return; }
      _pocketRuns[d.dim] = d;
      // Someone in our run triggered the catastrophe — everyone goes down
      // together, rather than each client waiting for its own timer.
      if (pocketActive && !pocketCollapsing && _sharedRun && d.dim === currentDim
          && d.startTs === _sharedRun.startTs && d.collapseTs) {
        startPocketCollapse(true);
      }
    });
  }, (e) => console.error('Pocket run sync error:', e));
}

// Starts a timed run the moment the player enters a pocket dimension.
function beginPocketRun(preX, preY) {
  pocketReturn = { x: preX, y: preY };
  // Snapshot the inventory so a collapse/death can roll back to it (the delta —
  // everything gathered this run — is what gets lost).
  pocketEntryInventory = inventory.map(it => it ? { block: it.block, count: it.count } : null);

  const now = Date.now();
  const open = _pocketRuns[currentDim];
  const canJoin = open && !open.collapseTs && (now - open.startTs) < POCKET_JOIN_WINDOW;
  if (canJoin) {
    _sharedRun = open;
    pocketSeedOffset = open.offset;
    _publishPocketSalt();
    showNotification('👥 Joined a run already in progress');
  } else {
    pocketSeedOffset = (Math.random() * 1e9) | 0; // fresh layout every entry
    _publishPocketSalt();
    _sharedRun = null;
    if (isMultiplayerActive && mpVisible && db && userId) {
      _sharedRun = { seed: rawSeedString, dim: currentDim, offset: pocketSeedOffset, startTs: now,
                     dur: currentDim === 'GOLD' ? POCKET_DURATION_GOLD : POCKET_DURATION,
                     host: userId, collapseTs: null };
      setDoc(pocketRunRef(currentDim), _sharedRun).catch(e => console.error('Pocket run create error:', e));
    }
  }
  dimensions[currentDim].clear();               // wipe the previous visit's blocks
  exploredCells[currentDim].clear();             // fresh minimap fog too — the layout is new
  _minimapLastCell = null;
  pocketLandmarkX = pickPocketLandmarkX();
  // Reset — buildPocketLandmark() re-stamps this run's single forge for the
  // dimension being entered (see _stampDimForge).
  dimForgeX = null; dimForgeY = null;
  pocketActive = true;
  pocketCollapsing = false;
  pocketCollapseTimer = 0;
  pocketMeteor = null;
  pocketShowerMeteors = [];
  pocketCollapseData = null;
  pocketShockwave = 0;
  playerOxygen = OXYGEN_MAX; playerDrowning = false;
  player.x = POCKET_ENTRY_X * TILE; // land in the middle of the bounded pocket
  if (currentDim === "GOLD") spawnGoldSlimes(); else goldSlimes.length = 0;
  if (currentDim === "OCEAN") {
    // No collapse timer here — survival is the oxygen meter instead (see the
    // OXYGEN_* block above and the currentDim === "OCEAN" branch in
    // updatePocketDimension).
    pocketTimer = 0;
    hidePocketTimer();
    showOceanOxygenBar();
    updateOceanOxygenBarUI();
  } else {
    // A joined run inherits the time already elapsed, so latecomers get the
    // remainder rather than a full fresh countdown of their own.
    pocketTimer = _sharedRun
      ? Math.max(1, _sharedRun.dur - (Date.now() - _sharedRun.startTs) * 0.06)
      : (currentDim === "GOLD" ? POCKET_DURATION_GOLD : POCKET_DURATION);
    hideOceanOxygenBar();
    showPocketTimer();
    updatePocketTimerHud();
  }
}

// Ends a run — killed=true when the timer collapse or a hazard death took it
// (this-run loot is forfeited), killed=false on a clean walk-out through the
// return portal (loot kept). Either way the pocket is wiped, the entry portal
// is consumed, and the player returns to the overworld.
function endPocketRun(killed) {
  if (!pocketActive) return; // guard against the collapse + a hazard death both firing
  const dim = currentDim;
  // Only the player who opened the run clears it, and only once it's really
  // over — otherwise a friend still inside would have their run yanked out
  // from under them the moment the first person walked out.
  if (_sharedRun && _sharedRun.host === userId && db) {
    deleteDoc(pocketRunRef(dim)).catch(() => {});
  }
  _sharedRun = null;
  pocketActive = false;
  pocketCollapsing = false;
  pocketCollapseTimer = 0;
  pocketMeteor = null;
  pocketShowerMeteors = [];
  pocketCollapseData = null;
  pocketShockwave = 0;
  goldSlimes.length = 0;
  hidePocketTimer();
  hideOceanOxygenBar();
  playerOxygen = OXYGEN_MAX; playerDrowning = false;
  currentDim = "OVERWORLD";
  voidGravityScale = 1.0;
  lavaDamageTimer = 0;
  dimensions[dim].clear(); // never keep a stale pocket around
  if (killed && pocketEntryInventory) {
    inventory = normalizeInventory(pocketEntryInventory);
    if (typeof drawHotbar === 'function') drawHotbar();
    player.health = maxHealth;
    if (typeof drawHealth === 'function') drawHealth();
  }
  pocketEntryInventory = null;
  // Drop the player back where they entered, and consume the one-use entry portal.
  player.x = pocketReturn.x; player.y = pocketReturn.y;
  player.vx = 0; player.vy = 0;
  removePortalCluster(Math.floor(pocketReturn.x / TILE), Math.floor((pocketReturn.y / TILE) + 1));
  camX = player.x - (COLS >> 1) * TILE; camY = player.y - (ROWS >> 1) * TILE;
  drawCamX = camX; drawCamY = camY;
  blockDamage = {}; blockHitFlashes.length = 0;
  particles.length = 0; floatingTexts.length = 0; burningBlocks.length = 0; activeDynamites.length = 0;
  if (!killed) {
    showNotification("🌍 Back in the normal world!");
    // Only the voluntary, successful exit gets the triumphant burst — dying or
    // the dimension collapsing under you is not a moment to celebrate.
    if (window.VxJuice) VxJuice.dimensionShift(player.x, player.y, "OVERWORLD");
    else screenShake = 20;
  }
  else if (dim === "OCEAN") showNotification("💀 You drowned! Hurled back to the surface.");
  else showNotification("💀 The dimension collapsed! Hurled back to the surface.");
  // Leaving a pocket run returns through here instead of doTeleport's main
  // path, so the event has to be fired here too — otherwise "when entering
  // OVERWORLD" would work coming out of a portal but not out of a pocket run.
  fireGraphEvent('onEnterDim', { dim: 'OVERWORLD' });
}

// Removes the overworld PORTAL blocks the player built to enter, so a pocket
// portal is single-use ("das Portal verschwindet wieder").
function removePortalCluster(tx, ty) {
  for (let dx = -2; dx <= 2; dx++) for (let dy = -4; dy <= 3; dy++) {
    const x = tx + dx, y = ty + dy;
    if (getBlock(x, y) === BLOCKS.PORTAL) {
      setBlockAndBroadcast(x, y, BLOCKS.AIR);
      delete portalDestinations[`${x},${y}`];
    }
  }
}

function showPocketTimer() {
  const b = document.getElementById('pocket-timer');
  if (!b) return;
  const lbl = document.getElementById('pt-label'); if (lbl) lbl.textContent = 'Sandsturm in';
  b.classList.add('show'); b.classList.remove('danger');
}
function hidePocketTimer() {
  const b = document.getElementById('pocket-timer');
  if (b) b.classList.remove('show', 'danger');
}
function updatePocketTimerHud() {
  const el = document.getElementById('pt-time');
  if (!el) return;
  const secs = Math.max(0, Math.ceil(pocketTimer / 60)); // dt units ≈ frames @60fps
  const m = Math.floor(secs / 60), s = secs % 60;
  el.textContent = m + ':' + String(s).padStart(2, '0');
  const box = document.getElementById('pocket-timer');
  if (box) box.classList.toggle('danger', pocketTimer <= POCKET_WARN_AT);
}

// The last 40 seconds are not a second damage system. They are a readable
// approach phase for the same hard run deadline: dust increases, but the
// player still has a fair chance to navigate back to the portal.
function drawErgStormWarning() {
  if (!pocketActive || pocketCollapsing || currentDim !== 'ERG' || pocketTimer > 2400) return;
  const t = 1 - Math.max(0, pocketTimer) / 2400;
  const W = canvas.width, H = canvas.height;
  ctx.save();
  ctx.fillStyle = `rgba(151,91,30,${0.05 + t * 0.18})`;
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 0.12 + t * 0.2;
  const drift = (frameCount * (1.5 + t * 2.5)) % 26;
  for (let y = 12; y < H; y += 26) {
    ctx.fillStyle = (Math.floor(y / 26) % 2) ? '#dca954' : '#8e5525';
    ctx.fillRect(Math.floor(-drift), y, 18 + t * 22, 2);
    ctx.fillRect(Math.floor(W * 0.48 - drift), y + 9, 24 + t * 26, 2);
  }
  ctx.restore();
}

// Ocean's oxygen meter — same top-center HUD slot as the collapse timer
// (mutually exclusive, since only one dimension is ever active). Fill reads
// as "air remaining", so unlike a countdown it starts full and drains, and
// "danger" triggers on LOW instead of high.
function showOceanOxygenBar() {
  const b = document.getElementById('ocean-oxygen-bar');
  if (b) { b.classList.add('show'); b.classList.remove('danger'); }
}
function hideOceanOxygenBar() {
  const b = document.getElementById('ocean-oxygen-bar');
  if (b) b.classList.remove('show', 'danger');
}
function updateOceanOxygenBarUI() {
  const fill = document.getElementById('ocean-oxygen-fill');
  if (!fill) return;
  const pct = Math.round((playerOxygen / OXYGEN_MAX) * 100);
  fill.style.width = pct + '%';
  const label = document.getElementById('ocean-oxygen-pct');
  if (label) label.textContent = pct + '%';
  const box = document.getElementById('ocean-oxygen-bar');
  if (box) box.classList.toggle('danger', playerOxygen <= OXYGEN_MAX * 0.2);
}

// Frame tick for a live run — counts the timer down, then plays out the
// dimension-specific collapse before ejecting the player. Ocean has no timer
// or collapse at all — it runs the oxygen meter instead (see updateOceanOxygen).
function updatePocketDimension(dt) {
  if (!pocketActive) return;
  if (pocketCollapsing) {
    runPocketCollapse(dt);
    pocketCollapseTimer -= dt;
    if (pocketCollapseTimer <= 0) endPocketRun(true);
    return;
  }
  if (currentDim === "OCEAN") { updateOceanOxygen(dt); return; }
  // In a shared run the countdown is derived from the run's own start time
  // rather than accumulated per frame — two clients ticking their own dt would
  // otherwise drift apart and collapse seconds away from each other.
  if (_sharedRun) pocketTimer = Math.max(0, _sharedRun.dur - (Date.now() - _sharedRun.startTs) * 0.06);
  else pocketTimer -= dt;
  if (pocketTimer <= 0) { pocketTimer = 0; startPocketCollapse(); }
  updatePocketTimerHud();
}

// Ocean's survival mechanic: an ever-present oxygen meter that only ever
// drains, instead of a fixed countdown. Ambient — there's no "touching a
// specific block" trigger, since virtually the whole dimension is water. The
// Pressure Diving Suit only throttles the drain (see the fullyImmune split
// below), not full immunity; admin/potion immunity still stop it outright.
// No refill mechanic exists — the suit's slowdown is the only lever.
function updateOceanOxygen(dt) {
  // Admin immunity and an active hazard-immunity potion are absolute (same
  // as every other dimension hazard) — but the Diving Suit on its own only
  // throttles the drain, it doesn't stop it. That's why this doesn't just
  // call isHazardProtected(): that helper bundles all three sources into one
  // true/false, which would make the suit fully immune here too.
  const fullyImmune = hasHazardImmunity || hazardPotionTimer > 0;
  if (!fullyImmune) {
    let rate = OXYGEN_DEPLETE_RATE;
    if (equippedArmor.has('OCEAN')) rate *= OXYGEN_ARMOR_MULT;
    playerOxygen = Math.max(0, playerOxygen - rate * dt);
  }
  updateOceanOxygenBarUI();

  if (playerOxygen <= 0 && !playerDrowning) {
    playerDrowning = true;
    addJuiceText(player.x + player.w / 2, player.y, '💧 Drowning!', '#3fa9ff');
    screenShake = Math.max(screenShake, 14);
    showNotification('💧 You ran out of air!');
    setTimeout(() => { handlePlayerDeath(); }, 500);
  }
}

// Kicks off the catastrophe — a different signature event per dimension. The
// cinematic runs in two stages (tracked in pocketCollapseData): a buildup —
// warning particles, an escalating rumble — then a climax (the meteor lands /
// the wave crests / the singularity finishes swallowing the world).
// runPocketCollapse animates it frame-to-frame; drawPocketCollapseOverlay
// paints the full-screen wave/flood/singularity on top of everything else.
// fromRemote=true when this is us reacting to a collapse another player in the
// same shared run already triggered — it must not be written back, or the two
// clients would keep re-announcing the same catastrophe to each other.
function startPocketCollapse(fromRemote) {
  if (pocketCollapsing) return;
  pocketCollapsing = true;
  pocketCollapseTimer = POCKET_COLLAPSE_LEN;
  if (!fromRemote && _sharedRun && db && userId) {
    _sharedRun = Object.assign({}, _sharedRun, { collapseTs: Date.now() });
    setDoc(pocketRunRef(currentDim), _sharedRun).catch(() => {});
  }
  pocketCollapseData = { showerTimer: 0, crumbleTimer: 0, impacted: false };
  pocketShockwave = 0;
  const box = document.getElementById('pocket-timer');
  if (box) { const lbl = document.getElementById('pt-label'); if (lbl) lbl.textContent = 'Collapsing!'; const t = document.getElementById('pt-time'); if (t) t.textContent = '0:00'; box.classList.add('danger'); }
  screenShake = Math.max(screenShake, 22);
  const cx0 = player.x + player.w / 2, cy0 = player.y + player.h / 2;
  if (currentDim === 'ERG') {
    playSound('hiss');
    impactFlash = Math.max(impactFlash, 0.35); impactFlashColor = '235,190,105';
    addJuiceText(cx0, player.y - 20, '🌪️ SANDSTURM!', '#f3cf76');
  } else if (currentDim === 'GOLD') {
    playSound('meteor');
    impactFlash = Math.max(impactFlash, 0.5); impactFlashColor = '255,200,90';
    pocketMeteor = null; pocketShowerMeteors = [];
    addJuiceText(cx0, player.y - 20, '☄️ GOLDEN METEOR!', '#ffd700');
  } else if (currentDim === 'OCEAN') {
    playSound('explode');
    impactFlash = Math.max(impactFlash, 0.4); impactFlashColor = '80,160,255';
    addJuiceText(cx0, player.y - 20, '🌊 TSUNAMI!', '#4fc3f7');
  } else if (currentDim === 'LAVA') {
    playSound('explode');
    impactFlash = Math.max(impactFlash, 0.45); impactFlashColor = '255,90,20';
    addJuiceText(cx0, player.y - 20, '🌋 LAVA FLOOD!', '#ff4400');
  } else { // VOID
    playSound('explode');
    impactFlash = Math.max(impactFlash, 0.5); impactFlashColor = '150,60,255';
    addJuiceText(cx0, player.y - 20, '🕳️ BLACK HOLE!', '#b388ff');
  }
  showNotification('💥 The dimension collapses around you!');
}

// Per-frame catastrophe visuals while pocketCollapseTimer drains. progress
// goes 0 -> 1 across the whole cinematic, driving every effect's intensity.
function runPocketCollapse(dt) {
  const d = pocketCollapseData || (pocketCollapseData = { showerTimer: 0, crumbleTimer: 0, impacted: false });
  const progress = 1 - pocketCollapseTimer / POCKET_COLLAPSE_LEN;
  screenShake = Math.max(screenShake, 8 + progress * 30);
  const cx0 = player.x + player.w / 2, cy0 = player.y + player.h / 2;

  // Shared "world falling apart underfoot" effect — ground near the player
  // crumbles to nothing as the pocket destabilizes, escalating with progress.
  // Purely cosmetic (the whole dimension is wiped on exit either way).
  d.crumbleTimer -= dt;
  if (d.crumbleTimer <= 0) {
    d.crumbleTimer = Math.max(3, 11 - progress * 8);
    const n = 1 + Math.floor(progress * 4);
    const px = Math.floor(player.x / TILE), py = Math.floor(player.y / TILE);
    for (let i = 0; i < n; i++) {
      const bx = px + Math.floor((Math.random() - 0.5) * 22);
      const by = py + Math.floor((Math.random() - 0.5) * 14);
      const b = getBlock(bx, by);
      if (b === BLOCKS.AIR || b === BLOCKS.BEDROCK) continue;
      spawnBreakParticles(bx, by, b);
      setBlock(bx, by, BLOCKS.AIR);
    }
  }

  if (currentDim === 'ERG') {
    // A bounded, visual-only wall of sand. The run itself is still resolved by
    // the shared timer, so this never has to simulate an expensive sand fill.
    const n = 4 + Math.floor(progress * 15);
    for (let k = 0; k < n; k++) {
      particles.push({
        x: camX + Math.random() * COLS * TILE,
        y: camY + Math.random() * ROWS * TILE,
        vx: -5 - progress * 8, vy: (Math.random() - 0.5) * 1.6,
        color: Math.random() < 0.55 ? '#e5bd65' : '#a96728',
        size: 2 + Math.random() * 4, life: 12 + Math.random() * 14, maxLife: 26, type: 'dust'
      });
    }
  } else if (currentDim === 'GOLD') {
    if (progress < 0.55) {
      // Buildup — a meteor shower streaks across the sky (cosmetic only; the
      // crumble effect above already handles terrain destruction).
      d.showerTimer -= dt;
      if (d.showerTimer <= 0) {
        d.showerTimer = 5 + Math.random() * 6;
        pocketShowerMeteors.push({ x: camX + Math.random() * COLS * TILE, y: camY - 40, vx: (Math.random() - 0.5) * 2, vy: 5 + Math.random() * 3 });
      }
      for (let i = pocketShowerMeteors.length - 1; i >= 0; i--) {
        const m = pocketShowerMeteors[i];
        m.x += m.vx * dt; m.y += m.vy * dt;
        if (Math.random() < 0.7) particles.push({ x: m.x, y: m.y, vx: -m.vx * 0.3, vy: -1, color: Math.random() < 0.5 ? '#ffd54a' : '#ff8800', size: 2 + Math.random() * 3, life: 12 + Math.random() * 8, maxLife: 20, type: 'spark' });
        if (m.y > camY + ROWS * TILE + 60) pocketShowerMeteors.splice(i, 1);
      }
    } else if (!pocketMeteor && !d.impacted) {
      // Climax — one giant golden meteor, falling straight at the player.
      pocketMeteor = { x: cx0, y: camY - 260, vy: 11, size: 46 };
    }
    if (pocketMeteor) {
      pocketMeteor.y += pocketMeteor.vy * dt;
      pocketMeteor.vy += 0.15 * dt; // accelerates in on final approach
      for (let k = 0; k < 6; k++) particles.push({ x: pocketMeteor.x + (Math.random() - 0.5) * pocketMeteor.size, y: pocketMeteor.y - pocketMeteor.size + (Math.random() - 0.5) * pocketMeteor.size, vx: (Math.random() - 0.5) * 3, vy: -Math.random() * 3, color: Math.random() < 0.5 ? '#ffd54a' : '#ff8800', size: 4 + Math.random() * 7, life: 16 + Math.random() * 10, maxLife: 26, type: 'spark' });
      if (pocketMeteor.y >= cy0) {
        d.impacted = true;
        pocketShockwave = 1;
        impactFlash = Math.max(impactFlash, 1); impactFlashColor = '255,225,140';
        screenShake = Math.max(screenShake, 60);
        playSound('meteor');
        for (let k = 0; k < 80; k++) particles.push({ x: pocketMeteor.x, y: pocketMeteor.y, vx: (Math.random() - 0.5) * 20, vy: -Math.random() * 16, color: Math.random() < 0.5 ? '#ffd700' : '#ff7722', size: 3 + Math.random() * 7, life: 22 + Math.random() * 22, maxLife: 44 });
        pocketMeteor = null;
        pocketShowerMeteors.length = 0;
      }
    }
  } else if (currentDim === 'OCEAN') {
    const n = 3 + Math.floor(progress * 10);
    for (let k = 0; k < n; k++) particles.push({ x: camX + Math.random() * COLS * TILE, y: camY + (1 - progress) * ROWS * TILE - Math.random() * 40, vx: (Math.random() - 0.5) * 5, vy: -3 - Math.random() * 4 - progress * 4, color: Math.random() < 0.5 ? '#4fc3f7' : '#bfe9ff', size: 3 + Math.random() * 6, life: 24 + Math.random() * 16, maxLife: 40 });
    if (progress > 0.3 && Math.random() < 0.15 * dt) playSound('hiss');
  } else if (currentDim === 'LAVA') {
    const n = 3 + Math.floor(progress * 10);
    for (let k = 0; k < n; k++) particles.push({ x: camX + Math.random() * COLS * TILE, y: camY + (1 - progress) * ROWS * TILE - Math.random() * 40, vx: (Math.random() - 0.5) * 4, vy: -2 - Math.random() * 4 - progress * 3, color: Math.random() < 0.5 ? '#ff4400' : '#ffcc55', size: 3 + Math.random() * 6, life: 24 + Math.random() * 16, maxLife: 40 });
    if (progress > 0.3 && Math.random() < 0.1 * dt) { screenShake = Math.max(screenShake, 20); playSound('explode'); }
  } else { // VOID — an expanding singularity pulls everything toward the player
    const n = 4 + Math.floor(progress * 10);
    for (let k = 0; k < n; k++) {
      const ang = Math.random() * Math.PI * 2, rad = 100 + Math.random() * (260 - progress * 160);
      const px = cx0 + Math.cos(ang) * rad, py = cy0 + Math.sin(ang) * rad;
      particles.push({ x: px, y: py, vx: (cx0 - px) * 0.06, vy: (cy0 - py) * 0.06, color: Math.random() < 0.5 ? '#b388ff' : '#7733cc', size: 2 + Math.random() * 4, life: 18 + Math.random() * 10, maxLife: 28, type: 'spark' });
    }
  }

  if (pocketShockwave > 0) pocketShockwave = Math.max(0, pocketShockwave - 0.05 * dt);
}

// Full-screen catastrophe painted on top of everything else — a rising tidal
// wave (OCEAN), a rising flood of lava (LAVA), a growing singularity (VOID),
// or a tensing golden vignette + impact shockwave ring (GOLD, whose meteor
// and particle burst already dominate the screen on their own).
function drawPocketCollapseOverlay() {
  if (!pocketCollapsing) return;
  const progress = 1 - pocketCollapseTimer / POCKET_COLLAPSE_LEN;
  const W = canvas.width, H = canvas.height;

  if (currentDim === 'ERG') {
    // Pixel-dust veil with diagonal streaks; no blur so it remains legible at
    // the game's low-resolution look even on a large display.
    ctx.save();
    ctx.fillStyle = `rgba(133,76,25,${0.14 + progress * 0.42})`;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 0.24 + progress * 0.42;
    const step = 20;
    const drift = (frameCount * (2 + progress * 3)) % step;
    for (let y = -step; y < H + step; y += step) {
      for (let x = -step; x < W + step; x += step * 2) {
        ctx.fillStyle = ((x + y) / step) % 2 ? '#f4d581' : '#b87931';
        ctx.fillRect(Math.floor(x - drift), Math.floor(y + (x % 13)), 12, 2);
      }
    }
    ctx.restore();
  } else if (currentDim === 'GOLD') {
    ctx.save();
    ctx.fillStyle = `rgba(255,190,60,${Math.min(0.35, progress * 0.4)})`;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  } else if (currentDim === 'OCEAN' || currentDim === 'LAVA') {
    const wallY = H * (1 - Math.min(1, progress * 1.15));
    ctx.save();
    const grad = ctx.createLinearGradient(0, wallY, 0, H);
    if (currentDim === 'OCEAN') { grad.addColorStop(0, 'rgba(120,210,255,0.9)'); grad.addColorStop(0.15, 'rgba(30,110,200,0.88)'); grad.addColorStop(1, 'rgba(5,30,70,0.92)'); }
    else { grad.addColorStop(0, 'rgba(255,220,120,0.9)'); grad.addColorStop(0.15, 'rgba(255,90,20,0.88)'); grad.addColorStop(1, 'rgba(90,10,0,0.94)'); }
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(0, wallY);
    const crestAmp = 10 + progress * 14;
    for (let x = 0; x <= W; x += 24) ctx.lineTo(x, wallY + Math.sin(x * 0.03 + frameCount * 0.15) * crestAmp);
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
    ctx.fill();
    ctx.restore();
  } else { // VOID
    const cx0 = W / 2, cy0 = H / 2;
    const maxR = Math.hypot(W, H) * 0.62;
    const r = Math.max(6, progress * progress * maxR); // accelerating growth reads as a real singularity
    ctx.save();
    const grad = ctx.createRadialGradient(cx0, cy0, Math.max(0, r * 0.7), cx0, cy0, r);
    grad.addColorStop(0, 'rgba(4,0,10,0.97)');
    grad.addColorStop(0.85, 'rgba(20,0,35,0.9)');
    grad.addColorStop(1, 'rgba(179,136,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(cx0, cy0, r, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 3 + progress * 4;
    ctx.strokeStyle = `rgba(179,136,255,${0.5 + Math.sin(frameCount * 0.3) * 0.2})`;
    ctx.beginPath(); ctx.arc(cx0, cy0, r, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  // GOLD's impact shockwave ring, punching outward from screen center.
  if (pocketShockwave > 0) {
    const cx0 = W / 2, cy0 = H / 2;
    const ringR = (1 - pocketShockwave) * Math.hypot(W, H) * 0.7;
    ctx.save();
    ctx.strokeStyle = `rgba(255,215,90,${pocketShockwave * 0.8})`;
    ctx.lineWidth = 10 * pocketShockwave + 2;
    ctx.beginPath(); ctx.arc(cx0, cy0, ringR, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
}

function doTeleport() {
  if (pocketCollapsing) return; // no fleeing once the collapse has begun
  teleportCooldown = 150;
  blockDamage = {}; // in-progress mining cracks don't carry over between dimensions
  blockHitFlashes.length = 0;
  // Teleport flash
  damageFlashTimer = 0; healFlashTimer = 18;
  const pTileX = Math.floor(player.x / TILE + 0.5);
  const pTileY = Math.floor(player.y / TILE + 1.0);
  const preX = player.x, preY = player.y; // overworld spot, restored when a pocket run ends

  // Determine destination from portal map, or toggle overworld/gold as fallback
  const key = `${pTileX},${pTileY}`;
  let targetDim = portalDestinations[key];
  if (!targetDim) {
    // Check surrounding tiles
    for (let dx = -1; dx <= 1 && !targetDim; dx++) for (let dy = -1; dy <= 1 && !targetDim; dy++) {
      targetDim = portalDestinations[`${pTileX+dx},${pTileY+dy}`];
    }
  }
  if (!targetDim) targetDim = currentDim === "OVERWORLD" ? "ERG" : "OVERWORLD";

  const prevDim = currentDim;

  // Leaving a pocket dimension through its return portal — a successful run:
  // loot is kept (only collapse/death takes it), the entry portal is consumed,
  // and the player is set back exactly where they left the overworld.
  if (POCKET_DIMS.has(prevDim)) {
    playSound('portal'); // shake + burst for this exit live in endPocketRun, after its own particle clear
    endPocketRun(false);
    return;
  }

  if (currentDim !== "OVERWORLD") {
    currentDim = "OVERWORLD";
    showNotification("🌍 Back in the normal world!");
  } else if (targetDim === "OVERWORLD") {
    // No longer buildable (the tutorial that created these was removed), but
    // an old save or a shared/synced world can still have one standing from
    // before — keep it a harmless no-op instead of leaving it to fall through
    // to the dimension-entry branch below with an undefined dimension name.
    showNotification("🌀 Just a practice portal. It doesn't lead anywhere.");
  } else {
    currentDim = targetDim;
    const dimNames = { ERG: "🏜️ The Erg — Wüstendimension!" };
    showNotification("✨ Welcome to the " + (dimNames[targetDim] || targetDim));
  }

  // Entering a dimension uncovers the next one in the Portal Book's discovery chain.
  if (currentDim !== "OVERWORLD") markDimVisited(currentDim);

  // Starting a fresh, timed pocket run — regenerates the world and lands the
  // player in the middle of the bounded area (must run before the spawn scan).
  if (POCKET_DIMS.has(currentDim)) beginPocketRun(preX, preY);

  // Adjust dimension-specific effects
  voidGravityScale = currentDim === "VOID" ? 0.35 : 1.0;

  playSound('portal');
  particles.length = 0; floatingTexts.length = 0; burningBlocks.length = 0; activeDynamites.length = 0;
  // The composed 3-beat version replaces the old flat screenShake=20 -- it has
  // to run AFTER the clear above, otherwise its own burst is what gets wiped.
  if (window.VxJuice) VxJuice.dimensionShift(player.x, player.y, currentDim);
  else screenShake = 20;
  let newPTileX = Math.floor(player.x / TILE + 0.5);
  let newSy = 10;
  for (let y = 0; y < WORLD_H; y++) {
    let bk = getBlock(newPTileX, y);
    if (bk !== BLOCKS.AIR && bk !== BLOCKS.PORTAL && bk !== BLOCKS.DEEP_WATER && bk !== BLOCKS.LAVA) {
      newSy = y; break;
    }
  }
  // For Ocean: spawn above water, for Void: spawn on a guaranteed platform,
  // for Lava: spawn inside the cavern, not on top of its sealed bedrock ceiling
  if (currentDim === "OCEAN") {
    newSy = Math.min(newSy - 3, 10);
  } else if (currentDim === "VOID") {
    newSy = 40;
    ensureVoidLandingPlatform(newPTileX, newSy);
  } else if (currentDim === "LAVA") {
    // Lava Core is sealed with bedrock at row 0 AND row WORLD_H-1 (unlike the
    // open-sky dimensions), so the generic scan above — which just looks for
    // the first solid block starting at row 0 — immediately hit that top
    // bedrock ceiling and left the player stranded on top of it, unable to
    // ever reach the actual cavern below (bedrock can't be mined). Land near
    // the BOTTOM of the open-air cavern pocket instead of right under the
    // ceiling — landing at the top made every single entry fall the cavern's
    // full ~40-tile height straight into the lava pool at the bottom, with no
    // chance to react. This keeps the dimension's danger (a short lava-pool
    // brush is still likely) without a guaranteed multi-second plunge first.
    let airEnd = -1;
    for (let y = 1; y < WORLD_H; y++) {
      const bk = getBlock(newPTileX, y);
      if (bk === BLOCKS.AIR) airEnd = y;
      else if (airEnd !== -1) break; // past the first open-air pocket below the ceiling
    }
    newSy = airEnd !== -1 ? airEnd : 40;
  }
  player.y = (newSy - 3) * TILE; player.vy = 0;
  camX = player.x - (COLS >> 1) * TILE; camY = player.y - (ROWS >> 1) * TILE;
  drawCamX = camX; drawCamY = camY;
  // Place return portal at destination
  if (getBlock(newPTileX, newSy - 2) !== BLOCKS.PORTAL) {
    // Return portal always goes back to OVERWORLD — synced the same way as
    // any other portal so it resolves consistently for every player.
    setBlockAndBroadcast(newPTileX, newSy - 2, BLOCKS.PORTAL, "OVERWORLD");
    setBlockAndBroadcast(newPTileX - 1, newSy - 2, BLOCKS.PORTAL, "OVERWORLD");
    setBlockAndBroadcast(newPTileX + 1, newSy - 2, BLOCKS.PORTAL, "OVERWORLD");
    setBlockAndBroadcast(newPTileX, newSy - 3, BLOCKS.PORTAL, "OVERWORLD");
    setBlockAndBroadcast(newPTileX, newSy - 1, BLOCKS.PORTAL, "OVERWORLD");
  }
  // Golden watchtowers flanking the return portal (Gold Dimension only).
  if (currentDim === "GOLD") {
    buildGoldWatchtower(newPTileX - 10);
    buildGoldWatchtower(newPTileX + 10);
  }

  // Fired last, once the destination is fully built and the player is standing
  // in it. Earlier in this function a pocket run would still regenerate the
  // world underneath, so any block a mod placed — or anywhere it teleported
  // the player — would be thrown away again a few lines later. Both directions
  // count as "entering": returning to the overworld is a change a mod should
  // be able to react to just as much.
  fireGraphEvent('onEnterDim', { dim: currentDim });
}

// =========================================================
// PORTAL BOOK UI
// =========================================================
const PORTAL_DEFS = [
  {
    id: 'ERG', name: 'The Erg', unlocked: true,
    color: '#e8c468', glow: 'rgba(232,196,104,0.3)',
    desc: 'Eine begrenzte Wüstendimension mit wandernden Dünen, versunkenen Ruinen und einem tödlichen Sandsturm. Baue wertvolle Materialien ab und kehre vor der Sturmwand zum Portal zurück.',
    recipe: { center: BLOCKS.GRASS, cross: BLOCKS.DIRT },
    centerLabel: 'Grass Block', crossLabel: 'Dirt Block',
    rewards: 'Dune Sand, Erg Sandstone, Cactus Wood'
  }
];

// Dimensions are uncovered one after another. GOLD is always known; every later
// dimension's Portal Book entry stays blacked out until you have VISITED the one
// before it in the chain. `visitedDims` is intentionally a fresh per-session Set
// (not persisted) — portals aren't saved either (see setBlockAndBroadcast), so
// each session is its own discovery run.
const DIM_CHAIN = ['ERG'];
let visitedDims = new Set();
function isDimRevealed(id) {
  const idx = DIM_CHAIN.indexOf(id);
  if (idx <= 0) return true; // GOLD (first link) — and anything off-chain — is always shown
  return visitedDims.has(DIM_CHAIN[idx - 1]);
}
// Called whenever the player actually enters a dimension, so the NEXT one in the
// chain becomes revealed in the Portal Book.
function markDimVisited(dim) {
  if (DIM_CHAIN.includes(dim)) {
    visitedDims.add(dim);
    if (typeof showHintOnce === 'function') {
      showHintOnce('dimension_armor', '🛡️ New dimension, new hazards!', "Check the Portal Book's Crafting tab. Some armor is forged in-world at a dimension's own special structure, so look around!");
    }
  }
}

// Portal Book navigation — a three-level drill-down instead of tabs, so the
// book only ever shows one thing at a time:
//   'dims'  → the four dimension tiles
//   'dim'   → one dimension: how to open its portal + the armor it builds
//   'armor' → how to build that armor
// pbViewDim is which dimension the 'dim'/'armor' views are about.
let pbView = 'dims';
let pbViewDim = null;

function togglePortalBook() {
  const modal = document.getElementById('portal-book-modal');
  modal.classList.toggle('open');
  // Always reopen at the top level — coming back to a book still buried three
  // levels deep in a dimension you looked at ten minutes ago reads as broken.
  if (modal.classList.contains('open')) { pbView = 'dims'; pbViewDim = null; renderPortalBook(); }
}

function pbGoto(view, dimId) {
  pbView = view;
  if (dimId !== undefined) pbViewDim = dimId;
  renderPortalBook();
}


// =========================================================
// DIMENSION FORGES — every pocket dimension has ONE forge monument, built
// beside its landmark (see _stampDimForge). It is a LANDMARK, not a machine:
// it has no interaction of its own. What it does is tell you, in-world, which
// armor this realm makes — the hologram above it shows the piece, and the
// hammer you hear approaching it is the cue that this realm forges something
// at all. The armor itself is built by placing the altar pattern anywhere in
// this dimension (see ARMOR_PATTERN / checkArmorAltar), which is what FORGE_OUTPUT
// gates: the realm you're standing in decides which piece can be completed.
// =========================================================
const FORGE_RADIUS_PX = TILE * 2.2;
// Which armor each dimension produces. It sits one dimension EARLIER than the
// armor protects, so the whole chain bootstraps: Gold (safe) makes Lava armor →
// Lava makes Ocean armor → Ocean makes Void armor → Void makes the prestige
// Gold armor.
const FORGE_OUTPUT = {};
// Hologram/ambient tint per forge dimension — blends with each realm's palette.
const FORGE_TINT = { GOLD: '255,140,70', LAVA: '255,120,60', OCEAN: '90,200,255', VOID: '170,120,255' };
let forgeSoundTimer = 0;      // rhythmic-hammer cadence counter (dt units)
const FORGE_SOUND_RANGE = 10; // blocks — within this you hear the forge working

// This dimension's forge recipe, or null if this dimension has no forge / it's
// already been forged.
function currentForgeRecipe() {
  const id = FORGE_OUTPUT[currentDim];
  if (!id) return null;
  return CRAFTING_RECIPES.find(x => x.id === id) || null;
}

function nearestDimForge() {
  if (!pocketActive || dimForgeX === null) return null;
  const r = currentForgeRecipe();
  if (!r || recipeOwned(r)) return null;
  const px = player.x + player.w / 2, py = player.y + player.h / 2;
  const fxp = (dimForgeX + 0.5) * TILE, fyp = (dimForgeY + 0.5) * TILE;
  if (Math.hypot(px - fxp, py - fyp) < FORGE_RADIUS_PX) return { recipeId: r.id, x: fxp, y: fyp };
  return null;
}

// Small fiery/golden particle burst on the character the instant armor gets
// forged — the "feuriges Glühen" completion flourish.
function spawnForgeGlowBurst(x, y, dim) {
  const color = dim === 'LAVA' ? '255,106,61' : '255,217,122';
  for (let i = 0; i < 16; i++) {
    const ang = Math.random() * Math.PI * 2;
    const spd = 1 + Math.random() * 2.5;
    particles.push({
      x, y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd - 1,
      color: `rgba(${color},${0.7 + Math.random() * 0.3})`,
      size: 3 + Math.random() * 4, life: 30 + Math.random() * 20, maxLife: 50, type: 'dust'
    });
  }
}

// Called from executePlace the moment a placed block completes an altar.
// Scans every core position that could own the block just placed — the block
// can be any of the 9 cells, so the owning core always lies within this window.
function checkArmorAltar(wx, wy) {
  const recipeId = FORGE_OUTPUT[currentDim];
  // No entry means this dimension forges nothing — including the Overworld,
  // which is what keeps an ordinary surface build from ever triggering armor.
  if (!recipeId) return false;
  const r = CRAFTING_RECIPES.find(x => x.id === recipeId);
  if (!r || recipeOwned(r)) return false;
  for (let dx = -2; dx <= 2; dx++) for (let dy = -1; dy <= 1; dy++) {
    const cx = wx + dx, cy = wy + dy;
    if (getBlock(cx, cy) !== r.core) continue;
    var complete = true;
    for (const [ox, oy] of ARMOR_PATTERN) {
      if (getBlock(cx + ox, cy + oy) !== r.base) { complete = false; break; }
    }
    if (complete) { completeArmorAltar(r, cx, cy); return true; }
  }
  return false;
}

function completeArmorAltar(r, cx, cy) {
  // The altar IS the cost: its 9 blocks are consumed as they turn into the
  // armor. Nothing is taken from the inventory here — placing them already did
  // that, which is the whole point of building the recipe instead of buying it.
  setBlockAndBroadcast(cx, cy, BLOCKS.AIR);
  for (const [ox, oy] of ARMOR_PATTERN) setBlockAndBroadcast(cx + ox, cy + oy, BLOCKS.AIR);

  craftedArmor.add(r.dim);
  equippedArmor.add(r.dim); // auto-equip what you just built
  syncProgressToCloud();
  drawHotbar();
  updateDefenseBadge();
  applyArmorStatBonuses();
  playSound('buy');
  screenShake = Math.max(screenShake, 22);
  // Effects fire at the ALTAR, not the player — that's where the transformation
  // visibly happens, and the player is usually standing off to one side after
  // placing the last block.
  const ax = (cx + 0.5) * TILE, ay = (cy + 0.5) * TILE;
  spawnForgeGlowBurst(ax, ay, r.dim);
  // Expanding shockwave ring + a full-screen color-flash punch — reuses the
  // same 'ring' particle type and impactFlash mechanism as meteor/lightning
  // hits, so the completion moment reads with the same weight as the game's
  // other big impacts.
  particles.push({ x: ax, y: ay, vx: 0, vy: 0, color: '', size: 0, life: 26, maxLife: 26, type: 'ring' });
  impactFlash = Math.max(impactFlash, 0.7);
  const ARMOR_FLASH = { LAVA: '255,120,60', OCEAN: '90,200,255', VOID: '170,120,255', GOLD: '255,217,122' };
  const ARMOR_MSG = {
    LAVA:  '🔥 LAVA-RESISTENZ FREIGESCHALTET!',
    OCEAN: '🌊 OZEAN-RESISTENZ FREIGESCHALTET!',
    VOID:  '🌌 VOID-RESISTENZ FREIGESCHALTET!',
    GOLD:  '✨ GOLDENE AEGIS GESCHMIEDET · Prestige komplett!'
  };
  impactFlashColor = ARMOR_FLASH[r.dim] || '255,217,122';
  // Everything above lands on ONE frame, which reads as a single flat bang at
  // the 15fps a GIF gets captured at. forgeSlam re-spreads the same moment over
  // ~0.9s in three beats (anticipation → hit → afterglow) without replacing any
  // of it: it only ever raises screenShake/impactFlash via max(), so with
  // voxeria-juice.js absent this line does nothing and the moment is unchanged.
  if (window.VxJuice) VxJuice.forgeSlam(ax, ay, r.dim);
  showNotification(ARMOR_MSG[r.dim] || ('✨ ' + r.dim + '-RESISTENZ FREIGESCHALTET!'));
  // Armor state shows up on every level of the book (the "already built"
  // sub-line on a dimension tile, the equip button on the armor view), so
  // refresh whichever view happens to be open.
  if (document.getElementById('portal-book-modal').classList.contains('open')) renderPortalBook();
}

// Ambient trickle of themed particles drifting up off an un-forged structure,
// so it reads as "alive" even before the player ever interacts with it.
function spawnForgeAmbient(fx, fy, colorRgb) {
  particles.push({
    x: (fx + (Math.random() - 0.5) * 0.7) * TILE, y: (fy + 0.6) * TILE,
    vx: (Math.random() - 0.5) * 0.3, vy: -0.6 - Math.random() * 0.7,
    color: `rgba(${colorRgb},${0.5 + Math.random() * 0.4})`,
    size: 1.5 + Math.random() * 2, life: 40 + Math.random() * 30, maxLife: 70, type: 'dust'
  });
}

// A single small energy mote arcing from the forge into the character while
// charging — visually ties the hologram/forge to the hold-progress bar and
// gets denser as progress climbs, so the last couple seconds feel like the
// forge is really pouring itself into the armor.
// Proximity forge ambience: a short metallic hammer clang, layered from two
// detuned oscillators with a fast decay. Volume is passed in (scaled by how
// close the player is) and routes through masterGain so the mute/volume slider
// governs it like every other SFX.
function playForgeHammer(vol) {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const t = audioCtx.currentTime;
  const g = audioCtx.createGain();
  g.connect(masterGain);
  g.gain.setValueAtTime(Math.max(0.001, vol), t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
  const o1 = audioCtx.createOscillator();
  o1.type = 'square';
  o1.frequency.setValueAtTime(520, t); o1.frequency.exponentialRampToValueAtTime(170, t + 0.2);
  const o2 = audioCtx.createOscillator();
  o2.type = 'triangle';
  o2.frequency.setValueAtTime(820, t); o2.frequency.exponentialRampToValueAtTime(300, t + 0.15);
  o1.connect(g); o2.connect(g);
  o1.start(t); o2.start(t); o1.stop(t + 0.2); o2.stop(t + 0.2);
}

// A flickering, scanlined holographic projection floating above a forge,
// showing exactly which materials it still needs and how many you're
// carrying — "Man soll oberhalb der Schmiede in Hologramm-Form die
// benötigten Materialien schweben sehen". Drawn every frame while the recipe
// is un-owned; screen position tracks the camera like everything else here.
function drawForgeHologram(fx, fy, r, tintRgb) {
  const sx = (fx + 0.5) * TILE - drawCamX;
  const baseY = fy * TILE - drawCamY;
  const bob = Math.sin(frameCount * 0.05 + fx) * 4;
  const mats = Object.keys(r.mats).map(b => parseInt(b, 10));
  const iconSize = 26, gap = 8;
  const totalW = mats.length * iconSize + (mats.length - 1) * gap;
  const topY = baseY - 96 + bob;

  // Projector disc resting on the structure.
  ctx.save();
  ctx.globalAlpha = 0.5 + Math.sin(frameCount * 0.1) * 0.15;
  ctx.strokeStyle = `rgba(${tintRgb},0.85)`;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.ellipse(sx, baseY - 4, 16, 5, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();

  // Beam cone connecting the disc to the floating icons.
  ctx.save();
  const grad = ctx.createLinearGradient(sx, baseY - 6, sx, topY + iconSize / 2);
  grad.addColorStop(0, `rgba(${tintRgb},0.35)`);
  grad.addColorStop(1, `rgba(${tintRgb},0)`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(sx - 14, baseY - 6);
  ctx.lineTo(sx + 14, baseY - 6);
  ctx.lineTo(sx + totalW / 2 + 8, topY + iconSize / 2);
  ctx.lineTo(sx - totalW / 2 - 8, topY + iconSize / 2);
  ctx.closePath(); ctx.fill();
  ctx.restore();

  // Material icons, each with a live have/need count.
  let ix = sx - totalW / 2;
  ctx.save();
  ctx.globalAlpha = 0.9 + Math.sin(frameCount * 0.22) * 0.1; // gentle hologram flicker
  for (const bid of mats) {
    const need = r.mats[bid];
    const have = countInInventory(bid);
    const ok = have >= need;
    ctx.shadowColor = `rgba(${tintRgb},0.9)`;
    ctx.shadowBlur = 12;
    ctx.drawImage(_forgeIcon(bid), ix, topY, iconSize, iconSize);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = ok ? 'rgba(120,255,150,0.9)' : `rgba(${tintRgb},0.7)`;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(ix, topY, iconSize, iconSize);
    ctx.fillStyle = ok ? '#9dffb0' : '#ffe9c2';
    ctx.font = fontUI('bold 11px'); ctx.textAlign = 'center';
    ctx.fillText(Math.min(have, need) + '/' + need, ix + iconSize / 2, topY + iconSize + 12);
    ix += iconSize + gap;
  }
  // Thin scanlines sweeping through the band for a sci-fi hologram feel.
  for (let ly = topY - 4; ly < topY + iconSize + 4; ly += 4) {
    const phase = (ly + frameCount * 1.2) % 8;
    ctx.globalAlpha = phase < 2 ? 0.14 : 0.05;
    ctx.fillStyle = `rgba(${tintRgb},1)`;
    ctx.fillRect(sx - totalW / 2 - 6, ly, totalW + 12, 1.5);
  }
  ctx.restore();
}

// The monumental forge itself, drawn over its placed blocks: a dark metallic
// anvil on the stone base, a pulsing warm core glow, and a floating energy
// cube/flame bobbing above it. Rendered after the world so its glow reads
// even through nearby walls. `near` adds a bright interaction frame + [E]
// keycap once the player is right in front. All colors come from tintRgb so
// each dimension's forge glows in its own palette (gold heat, blue deep-fire…).
// `spent` (already forged) dims the pulse way down — a calm, settled ember
// glow instead of an active working forge — but the monument itself never
// disappears; it stays a proper landmark, not a wall of bare blocks.
function drawForgeStructure(fx, fy, tintRgb, near, spent) {
  const cx = (fx + 0.5) * TILE - drawCamX;      // core column centre
  const coreCy = (fy + 0.5) * TILE - drawCamY;  // core block centre
  const baseTop = fy * TILE - drawCamY;         // top edge of the core row
  const t = frameCount;
  const pulse = spent ? (0.18 + Math.sin(t * 0.03) * 0.08) : (0.6 + Math.sin(t * 0.08) * 0.4); // 0.2..1.0 active, faint ember when spent

  // 1. Pulsing radial ground glow behind the whole structure (additive).
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const gr = ctx.createRadialGradient(cx, coreCy, 2, cx, coreCy, TILE * 2.4);
  gr.addColorStop(0, `rgba(${tintRgb},${0.45 * pulse})`);
  gr.addColorStop(0.5, `rgba(${tintRgb},${0.16 * pulse})`);
  gr.addColorStop(1, `rgba(${tintRgb},0)`);
  ctx.fillStyle = gr;
  ctx.beginPath(); ctx.arc(cx, coreCy, TILE * 2.4, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // 2. Dark metallic anvil silhouette on the core block — the monumental form.
  ctx.save();
  const aw = TILE * 1.5, ah = TILE * 0.95;
  const ax0 = cx - aw / 2, ay0 = baseTop + TILE * 0.05;
  ctx.fillStyle = '#20242e';
  ctx.fillRect(ax0, ay0, aw, ah * 0.30);                                   // top plate
  ctx.beginPath();                                                          // horn
  ctx.moveTo(ax0, ay0 + ah * 0.06);
  ctx.lineTo(ax0 - aw * 0.20, ay0 + ah * 0.16);
  ctx.lineTo(ax0, ay0 + ah * 0.30);
  ctx.closePath(); ctx.fill();
  ctx.fillRect(cx - aw * 0.16, ay0 + ah * 0.30, aw * 0.32, ah * 0.34);      // waist
  ctx.fillRect(cx - aw * 0.30, ay0 + ah * 0.64, aw * 0.60, ah * 0.36);      // base
  ctx.fillStyle = `rgba(${tintRgb},${0.3 + 0.35 * pulse})`;                 // hot metallic top
  ctx.fillRect(ax0, ay0, aw, 3);
  ctx.restore();

  // 3. Floating energy cube / flame above the anvil, bobbing + pulsing.
  const bob = Math.sin(t * 0.12) * 4;
  const flameY = baseTop - TILE * 0.55 + bob;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const fg = ctx.createRadialGradient(cx, flameY, 1, cx, flameY, 15 + pulse * 7);
  fg.addColorStop(0, `rgba(${tintRgb},0.95)`);
  fg.addColorStop(1, `rgba(${tintRgb},0)`);
  ctx.fillStyle = fg;
  ctx.beginPath(); ctx.arc(cx, flameY, 15 + pulse * 7, 0, Math.PI * 2); ctx.fill();
  ctx.translate(cx, flameY); ctx.rotate(t * 0.04);
  const cs = 5 + pulse * 2.5;
  ctx.globalAlpha = 0.92; ctx.fillStyle = '#ffffff';
  ctx.fillRect(-cs / 2, -cs / 2, cs, cs);
  ctx.restore();

  // 4. Interaction frame (corner brackets) + [E] keycap when right in front.
  if (near) {
    const fl = cx - TILE * 1.7, fr = cx + TILE * 1.7;
    const ftp = baseTop - TILE * 1.3, fbt = coreCy + TILE * 1.15;
    const a = 0.55 + 0.45 * Math.sin(t * 0.2);
    ctx.save();
    ctx.strokeStyle = `rgba(${tintRgb},${a})`;
    ctx.lineWidth = 2.5; ctx.lineCap = 'round';
    const cL = 13;
    ctx.beginPath(); ctx.moveTo(fl, ftp + cL); ctx.lineTo(fl, ftp); ctx.lineTo(fl + cL, ftp); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(fr - cL, ftp); ctx.lineTo(fr, ftp); ctx.lineTo(fr, ftp + cL); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(fl, fbt - cL); ctx.lineTo(fl, fbt); ctx.lineTo(fl + cL, fbt); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(fr - cL, fbt); ctx.lineTo(fr, fbt); ctx.lineTo(fr, fbt - cL); ctx.stroke();
    // [E] keycap floating just above the flame.
    const kx = cx - 11, ky = ftp - 20, kw = 22, kh = 20;
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = 'rgba(10,8,16,0.85)';
    ctx.strokeStyle = `rgba(${tintRgb},0.95)`; ctx.lineWidth = 2;
    ctx.fillRect(kx, ky, kw, kh); ctx.strokeRect(kx, ky, kw, kh);
    ctx.globalAlpha = 1; ctx.fillStyle = '#fff';
    ctx.font = fontUI('bold 13px'); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('E', cx, ky + kh / 2 + 1);
    ctx.textBaseline = 'alphabetic';
    ctx.restore();
  }
}

// Draws the current dimension's forge hologram (only while un-owned) and drips
// a little ambient particle life off it. Called from the main render chain;
// see updateDimForge for the actual hold-to-craft interaction.
function drawDimForge() {
  if (!pocketActive || dimForgeX === null) return;
  const r = currentForgeRecipe();
  if (!r) return;
  const tint = FORGE_TINT[currentDim] || '255,200,120';
  const owned = recipeOwned(r);
  // The monument itself always stands — only its "active working forge" signals
  // (hologram, spark swarm, interaction prompt) go quiet once it's been used.
  const near = !owned && !!nearestDimForge();
  drawForgeStructure(dimForgeX, dimForgeY, tint, near, owned);
  if (owned) return;
  drawForgeHologram(dimForgeX, dimForgeY, r, tint);
  // Rising spark swarm — dense enough to catch the eye from a few blocks away.
  if (Math.random() < 0.6) spawnForgeAmbient(dimForgeX, dimForgeY, tint);
  // Occasional bright twinkle spark for extra sparkle.
  if (Math.random() < 0.12) {
    particles.push({
      x: (dimForgeX + (Math.random() - 0.5) * 1.4) * TILE, y: (dimForgeY - 0.2) * TILE,
      vx: (Math.random() - 0.5) * 0.5, vy: -1 - Math.random() * 1.2,
      color: `rgba(${tint},1)`, size: 2 + Math.random() * 2, life: 30 + Math.random() * 25, maxLife: 55, type: 'twinkle'
    });
  }
}

// Per-frame tick, called from the main loop right after updatePocketDimension.
// The forge monument no longer has an interaction of its own — armor is built
// by placing the altar pattern anywhere in this dimension (see checkArmorAltar).
// What's left here is pure atmosphere: the rhythmic hammer you hear as you
// approach, which is also the cue that tells you THIS is the realm that forges
// something. It falls silent once the armor has been made.
function updateDimForge(dt) {
  const r = (pocketActive && dimForgeX !== null) ? currentForgeRecipe() : null;
  if (!r || recipeOwned(r)) { forgeSoundTimer = 0; return; }

  const fxp = (dimForgeX + 0.5) * TILE, fyp = (dimForgeY + 0.5) * TILE;
  const distTiles = Math.hypot(player.x + player.w / 2 - fxp, player.y + player.h / 2 - fyp) / TILE;
  if (distTiles < FORGE_SOUND_RANGE) {
    forgeSoundTimer -= dt;
    if (forgeSoundTimer <= 0) {
      playForgeHammer(0.03 + (1 - distTiles / FORGE_SOUND_RANGE) * 0.09);
      forgeSoundTimer = 38; // ~0.63s between clangs at 60fps
    }
  } else {
    forgeSoundTimer = 0;
  }
}



// =========================================================
// SESSION STORAGE – Tab-Wechsel überleben
// =========================================================

function saveSession() {
  try {
    sessionStorage.setItem('voxeria_session', JSON.stringify({
      x: player.x,
      y: player.y,
      dim: currentDim,
      health: player.health,
      inventory: inventory,
      seed: rawSeedString
    }));
  } catch(e) {}
}

function tryResumeSession() {
  try {
    const raw = sessionStorage.getItem('voxeria_session');
    if (!raw) return;
    const s = JSON.parse(raw);
    // Nur wiederherstellen wenn Seed übereinstimmt
    if (s.seed !== rawSeedString) return;
    player.x = s.x;
    player.y = s.y;
    currentDim = s.dim || 'OVERWORLD';
    if (s.inventory && s.inventory.length) inventory = normalizeInventory(s.inventory);
    // Movement/mining stats are fully derived from equipped armor (already
    // loaded from cloud progress by this point) — no separate snapshot needed.
    applyArmorStatBonuses();
    player.health = s.health || maxHealth;
    voidGravityScale = currentDim === 'VOID' ? 0.35 : 1.0;
    drawHealth(); drawHotbar();
    showNotification('🌿 Welcome back, explorer!');
  } catch(e) {}
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden && gameState === 'PLAYING') saveSession();
});


// =========================================================
// PROGRESS SAVE (localStorage)
// =========================================================
// Builds the full permanent-progress payload: crafted/equipped armor.
// This is the SINGLE source of truth for "forever" progress.
function _buildProgressSaveData() {
  return {
    craftedArmor: [...craftedArmor],
    equippedArmor: [...equippedArmor],
    ts: Date.now()
  };
}

// Tracks the freshest ts we've already applied this page load, so a stale
// saved copy can never clobber more-recent local data with an older one.
let _lastAppliedProgressTs = 0;

// Nothing is allowed to write to the permanent save until the very first
// restore attempt has happened — otherwise an armor change in the first
// frames of gameplay (before that state is restored) would call
// syncProgressToCloud() with the not-yet-restored defaults (no armor) and
// permanently stomp real progress. See loadProgressFromCloud().
let _progressRestoreAttempted = false;

function _applyProgressSaveData(parsed) {
  if (!parsed) return;
  if (typeof parsed.ts === 'number') {
    if (parsed.ts < _lastAppliedProgressTs) return;
    _lastAppliedProgressTs = parsed.ts;
  }
  if (Array.isArray(parsed.craftedArmor)) craftedArmor = new Set(parsed.craftedArmor);
  // Older saves predate the equip/unequip toggle and only ever had
  // craftedArmor — for those, default everything owned to equipped so
  // returning players don't silently lose armor they could already see and
  // rely on for protection. Newer saves carry their own explicit choice.
  if (Array.isArray(parsed.equippedArmor)) equippedArmor = new Set(parsed.equippedArmor);
  else equippedArmor = new Set(craftedArmor);
  updateDefenseBadge();
  applyArmorStatBonuses();
  drawHealth(); drawHotbar();
}

function syncProgressToCloud() {
  if (!_progressRestoreAttempted) return;
  const saveData = _buildProgressSaveData();
  try { localStorage.setItem('voxeria_economy', JSON.stringify(saveData)); } catch (e) {}
}

async function loadProgressFromCloud() {
  try {
    const local = localStorage.getItem('voxeria_economy');
    if (local) _applyProgressSaveData(JSON.parse(local));
  } catch (e) {}
  _progressRestoreAttempted = true;
}

// =========================================================
// SESSION RESUME – nach Intro-Dismiss aufrufen
// =========================================================
// Patcht dismissIntro im Video-Overlay IIFE nicht möglich direkt,
// deshalb: nach kurzer Verzögerung versuchen.
// Sicherer: am Ende von resetGameAndWorld ruft tryResumeSession auf.
const _origUpdateAndDrawIntro = updateAndDrawIntro;
let _sessionResumeAttempted = false;
updateAndDrawIntro = function(ctx, dt) {
  _origUpdateAndDrawIntro(ctx, dt);
  // Sobald das Intro fertig ist und das Spiel startet
  if (gameState === 'PLAYING' && !_sessionResumeAttempted) {
    _sessionResumeAttempted = true;
    tryResumeSession();
  }
};

// =========================================================
// DAS PORTAL-BUCH -- vollstaendig, statt auf zwei Dateien verteilt
// =========================================================
// Bis eben lag das Buch quer ueber beide Dateien: Zustand und Navigation
// (pbView, pbGoto, isDimRevealed, togglePortalBook) hier, das Zeichnen aller
// drei Ebenen in voxeria-engine.js. Die Engine las dafuer PORTAL_DEFS,
// isDimRevealed und pbGoto aus dieser Datei nach oben, und diese Datei rief
// renderPortalBook() zurueck nach unten. Ein Bildschirm, zwei Dateien, ein
// Ring.
//
// Jetzt ist alles hier. Was umgezogen ist:
//
//   _pbTile / _pbBack / _pbLabel     die drei Bausteine der Oberflaeche
//   PB_DIM_SCENE / drawDimScene      die kleine Szene pro Dimension
//   drawRecipePreview / drawAltar…   die Rezeptvorschauen
//   renderPortalBook + die 3 Ebenen  Dimensionsliste, Dimension, Ruestung
//   toggleArmorEquip                 nur vom Buch aus erreichbar
//
// Bewusst NICHT mitgekommen ist drawBlockMini(): das benutzen auch die
// Mod-Galerie und der Block-Katalog, es ist also echtes Allgemeingut der
// Engine und bleibt dort.
//
// Alles hier liest weiter frei aus der Engine (BLOCKS, blockColors,
// craftedArmor, showNotification und so weiter). Das ist die erlaubte
// Richtung: ein Feature darf das Fundament benutzen.
// =========================================================

// One tile shape for everything the player clicks in this book: image on the
// left, name (plus an optional sub-line) on the right.
function _pbTile(opts) {
  const tile = document.createElement('div');
  tile.className = 'pb-tile' + (opts.onClick ? ' clickable' : '') + (opts.locked ? ' locked' : '');
  if (opts.lockGlyph) {
    const l = document.createElement('div');
    l.className = 'pb-tile-lock';
    l.textContent = opts.lockGlyph;
    tile.appendChild(l);
  } else if (opts.img) {
    opts.img.className = 'pb-tile-img';
    tile.appendChild(opts.img);
  }
  const txt = document.createElement('div');
  txt.className = 'pb-tile-text';
  const nm = document.createElement('div');
  nm.className = 'pb-tile-name';
  nm.textContent = opts.name;
  if (opts.nameColor) nm.style.color = opts.nameColor;
  txt.appendChild(nm);
  if (opts.sub) {
    const s = document.createElement('div');
    s.className = 'pb-tile-sub';
    s.textContent = opts.sub;
    txt.appendChild(s);
  }
  tile.appendChild(txt);
  if (opts.onClick) {
    const chev = document.createElement('div');
    chev.className = 'pb-tile-chev';
    chev.textContent = '›';
    tile.appendChild(chev);
    tile.onclick = opts.onClick;
  }
  return tile;
}

function _pbBack(label, onClick) {
  const b = document.createElement('button');
  b.className = 'pb-back';
  b.textContent = '‹ ' + label;
  b.onclick = onClick;
  return b;
}

function _pbLabel(text) {
  const el = document.createElement('div');
  el.className = 'pb-label';
  el.textContent = text;
  return el;
}

// Recipe for each dimension's generated preview scene: the sky ramp it sits
// under, the blocks its terrain is made of (surface → deeper), the rarer blocks
// scattered through it, and the colour of its ambient glow. All drawn with the
// game's real block palette, so the card previews what the realm actually
// looks like rather than being decorative art made up separately.
const PB_DIM_SCENE = {
  GOLD:  { sky: ['#432a07', '#8a5f18', '#e0a233'],
           ground: [BLOCKS.YELLOW_LIMESTONE, BLOCKS.GOLD_BRICK, BLOCKS.OBSIDIAN],
           accents: [BLOCKS.EMBER_ORE, BLOCKS.RAINBOW_ORE, BLOCKS.GOLD_ORE],
           glow: 'rgba(255,190,80,0.34)' },
  LAVA:  { sky: ['#190603', '#4d1206', '#ad2c09'],
           ground: [BLOCKS.VOLCANIC_ROCK, BLOCKS.MAGMA, BLOCKS.OBSIDIAN],
           accents: [BLOCKS.LAVA, BLOCKS.FIRE_CRYSTAL, BLOCKS.EMBER_ORE],
           glow: 'rgba(255,90,30,0.4)' },
  OCEAN: { sky: ['#02121f', '#064063', '#0b73a0'],
           ground: [BLOCKS.CORAL, BLOCKS.OCEAN_STONE, BLOCKS.OCEAN_STONE],
           accents: [BLOCKS.SEA_LANTERN, BLOCKS.KELP, BLOCKS.CORAL],
           glow: 'rgba(80,200,255,0.3)' },
  VOID:  { sky: ['#07030e', '#1c0a35', '#37135e'],
           ground: [BLOCKS.VOID_STONE, BLOCKS.VOID_GLASS, BLOCKS.VOID_STONE],
           accents: [BLOCKS.VOID_ORE, BLOCKS.STAR_DUST, BLOCKS.ETHER_CRYSTAL],
           glow: 'rgba(160,110,255,0.36)' },
  ERG:   { sky: ['#7a4a12', '#c9862f', '#e8c468'],
           ground: [BLOCKS.ERG_SAND, BLOCKS.ERG_SAND, BLOCKS.ERG_SANDSTONE],
           accents: [BLOCKS.ERG_CACTUS],
           glow: 'rgba(232,196,104,0.32)' }
};

// Small deterministic PRNG so a dimension's card looks identical every time
// the book is opened, instead of reshuffling on every render.
function _pbSceneRand(seed) {
  let s = (seed >>> 0) || 1;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function drawDimScene(canvas, dimId) {
  const W = 400, H = 140;
  canvas.width = W; canvas.height = H;
  const c = canvas.getContext('2d');
  const cfg = PB_DIM_SCENE[dimId];
  if (!cfg) { c.fillStyle = '#111'; c.fillRect(0, 0, W, H); return; }

  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, cfg.sky[0]); g.addColorStop(0.55, cfg.sky[1]); g.addColorStop(1, cfg.sky[2]);
  c.fillStyle = g; c.fillRect(0, 0, W, H);

  const rnd = _pbSceneRand(hashCode('scene-' + dimId));

  // Ambient light blooms — these are what survive the blur most and give each
  // realm its colour at a glance.
  for (let i = 0; i < 5; i++) {
    const gx = rnd() * W, gy = H * 0.1 + rnd() * H * 0.6, gr = 38 + rnd() * 78;
    const rg = c.createRadialGradient(gx, gy, 0, gx, gy, gr);
    rg.addColorStop(0, cfg.glow); rg.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = rg;
    c.beginPath(); c.arc(gx, gy, gr, 0, Math.PI * 2); c.fill();
  }

  const S = 16;
  const colsN = Math.ceil(W / S), rowsN = Math.ceil(H / S);
  function blockAt(px, py, btype) {
    const col = blockColors[btype];
    if (!col) return;
    c.fillStyle = col[0]; c.fillRect(px, py, S, S);
    c.fillStyle = col[2]; c.fillRect(px, py, S, 3);
    c.fillStyle = col[1]; c.fillRect(px, py + S - 3, S, 3);
    c.fillStyle = col[3]; c.fillRect(px + S - 3, py, 3, S);
  }
  const pick = arr => arr[Math.floor(rnd() * arr.length)];

  if (dimId === 'VOID') {
    // Floating islands rather than continuous ground — that IS the Blither.
    let x = 0;
    while (x < colsN) {
      const w = 2 + Math.floor(rnd() * 4);
      const top = 2 + Math.floor(rnd() * 4);
      const depth = 1 + Math.floor(rnd() * 2);
      for (let i = 0; i < w && x + i < colsN; i++) {
        for (let d = 0; d < depth; d++) {
          const base = d === 0 ? cfg.ground[0] : cfg.ground[1];
          blockAt((x + i) * S, (top + d) * S, rnd() < 0.16 ? pick(cfg.accents) : base);
        }
      }
      x += w + 1 + Math.floor(rnd() * 2);
    }
  } else {
    let h = Math.floor(rowsN * 0.5);
    for (let cx = 0; cx < colsN; cx++) {
      h += Math.floor(rnd() * 3) - 1;
      h = Math.max(Math.floor(rowsN * 0.3), Math.min(rowsN - 1, h));
      for (let ry = h; ry < rowsN; ry++) {
        let bt = ry === h ? cfg.ground[0] : (ry < h + 2 ? cfg.ground[1] : cfg.ground[2]);
        if (ry > h && rnd() < 0.09) bt = pick(cfg.accents);
        blockAt(cx * S, ry * S, bt);
      }
    }
  }
}

// Renders any rectangular recipe grid (0 = empty cell) into a canvas. Shared by
// the portal recipes (3x3 plus-shape) and the armor altars (5x3), so both read
// as the same kind of diagram instead of two different visual languages.
function _drawRecipeGrid(canvas, grid) {
  const rc = canvas.getContext('2d');
  const S = 16; // cell size
  const PAD = 4;
  const rows = grid.length, cols0 = grid[0].length;
  canvas.width = S * cols0 + PAD * (cols0 + 1);
  canvas.height = S * rows + PAD * (rows + 1);
  rc.fillStyle = 'rgba(0,0,0,0.4)';
  rc.fillRect(0, 0, canvas.width, canvas.height);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols0; col++) {
      const btype = grid[row][col];
      const bx = PAD + col * (S + PAD);
      const by = PAD + row * (S + PAD);
      if (btype === 0) {
        rc.fillStyle = 'rgba(255,255,255,0.05)';
        rc.fillRect(bx, by, S, S);
        continue;
      }
      const cols = blockColors[btype];
      if (cols) {
        rc.fillStyle = cols[0]; rc.fillRect(bx, by, S, S);
        rc.fillStyle = cols[2]; rc.fillRect(bx, by, S, 2);
        rc.fillStyle = cols[3]; rc.fillRect(bx+S-2, by, 2, S);
        rc.fillStyle = cols[1]; rc.fillRect(bx, by+S-2, S, 2);
        rc.fillStyle = cols[1]; rc.fillRect(bx, by, 2, S);
        if (btype === BLOCKS.RAINBOW_ORE) {
          rc.fillStyle = '#55ffff'; rc.fillRect(bx+3,by+3,3,3); rc.fillRect(bx+9,by+7,3,3); rc.fillRect(bx+3,by+9,3,3);
        } else if (ORE_SPECKLE_IDS.has(btype)) {
          // Without this, ores whose base/shadow match their dimension's plain
          // rock (e.g. Gold/Diamond/Coal share Stone's grey, or Ember Ore
          // shares Magma Rock's tone) render as an almost-plain colored square
          // here — the accent color is otherwise just a barely-visible 2px rim.
          rc.fillStyle = cols[3]; rc.fillRect(bx+3,by+3,3,3); rc.fillRect(bx+9,by+7,3,3); rc.fillRect(bx+3,by+9,3,3);
        }
      }
      rc.strokeStyle = 'rgba(255,255,255,0.15)'; rc.lineWidth = 0.5; rc.strokeRect(bx, by, S, S);
    }
  }
}

function drawRecipePreview(canvas, centerBlock, crossBlock) {
  _drawRecipeGrid(canvas, [
    [0, crossBlock, 0],
    [crossBlock, centerBlock, crossBlock],
    [0, crossBlock, 0]
  ]);
}

// The armor altar. The grid is DERIVED from ARMOR_PATTERN rather than written
// out again, so the diagram the player is asked to copy can never drift out of
// sync with the shape checkArmorAltar actually looks for.
function drawAltarPreview(canvas, baseBlock, coreBlock) {
  const xs = ARMOR_PATTERN.map(p => p[0]).concat(0);
  const ys = ARMOR_PATTERN.map(p => p[1]).concat(0);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const grid = [];
  for (let y = minY; y <= maxY; y++) {
    const row = [];
    for (let x = minX; x <= maxX; x++) row.push(0);
    grid.push(row);
  }
  for (const [ox, oy] of ARMOR_PATTERN) grid[oy - minY][ox - minX] = baseBlock;
  grid[0 - minY][0 - minX] = coreBlock;
  _drawRecipeGrid(canvas, grid);
}

function renderPortalBook() {
  const body = document.getElementById('pb-body');
  body.innerHTML = '';
  if (pbView === 'armor' && pbViewDim) { _pbRenderArmor(body, pbViewDim); return; }
  if (pbView === 'dim' && pbViewDim) { _pbRenderDim(body, pbViewDim); return; }
  _pbRenderDims(body);
}

// Level 1 — one tile per dimension. Undiscovered ones stay blacked out; you
// uncover them by entering the dimension before them in the chain.
function _pbRenderDims(body) {
  PORTAL_DEFS.forEach(def => {
    const revealed = isDimRevealed(def.id);
    const card = document.createElement('div');
    card.className = 'pb-dim-card' + (revealed ? '' : ' locked');

    const scene = document.createElement('canvas');
    scene.className = 'pb-dim-scene';
    drawDimScene(scene, def.id);
    card.appendChild(scene);

    const veil = document.createElement('div');
    veil.className = 'pb-dim-veil';
    card.appendChild(veil);

    const label = document.createElement('div');
    label.className = 'pb-dim-label';
    const title = document.createElement('div');
    title.className = 'pb-dim-title';
    title.textContent = revealed ? def.name : '? ? ?';
    if (revealed) title.style.color = def.color;
    label.appendChild(title);

    const noteText = !revealed
      ? 'Discover the dimension before this one'
      : (currentDim === def.id ? '◉ You are here' : null);
    if (noteText) {
      const note = document.createElement('div');
      note.className = 'pb-dim-note';
      note.textContent = noteText;
      label.appendChild(note);
    }
    card.appendChild(label);

    if (revealed) card.onclick = () => pbGoto('dim', def.id);
    body.appendChild(card);
  });
}

// Level 2 — one dimension: how to open its portal, then the armor it builds.
function _pbRenderDim(body, dimId) {
  const def = PORTAL_DEFS.find(d => d.id === dimId);
  if (!def) { pbGoto('dims'); return; }
  body.appendChild(_pbBack('All dimensions', () => pbGoto('dims')));

  const banner = document.createElement('div');
  banner.className = 'pb-dim-card compact';
  const bScene = document.createElement('canvas');
  bScene.className = 'pb-dim-scene';
  drawDimScene(bScene, def.id);
  const bVeil = document.createElement('div');
  bVeil.className = 'pb-dim-veil';
  const bLabel = document.createElement('div');
  bLabel.className = 'pb-dim-label';
  const bTitle = document.createElement('div');
  bTitle.className = 'pb-dim-title';
  bTitle.textContent = def.name;
  bTitle.style.color = def.color;
  bLabel.appendChild(bTitle);
  banner.appendChild(bScene); banner.appendChild(bVeil); banner.appendChild(bLabel);
  body.appendChild(banner);

  const desc = document.createElement('div');
  desc.className = 'pb-desc';
  desc.textContent = def.desc;
  body.appendChild(desc);

  body.appendChild(_pbLabel('Portal Recipe'));
  const panel = document.createElement('div');
  panel.className = 'pb-panel';
  const rc = document.createElement('canvas');
  drawRecipePreview(rc, def.recipe.center, def.recipe.cross);
  const ptxt = document.createElement('div');
  ptxt.className = 'pb-panel-text';
  ptxt.innerHTML = 'Center: <b>' + escapeHtml(def.centerLabel) + '</b><br>' +
                   'Cross: <b>' + escapeHtml(def.crossLabel) + '</b>';
  panel.appendChild(rc); panel.appendChild(ptxt);
  body.appendChild(panel);

  // The armor this realm makes (FORGE_OUTPUT: always the piece you need for the
  // NEXT dimension, which is why it's found one realm early).
  const recId = FORGE_OUTPUT[dimId];
  const r = recId ? CRAFTING_RECIPES.find(x => x.id === recId) : null;
  if (r) {
    body.appendChild(_pbLabel('Armor built here'));
    const img = document.createElement('canvas');
    img.width = 60; img.height = 60;
    drawArmorPreview(img, r.dim);
    body.appendChild(_pbTile({
      img, name: r.name,
      sub: craftedArmor.has(r.dim) ? '✓ Already built' : 'Not built yet',
      onClick: () => pbGoto('armor', dimId)
    }));
  }
}

// Level 3 — how to build one armor piece: the altar shape, nothing else.
function _pbRenderArmor(body, dimId) {
  const recId = FORGE_OUTPUT[dimId];
  const r = recId ? CRAFTING_RECIPES.find(x => x.id === recId) : null;
  const def = PORTAL_DEFS.find(d => d.id === dimId);
  if (!r) { pbGoto('dim', dimId); return; }
  body.appendChild(_pbBack(def ? def.name : 'Back', () => pbGoto('dim', dimId)));

  const head = document.createElement('div');
  head.className = 'pb-detail-head';
  const ico = document.createElement('canvas');
  ico.width = 60; ico.height = 60;
  ico.className = 'pb-tile-img';
  drawArmorPreview(ico, r.dim);
  const nm = document.createElement('div');
  nm.className = 'pb-detail-name';
  nm.textContent = r.name;
  head.appendChild(ico); head.appendChild(nm);
  body.appendChild(head);

  const eff = document.createElement('div');
  eff.className = 'pb-desc';
  eff.textContent = r.effect + ' (-' + Math.round(ARMOR_DEFENSE[r.dim] * 100) + '% DMG while equipped)';
  body.appendChild(eff);

  body.appendChild(_pbLabel('How to build it'));
  const panel = document.createElement('div');
  panel.className = 'pb-panel';
  const shape = document.createElement('canvas');
  drawAltarPreview(shape, r.base, r.core);
  const txt = document.createElement('div');
  txt.className = 'pb-panel-text';
  const haveBase = countInInventory(r.base), haveCore = countInInventory(r.core);
  const needBase = r.mats[r.base], needCore = r.mats[r.core];
  txt.innerHTML =
    'Place the blocks in exactly this shape while you are in the <b>' + escapeHtml(r.forge.dim) + '</b> Dimension. They turn into the armor on the spot.<br>' +
    '<span class="' + (haveBase >= needBase ? 'cm-ok' : 'cm-short') + '">' +
      escapeHtml(blockNames[r.base] || 'Block') + ' ' + Math.min(haveBase, needBase) + '/' + needBase + '</span> · ' +
    '<span class="' + (haveCore >= needCore ? 'cm-ok' : 'cm-short') + '">' +
      escapeHtml(blockNames[r.core] || 'Block') + ' ' + Math.min(haveCore, needCore) + '/' + needCore + ' (core)</span>';
  panel.appendChild(shape); panel.appendChild(txt);
  body.appendChild(panel);

  // Wearing it is the only thing there's still a button for.
  if (craftedArmor.has(r.dim)) {
    const btn = document.createElement('button');
    btn.className = 'craft-btn';
    const equipped = equippedArmor.has(r.dim);
    btn.classList.add(equipped ? 'equipped' : 'stowed');
    btn.textContent = equipped ? 'Equipped (click to remove)' : 'Stowed (click to wear)';
    btn.onclick = () => toggleArmorEquip(r.dim);
    body.appendChild(btn);
  }
}

// Toggles a crafted armor piece between worn and stowed. No-op if you don't
// actually own it yet (equipping is only ever a display/protection choice
// over what's already been crafted, never a way to skip crafting).
function toggleArmorEquip(dim) {
  if (!craftedArmor.has(dim)) return;
  if (equippedArmor.has(dim)) {
    equippedArmor.delete(dim);
    showNotification('👕 Unequipped ' + dim + ' armor.');
  } else {
    equippedArmor.add(dim);
    showNotification('🛡️ Equipped ' + dim + ' armor.');
  }
  syncProgressToCloud();
  drawHotbar();
  updateDefenseBadge();
  applyArmorStatBonuses();
  // Armor state shows up on every level of the book (the "already built"
  // sub-line on a dimension tile, the equip button on the armor view), so
  // refresh whichever view happens to be open.
  if (document.getElementById('portal-book-modal').classList.contains('open')) renderPortalBook();
}

// =========================================================
// GOLD SLIMES -- die Kreatur der Gold-Dimension, jetzt bei ihrer Dimension
// =========================================================
// Diese ~120 Zeilen standen in voxeria-engine.js und lasen von dort aus vier
// Namen nach oben in diese Datei: POCKET_LEFT, POCKET_RIGHT, POCKET_ENTRY_X
// und goldSurfaceY. Eine Kreatur, die nur in einer Pocket-Dimension existiert,
// deren Waende kennt und deren Boden abtastet, gehoert nicht ins Fundament.
//
// Der Weg zurueck laeuft ueber zwei Punkte, beide an exakt der alten Stelle
// im Frame: 'update' fuer die Simulation und 'drawCreatures' am Ende von
// drawAnimals() fuer das Zeichnen.
// =========================================================

// Gold Dimension hazard: 3-5 bouncing "Gold Slime" balls per pocket run —
// no damage on touch, just a flash-freeze (see player.goldFrozenTimer).
let goldSlimes = [];

// =========================================================
// GOLD SLIMES — bouncing yellow balls with eyes, unique to the Gold
// Dimension pocket run. No damage on touch, just a 5s flash-freeze (see
// player.goldFrozenTimer / GOLD_FREEZE_DURATION). Spawned once per run in
// beginPocketRun, cleared in endPocketRun.
// =========================================================
function spawnGoldSlimes() {
  goldSlimes = [];
  const count = seededInt(3, 5, 'gs-count');
  for (let i = 0; i < count; i++) {
    let wx, tries = 0;
    do { wx = seededInt(POCKET_LEFT + 20, POCKET_RIGHT - 20, 'gs-x', i, tries++); }
    while (Math.abs(wx - POCKET_ENTRY_X) < 14 && tries < 8); // steer clear of the landing spot
    const sy = goldSurfaceY(wx);
    goldSlimes.push({
      x: wx * TILE, y: (sy - 3) * TILE,
      vx: (seededRandom('gs-dir', i) < 0.5 ? -1 : 1) * (0.6 + seededRandom('gs-spd', i) * 0.5),
      vy: 0, w: 30, h: 30, onGround: false,
      hopCooldown: 30 + seededInt(0, 60, 'gs-hop', i),
      scaleX: 1, scaleY: 1, // squash/stretch, punched by triggerLandingSquash/triggerTurnSquash and eased by updateCreatureSquash — same shared juice helpers the animals use
      blink: Math.floor(seededRandom('gs-blink', i) * 160) + 40
    });
  }
}

function updateGoldSlimes(dt) {
  if (!pocketActive || currentDim !== "GOLD" || pocketCollapsing) return;
  for (const s of goldSlimes) {
    s.blink -= dt;
    if (s.blink <= 0) s.blink = 140 + Math.random() * 80;
    updateCreatureSquash(s, dt);

    s.vy += GRAVITY * 0.75 * dt;
    if (s.vy > 8) s.vy = 8;
    const nextX = s.x + s.vx * dt;
    const footY = Math.floor((s.y + s.h - 2) / TILE);
    const sideX = Math.floor((nextX + (s.vx > 0 ? s.w : 0)) / TILE);
    if (isSolid(getBlock(sideX, footY)) || isSolid(getBlock(sideX, footY - 1))) { s.vx *= -1; triggerTurnSquash(s); }
    else s.x = nextX;
    // Belt-and-braces wall so a terrain gap near the pocket's edge can't let
    // one wander into the bedrock border.
    if (s.x < POCKET_LEFT * TILE) { s.x = POCKET_LEFT * TILE; s.vx = Math.abs(s.vx); }
    if (s.x + s.w > (POCKET_RIGHT + 1) * TILE) { s.x = (POCKET_RIGHT + 1) * TILE - s.w; s.vx = -Math.abs(s.vx); }

    s.y += s.vy * dt;
    const wasOnGround = s.onGround;
    s.onGround = false;
    const left = Math.floor((s.x + 3) / TILE), right = Math.floor((s.x + s.w - 3) / TILE), bottom = Math.floor((s.y + s.h) / TILE);
    for (let tx = left; tx <= right; tx++) {
      if (isSolid(getBlock(tx, bottom)) && s.vy >= 0) { s.y = bottom * TILE - s.h; s.vy = 0; s.onGround = true; break; }
    }
    if (!wasOnGround && s.onGround) {
      triggerLandingSquash(s);
      spawnDustBurst(s.x + s.w / 2, s.y + s.h);
      screenShake = Math.max(screenShake, 3);
    }
    s.hopCooldown -= dt;
    if (s.onGround && s.hopCooldown <= 0) {
      s.vy = -9;
      s.scaleX = 1.35; s.scaleY = 0.6; // anticipation squat right before the leap, eases back out via updateCreatureSquash
      s.hopCooldown = 50 + Math.random() * 70;
    }

    // Touch = flash-frozen in gold, not damage.
    if (player.goldFrozenTimer <= 0 && player.frozenTimer <= 0 && !deathPending &&
        player.x + player.w > s.x && player.x < s.x + s.w &&
        player.y + player.h > s.y && player.y < s.y + s.h) {
      player.goldFrozenTimer = GOLD_FREEZE_DURATION;
      player.vx = 0; player.vy = 0;
      addJuiceText(player.x + player.w / 2, player.y, '✨ Frozen in Gold!', '#ffd700');
      spawnJuiceBurst(player.x + player.w / 2, player.y + player.h / 2, '#ffd700', 18, 7);
      screenShake = Math.max(screenShake, 6);
      playSound('hurt');
    }
  }
}

function drawGoldSlimes() {
  if (!pocketActive || currentDim !== "GOLD") return;
  for (const s of goldSlimes) {
    const sx = s.x - drawCamX, sy = s.y - drawCamY;
    // A subtle always-on jelly wobble on top of the event-driven squash, so
    // it reads as squishy rubber even between hops.
    const wob = Math.sin(frameCount * 0.1 + s.x * 0.05) * 0.05;
    ctx.save();
    ctx.translate(sx + s.w / 2, sy + s.h / 2);
    ctx.scale(s.scaleX * (1 + wob), s.scaleY * (1 - wob));
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.ellipse(0, s.h / 2 - 2, s.w * 0.45, 4, 0, 0, Math.PI * 2); ctx.fill();
    const grad = ctx.createRadialGradient(-s.w * 0.15, -s.h * 0.2, s.w * 0.05, 0, 0, s.w * 0.55);
    grad.addColorStop(0, '#fff4b0');
    grad.addColorStop(0.45, '#ffd700');
    grad.addColorStop(1, '#c99400');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.ellipse(0, 0, s.w / 2, s.h / 2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath(); ctx.ellipse(-s.w * 0.18, -s.h * 0.22, s.w * 0.22, s.h * 0.14, -0.4, 0, Math.PI * 2); ctx.fill();
    const blinking = s.blink < 8;
    const eyeR = s.w * 0.15, eyeDX = s.w * 0.19, eyeY = -s.h * 0.04;
    if (blinking) {
      ctx.strokeStyle = '#4a3300'; ctx.lineWidth = s.w * 0.06;
      ctx.beginPath(); ctx.moveTo(-eyeDX - eyeR, eyeY); ctx.lineTo(-eyeDX + eyeR, eyeY);
      ctx.moveTo(eyeDX - eyeR, eyeY); ctx.lineTo(eyeDX + eyeR, eyeY); ctx.stroke();
    } else {
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(-eyeDX, eyeY, eyeR, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(eyeDX, eyeY, eyeR, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#1a1a1a';
      const pupilR = eyeR * 0.55;
      ctx.beginPath(); ctx.arc(-eyeDX + eyeR * 0.2, eyeY + eyeR * 0.2, pupilR, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(eyeDX + eyeR * 0.2, eyeY + eyeR * 0.2, pupilR, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
}

// order 10, damit die Slimes wie bisher NACH der Graph-Runtime aus
// voxeria-modding.js laufen. Ohne die Zahl entschiede die Anmeldereihenfolge,
// und diese Datei laedt vor modding, der Ablauf waere also still vertauscht.
//
// Gegenueber frueher laufen sie zwei Anweisungen frueher im Frame, naemlich vor
// updateSelectedBlockPopup() und updateDayNightCycle(). Beide sind reine
// Zaehler, die kein Slime liest, das Verhalten ist also unveraendert.
VxHooks.on('update', updateGoldSlimes, 10);
VxHooks.on('drawCreatures', drawGoldSlimes);

// =========================================================
// ANMELDUNG BEI DER ENGINE
// =========================================================
// Bis hierher stand in voxeria-engine.js woertlich updatePocketDimension(),
// drawDimForge(), checkPortal() und so weiter: die Engine kannte jedes
// Feature dieser Datei beim Namen. Damit lief der Pfeil nach oben, in eine
// Datei, die erst nach ihr geladen wird, und der Abhaengigkeitsgraph war ein
// Ring statt eines Stapels (nachzaehlbar mit `node tools/check.js deps`).
//
// Jetzt meldet sich diese Datei selbst an. Die Engine macht nur noch benannte
// Punkte auf und weiss nicht, wer daran haengt. Aufrufreihenfolge und
// Aufrufzeitpunkt sind unveraendert, es ist dieselbe Stelle im Frame.
//
// Die Reihenfolge der on()-Aufrufe IST die Aufrufreihenfolge. Deshalb steht
// drawErgStormWarning vor drawPocketCollapseOverlay: das Collapse-Kino lag
// schon vorher darueber und muss oben bleiben.
// Weltneustart: ein laufender Pocket-Run ist damit verloren, und alles, was
// von ihm noch am Bildschirm haengt, muss weg, damit nichts in die frische
// Welt leckt. Diese neun Zeilen standen bis eben in resetGameAndWorld() in
// voxeria-engine.js.
VxHooks.on('worldReset', function () {
  pocketActive = false; pocketCollapsing = false; pocketMeteor = null;
  pocketEntryInventory = null; pocketTimer = 0; pocketCollapseTimer = 0;
  hidePocketTimer();
  hideOceanOxygenBar();
  playerOxygen = OXYGEN_MAX; playerDrowning = false;
});
// Zeitlauf-Regel der Gold-Dimension: rohes Gold ohne die Goldene Aegis
// abzubauen destabilisiert die ganze Tasche sofort, ohne zweite Chance. Einen
// Goldziegel aus dem Tempel zu schlagen zieht stattdessen Zeit vom
// Einsturz-Timer ab, ein bewusstes "die Ruine lebt" Risiko, das die anderen
// drei Pocket-Dimensionen nicht haben.
VxHooks.on('blockMined', function (wx, wy, block) {
  if (currentDim !== "GOLD" || !pocketActive || pocketCollapsing) return;
  if (block === BLOCKS.GOLD_ORE && !equippedArmor.has('GOLD')) {
    startPocketCollapse();
  } else if (block === BLOCKS.GOLD_BRICK) {
    pocketTimer = Math.max(0, pocketTimer - 900); // -15s
    updatePocketTimerHud();
    addJuiceText(wx*TILE+TILE/2, wy*TILE, '⏳ -15s!', '#ffcc33');
  }
});

// Multiplayer ist verbunden: eigene Firebase-Stroeme aufmachen.
VxHooks.on('multiplayerReady', subscribePocketRuns);

// Der Spieler steht in einem Portalblock. Wohin es geht, weiss nur diese Datei.
VxHooks.on('enterPortal', doTeleport);

// Tod in einer Pocket-Dimension. Es fallen keine Blocke, weil die ganze Welt
// gleich zerstoert wird: der Lauf endet einfach, die Beute dieses Laufs ist
// verloren und der Spieler wird an die Oberflaeche zurueckgeworfen.
//
// Der Rueckgabewert ist die ganze Absprache. true heisst "ich habe das Sterben
// uebernommen, misch dich nicht ein". Beim laufenden Einsturz-Kino ist das
// ebenfalls true, aber ohne deathPending zu setzen, denn dort gehoert das Ende
// schon jemand anderem und die Engine soll auch nichts nachholen.
VxHooks.on('playerDeath', function (beansprucht) {
  if (beansprucht || !pocketActive) return;
  if (pocketCollapsing) return true;
  deathPending = true;
  VxHooks.run('gameEvent', 'onDeath', {});
  spawnPlayerExplosion();
  showNotification('💀 You died! Hurled back to the surface.');
  setTimeout(() => { endPocketRun(true); deathPending = false; }, 1400);
  return true;
});

// Fortschritt aus der Cloud holen. Die Verzoegerung ueber DOMContentLoaded
// stand bis eben ganz oben in voxeria-engine.js, weil loadProgressFromCloud()
// Zustand anfasst, der in DIESER Datei mit `let` deklariert wird und beim
// Parsen der Engine noch in seiner temporalen Todeszone lag. Hier unten, hinter
// allen Deklarationen, gibt es dieses Problem nicht mehr, aber der Aufruf muss
// weiterhin warten, bis das Dokument steht.
(function _bootStandaloneProgress() {
  function run() { try { loadProgressFromCloud(); } catch (e) { console.error("loadProgressFromCloud error:", e); } }
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', run);
  else run();
})();

// Eigene Dimensionen erzeugen. Die Reihenfolge ist die alte: erst die
// Pocket-Dimensionen, dann die Arena, denn die Arena ist keine eigene
// Dimension, sondern eine leere Overworld im Arena-Modus, und wuerde sie
// zuerst greifen, bekaeme eine Pocket-Dimension im Arena-Modus die falsche.
//
// Beide fuellen chunk direkt. decoratePocketChunk laeuft ueber localSetBlock
// und muss deshalb warten, bis der Chunk registriert ist, deshalb reicht es
// als decorate() zurueck statt selbst zu laufen. Die Arena braucht das nicht:
// ihre Startplattform steckt schon in generateArenaChunk und MUSS generiert
// sein, sonst landete sie nicht in worldEdits und waere nach dem Runden-Reset
// weg.
VxHooks.on('generateChunk', function (beansprucht, cx, chunk) {
  if (beansprucht) return;
  if (POCKET_DIMS.has(currentDim)) {
    generatePocketChunk(cx, chunk);
    return { decorate: decoratePocketChunk };
  }
  if (currentDim === 'OVERWORLD' && gameMode === 'arena') {
    generateArenaChunk(cx, chunk);
    return {};
  }
});

VxHooks.on('updateLate', updatePocketDimension);
VxHooks.on('updateLate', updateDimForge);
VxHooks.on('drawWorld', drawDimForge);
VxHooks.on('drawOverlay', drawErgStormWarning);
VxHooks.on('drawOverlay', drawPocketCollapseOverlay);
// Beide pruefen intern selbst, ob die Platzierung ueberhaupt etwas vollendet
// hat, und beide sind auf ihre Dimension beschraenkt. Sie sehen deshalb jeden
// gesetzten Block, genau wie vorher.
VxHooks.on('blockPlaced', checkPortal);
VxHooks.on('blockPlaced', checkArmorAltar);
