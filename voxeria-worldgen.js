// ============================================================================
// VOXERIA — WELTGENERIERUNG
// ============================================================================
// Alles, was aus einem Seed Gelaende macht, liegt ab hier in EINER Datei:
// die Rauschfelder und die Hoehenkurve, das Dichtefeld, das Feature-Gitter mit
// den drei Wahrzeichen, die Spawn-Suche, die seltenen Set-Pieces und ganz
// unten getChunk(), das all das zu echten Bloecken zusammensetzt.
//
// Vorher stand die Hoehenkurve in voxeria-engine.js und getChunk() in
// voxeria-dimensions-progress.js. Das war die eine Stelle, an der man zwei
// Dateien offen haben musste, um EINE Frage zu beantworten.
//
// LADEREIHENFOLGE: nach voxeria-engine.js (von dort kommen BLOCKS, CHUNK_W,
// WORLD_H, currentDim, dimensions, seededRandom/seededInt) und vor
// voxeria-dimensions-progress.js, dessen Pocket- und Arena-Generatoren
// getChunk() aufruft.
//
// Was BEWUSST nicht hier liegt: generatePocketChunk/decoratePocketChunk
// (Pocket-Dimensionen) und generateArenaChunk (Arena). Beide erzeugen zwar
// auch Welt, gehoeren aber inhaltlich zu ihrem jeweiligen Modus und werden von
// getChunk() nur aufgerufen. Sie bleiben in voxeria-dimensions-progress.js.
// ============================================================================

// =========================================================
// WORLD GENERATION
// =========================================================
// Channel ids keep the noise fields below (terrain, detail, mountains, biome
// temperature/variety, domain warp) statistically independent even though
// they all share the same hash function and world SEED.
// RELIEF/VALLEY/TERRACE/OVERHANG were added with the terrain overhaul; they
// keep the new fields independent of the five that were already here.
// BIOME_MIX/PLATEAU/RUGGED came with the sub-zone pass; same rule as before,
// each new field gets its own channel so it stays independent of the others.
// Channels 2 and 6 (formerly VOLCANO / BIOME_EXOTIC) are retired along with the
// biomes that used them, and left unassigned rather than renumbered: every
// other id below is a literal, so skipping them costs nothing and reusing them
// would resalt hashes that unrelated fields still depend on.
const NOISE_CH = { TERRAIN: 0, DETAIL: 1, MOUNTAIN: 3, BIOME_WARP: 4, BIOME_TEMP: 5,
                   RELIEF: 7, VALLEY: 8, TERRACE: 9, OVERHANG: 10,
                   BIOME_MIX: 11, PLATEAU: 12, RUGGED: 13,
                   DENSITY: 14, DENSITY_FINE: 15, FLOAT: 16,
                   LANDMARK: 17, RUINS: 18, MICRO: 19 };

// ── Per-column caches ─────────────────────────────────────────────────────
// getBiomeHeight() is NOT only a world-gen function: the parallax background
// renderer calls it once per visible column per frame (see drawBackgroundHills
// and the cave backdrop below), which is a few thousand calls a second. It was
// already 14 noise octaves deep before the sub-zone fields were added on top,
// so from here on the result is memoised.
//
// Direct-mapped rather than a Map: both consumers scan a contiguous run of
// columns (32 for a chunk, ~50 to 120 for the viewport), so with a table this
// size collisions inside one pass are effectively nil, and there is no
// allocation and no unbounded growth to clean up. Negative x is fine, a
// power-of-two mask on an int32 always lands in range.
const _HEIGHT_N = 4096;
const _heightX = new Int32Array(_HEIGHT_N).fill(0x7fffffff);
const _heightV = new Float32Array(_HEIGHT_N);
let _heightTok = -1;

const _SNOWCOL_N = 2048;
const _snowColX = new Int32Array(_SNOWCOL_N).fill(0x7fffffff);
const _snowColV = new Uint8Array(_SNOWCOL_N);
let _snowColTok = -1;

const _SNOWW_N = 2048;
const _snowWX = new Int32Array(_SNOWW_N).fill(0x7fffffff);
const _snowWV = new Float32Array(_SNOWW_N);
let _snowWTok = -1;

// Cheap numeric fingerprint of everything the cached values depend on. Checked
// on every lookup instead of hunting down each of the seven places that assign
// SEED or activeMod: a stale terrain cache would show up as a world that keeps
// the old landscape after loading a different save, which is exactly the kind
// of bug that survives testing because it needs two worlds in one session.
function _terrainToken() {
  const w = activeMod && activeMod.world;
  const hm = (w && w.heightMult) || 1;
  const bf = !w || !w.biomeFocus ? 0 : (w.biomeFocus === 'SNOW' ? 2 : 1);
  return ((SEED | 0) ^ Math.imul(Math.round(hm * 1024), 2654435761) ^ (bf * 40503)) | 0;
}

function hash1D(n, channel) {
  let h = (n * 374761393 + SEED * 668265263 + channel * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

// ── 2D value noise ────────────────────────────────────────────────────────
// Same construction as the 1D trio below, one dimension up. It exists for one
// reason: a heightmap cannot describe an overhang. A field sampled at (x, y)
// can, because it answers "is there rock HERE" instead of "where does the rock
// stop in this column". See the cliff pass in getChunk (voxeria-dimensions-
// progress.js), which is the only consumer.
function hash2Di(x, y, channel) {
  let h = (x * 374761393 + y * 668265263 + SEED * 1442695041 + channel * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return h >>> 0;
}
function hash2D(x, y, channel) {
  return hash2Di(x, y, channel) / 4294967296;
}

// ── 2D simplex (gradient) noise ───────────────────────────────────────────
// The value noise above is fine for a height CURVE, where you only ever look
// at one axis and nobody can see the lattice. A density field is looked at in
// two dimensions at once, and there value noise gives itself away: its extremes
// sit on the integer grid, so carved shapes line up into horizontal and
// vertical streaks. Gradient noise puts zeroes on the lattice instead of
// extremes, and its cells are triangles rather than squares, so there is no
// axis for the eye to lock onto.
//
// Returns [-1, 1], NOT [0, 1] like fractalNoise1D/2D. Mixing the two up is the
// obvious way to get this wrong, so the range is stated at both functions.
const _SIMPLEX_GRAD = [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
const _SIMPLEX_F2 = 0.5 * (Math.sqrt(3) - 1);
const _SIMPLEX_G2 = (3 - Math.sqrt(3)) / 6;
function simplex2D(xin, yin, channel) {
  const s = (xin + yin) * _SIMPLEX_F2;
  const i = Math.floor(xin + s), j = Math.floor(yin + s);
  const t = (i + j) * _SIMPLEX_G2;
  const x0 = xin - (i - t), y0 = yin - (j - t);
  // Which of the two triangles in this cell the point landed in
  const i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
  const x1 = x0 - i1 + _SIMPLEX_G2,   y1 = y0 - j1 + _SIMPLEX_G2;
  const x2 = x0 - 1 + 2 * _SIMPLEX_G2, y2 = y0 - 1 + 2 * _SIMPLEX_G2;
  let n = 0;
  for (let c = 0; c < 3; c++) {
    const xx = c === 0 ? x0 : c === 1 ? x1 : x2;
    const yy = c === 0 ? y0 : c === 1 ? y1 : y2;
    let tt = 0.5 - xx * xx - yy * yy;
    if (tt <= 0) continue;
    const gi = c === 0 ? hash2Di(i, j, channel)
             : c === 1 ? hash2Di(i + i1, j + j1, channel)
             :           hash2Di(i + 1, j + 1, channel);
    const g = _SIMPLEX_GRAD[gi & 7];
    tt *= tt;
    n += tt * tt * (g[0] * xx + g[1] * yy);
  }
  return Math.max(-1, Math.min(1, 70 * n));
}

// Layered simplex. Returns [-1, 1].
function fractalSimplex2D(x, y, channel, octaves = 3, persistence = 0.5, lacunarity = 2) {
  let amp = 1, freq = 1, total = 0, maxAmp = 0;
  for (let o = 0; o < octaves; o++) {
    total += simplex2D(x * freq, y * freq, channel * 31 + o) * amp;
    maxAmp += amp;
    amp *= persistence;
    freq *= lacunarity;
  }
  return total / maxAmp;
}
function smoothNoise2D(x, y, channel) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const tx = x - x0, ty = y - y0;
  const fx = tx * tx * tx * (tx * (tx * 6 - 15) + 10);
  const fy = ty * ty * ty * (ty * (ty * 6 - 15) + 10);
  const v00 = hash2D(x0, y0, channel),     v10 = hash2D(x0 + 1, y0, channel);
  const v01 = hash2D(x0, y0 + 1, channel), v11 = hash2D(x0 + 1, y0 + 1, channel);
  const a = v00 + (v10 - v00) * fx;
  const b = v01 + (v11 - v01) * fx;
  return a + (b - a) * fy;
}
function fractalNoise2D(x, y, channel, octaves = 3, persistence = 0.5, lacunarity = 2) {
  let amp = 1, freq = 1, total = 0, maxAmp = 0;
  for (let o = 0; o < octaves; o++) {
    total += smoothNoise2D(x * freq, y * freq, channel * 31 + o) * amp;
    maxAmp += amp;
    amp *= persistence;
    freq *= lacunarity;
  }
  return total / maxAmp;
}

// Smooth (quintic-interpolated) 1D value noise. Unlike a raw sine wave it
// never repeats on a short, visually-obvious period.
function smoothNoise1D(x, channel) {
  const x0 = Math.floor(x);
  const t = x - x0;
  const fade = t * t * t * (t * (t * 6 - 15) + 10);
  const v0 = hash1D(x0, channel);
  const v1 = hash1D(x0 + 1, channel);
  return v0 + (v1 - v0) * fade;
}

// Layered (fractal) noise: several octaves of smoothNoise1D combined for
// natural rolling detail. Returns a value in [0, 1).
function fractalNoise1D(x, channel, octaves = 4, persistence = 0.5, lacunarity = 2) {
  let amp = 1, freq = 1, total = 0, maxAmp = 0;
  for (let o = 0; o < octaves; o++) {
    total += smoothNoise1D(x * freq, channel * 31 + o) * amp;
    maxAmp += amp;
    amp *= persistence;
    freq *= lacunarity;
  }
  return total / maxAmp;
}

function noise(x) {
  const heightMult = (activeMod && activeMod.world && activeMod.world.heightMult) || 1;
  const n = fractalNoise1D(x * 0.05, NOISE_CH.TERRAIN, 4, 0.5, 2) * 2 - 1; // [-1, 1]
  return n * 16 * heightMult;
}

// Large, irregular mountain ranges that cut across biome borders. Ridged
// noise (1 - |2n-1|, then sharpened) turns a rolling field into distinct
// peaks separated by flatter ground instead of uniform hills everywhere.
function getMountainBoost(x) {
  const m = fractalNoise1D(x * 0.004, NOISE_CH.MOUNTAIN, 3, 0.5, 2);
  const ridge = 1 - Math.abs(m * 2 - 1);
  return Math.pow(ridge, 3) * 40;
}

// Jungle, Desert, Volcano and Mystic were removed as overworld biomes — only
// FOREST and SNOW generate now. getBiome() only ever returns one of those two,
// so every "biome === 'DESERT'" (etc.) branch left elsewhere in the file is
// now permanently unreachable through normal world-gen; each one was cleaned
// up at its call site rather than left as dead code. temp is still what tells
// FOREST from SNOW apart, so that split — and the domain warp that keeps its
// border from being a straight line — stays; the exotic noise channel that
// used to pick out Volcano/Mystic pockets is gone.
const REMOVED_BIOMES = new Set(['DESERT', 'JUNGLE', 'VOLCANO', 'MYSTIC']);

// A mod can pin the whole world to one biome. Read in one place so the climate
// field, the chunk label and the per-column dithering can never disagree about
// it. Returns null when no override is active.
function _biomeOverride() {
  const w = activeMod && activeMod.world;
  if (w && w.biomeFocus && !REMOVED_BIOMES.has(w.biomeFocus)) return w.biomeFocus;
  return null;
}

// Raw temperature, per BLOCK rather than per chunk. Domain warp distorts the
// sampling position with its own noise field so the FOREST/SNOW border comes
// out as an irregular line, not a straight one.
const SNOW_EDGE = -0.4;          // the threshold the per-chunk version used
const CLIMATE_BLEND = 128;       // 4 chunks: how wide the transition should read
function getClimateTemp(x) {
  const warp = (fractalNoise1D(x * 0.01, NOISE_CH.BIOME_WARP, 2, 0.5, 2) - 0.5) * 250;
  return fractalNoise1D((x + warp) * 0.0035, NOISE_CH.BIOME_TEMP, 3, 0.5, 2) * 2 - 1;
}

// How snowy is this exact column, as a smooth 0..1 weight instead of a yes/no.
//
// Measured as a TENT-WEIGHTED AVERAGE of the yes/no answer across the
// surrounding CLIMATE_BLEND blocks, rather than by smoothstepping the
// temperature itself. Two attempts at the latter came out too narrow: a fixed
// width in temperature units gives a 20 block transition in one place and a
// 400 block one in the next, because the domain warp makes the field cross the
// threshold at wildly different speeds, and dividing by a measured gradient
// only trades that for a different error, since the warp wobbles faster than
// any baseline you can measure the slope over (it undershot to ~40 blocks).
//
// Averaging the DECISION sidesteps the field's shape entirely. The transition
// is then as wide as the filter, by construction, wherever it falls. The tent
// weighting (rather than a flat box) is what makes it an S-curve: a box
// average of a step is a straight ramp with two corners in it.
// Three temperature evaluations deep, so this is the one field in the height
// function worth caching on its own. Rounded to whole blocks even when asked
// for a fractional one: the temperature field runs at frequency 0.0035, about
// 286 blocks per cell, so the difference between x and x + 0.4 is far below
// what a single block of terrain could express.
function getSnowWeight(x) {
  const xi = Math.round(x);
  const slot = xi & (_SNOWW_N - 1);
  const tok = _terrainToken();
  if (_snowWTok !== tok) { _snowWX.fill(0x7fffffff); _snowWTok = tok; }
  if (_snowWX[slot] === xi) return _snowWV[slot];
  const v = _computeSnowWeight(xi);
  _snowWX[slot] = xi;
  _snowWV[slot] = v;
  return v;
}

const CLIMATE_STRIDE = 16;   // sample spacing: 9 taps across the tent
const CLIMATE_SOFT   = 0.07; // how soft each individual tap's yes/no is
function _computeSnowWeight(x) {
  const forced = _biomeOverride();
  if (forced) return forced === 'SNOW' ? 1 : 0;
  // A tent of half-width R smears a step over 2R, so the reach is half the
  // width we want the transition to read as.
  const reach = CLIMATE_BLEND / 2;
  let sum = 0, wsum = 0;
  for (let d = -reach; d <= reach; d += CLIMATE_STRIDE) {
    const w = 1 - Math.abs(d) / (reach + CLIMATE_STRIDE);
    // Each tap answers softly rather than yes/no. With nine hard taps the
    // result can only take nine values, and it jumps by up to a fifth the
    // moment one tap crosses the line: in the stretches where the field
    // crosses several times over a short distance, that turned an otherwise
    // wide transition into a handful of visible steps. Softening the taps
    // costs one extra multiply each and makes the whole thing continuous.
    const u = Math.max(0, Math.min(1, (SNOW_EDGE + CLIMATE_SOFT - getClimateTemp(x + d)) / (2 * CLIMATE_SOFT)));
    sum += w * u * u * (3 - 2 * u);
    wsum += w;
  }
  return sum / wsum;
}

// The yes/no answer for things that draw or plant ONE column: ground texture,
// trees, snow underfoot.
//
// The boundary is DOMAIN WARPED rather than dithered: instead of asking "is
// this column snowy" it asks the climate field a short distance away, and lets
// noise decide how far and in which direction. Where that offset wobbles
// across the boundary the answer flips back and forth, which is what puts
// isolated pockets of snow out ahead of the snow line and islands of bare
// forest behind it, over a band tens of blocks deep.
//
// The obvious version (compare the weight against a noise value) was tried
// first and is wrong in a way that is easy to miss: fractal noise is a sum of
// octaves, so its values bunch up around 0.5 rather than spreading evenly.
// Thresholding against it jumped from almost no snow at weight 0.25 to 81%
// snow at weight 0.46, which threw away most of the blend the climate field
// had just been built to produce. Warping the position has no such bias: at
// weight 0.5 the answer is 50/50 by construction.
const CLIMATE_JITTER = 0.55;   // how far the boundary may wander, as a fraction of the blend
function isSnowColumn(x) {
  const xi = x | 0;
  const slot = xi & (_SNOWCOL_N - 1);
  const tok = _terrainToken();
  if (_snowColTok !== tok) { _snowColX.fill(0x7fffffff); _snowColTok = tok; }
  if (_snowColX[slot] === xi) return _snowColV[slot] === 1;
  let v;
  const w = getSnowWeight(xi);
  if (w <= 0) v = 0;
  else if (w >= 1) v = 1;
  else {
    // Frequency matters as much as amplitude here: at 0.02 the offset field
    // runs on a 50 block wavelength, which is longer than a chunk, so a whole
    // chunk would tip to snow at once and the patches never appeared. 0.045 is
    // a ~22 block wavelength, so pockets come out around ten blocks wide: a
    // stand of trees, not a chunk and not a dither pattern.
    const j = (fractalNoise1D(xi * 0.045, NOISE_CH.BIOME_MIX, 2, 0.5, 2) - 0.5) * 2 * CLIMATE_BLEND * CLIMATE_JITTER;
    v = getSnowWeight(xi + j) > 0.5 ? 1 : 0;
  }
  _snowColX[slot] = xi;
  _snowColV[slot] = v;
  return v === 1;
}

// The whole-chunk label, for everything that needs one answer for a region
// rather than for a column: weather, music mood, the HUD readout, structure
// rolls. Sampled at the chunk CENTRE, so a chunk reports whichever biome
// actually dominates it.
function getBiome(cx) {
  const forced = _biomeOverride();
  if (forced) return forced;
  return getSnowWeight(cx * CHUNK_W + (CHUNK_W >> 1)) > 0.5 ? "SNOW" : "FOREST";
}

// ── The terrain profile ───────────────────────────────────────────────────
// TERRAIN_BASE is deliberately unchanged at 65: every depth constant in the
// game is written relative to it (ore minDepth, cave start depth, the
// background layers' depthOffset), so moving it would quietly re-tune all of
// them at once.
const TERRAIN_BASE = 65;
const TERRAIN_MIN = 6, TERRAIN_MAX = 105;

// "How dramatic is this stretch of world?" A very low frequency field, so it
// changes over hundreds of blocks rather than tens.
//
// This is the piece that was missing. With a single noise field, every part of
// the world had the same character: hills of the same size, everywhere,
// forever. Amplitude that varies by REGION is what makes a world read as
// having places in it, calm lowlands you cross and highlands that announce
// themselves, instead of one uniform texture.
//
// Smoothstepped so most of the world commits to being one or the other rather
// than spending all its time in a mushy middle.
function getRelief(x) {
  const r = fractalNoise1D(x * 0.0012, NOISE_CH.RELIEF, 3, 0.5, 2);
  const t = Math.max(0, Math.min(1, (r - 0.28) / 0.44));
  return t * t * (3 - 2 * t);
}

// Valleys and canyons. Ridged noise again, but used the other way up from
// getMountainBoost: the ridge line here is where the ground is cut DOWN, and
// the high power makes the cut narrow with steep sides rather than a wide
// bowl. Multiplied by relief at the call site, so canyons belong to highlands
// (a canyon needs something to cut into) and lowlands get gentle dales.
function getValleyCut(x) {
  const v = fractalNoise1D(x * 0.0022, NOISE_CH.VALLEY, 3, 0.5, 2);
  const ridge = 1 - Math.abs(v * 2 - 1);
  return Math.pow(ridge, 5);
}

// Mesa country: how strongly this stretch snaps to flat steps. Zero over most
// of the world, which is the point: terracing is a landmark, and a world
// where everything is terraced has no landmarks.
//
// This is also the only thing in the height function that can produce a
// genuinely VERTICAL face. Everything else here is smooth noise, and smooth
// noise moves by well under a block per column: what feels like a steep
// mountainside is a 60-degree ramp, never a wall. Snapping the height to a
// coarse grid means that wherever the underlying curve crosses a step
// boundary, the whole step happens between two adjacent columns. That single
// jump is what the cliff pass in getChunk then undercuts into an overhang, so
// this field is what makes overhangs possible at all.
function getTerraceAmount(x) {
  const t = fractalNoise1D(x * 0.0016, NOISE_CH.TERRACE, 2, 0.5, 2);
  // Tuned by measurement, not by eye: this leaves roughly a quarter of the
  // world terraced at all and about a twentieth strongly so. At the first
  // setting that produced good-looking cliffs, half the world was stepped and
  // mesa country had stopped being a place you arrive at.
  return Math.max(0, Math.min(1, (t - 0.60) / 0.26));
}
// Tall enough that a step edge reads as a cliff with a lip rather than as a
// stair, small enough that a terraced slope is still climbable.
const TERRACE_STEP = 6;

// ── Sub-zones ─────────────────────────────────────────────────────────────
// Two more very low frequency axes, deliberately kept SEPARATE from getRelief
// instead of folded into it. Relief answers "how much height happens here";
// these two answer "what SHAPE does it take", and that is a different question:
// a high plateau and a jagged range can carry the same amount of relief and
// still be two places you would describe differently.
//
//   plateau  raises the base level over a broad stretch without adding
//            roughness, which is what a plateau is: elevation without drama.
//   rugged   shifts the same amplitude between smooth rolling ground and
//            craggy, stepped, canyon-cut ground.
//
// Crossed with the climate weight, the four named sub-zones fall out without a
// single new block type or an explicit list of zones anywhere:
//
//   snow   + plateau, calm     -> snowy high plateau
//   snow   + plateau, rugged   -> glacier canyon (a deep cut into high ground)
//   forest + low,     calm     -> flat valley thicket
//   any    + plateau, rugged   -> steep high mountains
// Snow lowers the bar for a plateau, so snowy country leans towards high
// ground. That is the actual relationship in the world (a snow line IS an
// altitude) and it is what makes "snowy high plateau" a place you can arrive
// at rather than a rare coincidence of two unrelated fields: at the same
// amplitude it roughly doubles how much of the snow country sits up on a
// shelf, without making plateaus any more common in the forest.
function getPlateau(x) {
  const p = fractalNoise1D(x * 0.0009, NOISE_CH.PLATEAU, 2, 0.5, 2);
  const gate = 0.52 - getSnowWeight(x) * 0.13;
  const t = Math.max(0, Math.min(1, (p - gate) / 0.30));
  return t * t * (3 - 2 * t);
}
function getRuggedness(x) {
  const r = fractalNoise1D(x * 0.0018, NOISE_CH.RUGGED, 2, 0.5, 2);
  const t = Math.max(0, Math.min(1, (r - 0.30) / 0.40));
  return t * t * (3 - 2 * t);
}

// The biome argument is gone: snowiness is now a continuous per-column weight
// (getSnowWeight), so the height field reads it itself instead of being told a
// yes/no answer that was only ever accurate to the nearest chunk. That alone
// removes a visible seam from the parallax hills, which used to switch profile
// at chunk borders because they passed getBiome(cx) in.
function getBiomeHeight(x) {
  // Only whole columns are cached. The parallax layers sample at wx * 0.28 and
  // friends, i.e. at FRACTIONAL x, and quantising those to whole blocks would
  // make three or four neighbouring screen columns share one height: the
  // distant hills would come out as visible stair steps instead of a smooth
  // ridge line. Those calls take the direct path, which is still much cheaper
  // than it was before getSnowWeight got its own cache below.
  const xi = x | 0;
  if (xi !== x) return _computeBiomeHeight(x);
  const slot = xi & (_HEIGHT_N - 1);
  const tok = _terrainToken();
  if (_heightTok !== tok) { _heightX.fill(0x7fffffff); _heightTok = tok; }
  if (_heightX[slot] === xi) return _heightV[slot];
  const h = _computeBiomeHeight(xi);
  _heightX[slot] = xi;
  _heightV[slot] = h;
  return h;
}

function _computeBiomeHeight(x) {
  const relief  = getRelief(x);
  const snow    = getSnowWeight(x);
  const rugged  = getRuggedness(x);
  const plateau = getPlateau(x);

  const n = noise(x);                                                              // +/-16
  const detail = (fractalNoise1D(x * 0.15, NOISE_CH.DETAIL, 2, 0.5, 2) * 2 - 1) * 3; // small ripples, [-3,3]

  // Lowlands stay calm and walkable, highlands get the full swing. Snow keeps
  // the flatter profile it always had, just faded in over the transition band
  // now rather than switching at a chunk border. At snow = 0 and snow = 1 this
  // is the same 1.0 / 0.85 it always was.
  const swing = (0.45 + relief * 0.95) * (1 - snow * 0.15);

  // Ripples are the fine grain of the ground, so they belong to ruggedness:
  // calm country reads as smooth even where it is tall, craggy country is
  // broken up even where it is low. Averages out to roughly the old amplitude.
  let h = TERRAIN_BASE + n * swing + detail * (0.55 + relief * 0.65) * (0.6 + rugged * 0.9);

  // Mountain ranges rise across any biome, but only where the relief field
  // says a range belongs. Ungated, ridged noise puts a peak in every quiet
  // meadow and the ranges stop meaning anything. Ruggedness decides whether
  // that range comes out as peaks or as high rolling ground.
  h -= getMountainBoost(x) * (0.22 + relief * 0.78) * (0.55 + rugged * 0.75);

  // The plateau shelf. Subtracting raises the ground (y grows downward), and
  // it is applied FLAT: no noise on it, because a plateau that wobbles is just
  // a hill. Snow leans into it harder, which is what makes snowy country read
  // as high country rather than as forest painted white.
  h -= plateau * (6 + relief * 22) * (0.75 + snow * 0.5);

  // ...and valleys cut back down through all of it. Deeper where the ground is
  // high and broken, which is the difference between a dale and a canyon: a
  // canyon needs something to cut INTO. This is what turns a snowy plateau
  // into a glacier canyon without either being named anywhere.
  h += getValleyCut(x) * (7 + relief * 23) * (0.7 + rugged * 0.6) * (1 + plateau * 1.8);

  // Flat-topped steps, in the few stretches that get them. Snapping the height
  // to a coarse grid is what turns a slope into a stack of cliffs and ledges.
  //
  // Ruggedness biases WHERE terracing lands without changing how much of it
  // there is: the multiplier averages 1.0 across the world, so the measured
  // budget the field was tuned to (roughly 30% terraced, 9% strongly) survives,
  // it just moves to the stretches where stepped ground belongs.
  const terrace = Math.min(1, getTerraceAmount(x) * (0.5 + rugged));
  if (terrace > 0) {
    h += (Math.round(h / TERRACE_STEP) * TERRACE_STEP - h) * terrace;
  }

  // Two of the three landmarks are shapes the height curve can carry, so they
  // are applied here, AFTER terracing: a canyon that then got snapped to a
  // six-block grid would come out as a staircase, and the point of it is the
  // sheer drop. Both use a high power of the chunk-wide strength profile, which
  // is what makes them narrow: sin squared alone would give a wide soft bowl
  // and a wide soft dome, and neither of those is a landmark.
  const kind = landmarkChunkKind(Math.floor(x / CHUNK_W));
  if (kind === 'CANYON' || kind === 'SPIRE') {
    const s = landmarkStrengthAt(x);
    // y grows downward: adding sinks the ground, subtracting raises it.
    if (kind === 'CANYON') h += Math.pow(s, 4) * 30;
    else                   h -= Math.pow(s, 5) * 20;
  }

  return Math.max(TERRAIN_MIN, Math.min(TERRAIN_MAX, h));
}

// ── The density field ─────────────────────────────────────────────────────
// Everything above is a HEIGHTMAP: one surface row per column, a silhouette you
// could draw without lifting the pen. An overhang needs two surfaces in one
// column and cannot be expressed there at all, however dramatic the curve gets.
//
// This is the field that answers the other question. Not "where does the rock
// stop in this column" but "is there rock at this exact spot", which is a
// question a heightmap cannot be asked. Overhangs, arches, free-standing
// pillars and cave mouths are all the same answer to it, rather than four
// special cases bolted onto the silhouette.
//
// It replaced two hand-written passes (undercut the cliff foot, then let the
// top rows stick out over the drop) that between them could only ever produce
// one shape. They are gone; their tuning constants live on here as the band.
const DENSITY_UP   = 9;     // rows above the heightmap that may turn to rock
const DENSITY_DOWN = 22;    // rows below the heightmap that may turn to air
// How hard the field must push to overrule the heightmap. Calibrated against
// the actual spread of the noise, not guessed: three octaves of simplex have a
// standard deviation of 0.305 and only reach 0.89 at the very extreme, so the
// first setting of 0.52 needed |n| > 0.43 even at full gate and changed 0.1% of
// the band. Overhangs came out at 1% of columns and arches at none.
const DENSITY_FLIP = 0.38;

// How much licence the field has in this column. Zero on flat ground, which is
// what keeps meadows walkable and stops the world turning into sponge.
//
// Note the two are NOT symmetric, and that is deliberate. Rock appearing above
// the surface (gateUp) is a ledge or an arch and only makes sense against a
// cliff, so it needs real steepness. Air appearing below it (gateDown) is an
// undercut or a pocket, and gets a standing allowance of 0.35: below the flip
// threshold on its own, so flat ground is still never touched, but enough that
// a merely rolling slope can hold a shallow hollow.
// The knee of the steepness ramp is measured, not chosen by eye. Only 13.6% of
// columns change height by 1.4 rows or more, and a slope of 2.6 is rare enough
// to be a landmark. An earlier ramp of (slope - 0.8) / 1.8 therefore sat at
// about 0.33 on ground that already reads as a cliff, which after multiplying
// through needed |n| > 0.93 from a field that only reaches 0.89: cliffs got
// nothing at all. This one is fully open by slope 1.8.
function densityGates(slope, wx) {
  const steep = Math.max(0, Math.min(1, (slope - 0.5) / 1.3));
  let up = steep * 1.6, down = 0.30 + steep * 1.15;
  // Micro-variance: the same slope does not carve the same way twice. Centred
  // on 1.0 so the measured budget above is unchanged on average, it just stops
  // every cliff of a given steepness looking like every other one.
  const mv = microVariance(wx);
  up   *= 0.70 + mv * 0.60;
  down *= 0.80 + mv * 0.40;
  // The OVERHANG landmark: one chunk where the field is let off the leash.
  if (landmarkChunkKind(Math.floor(wx / CHUNK_W)) === 'OVERHANG') {
    const s = landmarkStrengthAt(wx);
    up   += s * 1.30;
    down += s * 0.90;
  }
  return { up, down };
}

// True where there should be rock. `sy` is the heightmap surface for this
// column, and the answer collapses back to the plain heightmap wherever the
// field has no licence, so this stays a strict extension of what was here.
function terrainSolidAt(wx, y, sy, gateUp, gateDown) {
  // `sy` is the surface ROW and is itself rock, not the last row of air above
  // it. Writing this as y > sy instead lowered the entire world by one block,
  // which is invisible in any single screenshot and shows up as every measured
  // ground level being off by one.
  const below = y >= sy;
  const d = y - sy;
  if (d < -DENSITY_UP || d > DENSITY_DOWN) return below;
  const gate = below ? gateDown : gateUp;
  if (gate <= 0) return below;
  // Full licence over the inner half of the band, tapering to none at its
  // edges. The taper is what stops the carving ending at a horizontal line,
  // which would read as a seam across the whole world at exactly DENSITY_DOWN
  // below the ground. The flat middle is what lets an undercut be DEEP: a
  // plain tent from the surface outwards throttles the field the moment it
  // gets going, and capped overhangs at three rows.
  const prof = d <= 0
    ? (d >= -DENSITY_UP * 0.5   ? 1 : (DENSITY_UP + d) / (DENSITY_UP * 0.5))
    : (d <=  DENSITY_DOWN * 0.55 ? 1 : (DENSITY_DOWN - d) / (DENSITY_DOWN * 0.45));
  const g = gate * prof;
  if (g <= 0) return below;
  // Sampled at a lower frequency across x than down y, so features come out
  // wider than they are tall: shelves and ledges, which is what rock does,
  // rather than round blobs, which is what unstretched noise does. Both
  // frequencies are also low in absolute terms, because the size of a feature
  // here IS the size of the overhang: at 0.105 down y a hollow could not be
  // more than about five rows tall before the field closed it again.
  // Persistence 0.35, not the usual 0.5. Wherever the gate sits near the flip
  // threshold (the outer part of the band, by design) a small wobble is enough
  // to turn a cell, so the finest octave decides those cells on its own: at 0.5
  // it carried 14% of the amplitude and left one-block fins standing in the
  // middle of otherwise clean hollows. At 0.35 it carries 8% and adds texture
  // to an edge instead of drawing its own.
  const n = fractalSimplex2D(wx * 0.038, y * 0.062, NOISE_CH.DENSITY, 3, 0.35, 2);
  const delta = n * g;
  return below ? delta > -DENSITY_FLIP : delta > DENSITY_FLIP;
}

// Where a piece of rock that touches nothing is allowed to stay. Rare on
// purpose: a floating island is a landmark, and a world full of them has none.
// See the support pass in getChunk for why this is a field and not a constant.
function floatingAllowed(wx) {
  return fractalNoise1D(wx * 0.0015, NOISE_CH.FLOAT, 2, 0.5, 2) > 0.70;
}

// ── The feature lattice: spacing without a memory ──────────────────────────
// A chunk carries the feature if it passes its own gate roll AND outscores
// every other passing chunk within `radius`. Two winners inside one radius is
// arithmetically impossible: each would have to outscore the other. So this
// GUARANTEES a minimum spacing of radius + 1 chunks, without ever storing what
// was generated where.
//
// That last part is the whole point, and it is why this is not the running
// "already placed nearby" buffer it looks like it should be. Such a buffer
// makes the result depend on the ORDER chunks are generated in, and that order
// depends on where the player walks (the spawn search alone builds hundreds of
// chunks before anyone sees anything). Two players in the same room on the same
// seed would get different terrain, and a world would come back different after
// a reload. This is a pure function of the chunk index, so it cannot.
//
// Cost is 2 * radius + 1 hash pairs per query, which is why the callers cache
// their answer per chunk rather than per column.
function featureWinner(cx, radius, chance, channel) {
  if (hash1D(cx, channel) >= chance) return false;
  const mine = hash1D(cx, channel + 977);
  for (let d = -radius; d <= radius; d++) {
    if (d === 0) continue;
    const c = cx + d;
    if (hash1D(c, channel) >= chance) continue;
    const s = hash1D(c, channel + 977);
    // The tie branch is unreachable in practice (two 32-bit hashes colliding)
    // and still written out, because "in practice" is where a world that
    // generates differently on two machines comes from.
    if (s > mine || (s === mine && c < cx)) return false;
  }
  return true;
}

// ── Landmarks ─────────────────────────────────────────────────────────────
// One lattice for all three kinds rather than one each, so no two landmarks of
// ANY kind land within five chunks of each other. Separate lattices would let
// a spire and a canyon share a chunk, and the requirement is that a stretch of
// world does not repeat itself in a similar form either, not merely in the
// same form.
const LANDMARK_RADIUS = 5;
const LANDMARK_CHANCE = 0.35;   // gate roll; the lattice thins this to ~9% of chunks
const LANDMARK_KINDS  = ['OVERHANG', 'SPIRE', 'CANYON'];

const _LM_N = 512;
const _lmCx = new Int32Array(_LM_N).fill(0x7fffffff);
const _lmV  = new Int8Array(_LM_N);      // -1 none, else index into LANDMARK_KINDS
let _lmTok = -1;

function landmarkChunkKind(cx) {
  const slot = cx & (_LM_N - 1);
  const tok = _terrainToken();
  if (_lmTok !== tok) { _lmCx.fill(0x7fffffff); _lmTok = tok; }
  if (_lmCx[slot] !== cx) {
    let v = -1;
    // Chunk 0 is left plain: it is where the spawn search starts, and a canyon
    // or a spire there is the first thing every new world would show.
    if (cx !== 0 && featureWinner(cx, LANDMARK_RADIUS, LANDMARK_CHANCE, NOISE_CH.LANDMARK)) {
      v = Math.min(2, Math.floor(hash1D(cx, NOISE_CH.LANDMARK + 1531) * 3));
    }
    _lmCx[slot] = cx;
    _lmV[slot] = v;
  }
  const v = _lmV[slot];
  return v < 0 ? null : LANDMARK_KINDS[v];
}

// Strength across the chunk: zero at both borders, one in the middle. A
// landmark that simply switched on at a chunk boundary would end in a vertical
// wall exactly on the seam, which is the one place a landform must not have an
// edge. sin squared is zero AND flat at both ends, so it also joins the
// ordinary terrain without a crease.
function landmarkStrengthAt(wx) {
  const cx = Math.floor(wx / CHUNK_W);
  const kind = landmarkChunkKind(cx);
  if (!kind) return 0;
  const s = Math.sin(Math.PI * ((wx - cx * CHUNK_W) / CHUNK_W));
  return s * s;
}

// Micro-variance: a chunk-specific hash, interpolated smoothly ACROSS the
// chunk border rather than stepping at it. The lattice points sit exactly on
// chunk indices, so every chunk really does get its own seed, and no two
// stretches of world get the same slope aggressiveness or the same tree
// spacing; but the value never jumps, so the join is invisible. Reading a raw
// per-chunk hash instead would put a visible discontinuity on every seam.
function microVariance(wx) {
  return smoothNoise1D(wx / CHUNK_W, NOISE_CH.MICRO);
}

function getSurfaceYAt(wx, targetDim = currentDim) {
  const oldDim = currentDim;
  currentDim = targetDim;
  for (let y = 0; y < WORLD_H; y++) {
    const b = getBlock(wx, y);
    if (b !== BLOCKS.AIR && b !== BLOCKS.WATER && b !== BLOCKS.ICE) { currentDim = oldDim; return y; }
  }
  currentDim = oldDim;
  return 30;
}

function isValidSpawnGround(blockType) {
  return [BLOCKS.GRASS, BLOCKS.SAND, BLOCKS.DIRT, BLOCKS.STONE].includes(blockType);
}

function findSafeSpawnX() {
  const spawnRangeChunks = 160;
  const startCx = seededInt(-spawnRangeChunks, spawnRangeChunks, 'spawn-chunk');
  for (let radius = 0; radius <= spawnRangeChunks; radius++) {
    const candidates = radius === 0 ? [startCx] : [startCx + radius, startCx - radius];
    for (const cx of candidates) {
      const baseX = cx * CHUNK_W + Math.floor(CHUNK_W / 2);
      for (let dx = -12; dx <= 12; dx++) {
        const wx = baseX + dx;
        const sy = getSurfaceYAt(wx, "OVERWORLD");
        const ground = getBlock(wx, sy);
        if (isValidSpawnGround(ground) && getBlock(wx, sy-1) === BLOCKS.AIR && getBlock(wx, sy-2) === BLOCKS.AIR) return wx;
      }
    }
  }
  return 0;
}

function isGrassOrDirt(worldX, y) {
  const b = getBlock(worldX, y);
  return b === BLOCKS.GRASS || b === BLOCKS.DIRT;
}
function canSpawnFlowerAt(worldX, surfaceY) {
  return isGrassOrDirt(worldX, surfaceY) && getBlock(worldX, surfaceY - 1) === BLOCKS.AIR;
}

// Haine statt Gleichverteilung. Ein frueherer Versuch, die Baumdichte ueber
// ein CHUNK-weites Feld zu steuern (microVariance auf den Spaltenwurf, dann
// auf den Mindestabstand, siehe der Kommentar ueber der Decoration-Schleife
// in getChunk), war gemessen wirkungslos: bei ~0,2 Baeumen pro Chunk aendert
// ein entfernter Chunk-Multiplikator nichts Sichtbares, und das Feld
// korrelierte nicht mit den Spalten, die ueberhaupt Gras haben.
//
// Dieser Bonus setzt stattdessen direkt neben einem Baum an, der schon
// bewiesen hat, dass der Boden dort passt: fuer ein paar Spalten hinter ihm
// (aber ausserhalb TREE_MIN_SPACING, sonst waeren es verschmolzene Kronen)
// steigt die Rollchance an und klingt bis GROVE_RANGE wieder auf 1x ab. Weil
// der Bonus an eine bereits erfolgreiche Stelle gekoppelt ist statt an eine
// unabhaengige Zufallszahl, trifft er viel oefter auf brauchbaren Untergrund
// als ein blinder Wurf irgendwo im Chunk, und genau das macht ihn wirksam,
// wo der Chunk-weite Versuch es nicht war.
const GROVE_RANGE = 20;   // Spalten, ueber die der Bonus nach einem Baum ausklingt
const GROVE_BOOST  = 2.5; // Chance-Multiplikator direkt hinter TREE_MIN_SPACING
function groveMultiplier(worldX, lastTreeX) {
  const since = worldX - lastTreeX;
  if (since < TREE_MIN_SPACING || since >= GROVE_RANGE) return 1;
  const t = 1 - (since - TREE_MIN_SPACING) / (GROVE_RANGE - TREE_MIN_SPACING);
  return 1 + (GROVE_BOOST - 1) * t;
}

// ── World Director set-pieces (called only from getChunk, OVERWORLD only, so
// currentDim is already OVERWORLD and localSetBlock writes to the right dim) ──

// A 3-wide, 5-tall block font for hidden messages. '1' = an ink block.
const _msgFont = {
  G: ['011','100','101','101','011'],
  L: ['100','100','100','100','111'],
  H: ['101','101','111','101','101'],
  F: ['111','100','110','100','100'],
  O: ['111','101','101','101','111'],
  X: ['101','101','010','101','101'],
  V: ['101','101','101','101','010'],
  I: ['111','010','010','010','111'],
};
const _msgWords = ['HI', 'GG', 'GL', 'LOL', 'VOX', 'GLHF'];

// A short word spelled out in Gold Brick inside a carved pocket, buried
// shallow enough to stumble on while mining. You can even harvest the letters.
function placeHiddenMessage(cx, surfaceY) {
  const word = _msgWords[seededInt(0, _msgWords.length - 1, 'msg-w', cx)];
  const cols = word.length * 3 + (word.length - 1); // 1-tile gap between glyphs
  const lX = seededInt(2, Math.max(3, CHUNK_W - cols - 2), 'msg-x', cx);
  const worldX = cx * CHUNK_W + lX;
  const topY = surfaceY[lX] + seededInt(10, 22, 'msg-y', cx);
  if (topY + 5 >= WORLD_H - 4) return;
  // Carve an air pocket one tile larger all around
  for (let gy = -1; gy <= 5; gy++) for (let gx = -1; gx <= cols; gx++) {
    localSetBlock(worldX + gx, topY + gy, BLOCKS.AIR);
  }
  // Stamp the glyphs
  let penX = 0;
  for (const ch of word) {
    const glyph = _msgFont[ch];
    if (glyph) {
      for (let row = 0; row < 5; row++) for (let col = 0; col < 3; col++) {
        if (glyph[row][col] === '1') localSetBlock(worldX + penX + col, topY + row, BLOCKS.GOLD_BRICK);
      }
    }
    penX += 4;
  }
  // Light it so a passing miner actually notices the glint
  localSetBlock(worldX - 1, topY, BLOCKS.TORCH);
  localSetBlock(worldX + cols, topY, BLOCKS.TORCH);
}

// One of three whimsical, rule-breaking builds. Meant to look "wrong" in a
// way that reads as intentional and memorable, not as a generation bug.
function placeMemeStructure(cx, surfaceY, biome) {
  const pick = seededInt(0, 2, 'meme-pick', cx);
  const lX = seededInt(4, CHUNK_W - 8, 'meme-x', cx);
  const worldX = cx * CHUNK_W + lX;
  const sy = surfaceY[lX];
  if (sy < 12 || sy > 88) return;

  if (pick === 0) {
    // ── Monolith: a lone black obelisk with a single glowing gem on top.
    const h = 10 + seededInt(0, 6, 'mono-h', cx);
    if (sy - h - 2 < 2) return;
    for (let dy = 1; dy <= h; dy++) {
      localSetBlock(worldX, sy - dy, BLOCKS.OBSIDIAN);
      localSetBlock(worldX + 1, sy - dy, BLOCKS.OBSIDIAN);
    }
    localSetBlock(worldX, sy - h - 1, BLOCKS.RAINBOW_ORE);
    localSetBlock(worldX + 1, sy - h - 1, BLOCKS.RAINBOW_ORE);
  } else if (pick === 1) {
    // ── Staircase to nowhere: planks climbing into open sky, ending abruptly.
    const steps = 8 + seededInt(0, 5, 'stair-n', cx);
    for (let s = 0; s < steps; s++) {
      const bx = worldX + s;
      const by = sy - 1 - s;
      if (by < 3) break;
      localSetBlock(bx, by, BLOCKS.PLANKS);
      localSetBlock(bx, by + 1, BLOCKS.PLANKS); // a little riser under each tread
    }
  } else {
    // ── Upside-down house: a cottage flipped on its head, roof biting the
    // ground. Drawn from a fixed bitmap so it's unmistakably deliberate.
    const layout = [
      ' ##### ', // (was the floor) now the top
      ' #...# ',
      ' #...# ',
      '#######', // wall band
      ' ##### ', // roof, now pointing down
      '  ###  ',
      '   #   ',
    ];
    const roofBlock = BLOCKS.PLANKS;
    for (let row = 0; row < layout.length; row++) {
      const by = sy - (layout.length - 1) + row;
      if (by < 2) continue;
      for (let col = 0; col < layout[row].length; col++) {
        const ch = layout[row][col];
        const bx = worldX + col;
        if (ch === '#') localSetBlock(bx, by, roofBlock);
        else if (ch === '.') localSetBlock(bx, by, BLOCKS.BG_PLANKS);
      }
    }
    localSetBlock(worldX + 3, sy - 4, BLOCKS.TORCH); // a torch stuck to the "ceiling"
  }
}

// ── Mother Lode: the jackpot. A small deep chamber whose walls drip Diamond
// Ore, with a Rainbow Ore core and a stick of Diamond Dynamite. Deliberately
// bypasses the per-chunk ore budget (chunkOreWon) — that rule-break is the
// whole point, and its ~0.3%-of-chunks rarity keeps the economy intact.
function placeMotherLode(cx, surfaceY) {
  const lX = seededInt(4, CHUNK_W - 6, 'lode-x', cx);
  const worldX = cx * CHUNK_W + lX;
  const cy = surfaceY[lX] + 35 + seededInt(0, 12, 'lode-y', cx);
  if (cy + 5 >= WORLD_H - 3) return;
  const rX = 4, rY = 3;
  // Hollow it out
  for (let dx = -rX; dx <= rX; dx++) for (let dy = -rY; dy <= rY; dy++) {
    if ((dx*dx)/(rX*rX) + (dy*dy)/(rY*rY) <= 1) localSetBlock(worldX + dx, cy + dy, BLOCKS.AIR);
  }
  // Stud the shell with diamond
  for (let dx = -rX; dx <= rX; dx++) for (let dy = -rY; dy <= rY; dy++) {
    const e = (dx*dx)/(rX*rX) + (dy*dy)/(rY*rY);
    if (e > 1 && e <= 1.8 && seededRandom('lode-d', cx, dx, dy) < 0.6) {
      if (getBlock(worldX + dx, cy + dy) === BLOCKS.STONE) localSetBlock(worldX + dx, cy + dy, BLOCKS.DIAMOND_ORE);
    }
  }
  // Rainbow core + a dynamite dare + torches
  localSetBlock(worldX, cy, BLOCKS.RAINBOW_ORE);
  localSetBlock(worldX - 1, cy, BLOCKS.RAINBOW_ORE);
  localSetBlock(worldX + 1, cy, BLOCKS.RAINBOW_ORE);
  localSetBlock(worldX, cy - 1, BLOCKS.DIAMOND_DYNAMITE);
  localSetBlock(worldX - rX + 1, cy - rY + 1, BLOCKS.TORCH);
  localSetBlock(worldX + rX - 1, cy - rY + 1, BLOCKS.TORCH);
}

// =========================================================
// getChunk — hier wird aus den Feldern oben echter Fels
// =========================================================
// Kam aus voxeria-dimensions-progress.js. Ruft weiterhin
// generatePocketChunk/decoratePocketChunk und generateArenaChunk auf, die dort
// geblieben sind: klassische Scripts teilen einen globalen Scope, die
// Funktionsdeklarationen sind also von hier aus ohne import erreichbar, sobald
// alle Dateien geladen sind.
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
  // Fremde Dimensionen. Bis eben standen hier zwei feste Zweige, und dieser
  // Generator kannte dafuer Pocket-Dimensionen und den Arena-Modus beim Namen,
  // obwohl beide woanders wohnen. Wer eine Dimension selbst erzeugt, meldet
  // sich stattdessen an.
  //
  // null heisst "nicht meine Dimension". Ein Objekt heisst "ich habe den Chunk
  // gefuellt"; ein optionales decorate() laeuft danach, NACHDEM der Chunk in
  // der Map steht, damit Schreibvorgaenge ueber die Chunk-Grenze hinweg in
  // echten Chunks landen statt ins Leere.
  const fremd = VxHooks.filter('generateChunk', null, cx, chunk);
  if (fremd) {
    cmap.set(cx, chunk);
    if (typeof fremd.decorate === 'function') fremd.decorate(cx);
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
  //
  // groveMultiplier() (siehe oben, vor den World-Director-Set-Pieces) ist
  // trotzdem kein Widerspruch dazu: statt eines unabhaengigen Chunk-Feldes
  // haengt der Bonus dort an einem bereits gestandenen Baum, trifft also auf
  // denselben Boden, der ihn schon einmal passieren liess.

  for (let i = 0; i < CHUNK_W; i++) {
    const worldX = cx * CHUNK_W + i;
    const sy = surfaceY[i];

    const r = seededRandom('decor', cx, i);
    const cb = colBiome[i];
    const grove = groveMultiplier(worldX, lastTreeX);

    // Both biomes' trees come out of the shared planTree() generator (see
    // voxeria-engine.js) rather than the fixed silhouette each used to hard-code
    // here, so they vary in height, crown and branching — and so a tree that
    // grows in later looks like the ones that were always there. The rand()
    // passed in is seeded per column, which keeps world-gen trees identical on
    // every regeneration of the same chunk.
    if (cb === "SNOW") {
      if (r < 0.06 * grove && getBlock(worldX, sy) === BLOCKS.GRASS && worldX - lastTreeX >= TREE_MIN_SPACING) {
        let n = 0;
        const tiles = planTree(worldX, sy, 'SNOW', () => seededRandom('snow-tree', cx, i, n++));
        if (tiles) { for (const t of tiles) localSetBlock(t.x, t.y, t.b); lastTreeX = worldX; }
      }
    } else { // FOREST
      if (r < 0.08 * grove && isGrassOrDirt(worldX, sy) && worldX - lastTreeX >= TREE_MIN_SPACING) {
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

// =========================================================
// SELBSTTEST
// =========================================================
// Run worldGenSelfTest() in the console after touching getBiomeHeight,
// getChunk, the density-field constants or the landmark lattice. Same idea as
// modSelfTest() in voxeria-modding.js: not a full test suite, just a check of
// the specific properties this file's own comments claim to guarantee, so a
// tuning mistake shows up here instead of as "the world looks wrong" three
// files and two commits later.
//
// Generates real chunks, but far out (BASE_CX below) so nothing a live save
// has already walked into gets touched, and the hash functions treat that x
// exactly like any other — chunk 10,000,000 is as valid a sample as chunk 0.
function worldGenSelfTest(chunkSamples = 40, heightSamples = 600) {
  const fails = [];

  if (typeof gameMode !== 'undefined' && gameMode === 'arena') {
    fails.push('run this outside Arena mode: getChunk() would build the arena, not real terrain');
    console.log('❌ worldGenSelfTest: ' + fails.length + ' problem(s)');
    fails.forEach(f => console.log('   ' + f));
    return fails;
  }

  const BASE_CX = 10000000;

  // ── A: terrain bounds ──────────────────────────────────────────────────
  // getBiomeHeight() clamps to [TERRAIN_MIN, TERRAIN_MAX] by construction, so
  // that alone can never fail. What a bad coefficient CAN do is push an
  // outsized share of the world onto that clamp — a flat floor or ceiling
  // instead of a curve. Some clipping is normal (that is what a mountain peak
  // or a canyon floor IS); a lot of it means the field stopped varying.
  let clipLow = 0, clipHigh = 0;
  for (let i = 0; i < heightSamples; i++) {
    const h = getBiomeHeight(BASE_CX * CHUNK_W + i * 37);
    if (h <= TERRAIN_MIN) clipLow++;
    if (h >= TERRAIN_MAX) clipHigh++;
  }
  const clipRate = (clipLow + clipHigh) / heightSamples;
  if (clipRate > 0.08) {
    fails.push('getBiomeHeight clips at TERRAIN_MIN/MAX for ' + (clipRate * 100).toFixed(1) +
               '% of sampled columns (expected well under 8%) - low:' + clipLow + ' high:' + clipHigh);
  }

  // ── B: chunk structure ────────────────────────────────────────────────
  for (let n = 0; n < chunkSamples; n++) {
    const cx = BASE_CX + n;
    let chunk;
    try {
      chunk = getChunk(cx, 'OVERWORLD');
    } catch (e) {
      fails.push('getChunk(' + cx + ') threw: ' + e.message);
      continue;
    }
    if (chunk.length !== CHUNK_W * WORLD_H) {
      fails.push('getChunk(' + cx + ') returned ' + chunk.length + ' cells, expected ' + (CHUNK_W * WORLD_H));
      continue;
    }
    for (let i = 0; i < CHUNK_W; i++) {
      if (chunk[(WORLD_H - 1) * CHUNK_W + i] !== BLOCKS.BEDROCK) {
        fails.push('chunk ' + cx + ' column ' + i + ' has no bedrock floor');
      }
      let top = -1;
      for (let y = 0; y < WORLD_H; y++) {
        if (chunk[y * CHUNK_W + i] !== BLOCKS.AIR) { top = y; break; }
      }
      // Only the forced bedrock row is solid: a void column with nothing to
      // stand on above it.
      if (top === WORLD_H - 1) fails.push('chunk ' + cx + ' column ' + i + ' is a void down to bedrock');
      // Solid from the very top of the world: whatever raised the ground
      // (mountain boost, plateau, a landmark spire) ran away instead of
      // clamping.
      if (top === 0) fails.push('chunk ' + cx + ' column ' + i + ' is solid rock from the top of the world');
    }
  }

  // ── C: landmark spacing guarantee ────────────────────────────────────
  // featureWinner()'s whole point is that two winners can never land within
  // `radius` of each other. This is a direct check that LANDMARK_RADIUS and
  // LANDMARK_CHANCE, as tuned today, actually hold that promise over a run
  // long enough for a broken guarantee to show up.
  let lastLandmarkCx = null;
  const spanChunks = Math.max(400, chunkSamples * 4);
  for (let n = 0; n < spanChunks; n++) {
    const cx = BASE_CX + 50000 + n;
    if (landmarkChunkKind(cx)) {
      if (lastLandmarkCx !== null && cx - lastLandmarkCx <= LANDMARK_RADIUS) {
        fails.push('landmarks at chunk ' + lastLandmarkCx + ' and ' + cx + ' are only ' +
                   (cx - lastLandmarkCx) + ' apart, expected > ' + LANDMARK_RADIUS);
      }
      lastLandmarkCx = cx;
    }
  }

  // ── D: grove multiplier bounds ───────────────────────────────────────
  // groveMultiplier() should taper UP near a recent tree and settle back to
  // exactly 1x outside its range - never below 1x (that would make groves
  // rarer, backwards) and never past GROVE_BOOST.
  for (let since = 0; since < GROVE_RANGE + 10; since++) {
    const m = groveMultiplier(BASE_CX * CHUNK_W, BASE_CX * CHUNK_W - since);
    if (m < 1 || m > GROVE_BOOST + 1e-9) {
      fails.push('groveMultiplier(since=' + since + ') returned ' + m + ', expected [1, ' + GROVE_BOOST + ']');
    }
  }

  console.log(fails.length ? '❌ worldGenSelfTest: ' + fails.length + ' problem(s)'
                            : '✅ worldGenSelfTest passed (' + chunkSamples + ' chunks, ' + heightSamples + ' height samples, ' + spanChunks + '-chunk landmark span)');
  fails.forEach(f => console.log('   ' + f));
  return fails;
}
window.worldGenSelfTest = worldGenSelfTest;


// =========================================================
// WELTZUGRIFF -- getBlock/localSetBlock, dort wo getChunk steht
// =========================================================
// Beide standen in voxeria-engine.js und riefen von dort getChunk() hier
// herunter, waehrend diese Datei sie umgekehrt 89 Mal wieder hinaufrief. Genau
// das war der letzte Rest des Rings zwischen den beiden Dateien.
//
// Sie gehoeren hierher: eine Kachel zu lesen heisst, den Chunk auszurechnen und
// darin nachzuschlagen, und der Chunk ist das, was diese Datei erzeugt. Die
// Engine liest sie jetzt von hier, und das ist die richtige Richtung.
//
// setBlock() bleibt bewusst in der Engine: das ist der SPIELER-seitige Setzer,
// der zusaetzlich die Aenderung fuer den Spielstand mitschreibt. localSetBlock
// umgeht das absichtlich, weil erzeugtes Terrain nichts ist, was gespeichert
// werden muesste, es entsteht ja aus dem Seed neu.
function getBlock(x, y) {
  if (y < 0 || y >= WORLD_H) return BLOCKS.AIR;
  const cx = Math.floor(x / CHUNK_W);
  let lx = x % CHUNK_W;
  if (lx < 0) lx += CHUNK_W;
  return getChunk(cx, currentDim)[y * CHUNK_W + lx];
}

function localSetBlock(x, y, type, targetDim = currentDim) {
  if (y < 0 || y >= WORLD_H) return;
  const cx = Math.floor(x / CHUNK_W);
  let lx = x % CHUNK_W;
  if (lx < 0) lx += CHUNK_W;
  getChunk(cx, targetDim)[y * CHUNK_W + lx] = type;
}

// =========================================================
// TREES — one shared shape generator
// =========================================================
// planTree() returns the finished tile list of a tree ({x, y, b} entries, all
// LOG tiles first and bottom-up, then the canopy) without touching the world
// itself, so both callers can apply it the way that suits them:
//   • world generation (getChunk's decoration loop) paints the whole list at
//     once with localSetBlock, i.e. terrain, not a recorded player edit;
//   • the sapling growth below reveals the same list one tile at a time with
//     setBlock, so a tree visibly grows out of the ground.
// Logs coming first in the list is what makes that safe: a half-grown tree is
// always a bare trunk, never a leaf waiting for the trunk that holds it up.
//
// Two geometry rules every shape here has to respect, because the rest of the
// engine assumes them:
//   • every LEAVES tile stays within Manhattan distance TREE_LEAF_REACH of one
//     of this tree's own LOG tiles — that's exactly the radius isLeafSupported()
//     accepts, so a canopy can never decay the moment it's finished. Tiles that
//     would sit further out are dropped rather than drawn, which is also what
//     keeps the crowns rounded instead of square;
//   • no leaf sits more than 3 columns beside or 5 rows above its trunk, the
//     window _leafTreeTrunkX() scans when it resolves the one shared canopy
//     colour per tree.
const TREE_LEAF_REACH = 5;

// Minimum trunk-to-trunk gap, shared by world generation (getChunk's
// decoration loop) and the sapling-growth spacing check below. Forest crowns
// reach up to 3 columns past their own trunk (see rx above), so anything
// closer than double that plus a little air lets two crowns interlock into
// one solid, hard-edged mass instead of reading as two separate trees — and
// since each tree's canopy colour is picked independently (see
// _leafTreeTrunkX), an interlocked pair shows a sharp, wrong-looking seam
// where one tree's colour abruptly cuts into the other's.
const TREE_MIN_SPACING = 6;

// Trees used to be one fixed silhouette per biome — every Forest tree a 4-high
// trunk under the same diamond, every Snow tree the same 4-tier cone. Height,
// crown width, raggedness and (in the Forest) a branch or two now vary per
// tree, drawn from the caller's rand() so world-gen trees stay fully seeded
// and reproducible while grown ones are free to be random.
function planTree(x, groundY, kind, rand, getAt) {
  const get = getAt || getBlock;
  const snow = kind === 'SNOW';
  const h = snow ? 5 + Math.floor(rand() * 3)   // 5..7 — conifers run taller
                 : 4 + Math.floor(rand() * 4);  // 4..7
  const topY = groundY - h;                     // the trunk's topmost log
  if (topY - 5 < 2) return null;                // no headroom for the crown

  // The trunk needs a clear column; the canopy just skips whatever is in its
  // way, so a tree can still nestle against a hillside or another tree.
  for (let dy = 1; dy <= h; dy++) {
    if (get(x, groundY - dy) !== BLOCKS.AIR) return null;
  }

  const logs = [];
  for (let dy = 1; dy <= h; dy++) logs.push({ x, y: groundY - dy, b: BLOCKS.LOG });

  // Forest trees grow 1-2 stubby side branches near the crown once they're
  // tall enough to carry them. They read as branches, and they also widen the
  // area that counts as "supported" for the leaves hanging off that side.
  if (!snow && h >= 5) {
    let side = rand() < 0.5 ? -1 : 1;
    const branches = h >= 6 ? 2 : 1;
    for (let i = 0; i < branches; i++) {
      const bx = x + side, by = topY + 1 + i;
      if (get(bx, by) === BLOCKS.AIR) logs.push({ x: bx, y: by, b: BLOCKS.LOG });
      side = -side;
    }
  }

  const nearLog = (lx, ly) => {
    let best = 99;
    for (const l of logs) {
      const d = Math.abs(l.x - lx) + Math.abs(l.y - ly);
      if (d < best) best = d;
    }
    return best;
  };
  const leaves = [];
  const addLeaf = (lx, ly) => {
    if (get(lx, ly) !== BLOCKS.AIR) return;
    if (nearLog(lx, ly) > TREE_LEAF_REACH) return;
    if (leaves.some(l => l.x === lx && l.y === ly)) return;
    leaves.push({ x: lx, y: ly, b: BLOCKS.LEAVES });
  };

  if (snow) {
    // Conifer: tiers that narrow toward a single capping leaf. Two rows share
    // the same radius on the way up so the silhouette steps rather than slopes
    // evenly, and the widest skirt hangs one row below the trunk's top.
    const radii = h >= 6 ? [3, 2, 2, 1, 1, 0] : [3, 2, 2, 1, 0];
    for (let i = 0; i < radii.length; i++) {
      const ly = topY + 1 - i;
      const rad = radii[i];
      for (let dx = -rad; dx <= rad; dx++) {
        // Nick the odd tip off the widest rows — a perfectly straight cone
        // edge is what made every old Snow tree look stamped from the same
        // mould. The trunk column itself is never skipped.
        if (dx !== 0 && Math.abs(dx) === rad && rad > 1 && rand() < 0.3) continue;
        addLeaf(x + dx, ly);
      }
    }
  } else {
    // Forest: an ellipse centred just above the trunk's top log, with a ragged
    // outer ring. The wider crown only shows up on some trees, so a stand of
    // Forest trees has both slim and broad ones in it.
    const rx = rand() < 0.45 ? 3 : 2;
    const ry = rand() < 0.35 ? 3 : 2;
    const cy = topY - (ry - 1);
    for (let dy = -ry; dy <= ry; dy++) {
      for (let dx = -rx; dx <= rx; dx++) {
        const ex = dx / (rx + 0.4), ey = dy / (ry + 0.4);
        const d2 = ex * ex + ey * ey;
        if (d2 > 1) continue;
        if (d2 > 0.55 && rand() < 0.3) continue;   // ragged edge
        addLeaf(x + dx, cy + dy);
      }
    }
    // A leaf directly on top of the trunk guarantees the crown never ends up
    // with a bald spot over its own stem, however the jitter above rolled.
    addLeaf(x, topY - 1);
  }

  if (leaves.length < 4) return null;             // too boxed in to be a tree
  return logs.concat(leaves);
}
