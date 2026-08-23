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

function getChunk(cx, targetDim = currentDim) {
  let cmap = dimensions[targetDim];
  if (cmap.has(cx)) return cmap.get(cx);

  let oldDim = currentDim;
  currentDim = targetDim;
  const chunk = new Uint8Array(CHUNK_W * WORLD_H);

  // ── POCKET DIMENSIONS (GOLD / OCEAN / LAVA / VOID) ──
  // Bounded, salted, single-landmark generation. Terrain is filled directly
  // into `chunk`; decorations + the one guaranteed landmark are placed via
  // localSetBlock AFTER the chunk is registered in the map (so cross-boundary
  // writes land in real chunks). See generatePocketChunk / decoratePocketChunk.
  if (POCKET_DIMS.has(currentDim)) {
    generatePocketChunk(cx, chunk);
    cmap.set(cx, chunk);
    decoratePocketChunk(cx);
    currentDim = oldDim;
    return chunk;
  }

  // ── ARENA-WELT ──
  // Die leere Leinwand des Arena-Modus (siehe generateArenaChunk oben). Steht
  // VOR der Overworld-Generierung, weil sie nichts davon will: keine Biome,
  // keine Erze, keine Hoehlen, keine Doerfer, keine Welt-Ereignisse. Wuerde sie
  // durchfallen, liefe der gesamte Rumpf dieser Funktion trotzdem durch und
  // fuellte die Arena mit Terrain.
  //
  // Keine Dekorationsrunde wie bei den Pockets: die Startplattform steckt schon
  // in generateArenaChunk. Sie muss GENERIERT sein und darf nicht ueber
  // localSetBlock kommen -- sonst landete sie nicht in worldEdits (der
  // Generator umgeht das absichtlich) und waere nach dem Runden-Reset weg.
  if (currentDim === 'OVERWORLD' && typeof gameMode !== 'undefined' && gameMode === 'arena') {
    generateArenaChunk(cx, chunk);
    cmap.set(cx, chunk);
    currentDim = oldDim;
    return chunk;
  }

  // OVERWORLD
  const surfaceY = new Array(CHUNK_W);
  const colBiome = new Array(CHUNK_W);
  // Der Chunk-Aufkleber. Wird nur noch fuer Dinge gebraucht, die eine Antwort
  // fuer die ganze Gegend brauchen (Ruinen-Wurf, Bauwerks-Material), nicht mehr
  // fuer den Boden selbst.
  const biome = getBiome(cx);

  // Der frühere Rand-Blend ist weg: er mischte die Hoehe ueber 6 Spalten linear
  // und wuerfelte das Biom pro Spalte aus, weil getBiome() nur chunkweise
  // antworten konnte. Beides erledigt jetzt das Klimafeld selbst
  // (getSnowWeight/isSnowColumn in voxeria-engine.js). Die Hoehe ist dort ohnehin
  // stetig, weil sie den Schneeanteil pro Block liest statt ein Ja/Nein pro
  // Chunk; der Uebergang laeuft dadurch ueber rund vier Chunks statt ueber
  // sechs Spalten, und er sitzt da, wo das Klima ihn hinlegt, statt auf einer
  // Chunk-Grenze.
  for (let i = 0; i < CHUNK_W; i++) {
    const wx = cx * CHUNK_W + i;
    surfaceY[i] = Math.floor(getBiomeHeight(wx));
    colBiome[i] = isSnowColumn(wx) ? "SNOW" : "FOREST";
  }

  // The VILLAGE HOUSE that used to be rolled here (Forest, 15% of chunks) is
  // gone by request, and with it the terrain flattening it needed: nine
  // columns of surfaceY were forced to one height to give the house a level
  // plot. That flattening was the only thing in this function that overrode
  // the height field, so the ground here is now purely what getBiomeHeight
  // produced.
  //
  // Deliberately kept: the RUINS further down (5% of Forest/Snow chunks) and
  // the COAL MINE chamber variant in the cave carver.

  // ══════════════════════════════════════════════════════════
  // ROCK: THE DENSITY FIELD
  // ══════════════════════════════════════════════════════════
  // Everything above this point is a HEIGHTMAP: exactly one surface row per
  // column. That is a silhouette you could draw without lifting the pen, which
  // is why the world could only ever be hills, however dramatic the height
  // function got. An overhang needs two surfaces in one column, so it cannot be
  // expressed at all up there. This is where the terrain stops being a line and
  // becomes rock.
  //
  // The two hand-written passes that used to sit here are gone. One undercut
  // the foot of a cliff, the other let the top two rows stick out over a drop.
  // Between them they could produce exactly one shape, and every further shape
  // would have needed its own pass with its own rules. terrainSolidAt() in
  // voxeria-engine.js answers a single question instead, "is there rock at this
  // spot", and overhangs, arches, free-standing pillars and cave mouths are all
  // the same answer to it.
  //
  // Still true, and still the reason nothing here calls getBlock(): this runs
  // BEFORE cmap.set(). getBlock()/localSetBlock() reach across chunk borders
  // and pull neighbouring chunks into existence, so calling one from here,
  // while this chunk is not yet in the map, would recurse into getChunk() for
  // the neighbour, which would do the same back. The cave carver further down
  // is allowed to use them precisely because it runs after cmap.set().

  // The ruins' plot is reserved from all of it. That structure is drawn from a
  // fixed layout grid against ONE surface row (see the ruins block further
  // down), so a hollow or a shelf inside its footprint would leave it
  // straddling a hole or half-buried.
  //
  // Rolled HERE and read there, rather than rolled twice: both rolls are pure
  // hashes of cx and would agree today, but two copies of the same decision is
  // exactly the kind of thing that drifts apart the first time somebody tunes
  // one of them.
  // Ruinen liegen jetzt auf dem Feature-Gitter (featureWinner in
  // voxeria-engine.js) statt auf einem freien 5%-Wurf. Der freie Wurf konnte
  // zwei Ruinen in benachbarte Chunks legen, und zwei gleiche Bauwerke in
  // Sichtweite nehmen beiden das Besondere. Die Torwahrscheinlichkeit steht auf
  // 8 %, weil das Gitter sie auf gemessene 5,5 % ausduennt; die Haeufigkeit
  // bleibt also praktisch wie vorher, nur der Mindestabstand ist neu.
  const hasRuins = (biome === "FOREST" || biome === "SNOW") && cx !== 0
                && featureWinner(cx, 5, 0.08, NOISE_CH.RUINS);
  const ruinX = seededInt(3, Math.max(4, CHUNK_W - 22), 'r-x', cx);
  const RUIN_W = 21;   // widest row of the layout grid below
  const reservedCol = new Array(CHUNK_W).fill(false);
  if (hasRuins) {
    for (let i = 0; i < RUIN_W; i++) if (ruinX + i < CHUNK_W) reservedCol[ruinX + i] = true;
  }

  const CLIFF_SLOPE = 1.4;  // height change per column that reads as a cliff face
  const TREE_LINE   = 32;   // above this row, ground is bare rock

  // ── The wide working buffer ──────────────────────────────────────────────
  // The rock is built across a window that overhangs the chunk by MARGIN
  // columns on each side, and only the middle is kept. This is what finally
  // fixes the chunk seam, which the old passes could not: they noted that the
  // neighbour "cannot be read from here at all", and that was true of the
  // neighbour's CHUNK, but not of its terrain. Height and density are pure
  // functions of world position, so the neighbouring columns can simply be
  // recomputed here without touching getChunk() and without any recursion.
  //
  // That matters for one step only, and it matters completely: deciding what
  // is still attached to the ground. A piece of rock held up by something two
  // columns into the next chunk looks unsupported when you can only see this
  // chunk, and deleting it carves a notch straight down the chunk boundary.
  // Under the old, deliberately tiny carves that was a rare nick. Under a
  // density field, formations are the size of the margin, and it would have
  // been a visible scar on every seam in the world.
  const MARGIN = 24;
  const WIDE = CHUNK_W + MARGIN * 2;
  const baseX = cx * CHUNK_W - MARGIN;

  const wSurf = new Int32Array(WIDE);
  for (let i = 0; i < WIDE; i++) wSurf[i] = Math.floor(getBiomeHeight(baseX + i));

  const wSlope = new Float32Array(WIDE);
  for (let i = 0; i < WIDE; i++) {
    const a = Math.max(0, i - 1), b = Math.min(WIDE - 1, i + 1);
    wSlope[i] = b > a ? Math.abs(wSurf[b] - wSurf[a]) / (b - a) : 0;
  }

  // 1 = rock, 0 = air. Bedrock row is forced solid: it is the anchor the
  // support check floods out from.
  const wRock = new Uint8Array(WIDE * WORLD_H);
  for (let i = 0; i < WIDE; i++) {
    const wx = baseX + i;
    const sy = wSurf[i];
    const inChunk = i - MARGIN;
    const reserved = inChunk >= 0 && inChunk < CHUNK_W && reservedCol[inChunk];
    const gates = densityGates(wSlope[i], wx);
    const gUp = reserved ? 0 : gates.up;
    const gDn = reserved ? 0 : gates.down;
    // Outside the band the answer is the plain heightmap, so it is filled
    // directly rather than asked for: that is seven eighths of the world, and
    // asking would mean a simplex evaluation for every one of those cells.
    const bandTop = Math.max(0, sy - DENSITY_UP);
    const bandBot = Math.min(WORLD_H - 2, sy + DENSITY_DOWN);
    for (let y = bandTop; y <= bandBot; y++) {
      if (terrainSolidAt(wx, y, sy, gUp, gDn)) wRock[y * WIDE + i] = 1;
    }
    for (let y = bandBot + 1; y < WORLD_H; y++) wRock[y * WIDE + i] = 1;
  }

  // ── Support: what is still attached to the ground ────────────────────────
  // The field does not know about gravity, so it will leave rock hanging in
  // mid-air. Most of that is crumbs, a block or three shaved off a ledge, and
  // it looks like a bug because it is one. But a genuine arch that has lost its
  // second leg, or a slab left standing off a cliff, is a landmark, and the old
  // rule (delete everything not connected to bedrock) could not tell the two
  // apart because it never asked how big the piece was.
  //
  // So each disconnected piece is measured, and it survives if it is big
  // enough AND its region allows floating rock at all. Everything else goes.
  //
  // A piece that reaches the edge of the wide window is KEPT without asking.
  // Its true extent is unknown from here, so it may well be connected to
  // bedrock somewhere further along, and keeping it is the harmless mistake:
  // an extra formation nobody notices, rather than a hole where the world
  // stops. It also makes the decision consistent between neighbouring chunks,
  // which see the same rock through different windows.
  const MIN_ISLAND = 10;
  const wSup = new Uint8Array(WIDE * WORLD_H);
  const stack = [];
  for (let i = 0; i < WIDE; i++) {
    const k = (WORLD_H - 1) * WIDE + i;
    if (wRock[k]) { wSup[k] = 1; stack.push(k); }
  }
  while (stack.length) {
    const k = stack.pop();
    const x = k % WIDE, y = (k - x) / WIDE;
    const visit = n => { if (!wSup[n] && wRock[n]) { wSup[n] = 1; stack.push(n); } };
    if (x > 0) visit(k - 1);
    if (x < WIDE - 1) visit(k + 1);
    if (y > 0) visit(k - WIDE);
    if (y < WORLD_H - 1) visit(k + WIDE);
  }

  const seen = new Uint8Array(WIDE * WORLD_H);
  const comp = [];
  for (let k0 = 0; k0 < wRock.length; k0++) {
    if (!wRock[k0] || wSup[k0] || seen[k0]) continue;
    comp.length = 0;
    comp.push(k0); seen[k0] = 1;
    let head = 0, touchesEdge = false, sumX = 0;
    while (head < comp.length) {
      const k = comp[head++];
      const x = k % WIDE, y = (k - x) / WIDE;
      if (x === 0 || x === WIDE - 1) touchesEdge = true;
      sumX += x;
      const visit = n => { if (wRock[n] && !wSup[n] && !seen[n]) { seen[n] = 1; comp.push(n); } };
      if (x > 0) visit(k - 1);
      if (x < WIDE - 1) visit(k + 1);
      if (y > 0) visit(k - WIDE);
      if (y < WORLD_H - 1) visit(k + WIDE);
    }
    const keep = touchesEdge ||
      (comp.length >= MIN_ISLAND && floatingAllowed(baseX + Math.round(sumX / comp.length)));
    if (!keep) for (let n = 0; n < comp.length; n++) wRock[comp[n]] = 0;
  }

  // ── Out of the window and into the chunk ─────────────────────────────────
  // Everything solid becomes STONE here; the surface pass below repaints the
  // top rows as grass or dirt. Filling soil in first (as the heightmap version
  // did) and correcting it afterwards produced the same result by a longer
  // route, and only worked because the correction ran over every row anyway.
  for (let y = 0; y < WORLD_H; y++) {
    for (let i = 0; i < CHUNK_W; i++) {
      chunk[y * CHUNK_W + i] = y === WORLD_H - 1 ? BLOCKS.BEDROCK
                             : (wRock[y * WIDE + MARGIN + i] ? BLOCKS.STONE : BLOCKS.AIR);
    }
  }

  const slope = new Array(CHUNK_W);
  for (let i = 0; i < CHUNK_W; i++) slope[i] = wSlope[MARGIN + i];

  // Steep ground and high ground carry no soil. Free realism: the shape is
  // already there, this only stops it being carpeted in grass, and it is what
  // makes a cliff read as rock rather than as a very abrupt lawn.
  const bareRock = new Array(CHUNK_W).fill(false);
  for (let i = 0; i < CHUNK_W; i++) {
    if (reservedCol[i]) continue;
    if (slope[i] >= CLIFF_SLOPE || surfaceY[i] < TREE_LINE) bareRock[i] = true;
  }

  // ── Surface material, and where the surface now actually is ──────────────
  // Re-derived from the finished rock rather than from the heightmap, because
  // the density field has moved it: a shelf gives a column a new and much
  // higher top, a hollow can leave a ledge thinner than the soil band, and an
  // arch puts the top of the column a dozen rows above the ground under it.
  // Every later stage (ore depth, trees, ruins, caves, spawn) reads surfaceY,
  // so this is the point where it has to become true again.
  for (let i = 0; i < CHUNK_W; i++) {
    let top = -1;
    for (let y = 0; y < WORLD_H; y++) {
      if (chunk[y * CHUNK_W + i] !== BLOCKS.AIR) { top = y; break; }
    }
    if (top < 0) { surfaceY[i] = WORLD_H - 1; continue; }
    surfaceY[i] = top;
    const rock = bareRock[i];
    chunk[top * CHUNK_W + i] = rock ? BLOCKS.STONE : BLOCKS.GRASS;
    for (let d = 1; d <= 3; d++) {
      const y = top + d;
      if (y >= WORLD_H - 1) break;
      const idx = y * CHUNK_W + i;
      // Air here means the ledge is thinner than the soil band would be; the
      // band simply stops rather than being painted into the void below.
      if (chunk[idx] === BLOCKS.AIR) break;
      chunk[idx] = rock ? BLOCKS.STONE : BLOCKS.DIRT;
    }
    // Nothing below the first four rows keeps soil: dirt sitting under an
    // overhang's roof, with no sky above it, is exactly the giveaway that a
    // world was carved rather than grown.
    for (let y = top + 4; y < WORLD_H - 1; y++) {
      const idx = y * CHUNK_W + i;
      if (chunk[idx] === BLOCKS.DIRT || chunk[idx] === BLOCKS.GRASS) chunk[idx] = BLOCKS.STONE;
    }
  }

  cmap.set(cx, chunk);

  // Ore rarity — one gate roll per chunk per tier. Most chunks contain NONE
  // of a given ore at all; only on a "win" does the chunk get exactly one
  // organic vein.
  // chunkOreWon is also read further below by the cave-chamber-wall ore
  // decoration, so caves can't sneak in extra ore beyond this same budget.
  const ORE_TIERS = [
    { key: 'COAL',    block: BLOCKS.COAL_ORE,    minDepth: 4,  chance: 0.25,  sizeMin: 3, sizeMax: 6 },
    { key: 'IRON',    block: BLOCKS.IRON_ORE,    minDepth: 8,  chance: 0.15,  sizeMin: 3, sizeMax: 5 },
    { key: 'GOLD',    block: BLOCKS.GOLD_ORE,    minDepth: 15, chance: 0.08,  sizeMin: 2, sizeMax: 4 },
    { key: 'DIAMOND', block: BLOCKS.DIAMOND_ORE, minDepth: 25, chance: 0.05,  sizeMin: 1, sizeMax: 3 },
    { key: 'RAINBOW', block: BLOCKS.RAINBOW_ORE, minDepth: 35, chance: 0.02,  sizeMin: 1, sizeMax: 2 },
    // Player-authored ore pieces (see registerCustomBlockPieces, ~4900) —
    // same tier shape, same vein-growth loop below, nothing else changes.
    ...customOreTiers,
  ];
  const chunkOreWon = {};
  for (const tier of ORE_TIERS) {
    const won = seededRandom('ore-tier-win', cx, tier.block) < tier.chance;
    chunkOreWon[tier.key] = won;
    if (!won) continue;
    const seedI = seededInt(0, CHUNK_W - 1, 'vein-x', cx, tier.block);
    const minY = surfaceY[seedI] + tier.minDepth;
    if (minY >= WORLD_H - 5) continue;
    const seedY = seededInt(minY, WORLD_H - 4, 'vein-y', cx, tier.block);
    const veinSize = seededInt(tier.sizeMin, tier.sizeMax, 'vein-size', cx, tier.block);
    // Branch from a random existing member each step (coordinates clamped
    // in-bounds) so the blob stays compact and connected, instead of a free
    // random walk that can drift out of the chunk and fragment into specks.
    const members = [[seedI, seedY]];
    if (chunk[seedY * CHUNK_W + seedI] === BLOCKS.STONE) chunk[seedY * CHUNK_W + seedI] = tier.block;
    for (let n = 1; n < veinSize; n++) {
      const [px, py] = members[seededInt(0, members.length - 1, 'vein-branch', cx, tier.block, n)];
      const nx = Math.max(0, Math.min(CHUNK_W - 1, px + seededInt(-1, 1, 'vein-walk-x', cx, tier.block, n)));
      const ny = Math.max(1, Math.min(WORLD_H - 2, py + seededInt(-1, 1, 'vein-walk-y', cx, tier.block, n)));
      members.push([nx, ny]);
      if (chunk[ny * CHUNK_W + nx] === BLOCKS.STONE) chunk[ny * CHUNK_W + nx] = tier.block;
    }
  }

  // Decoration
  // Tracks the last column a tree's trunk landed on, so consecutive rolls
  // within this chunk can't plant two trees close enough for their crowns to
  // interlock into one hard-edged, mismatched-colour blob (see
  // TREE_MIN_SPACING's comment in voxeria-engine.js). Chunk-local only — a
  // tree right at a chunk boundary can still end up close to one in the
  // neighbouring chunk, same as real forest edges are uneven, not a perfect grid.
  let lastTreeX = -Infinity;

  // Hier stand ein Versuch, Baumgruppen per Micro-Varianz pro Chunk zu steuern,
  // erst ueber den Spaltenwurf, dann ueber den Mindestabstand. Beides ist
  // gemessen wirkungslos und wurde wieder entfernt, weil keiner der beiden am
  // Flaschenhals sitzt: von den bestandenen Wuerfen scheitern **91 % am Boden**
  // (kein Gras, weil Fels oder Ueberhangdach) und nur **0,2 % am Abstand**.
  // Wie dicht ein Waldstueck wird, entscheidet also allein, wie viel Gras das
  // Gelaende dort uebrig laesst. Das ist kein Mangel: Baumgruppen folgen damit
  // der Landschaft (Haine wo Erde liegt, Lichtungen auf Fels) statt einem
  // zweiten, unabhaengigen Regler daneben. Enger stellen ginge ohnehin nicht,
  // die halbe Kronenbreite ist nachgemessen 3, zwei Baeume im Abstand 6
  // beruehren sich also schon.

  for (let i = 0; i < CHUNK_W; i++) {
    const worldX = cx * CHUNK_W + i;
    const sy = surfaceY[i];

    const r = seededRandom('decor', cx, i);
    const cb = colBiome[i];

    // Both biomes' trees come out of the shared planTree() generator (see
    // voxeria-engine.js) rather than the fixed silhouette each used to hard-code
    // here, so they vary in height, crown and branching — and so a tree that
    // grows in later looks like the ones that were always there. The rand()
    // passed in is seeded per column, which keeps world-gen trees identical on
    // every regeneration of the same chunk.
    if (cb === "SNOW") {
      if (r < 0.06 && getBlock(worldX, sy) === BLOCKS.GRASS && worldX - lastTreeX >= TREE_MIN_SPACING) {
        let n = 0;
        const tiles = planTree(worldX, sy, 'SNOW', () => seededRandom('snow-tree', cx, i, n++));
        if (tiles) { for (const t of tiles) localSetBlock(t.x, t.y, t.b); lastTreeX = worldX; }
      }
    } else { // FOREST
      if (r < 0.08 && isGrassOrDirt(worldX, sy) && worldX - lastTreeX >= TREE_MIN_SPACING) {
        let n = 0;
        const tiles = planTree(worldX, sy, 'FOREST', () => seededRandom('forest-tree', cx, i, n++));
        if (tiles) { for (const t of tiles) localSetBlock(t.x, t.y, t.b); lastTreeX = worldX; }
      }
      // Flowers no longer spawn here (used to be r < 0.2 && canSpawnFlowerAt(...)).
      // BLOCKS.FLOWER, canSpawnFlowerAt(), and every other flower-adjacent
      // function are left in place rather than deleted — same call as the
      // 'snow' weather removal: an untouched enum id and untouched drawing
      // code cost nothing, and it means a mod or an old save that already
      // placed a flower still renders it correctly instead of crashing on an
      // unrecognised block.
    }
  }


  // ══════════════════════════════════════════════════════════
  // CAVE SYSTEM — Worm Carving (OVERWORLD only)
  // ══════════════════════════════════════════════════════════
  const midSY = surfaceY[Math.floor(CHUNK_W / 2)];

  // 1–2 cave worms per chunk
  const numWorms = 1 + (seededRandom('cave-count', cx) > 0.65 ? 1 : 0);
  for (let w = 0; w < numWorms; w++) {
    const startLX = seededInt(0, CHUNK_W - 1, 'cave-wx', cx, w);
    let cwx = cx * CHUNK_W + startLX;
    let cwy = midSY + 12 + seededInt(0, 30, 'cave-wy', cx, w);
    if (cwy >= WORLD_H - 8) continue;

    let angle = seededRandom('cave-angle', cx, w) * Math.PI * 2;
    const wormLen = 30 + seededInt(0, 40, 'cave-len', cx, w);
    const baseRadius = 2.2 + seededRandom('cave-base-r', cx, w) * 1.8;

    for (let step = 0; step < wormLen; step++) {
      angle += (seededRandom('cave-turn', cx, w, step) - 0.5) * 0.7;
      const r = baseRadius + Math.sin(step * 0.4) * 0.8;
      const ry = r * 0.65;

      for (let dx2 = -Math.ceil(r); dx2 <= Math.ceil(r); dx2++) {
        for (let dy2 = -Math.ceil(ry); dy2 <= Math.ceil(ry); dy2++) {
          if ((dx2 * dx2) / (r * r) + (dy2 * dy2) / (ry * ry) <= 1) {
            const bx = Math.floor(cwx + dx2);
            const by = Math.floor(cwy + dy2);
            const localX = bx - cx * CHUNK_W;
            const minDepth = (localX >= 0 && localX < CHUNK_W) ? surfaceY[localX] + 5 : midSY + 5;
            // Only ever eats through plain Stone — ore veins, trees and
            // structures (all placed earlier in generation) already sit in
            // this depth range, and a worm carving through one unconditionally
            // would silently delete it or gut a wall from inside a build.
            if (by >= minDepth && by < WORLD_H - 3 && getBlock(bx, by) === BLOCKS.STONE) {
              localSetBlock(bx, by, BLOCKS.AIR);
            }
          }
        }
      }
      cwx += Math.cos(angle) * 1.6;
      cwy += Math.sin(angle) * 0.45;
      cwy = Math.max(midSY + 8, Math.min(WORLD_H - 10, cwy));
    }

    // ── Chamber at worm endpoint (50% chance) ──
    if (seededRandom('cave-chamber', cx, w) > 0.5) {
      const chR  = 5 + seededInt(0, 5, 'ch-r', cx, w);
      const chRY = Math.floor(chR * 0.65);
      const chX  = Math.floor(cwx);
      const chY  = Math.floor(cwy);

      for (let dx2 = -chR; dx2 <= chR; dx2++) {
        for (let dy2 = -chRY; dy2 <= chRY; dy2++) {
          if ((dx2*dx2)/(chR*chR) + (dy2*dy2)/(chRY*chRY) <= 1) {
            const bx = chX + dx2, by = chY + dy2;
            const localX = bx - cx * CHUNK_W;
            const minD = (localX >= 0 && localX < CHUNK_W) ? surfaceY[localX] + 5 : midSY + 5;
            if (by >= minD && by < WORLD_H - 3 && getBlock(bx, by) === BLOCKS.STONE) localSetBlock(bx, by, BLOCKS.AIR);
          }
        }
      }

      // Chamber variant — most read as natural caverns, but roughly a quarter
      // are an old coal mine's dig. Picked once per chamber so its decoration
      // and loot stay internally consistent.
      const caveDepth = chY - midSY;
      const chamberVariant = seededRandom('cave-variant', cx, w) < 0.25 ? 'coalmine' : 'natural';

      if (chamberVariant === 'natural') {
        // Stalactites (from ceiling)
        for (let dx2 = -chR + 1; dx2 < chR; dx2++) {
          if (seededRandom('stal-t', cx, w, dx2 + 50) < 0.45) {
            const bx = chX + dx2;
            const topY = chY - chRY + 1;
            const len = 1 + seededInt(0, 4, 'stal-tl', cx, w, dx2);
            for (let s = 0; s < len; s++) {
              const by = topY + s;
              if (getBlock(bx, by - 1) !== BLOCKS.AIR) localSetBlock(bx, by, BLOCKS.STONE);
            }
          }
        }
        // Stalagmites (from floor)
        for (let dx2 = -chR + 1; dx2 < chR; dx2++) {
          if (seededRandom('stal-b', cx, w, dx2 + 100) < 0.45) {
            const bx = chX + dx2;
            const botY = chY + chRY - 1;
            const len = 1 + seededInt(0, 4, 'stal-bl', cx, w, dx2);
            for (let s = 0; s < len; s++) {
              const by = botY - s;
              if (getBlock(bx, by + 1) !== BLOCKS.AIR) localSetBlock(bx, by, BLOCKS.STONE);
            }
          }
        }

        // Underground pool — used to be water shallow / lava deep. The water
        // half is gone: matches the surface ponds/lakes removal above, and
        // Ocean Depth is now the only dimension that ever generates WATER/
        // DEEP_WATER (see generatePocketChunk's OCEAN branch and the sunken
        // temple in buildPocketLandmark). This also removes a real gameplay
        // bug, not just a look — updatePlayer's nowInWater check re-samples
        // the block at the player's feet every frame and switches between
        // full gravity and 38%-gravity buoyancy depending on the result;
        // standing at the edge of one of these pools made that check flicker
        // between the two most frames, which read as the camera erratically
        // bobbing up and down. With no water left to trigger it outside
        // Ocean Depth, that flicker can no longer happen anywhere else.
        // Shallow caves (caveDepth <= 45) simply get no pool at all now
        // rather than a non-liquid stand-in — lava pools in deep caves are
        // untouched.
        if (caveDepth > 45 && seededRandom('cave-pool', cx, w) < 0.5) {
          const poolBlock = BLOCKS.LAVA;
          const poolW = Math.floor(chR * 0.55);
          for (let dx2 = -poolW; dx2 <= poolW; dx2++) {
            const bx = chX + dx2;
            const botY = chY + chRY - 1;
            if (getBlock(bx, botY + 1) !== BLOCKS.AIR) localSetBlock(bx, botY, poolBlock);
          }
        }

        // Torch in some chambers
        if (seededRandom('cave-torch', cx, w) < 0.35) {
          const bx = chX;
          const botY = chY + chRY - 1;
          if (getBlock(bx, botY + 1) !== BLOCKS.AIR && getBlock(bx, botY) === BLOCKS.AIR) {
            localSetBlock(bx, botY, BLOCKS.TORCH);
          }
        }

        // Ore veins on chamber walls (reward exploration) — gated by the same
        // chunkOreWon rarity roll above, so caves can't bypass the ore budget.
        if (caveDepth > 20) {
          for (let dx2 = -chR + 1; dx2 < chR; dx2++) {
            if (seededRandom('ch-ore', cx, w, dx2) < 0.12) {
              const bx = chX + dx2;
              const veinY = chY + seededInt(-chRY + 1, chRY - 1, 'ch-vy', cx, w, dx2);
              const oreBlock = (caveDepth > 40 && chunkOreWon.DIAMOND) ? BLOCKS.DIAMOND_ORE
                             : (caveDepth > 25 && chunkOreWon.GOLD) ? BLOCKS.GOLD_ORE
                             : chunkOreWon.IRON ? BLOCKS.IRON_ORE
                             : null;
              if (oreBlock && getBlock(bx, veinY) === BLOCKS.STONE) localSetBlock(bx, veinY, oreBlock);
            }
          }
        }
      } else if (chamberVariant === 'coalmine') {
        // Two timber support pillars holding up the ceiling, log posts capped
        // with a plank beam either side — an old dig, not a natural cavity.
        // Cleared with the same surface-depth safety margin as the chamber
        // ellipse above, but independently of it: a pillar column can sit
        // just outside where the ellipse itself happened to clear, and a
        // getBlock()===AIR gate would then silently skip the whole post.
        const postXs = [-Math.floor(chR * 0.5), Math.floor(chR * 0.5)];
        for (const px of postXs) {
          const bx = chX + px;
          const localX = bx - cx * CHUNK_W;
          const minD = (localX >= 0 && localX < CHUNK_W) ? surfaceY[localX] + 5 : midSY + 5;
          for (let dy2 = -chRY + 1; dy2 <= chRY - 1; dy2++) {
            const by = chY + dy2;
            if (by >= minD && by < WORLD_H - 3) localSetBlock(bx, by, BLOCKS.LOG);
          }
          localSetBlock(bx - 1, chY - chRY + 1, BLOCKS.PLANKS);
          localSetBlock(bx + 1, chY - chRY + 1, BLOCKS.PLANKS);
        }
        // Coal seam one row below the cleared floor — deliberately just
        // outside the ellipse (dy2=chRY+1 always fails the ellipse test),
        // so it's guaranteed-solid ground to embed ore into, instead of a
        // wall-vein roll that mostly lands back inside the cleared interior.
        for (let dx2 = -chR + 2; dx2 <= chR - 2; dx2++) {
          if (dx2 === postXs[0] || dx2 === postXs[1]) continue;
          if (seededRandom('cm-coal', cx, w, dx2) < 0.55) {
            const bx = chX + dx2, by = chY + chRY + 1;
            if (by < WORLD_H - 3 && getBlock(bx, by) !== BLOCKS.AIR) localSetBlock(bx, by, BLOCKS.COAL_ORE);
          }
        }
        // A mine is a lit mine
        localSetBlock(chX, chY - chRY + 2, BLOCKS.TORCH);
        localSetBlock(chX - 2, chY + chRY - 2, BLOCKS.TORCH);
        // A little Iron on top, gated by the same chunk budget as wild ore
        if (chunkOreWon.IRON) localSetBlock(chX + 2, chY + chRY - 2, BLOCKS.IRON_ORE);
      }
    }
  }

 // `hasRuins` and `ruinX` were decided up in the cliff section, which reserved
 // this footprint from being undercut. Re-rolling them here would be a second
 // copy of the same decision.
 if (hasRuins) {
  // Dein angepasstes Raster aus dem Screenshot (alle Zeilen auf 20 Zeichen ausgerichtetet)
  const layout = [
    "DDDDDDDDDDDDDDDDD    ", // Reihe 0 (Ganz oben)
    " ##............# ", // Reihe 1
    " T#.....A.....T# ", // Reihe 2
    "  #...AAAA..DDD#    ", // Reihe 3
    "  #....A...DDDD#   ", // Reihe 4
    "  ...A....DDDDD# ", // Reihe 5
    "  .......DDDDDD#    ", // Reihe 6
    " #......DDDDDDD#     ", // Reihe 7 (Direkt über dem Boden)
    "DDDDDDDDDDDDDDDDD     "  // Reihe 8 (Der feste Boden auf Oberflächenhöhe)
  ];

  const ruinH = layout.length;

  const rX = ruinX;
  const worldRX = cx * CHUNK_W + rX;
  const rY = surfaceY[rX];

  // The whole grid is drawn against this ONE surface row, so it needs ground
  // that is actually level. Before the terrain rework almost everywhere was,
  // and this went unchecked; now that cliffs and terraces are real, an
  // unchecked ruin lands half in the air on one side and buried on the other.
  // Measured across the footprint that is really used (the grid is clipped to
  // the chunk anyway).
  let plotLo = rY, plotHi = rY;
  for (let i = rX; i < Math.min(CHUNK_W, rX + RUIN_W); i++) {
    if (surfaceY[i] < plotLo) plotLo = surfaceY[i];
    if (surfaceY[i] > plotHi) plotHi = surfaceY[i];
  }
  const plotIsLevel = (plotHi - plotLo) <= 3;

  if (rY > 10 && rY < 88 && plotIsLevel) {
    const wallBlock = biome === "SNOW" ? BLOCKS.STONE : BLOCKS.PLANKS;
    const roofBlock = BLOCKS.STONE;

    // Iteriere durch das Raster von oben nach unten
    for (let r = 0; r < ruinH; r++) {
      const rowStr = layout[r];
      const targetY = rY - (ruinH - 1 - r);

      for (let dx = 0; dx < rowStr.length; dx++) {
        const char = rowStr[dx];
        const bx = worldRX + dx;

        if (char === '#') {
          localSetBlock(bx, targetY, wallBlock);
        } else if (char === 'D') {
          localSetBlock(bx, targetY, roofBlock);
        } else if (char === 'T') {
          localSetBlock(bx, targetY, BLOCKS.TORCH);
        } else if (char === '.') {
          // Ersetzt den hohlen Innenraum/Hintergrund durch die Planken-Rückwand
          localSetBlock(bx, targetY, BLOCKS.BG_PLANKS);
        } else if (char === 'A') {
          // NEU: Setzt an dieser Stelle explizit echte Luft (z.B. für Fenster oder offene Bereiche)
          localSetBlock(bx, targetY, BLOCKS.AIR);
        }
        // Leerzeichen ' ' werden übersprungen, damit die Außenwelt unberührt bleibt
      }
    }

    // Kohle/Eisen Loot im Inneren auf dem Boden — gated by the same chunk
    // rarity roll as wild ore, so ruins can't bypass the ore budget.
    if (chunkOreWon.COAL) localSetBlock(worldRX + 4, rY - 1, BLOCKS.COAL_ORE);
    if (chunkOreWon.IRON && seededRandom('r-iron', cx) < 0.5) {
      localSetBlock(worldRX + 5, rY - 1, BLOCKS.IRON_ORE);
    }
  }
}
  // The WATCHTOWERS that used to stand here (Forest/Snow, 12% of chunks) are
  // gone by request. Nothing else read them: their only outputs were blocks
  // written through localSetBlock, and their iron loot went through the same
  // chunkOreWon.IRON gate every other structure uses, so the ore budget is
  // unaffected. Their seededRandom('tower'/'t-x'/'t-h') rolls were pure hash
  // lookups rather than draws from a shared stream, so removing them leaves
  // every other roll in this chunk landing exactly where it did before.
  //
  // The ruins above and the abandoned mine shaft below are untouched.

  // ── UNDERGROUND DUNGEONS (all biomes, ~20% of chunks) ──
  if (cx !== 0 && seededRandom('dungeon', cx) < 0.20) {
    const dX = seededInt(3, CHUNK_W - 10, 'd-x', cx);
    const worldDX = cx * CHUNK_W + dX;
    const dDepth = 45 + seededInt(0, 15, 'd-depth', cx); // 45–60 blocks deep
    const dW = 7; const dH = 5;
    const dY = Math.min(surfaceY[dX] + dDepth, WORLD_H - dH - 2);
    if (dY > 20) {
      // Clear interior
      for (let dx = 1; dx < dW-1; dx++) for (let dy = 1; dy < dH-1; dy++) localSetBlock(worldDX+dx, dY+dy, BLOCKS.AIR);
      // Obsidian frame
      for (let dx = 0; dx < dW; dx++) {
        localSetBlock(worldDX+dx, dY, BLOCKS.OBSIDIAN);
        localSetBlock(worldDX+dx, dY+dH-1, BLOCKS.OBSIDIAN);
      }
      for (let dy = 0; dy < dH; dy++) {
        localSetBlock(worldDX, dY+dy, BLOCKS.OBSIDIAN);
        localSetBlock(worldDX+dW-1, dY+dy, BLOCKS.OBSIDIAN);
      }
      // Torch corners
      localSetBlock(worldDX+1, dY+1, BLOCKS.TORCH);
      localSetBlock(worldDX+dW-2, dY+1, BLOCKS.TORCH);
      // Treasure: Rainbow Ore + Diamond/Gold — gated by the same chunk rarity
      // roll as wild ore. This structure spawns in ~20% of ALL chunks, so
      // leaving its loot unconditional would make Rainbow Ore far more common
      // than intended (it was the actual cause of that bug, not the wild gen).
      if (chunkOreWon.RAINBOW) localSetBlock(worldDX+3, dY+dH-2, BLOCKS.RAINBOW_ORE);
      if (seededRandom('d-diamond', cx) < 0.5) {
        if (chunkOreWon.DIAMOND) localSetBlock(worldDX+4, dY+dH-2, BLOCKS.DIAMOND_ORE);
      } else if (chunkOreWon.GOLD) localSetBlock(worldDX+4, dY+dH-2, BLOCKS.GOLD_ORE);
    }
  }

  // ── ABANDONED MINE SHAFT (all biomes, ~12% of chunks) — a man-made,
  // timber-framed vertical shaft dug down from the surface, ending in a
  // small loot room. Unlike every other structure here it starts AT the
  // surface, so its entrance is a visible pit — a landmark you can spot
  // while walking by, not just luck while digging.
  if (cx !== 0 && seededRandom('mineshaft', cx) < 0.12) {
    const mX = seededInt(2, CHUNK_W - 4, 'ms-x', cx);
    const worldMX = cx * CHUNK_W + mX;
    const mSurfaceY = surfaceY[mX];
    const mDepth = 18 + seededInt(0, 14, 'ms-depth', cx); // 18-32 blocks down
    const mBottom = mSurfaceY + mDepth;
    if (mSurfaceY > 8 && mBottom < WORLD_H - 8) {
      // Carve the 2-wide shaft
      for (let dy = 0; dy <= mDepth; dy++) {
        localSetBlock(worldMX, mSurfaceY + dy, BLOCKS.AIR);
        localSetBlock(worldMX + 1, mSurfaceY + dy, BLOCKS.AIR);
      }
      // Timber support frames every 4-5 tiles: a plank beam spanning the
      // shaft with log posts biting into the walls either side
      for (let dy = 2; dy < mDepth; dy += 4 + seededInt(0, 1, 'ms-gap', cx, dy)) {
        localSetBlock(worldMX - 1, mSurfaceY + dy, BLOCKS.LOG);
        localSetBlock(worldMX, mSurfaceY + dy, BLOCKS.PLANKS);
        localSetBlock(worldMX + 1, mSurfaceY + dy, BLOCKS.PLANKS);
        localSetBlock(worldMX + 2, mSurfaceY + dy, BLOCKS.LOG);
        if (seededRandom('ms-torch', cx, dy) < 0.4) localSetBlock(worldMX - 1, mSurfaceY + dy - 1, BLOCKS.TORCH);
      }
      // Small room at the bottom
      for (let dx = -2; dx <= 3; dx++) for (let dy = -3; dy <= 0; dy++) localSetBlock(worldMX + dx, mBottom + dy, BLOCKS.AIR);
      for (let dx = -2; dx <= 3; dx++) localSetBlock(worldMX + dx, mBottom + 1, BLOCKS.PLANKS);
      localSetBlock(worldMX - 1, mBottom - 1, BLOCKS.TORCH);
      // Loot — gated the same way as every other structure's bonus ore
      localSetBlock(worldMX + 1, mBottom, BLOCKS.COAL_ORE);
      if (chunkOreWon.IRON) localSetBlock(worldMX + 2, mBottom, BLOCKS.IRON_ORE);
    }
  }

  // ── WORLD DIRECTOR: rare "anomalies" (retention set-pieces) ──
  // Everything above already builds a coherent, sensible world. This runs
  // last and almost always does nothing — but ~2% of chunks get one
  // deliberately special, sometimes deliberately ABSURD discovery: a hidden
  // message spelled in blocks, a meme structure that ignores the rules of a
  // normal build, or a jackpot that breaks the ore economy on purpose. These
  // are the moments players screenshot and tell their friends about, which is
  // exactly why they exist. All seeded, so a given world's anomalies are fixed
  // in place — two players on the same seed find the same wonders.
  if (cx !== 0 && seededRandom('anomaly', cx) < 0.02) {
    const kind = seededRandom('anomaly-kind', cx);
    if (kind < 0.45) placeHiddenMessage(cx, surfaceY);
    else if (kind < 0.85) placeMemeStructure(cx, surfaceY, biome);
    else placeMotherLode(cx, surfaceY);
  }

  currentDim = oldDim;
  return chunk;
}



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
    showNotification('👥 Joined a run already in progress');
  } else {
    pocketSeedOffset = (Math.random() * 1e9) | 0; // fresh layout every entry
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

// Cache of the exact 36x36 pixel-art icons the crafting cards use (see
// drawBlockMini) so the in-world hologram shows the identical art, not a
// re-implementation of it.
const _forgeIconCache = {};
function _forgeIcon(block) {
  let c = _forgeIconCache[block];
  if (!c) { c = document.createElement('canvas'); drawBlockMini(c, block); _forgeIconCache[block] = c; }
  return c;
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
