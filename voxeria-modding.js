// ============================================================================
// VOXERIA -- MODDING SYSTEM
// ----------------------------------------------------------------------------
// The whole player-facing mod pipeline:
//
//   * BLOCK RESKINS / CREATURE TOGGLES - the simple "Create Your Own Mod" panel
//   * MOD CODES                        - MOD1 / VXM3 encode + decode
//   * PIECES                           - painted 32x32 custom blocks & creatures
//   * FUNCTION GRAPHS + GRAPH RUNTIME  - the visual node-graph mod language
//   * MOD SPRITES                      - procedural creature art
//   * MOD BUILDER / PIXEL EDITOR       - authoring UI
//   * BLOCK & CREATURE DESIGNER        - the two painting tools
//   * MOD EDITOR                       - the node-graph canvas
//
// Loaded after the engine and the dimension layer, so it can call into both.
// ============================================================================

// Blocks that show up in blockNames (voxeria-engine.js) but can never
// actually end up in a player's inventory in normal play — the same set
// updateMiningHold's own `minable` check already carves out for mining.
// Named once here so every "pick a block" picker in the mod system (give/
// hold/carry conditions, starting items, "turn that block into") can share
// it instead of each guessing its own list. WATER/DEEP_WATER are fluid,
// BEDROCK ("Vox") is the indestructible world floor, PORTAL is session-only
// dimension state — none of them are things a mod was ever meant to hand
// out or check for.
const NON_ITEM_BLOCK_IDS = new Set([BLOCKS.AIR, BLOCKS.BEDROCK, BLOCKS.WATER, BLOCKS.DEEP_WATER, BLOCKS.PORTAL]);

// =========================================================
// CREATE-YOUR-OWN-MOD — visual block reskins + creature spawn toggles
// =========================================================
blockReskin = {};
try { blockReskin = JSON.parse(localStorage.getItem('voxeria_block_reskin') || '{}') || {}; } catch (e) { blockReskin = {}; }
creatureToggles = { butterfly: true };
try {
  const savedToggles = JSON.parse(localStorage.getItem('voxeria_creature_toggles') || 'null');
  // Only merge keys that still exist — an old save from before other
  // creatures were removed could otherwise resurrect a stray 'raccoon: false'
  // entry that nothing reads anymore but the toggle panel would still list.
  if (savedToggles) for (const k of Object.keys(creatureToggles)) {
    if (k in savedToggles) creatureToggles[k] = savedToggles[k];
  }
} catch (e) {}
function saveBlockReskin() { try { localStorage.setItem('voxeria_block_reskin', JSON.stringify(blockReskin)); } catch (e) {} }
function saveCreatureToggles() { try { localStorage.setItem('voxeria_creature_toggles', JSON.stringify(creatureToggles)); } catch (e) {} }

// =========================================================
// MOD CODES
// Two formats are understood:
//   "MOD1-" + base64url(JSON)   — the original, still read so that already
//                                 published mods keep working.
//   "VXM3-" + base32(bitfields) — the current one: every parameter is packed
//                                 into a fixed bit layout, so a whole mod fits
//                                 in ~20 characters and needs no server.
// BOTH are funnelled through normalizeModData() below, so a decoded mod is
// never used raw — see the security note there.
//
// Why the jump straight to VXM3-: dropping timeLimit and buildCost from
// MOD_FIELDS shifts the bit position of every field after them. An old VXM2-
// code has an intact checksum (that covers the characters, not their meaning),
// so it would have decoded cleanly into completely wrong values — a red
// creature quietly becoming a different shape and gravity. Changing the prefix
// makes those codes fail loudly instead. This is exactly the case the "the
// order of this list IS the wire format" warning on MOD_FIELDS describes.
// =========================================================
const MOD_PREFIX = "MOD1-";
const MOD2_PREFIX = "VXM3-";

// Crockford base32: no I, L, O or U, so a hand-copied code can't be broken by
// confusing 1/I or 0/O — the single most common failure when players retype a
// code they read off a screenshot.
const MOD_B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MOD_B32_LOOKUP = (() => {
  const m = {};
  for (let i = 0; i < MOD_B32.length; i++) m[MOD_B32[i]] = i;
  // Accept the excluded look-alikes on INPUT anyway and fold them onto what the
  // player obviously meant. Encoding never emits these.
  m['I'] = m['L'] = m['1']; m['O'] = m['0']; m['U'] = m['V'];
  return m;
})();

// ── The building-block libraries ─────────────────────────────────────────────
// Fixed, closed lists on purpose: a mod combines and tunes existing pieces, it
// never ships assets or code. That is what makes a mod code safe to run the
// instant it is pasted in.
const MOD_SPRITES  = ['blob','crawler','flyer','orb','golem','spike','ghost','crystal','worm','turret','wisp','beetle'];
const MOD_TINTS    = ['#7ee081','#66c2ff','#ff6b6b','#ffd166','#c084fc','#f472b6','#4ade80','#38bdf8',
                      '#fb923c','#a3e635','#e879f9','#2dd4bf','#f87171','#facc15','#94a3b8','#ffffff'];
const MOD_OVERLAYS = ['none','stripes','dots','checker','glow','sparks'];
const MOD_MOVES    = ['patrol','jump','fly'];
const MOD_ATTACKS  = ['melee','ranged','area'];
const MOD_TRIGGERS = ['sight','timer','random'];
const MOD_BIOMES   = ['','FOREST','DESERT','JUNGLE','SNOW','VOLCANO','MYSTIC'];
const MOD_WEATHERS = ['','clear','rain','storm','snow'];
// 'rain' stays in the list above (removing it would shift 'storm'/'snow' to
// different bit values and reinterpret every existing mod code — the same
// reasoning as REMOVED_BIOMES), but the game has no working 'rain' weather
// state any more. Hidden from the builder's dropdown and neutralised where
// forceWeather gets applied (see applySeedFromUI).
// 'snow' belongs here for exactly the same reason and was simply missed when
// snowfall was taken out: applySeedFromUI already neutralises it (see the
// forceIsInert check there), so the dropdown was offering an "Always snow"
// that provably does nothing.
const REMOVED_WEATHER = new Set(['rain', 'snow']);
const MOD_PERK_KEYS  = ['speed','reach','digspeed','doublejump','pickaxe','megajump','hazardimmune'];
const MOD_SPAWN_KEYS = ['butterfly','slime','crawler','flyer','golem','wisp'];

// ── The single source of truth ───────────────────────────────────────────────
// This table drives FOUR things at once: the bit layout of a code, the encoder,
// the decoder's clamping, and the builder UI's controls. They cannot drift
// apart, because there is only one description of each parameter.
//
// !! THE ORDER OF THIS LIST IS THE WIRE FORMAT !!
// Appending a field at the END is safe (older codes decode short and the
// missing tail falls back to defaults). Reordering, removing, or changing the
// `bits` of an existing entry silently reinterprets every code ever shared —
// bump MOD2_PREFIX to VXM3- instead if that is ever needed.
//
// kind:
//   enum  — index into `list`; an index past the end clamps to entry 0
//   range — integer 0..(2^bits-1) mapped linearly onto [min, max], then rounded
//           to `dec` decimals
//   flags — one bit per entry in `list`, decoded into a {key: bool} object
//
// `def` is what a NEW mod and a truncated code start from. Without it every
// range would default to its minimum, so a fresh mod would open at scale 0.5
// and opacity 0.3 — a tiny, half-transparent creature — and a mod that set
// nothing would quietly ship 0.2x gravity.
//
// Every `def` below is exactly representable in its own bit width (verified by
// the round-trip test in modSelfTest()). If it were not, opening a mod and
// re-saving it without touching anything would silently shift its values.
const MOD_FIELDS = [
  { g:'visual', k:'sprite',    bits:4, kind:'enum',  list:MOD_SPRITES,  label:'Base sprite' },
  { g:'visual', k:'tint',      bits:4, kind:'enum',  list:MOD_TINTS,    label:'Colour' },
  { g:'visual', k:'overlay',   bits:3, kind:'enum',  list:MOD_OVERLAYS, label:'Overlay texture' },
  { g:'visual', k:'scale',     bits:4, kind:'range', min:0.5, max:2.0,    dec:2, def:1,   unit:'×', label:'Scale' },
  { g:'visual', k:'rotation',  bits:4, kind:'range', min:0,   max:337.5,  dec:1, def:0,   unit:'°', label:'Rotation' },
  { g:'visual', k:'hue',       bits:5, kind:'range', min:0,   max:348.75, dec:0, def:0,   unit:'°', label:'Hue shift' },
  { g:'visual', k:'alpha',     bits:3, kind:'range', min:0.3, max:1.0,    dec:2, def:1,   unit:'',  label:'Opacity' },
  { g:'visual', k:'particles', bits:3, kind:'range', min:0,   max:7,      dec:0, def:0,   unit:'',  label:'Particle density' },

  { g:'behavior', k:'move',    bits:2, kind:'enum', list:MOD_MOVES,    label:'Movement' },
  { g:'behavior', k:'attack',  bits:2, kind:'enum', list:MOD_ATTACKS,  label:'Attack type' },
  { g:'behavior', k:'trigger', bits:2, kind:'enum', list:MOD_TRIGGERS, label:'Trigger' },

  // There used to be `timeLimit` and `buildCost` here, copied from how the
  // built-in pocket dimensions work (enter, timer runs down, the place
  // collapses). They were wrong for mods: loading a mod code builds a normal,
  // PERMANENT overworld via applySeedFromUI() — nothing ever collapses — so
  // both sliders described machinery that does not run, and a player walking
  // the world could never find any trace of them.
  //
  // Ranges are picked so that (max-min) divides evenly into the number of steps
  // AND the neutral value lands exactly on one. Getting only the second half
  // right is not enough: gravity was briefly 0.2..2.0, which put 1.0 on a step
  // but left a 0.12 gap rounded to 1 decimal, so the slider climbed
  // 0.2, 0.3, 0.4, 0.6 — a visible stutter with 0.5 simply missing.
  { g:'dim', k:'gravity',    bits:4, kind:'range', min:0.2, max:1.7, dec:1, def:1,   unit:'×', label:'Gravity' },
  { g:'dim', k:'spawnRate',  bits:4, kind:'range', min:0,   max:15,  dec:0, def:4,   unit:'',  label:'Enemy spawn rate' },
  { g:'dim', k:'spawnTable', bits:6, kind:'flags', list:MOD_SPAWN_KEYS, label:'Spawn table' },

  // 0.3..3.4 in exact 0.1 steps (31 steps x 0.1 = 3.1 span). Deliberately WIDER
  // than the old 0.3..2.5 slider rather than narrower: every value the old
  // range could produce is still hit exactly, so no already-published mod's
  // terrain shifts, and the extra headroom comes for free.
  { g:'world', k:'heightMult',   bits:5, kind:'range', min:0.3, max:3.4, dec:1, def:1, unit:'×', label:'Terrain height' },
  { g:'world', k:'biomeFocus',   bits:3, kind:'enum', list:MOD_BIOMES,   label:'Forced biome' },
  { g:'world', k:'forceWeather', bits:3, kind:'enum', list:MOD_WEATHERS, label:'Weather' },

  // A whole group that is itself a flag set — see the '__flags' handling below.
  { g:'perks', k:'__flags', bits:7, kind:'flags', list:MOD_PERK_KEYS, label:'Starting perks' }
];
const MOD_TOTAL_BITS = MOD_FIELDS.reduce((n, f) => n + f.bits, 0);

function _modFieldMax(f) { return (1 << f.bits) - 1; }

// value -> raw integer. Always lands inside [0, 2^bits-1]; a nonsense value in
// (wrong type, NaN, out of range) becomes the field's default rather than
// poisoning the bit stream.
function modFieldToRaw(f, value) {
  const max = _modFieldMax(f);
  if (f.kind === 'enum') {
    const i = f.list.indexOf(value);
    return i < 0 ? 0 : Math.min(i, max);
  }
  if (f.kind === 'flags') {
    let raw = 0;
    const obj = value && typeof value === 'object' ? value : {};
    f.list.forEach((key, i) => { if (obj[key]) raw |= (1 << i); });
    return raw & max;
  }
  const n = Number(value);
  if (!isFinite(n)) return 0;
  const t = (n - f.min) / (f.max - f.min);
  return Math.max(0, Math.min(max, Math.round(t * max)));
}

// raw integer -> value. THIS is the clamp that makes a hand-edited or corrupt
// code harmless: an enum index past the end of its list falls back to entry 0,
// and a range can only ever produce a number inside [min, max]. Nothing here
// can return a value the game was not built to handle.
function modRawToField(f, raw) {
  const max = _modFieldMax(f);
  const r = Math.max(0, Math.min(max, raw | 0));
  if (f.kind === 'enum') return r < f.list.length ? f.list[r] : f.list[0];
  if (f.kind === 'flags') {
    const out = {};
    f.list.forEach((key, i) => { out[key] = !!(r & (1 << i)); });
    return out;
  }
  const v = f.min + (f.max - f.min) * (r / max);
  const rounded = Number(v.toFixed(f.dec));
  return Math.max(f.min, Math.min(f.max, rounded));
}

// The baseline a short/partially-decoded code falls back to, and what the
// builder opens with. Fields carrying a `def` use it; everything else uses its
// raw-0 value (entry 0 of an enum, all-false for a flag set), which is already
// the sensible neutral for those kinds.
function modDefaults() {
  const out = { visual:{}, behavior:{}, dim:{}, world:{}, perks:{} };
  for (const f of MOD_FIELDS) {
    // Routing `def` through raw and back guarantees the default is a value the
    // format can actually store, so it survives a save/reload untouched.
    const v = f.def !== undefined ? modRawToField(f, modFieldToRaw(f, f.def)) : modRawToField(f, 0);
    if (f.k === '__flags') out[f.g] = v; else out[f.g][f.k] = v;
  }
  return out;
}

// ── Checksum ─────────────────────────────────────────────────────────────────
// 10 bits of FNV-1a over the body, written as the final two base32 characters.
// This catches truncation, a mistyped character and casual hand-editing — it is
// NOT a tamper-proof signature and cannot be: the algorithm runs on the
// player's own machine, so anyone determined can simply recompute it. The
// actual safety guarantee comes from modRawToField()'s clamping above, which
// holds even for a code whose checksum was deliberately fixed up.
function modChecksum(body) {
  let h = 2166136261;
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const v = (h >>> 0) % 1024;
  return MOD_B32[(v >> 5) & 31] + MOD_B32[v & 31];
}

// ── Text tail ────────────────────────────────────────────────────────────────
// Name, author, seed and the starting inventory are variable-length, so they
// ride behind the fixed bit block as base64url instead of being packed. A mod
// with no text at all is just the 16-character parameter block.
const MOD_TEXT_SEP = '\x1f';
function _modEncodeText(mod) {
  const inv = (mod.startInventory || []).slice(0, 8)
    .map(it => (it.block | 0) + '*' + (it.count | 0)).join('.');
  const parts = [mod.name || '', mod.author || '', mod.seed || '', inv];
  while (parts.length && parts[parts.length - 1] === '') parts.pop();
  if (!parts.length) return '';
  const b64 = btoa(unescape(encodeURIComponent(parts.join(MOD_TEXT_SEP))));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function _modDecodeText(b64, out) {
  if (!b64) return;
  const s = b64.replace(/-/g, '+').replace(/_/g, '/');
  const parts = decodeURIComponent(escape(atob(s))).split(MOD_TEXT_SEP);
  // Same length caps the builder's inputs enforce, applied again here because a
  // code can arrive from anywhere, not just from our own UI.
  out.name   = _modCleanText(parts[0], 30);
  out.author = _modCleanText(parts[1], 24);
  out.seed   = _modCleanText(parts[2], 60);
  out.startInventory = _modCleanInventory(parts[3]);
}
// Strips control characters (including the separator itself) so a crafted code
// can't smuggle line breaks or invisible glyphs into a name shown in the UI.
function _modCleanText(s, maxLen) {
  return String(s || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, maxLen);
}
function _modCleanInventory(s) {
  if (!s) return [];
  return String(s).split('.').map(pair => {
    const [b, c] = pair.split('*');
    return { block: parseInt(b, 10), count: parseInt(c, 10) };
  }).filter(it => Number.isInteger(it.block) && blockNames[it.block] && !NON_ITEM_BLOCK_IDS.has(it.block))
    .map(it => ({ block: it.block, count: Math.max(1, Math.min(99, it.count || 1)) }))
    .slice(0, 8);
}

// ── Encode / decode ──────────────────────────────────────────────────────────
function encodeModCode2(mod) {
  let bits = '';
  for (const f of MOD_FIELDS) {
    const value = f.k === '__flags' ? mod[f.g] : (mod[f.g] || {})[f.k];
    bits += modFieldToRaw(f, value).toString(2).padStart(f.bits, '0');
  }
  while (bits.length % 5) bits += '0';
  let params = '';
  for (let i = 0; i < bits.length; i += 5) params += MOD_B32[parseInt(bits.slice(i, 5 + i), 2)];
  const text = _modEncodeText(mod);
  const body = text ? params + '.' + text : params;
  return MOD2_PREFIX + body + modChecksum(body);
}

const MOD_PARAM_CHARS = Math.ceil(MOD_TOTAL_BITS / 5);

function decodeModCode2(s) {
  const raw = String(s).slice(MOD2_PREFIX.length).trim();
  // Two checksum characters plus at least one parameter character.
  if (raw.length < MOD_PARAM_CHARS + 2) return null;
  const body = raw.slice(0, -2);
  const given = raw.slice(-2).toUpperCase();
  if (modChecksum(body) !== given) {
    console.warn('Voxeria: mod code failed its checksum — corrupt or edited.');
    return null;
  }
  const dot = body.indexOf('.');
  const params = (dot < 0 ? body : body.slice(0, dot)).toUpperCase();
  const text = dot < 0 ? '' : body.slice(dot + 1);

  let bits = '';
  for (const ch of params) {
    const v = MOD_B32_LOOKUP[ch];
    if (v === undefined) return null; // a character that was never valid base32
    bits += v.toString(2).padStart(5, '0');
  }

  const out = modDefaults();
  out.v = 2;
  let pos = 0;
  for (const f of MOD_FIELDS) {
    // A code from an older, shorter field list simply runs out here; every
    // remaining field keeps the default already sitting in `out`.
    if (pos + f.bits > bits.length) break;
    const value = modRawToField(f, parseInt(bits.slice(pos, pos + f.bits), 2));
    if (f.k === '__flags') out[f.g] = value; else out[f.g][f.k] = value;
    pos += f.bits;
  }
  try { _modDecodeText(text, out); }
  catch (e) { console.warn('Voxeria: mod code text block unreadable, ignoring it.', e); }
  out.name = out.name || 'Unnamed Mod';
  return out;
}

// Brings ANY decoded mod — v1 JSON or v2 bitfield — onto the same fully
// clamped shape. The v1 path matters most: those codes are raw JSON, so before
// this existed a hand-written MOD1- code could set heightMult to 9999 or drop a
// non-existent block id into the inventory and the game would just take it.
function normalizeModData(data) {
  if (!data || typeof data !== 'object') return null;
  const out = modDefaults();
  out.v = 2;
  for (const f of MOD_FIELDS) {
    const incoming = f.k === '__flags' ? data[f.g] : (data[f.g] || {})[f.k];
    if (incoming === undefined || incoming === null) continue;
    // Round-tripping through raw is what enforces the range: anything the table
    // does not describe cannot survive the trip.
    const value = modRawToField(f, modFieldToRaw(f, incoming));
    if (f.k === '__flags') out[f.g] = value; else out[f.g][f.k] = value;
  }
  out.name   = _modCleanText(data.name, 30) || 'Unnamed Mod';
  out.author = _modCleanText(data.author, 24);
  out.seed   = _modCleanText(data.seed, 60);
  out.startInventory = Array.isArray(data.startInventory)
    ? data.startInventory
        .filter(it => it && Number.isInteger(it.block) && blockNames[it.block])
        .slice(0, 8)
        .map(it => ({ block: it.block, count: Math.max(1, Math.min(99, parseInt(it.count, 10) || 1)) }))
    : [];
  return out;
}

function isModCode(s) {
  return typeof s === 'string' && (s.startsWith(MOD_PREFIX) || s.startsWith(MOD2_PREFIX));
}

function decodeModCode(s) {
  try {
    if (String(s).startsWith(MOD2_PREFIX)) return decodeModCode2(s);
    const b64 = s.slice(MOD_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(escape(atob(b64)));
    const data = JSON.parse(json);
    if (!data || data.v !== 1 || typeof data.name !== 'string') return null;
    return normalizeModData(data);
  } catch (e) {
    console.error("Mod decode error:", e);
    return null;
  }
}

// Run modSelfTest() in the console after touching MOD_FIELDS or any piece
// field table. It checks the one property those tables must never lose: that
// every storable value survives a round trip unchanged. If this fails, editing
// a mod and saving it without changing anything would silently alter it — the
// kind of bug that only shows up as "my mod feels different now" weeks later.
function modSelfTest() {
  const fails = [];
  // BLOCK_PIECE_FIELDS rides the same encode/clamp helpers, so it inherits the
  // same trap and gets checked here rather than in a parallel test that would
  // drift out of date.
  const allFields = MOD_FIELDS.concat(BLOCK_PIECE_FIELDS);
  for (const f of allFields) {
    // Only values the field can legitimately HOLD have to round-trip. For an
    // enum that means indices below the list length — a raw index past the end
    // is exactly the corrupt input modRawToField() is supposed to collapse onto
    // entry 0, so it must NOT round-trip.
    const top = f.kind === 'enum' ? f.list.length - 1 : _modFieldMax(f);
    for (let raw = 0; raw <= top; raw++) {
      const value = modRawToField(f, raw);
      const back = modFieldToRaw(f, value);
      if (back !== raw) fails.push(f.g + '.' + f.k + ' raw ' + raw + ' -> ' + JSON.stringify(value) + ' -> raw ' + back);
    }
    // The aliasing trap: if `dec` rounds more coarsely than one raw step, two
    // neighbouring steps collapse onto the same number and the value drifts on
    // every save. Checked explicitly so the cause is named, not just the symptom.
    if (f.kind === 'range') {
      const step = (f.max - f.min) / _modFieldMax(f);
      const grid = Math.pow(10, -f.dec);
      if (grid > step + 1e-9) {
        fails.push(f.g + '.' + f.k + ' rounds to ' + grid + ' but its step is ' + step.toFixed(4) +
                   ' — raise `bits`, widen the range, or raise `dec`');
      }
    }
    if (f.def !== undefined) {
      const stored = modRawToField(f, modFieldToRaw(f, f.def));
      if (stored !== f.def) fails.push(f.g + '.' + f.k + ' default ' + f.def + ' is not representable (stores as ' + stored + ')');
    }
  }
  // Out-of-range enum indices must land on something valid rather than throw or
  // return undefined — the property the whole "never take a value raw" rule
  // rests on.
  for (const f of allFields) {
    if (f.kind !== 'enum') continue;
    for (let raw = f.list.length; raw <= _modFieldMax(f); raw++) {
      if (!f.list.includes(modRawToField(f, raw))) fails.push(f.g + '.' + f.k + ' raw ' + raw + ' escaped its list');
    }
  }
  const rt = encodeModCode2(modDefaults());
  if (!decodeModCode2(rt)) fails.push('default mod does not survive encode/decode');
  const pieceRt = encodeBlockPieceCode(Object.assign(pieceDefaults(BLOCK_PIECE_FIELDS), { name: 'Self Test', pixels: [] }));
  if (!decodeBlockPieceCode(pieceRt)) fails.push('default block piece does not survive encode/decode');
  if (MOD_TOTAL_BITS > MOD_PARAM_CHARS * 5) fails.push('MOD_TOTAL_BITS exceeds the parameter block');
  console.log(fails.length ? '❌ modSelfTest: ' + fails.length + ' problem(s)' : '✅ modSelfTest passed (' + MOD_TOTAL_BITS + ' bits, ' + MOD_PARAM_CHARS + ' chars)');
  fails.forEach(f => console.log('   ' + f));
  return fails;
}
window.modSelfTest = modSelfTest;

// =========================================================
// PIECES — "Lego" modding, phase 1: custom blocks with a player-painted
// texture. A piece is a small, independently-typed record (its own short
// code, its own entry in a personal library) instead of one fixed mod form.
// Reuses the exact same bit-packing/clamping machinery as MOD_FIELDS above
// (modFieldToRaw/modRawToField/modChecksum) so every piece type inherits the
// same safety guarantee for free: a hand-edited or corrupt piece code can
// only ever produce bounded, in-range values, never crash or inject code.
// =========================================================

// Reuses a handful of the existing mining-sound families (_BLOCK_SOUND_FX,
// ~3888) rather than inventing new ones — a custom block's mined-sound is
// just "which family does it belong to", same as every built-in block.
const BLOCK_SOUND_FAMILIES = ['stone', 'denseStone', 'ore', 'shinyOre', 'crystal', 'wood', 'glass', 'dirtEarth'];

// !! Same wire-format rule as MOD_FIELDS: append at the end only. !!
const BLOCK_PIECE_FIELDS = [
  { g:'block', k:'hardness',    bits:3, kind:'range', min:1,    max:8,    dec:0, def:2,    label:'Hardness' },
  { g:'block', k:'soundFamily', bits:3, kind:'enum',  list:BLOCK_SOUND_FAMILIES, def:'ore', label:'Mining sound' },
  { g:'block', k:'minDepth',    bits:6, kind:'range', min:0,    max:63,   dec:0, def:8,    label:'Min depth' },
  { g:'block', k:'chance',      bits:5, kind:'range', min:0.01, max:0.32, dec:2, def:0.08, label:'Rarity (per chunk)' },
  { g:'block', k:'veinSize',    bits:3, kind:'range', min:1,    max:8,    dec:0, def:3,    label:'Vein size' },
  { g:'block', k:'traits',      bits:2, kind:'flags', list:['glows', 'oreSpeckle'], label:'Traits' }
];

// The piece-type registry mentioned in the modding-system plan — currently
// just BLOCK, with CREATURE/RULE meant to slot in later phases the same way,
// each contributing its own field table to the same generic encode/decode
// helpers below rather than a bespoke format per type.
// Creatures are painted the same way blocks are — a 32x32 grid the player
// draws themselves. There is deliberately no shape library to pick from: the
// point of the piece system is that the art is the player's, not a tint on
// top of one of our silhouettes.
const CREATURE_MOVES = ['patrol', 'jump', 'fly'];
const CREATURE_BIOMES = ['any', 'FOREST', 'SNOW'];
// How a creature fights, matched by name against CUSTOM_CREATURE_ATTACKS in
// voxeria-engine.js. Kept separate from CREATURE_MOVES because locomotion and
// aggression are independent: a flyer that charges and a walker that charges
// are the same attack over different movement, and one combined list would
// have needed an entry per combination.
//
// 'none' is not a wasted slot — it is the creature with health that never
// fights back: a target dummy, a breakable egg, the crystal a defence mod
// wants protected. APPEND ONLY, same wire-format rule as the lists above.
const CREATURE_ATTACKS = ['none', 'touch', 'charge', 'leap', 'shoot'];

// !! Same wire-format rule as MOD_FIELDS: append at the end only. !!
const CREATURE_PIECE_FIELDS = [
  { g:'creature', k:'move',   bits:2, kind:'enum',  list:CREATURE_MOVES,  def:'patrol', label:'Movement' },
  { g:'creature', k:'size',   bits:3, kind:'range', min:8,   max:36,  dec:0, def:16,  label:'Size' },
  { g:'creature', k:'speed',  bits:3, kind:'range', min:0.2, max:1.6, dec:1, def:0.6, label:'Speed' },
  { g:'creature', k:'rarity', bits:3, kind:'range', min:1,   max:8,   dec:0, def:4,   label:'How common' },
  { g:'creature', k:'biome',  bits:2, kind:'enum',  list:CREATURE_BIOMES, def:'any',  label:'Lives in' },
  { g:'creature', k:'traits', bits:2, kind:'flags', list:['glows', 'trail'], label:'Traits' }
];

// VXB1- was the original untagged-pixel format; VXB2- adds the mode character
// in front of the pixel payload (see encodeBlockPixels). Same rule the mod
// codes follow (MOD1-/VXM3-, see the note above MOD_PREFIX): keep decoding the
// old prefix forever, only ever emit the new one.
const BLOCK_PIECE_PREFIX_V1 = 'VXB1-';
const PIECE_KINDS = {
  BLOCK:    { prefix: 'VXB2-', legacyPrefixes: [BLOCK_PIECE_PREFIX_V1], fields: BLOCK_PIECE_FIELDS,    group: 'block',    hasPixels: true },
  CREATURE: { prefix: 'VXC1-', legacyPrefixes: [],                      fields: CREATURE_PIECE_FIELDS, group: 'creature', hasPixels: true }
  // The RULE piece kind (VXR1-) that used to live here is gone — its knobs
  // (speed, gravity, reach, ...) are node actions in the Mod Editor now (see
  // GRAPH_ACTIONS). Node graphs have their own VXG1- codec, outside this
  // table entirely — see encodeGraphCode/decodeGraphCode.
};

// prefix -> { kindName, def, legacy } so decoding can dispatch on the code
// itself rather than the caller having to know what it is holding.
const _PIECE_BY_PREFIX = (() => {
  const m = {};
  for (const [kindName, def] of Object.entries(PIECE_KINDS)) {
    m[def.prefix] = { kindName, def, legacy: false };
    for (const lp of def.legacyPrefixes) m[lp] = { kindName, def, legacy: true };
  }
  return m;
})();
function _pieceLookup(s) {
  if (typeof s !== 'string') return null;
  for (const prefix of Object.keys(_PIECE_BY_PREFIX)) {
    if (s.startsWith(prefix)) return Object.assign({ prefix }, _PIECE_BY_PREFIX[prefix]);
  }
  return null;
}
function isPieceCode(s, kindName) {
  const hit = _pieceLookup(s);
  return !!hit && (!kindName || hit.kindName === kindName);
}

function pieceDefaults(fields) {
  const out = {};
  for (const f of fields) {
    if (!out[f.g]) out[f.g] = {};
    const v = f.def !== undefined ? modRawToField(f, modFieldToRaw(f, f.def)) : modRawToField(f, 0);
    if (f.k === '__flags') out[f.g] = v; else out[f.g][f.k] = v;
  }
  return out;
}
function pieceFieldsToRaw(fields, obj) {
  let bits = '';
  for (const f of fields) {
    const value = f.k === '__flags' ? obj[f.g] : (obj[f.g] || {})[f.k];
    bits += modFieldToRaw(f, value).toString(2).padStart(f.bits, '0');
  }
  return bits;
}
function pieceRawToFields(fields, bits, out) {
  let pos = 0;
  for (const f of fields) {
    if (pos + f.bits > bits.length) break;
    const value = modRawToField(f, parseInt(bits.slice(pos, pos + f.bits), 2));
    if (f.k === '__flags') out[f.g] = value; else out[f.g][f.k] = value;
    pos += f.bits;
  }
}
function _pieceB64url(s) { return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function _pieceB64urlDecode(s) { return atob(String(s || '').replace(/-/g, '+').replace(/_/g, '/')); }

// ── Pixel texture (32x32, indexed palette) ───────────────────────────────
// The list below is the palette a NEW drawing starts with, not the palette a
// drawing is limited to. It used to be both: sixteen fixed colours, four bits
// per pixel, and no way to paint anything else. That bound was inherited from
// the "fixed, closed lists" rule the rest of the piece format follows (see
// MOD_TINTS above), but that rule exists to stop a mod shipping arbitrary
// EXECUTABLE or asset payloads, and a colour is neither. Sixteen swatches
// bought no safety; it only meant every player's blocks looked like every
// other player's.
//
// A piece now carries its OWN colour table (see _packColourTable /
// _compactPiecePalette below), so the painter can use any RGB colour there is,
// and the code stays a self-contained piece of text with nothing to fetch.
// The starter set stays exactly as it was so a blank canvas opens on familiar
// swatches, and because indices 0-15 still mean these colours, every code
// ever exported before this change decodes bit-for-bit identically.
const BLOCK_PIXEL_SIZE = 32;
const BLOCK_PIXEL_PALETTE = [
  'transparent', '#1a1a1a', '#4a4a4a', '#7a7a7a', '#aaaaaa', '#e0e0e0', '#ffffff',
  '#5a3e0e', '#8b6914', '#c49a3a', '#d4a017',
  '#1a6fd0', '#38bdf8', '#2dd4bf', '#4ade80', '#ff4400'
];
// Index 0 is transparent by convention everywhere in this file, so a table can
// hold 254 real colours plus it. The cap exists because the colour count rides
// in a single byte of the payload; a 32x32 drawing has 1024 pixels, so running
// out is not a practical limit, it is only a format bound worth naming.
const BLOCK_PIXEL_MAX_COLOURS = 255;
// Every drawing starts from a COPY: the editor edits its palette in place
// (recolouring a swatch repaints every pixel using it), and handing out the
// shared constant would let that edit leak into the next drawing opened.
function defaultPiecePalette() { return BLOCK_PIXEL_PALETTE.slice(); }
// The one place that answers "what colour is index i in this piece?". Anything
// the table does not cover reads as transparent rather than as a crash, which
// is what makes a hand-edited or truncated code degrade into missing pixels
// instead of a broken editor.
function piecePaletteHex(palette, idx) {
  const pal = (palette && palette.length) ? palette : BLOCK_PIXEL_PALETTE;
  const hex = pal[idx];
  return (typeof hex === 'string' && hex) ? hex : 'transparent';
}
// Normalises whatever a colour input hands back ('#RGB', '#RRGGBB', mixed
// case) into the single lower-case '#rrggbb' spelling the rest of this file
// compares and stores. Without one spelling, the same colour picked twice
// could occupy two palette slots and defeat the de-duplication below.
function _normaliseHex(v) {
  let s = String(v || '').trim().toLowerCase();
  if (s === 'transparent') return 'transparent';
  if (s[0] !== '#') s = '#' + s;
  if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

// ── Per-pixel texture noise (the "Minecraft" look) ──────────────────────────
// Same technique the player sprite uses (see _playerTextured in
// voxeria-engine.js for the full rationale, kept in sync by hand): a flat
// fillRect per palette index reads as a vector shape, not a material — the
// game's own hand-painted blocks (Assets/*.png) already vary every pixel a
// little, but a player-painted custom block or creature came out perfectly
// flat, since it's built from exactly BLOCK_PIXEL_PALETTE with no noise of
// its own. Every PIXEL now gets its own small, PERMANENT brightness offset
// instead, so "this pixel is palette colour 3" still means one colour
// family, just never bit-identical to its neighbour. The offset is a pure
// function of the pixel's (row, col), not Math.random() — true randomness
// would repaint the same block differently on every redraw, which is a
// worse bug than the flatness it would "fix". Applied both to the baked
// canvas actually placed in the world (_pieceCanvasFromPixels) and to the
// editor's own live paint surface (see pixelEditor's redraw() below), so
// what you paint is what you get.
function _blockPixelHashRC(row, col) {
  let h = Math.imul(row, 374761393) + Math.imul(col, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967295;
}
const BLOCK_PIXEL_TEXTURE_NOISE = 14; // max +/- per RGB channel -- subtle, not static
function _blockPixelTextured(hex, row, col) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const d = (_blockPixelHashRC(row, col) - 0.5) * 2 * BLOCK_PIXEL_TEXTURE_NOISE;
  const c = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + c(r + d) + c(g + d) + c(b + d);
}

const BLOCK_PIXEL_COUNT = BLOCK_PIXEL_SIZE * BLOCK_PIXEL_SIZE;

// Four interchangeable packings, because which one wins depends on the art.
// The first two index the built-in 16-colour palette; the second two carry the
// drawing's own colour table in front of the pixels:
//   'P': flat 4 bits/pixel against BLOCK_PIXEL_PALETTE (always 512 bytes)
//   'R': run-length pairs [count, index], same 16 colours (tiny for the big
//        flat areas hand-drawn block art is mostly made of, worse for
//        deliberately noisy art)
//   'D': colour table + flat 8 bits/pixel (always table + 1024 bytes)
//   'C': colour table + run-length pairs [count, index], 8-bit indices
// encodePiecePixels() emits whichever came out shortest and tags it with the
// mode character, so a loadout carrying a dozen textures stays a manageable
// length without ever risking a lossy round trip.
//
// WHY THE 16-COLOUR MODES SURVIVED full-colour support instead of being
// replaced by it: a drawing that happens to use only the built-in swatches
// still encodes to the SAME bytes it did before, so (a) every code shared or
// saved before free colours existed still decodes, and (b) a code exported
// today from such a drawing can still be read by a copy of the game that
// predates this change. Only art that actually reaches for a new colour pays
// the extra bytes for a table.
function _packPixelsRaw(indices) {
  let bits = '';
  for (let i = 0; i < BLOCK_PIXEL_COUNT; i++) bits += ((indices[i] || 0) & 15).toString(2).padStart(4, '0');
  let bin = '';
  for (let i = 0; i < bits.length; i += 8) bin += String.fromCharCode(parseInt(bits.slice(i, i + 8).padEnd(8, '0'), 2));
  return bin;
}
function _unpackPixelsRaw(bin, indices) {
  let bits = '';
  for (let i = 0; i < bin.length; i++) bits += bin.charCodeAt(i).toString(2).padStart(8, '0');
  for (let i = 0; i < indices.length; i++) {
    const nib = bits.slice(i * 4, i * 4 + 4);
    indices[i] = nib.length === 4 ? parseInt(nib, 2) : 0;
  }
}
function _packPixelsRLE(indices) {
  let bin = '';
  let run = 0, cur = (indices[0] || 0) & 15;
  for (let i = 0; i < BLOCK_PIXEL_COUNT; i++) {
    const v = (indices[i] || 0) & 15;
    // A run is capped at 255 because the count rides in a single byte.
    if (v === cur && run < 255) { run++; continue; }
    bin += String.fromCharCode(run, cur);
    cur = v; run = 1;
  }
  if (run) bin += String.fromCharCode(run, cur);
  return bin;
}
function _unpackPixelsRLE(bin, indices) {
  let p = 0;
  for (let i = 0; i + 1 < bin.length; i += 2) {
    const count = bin.charCodeAt(i), idx = bin.charCodeAt(i + 1) & 15;
    for (let n = 0; n < count && p < indices.length; n++) indices[p++] = idx;
  }
}
// ── 8-bit twins of the two packings above ────────────────────────────────
// Byte-for-byte the same shape, one index per byte instead of per nibble, so
// a drawing can address a 255-entry table rather than a 16-entry one.
function _packPixelsRaw8(indices) {
  let bin = '';
  for (let i = 0; i < BLOCK_PIXEL_COUNT; i++) bin += String.fromCharCode((indices[i] || 0) & 255);
  return bin;
}
function _unpackPixelsRaw8(bin, indices) {
  for (let i = 0; i < indices.length; i++) indices[i] = i < bin.length ? (bin.charCodeAt(i) & 255) : 0;
}
function _packPixelsRLE8(indices) {
  let bin = '';
  let run = 0, cur = (indices[0] || 0) & 255;
  for (let i = 0; i < BLOCK_PIXEL_COUNT; i++) {
    const v = (indices[i] || 0) & 255;
    // A run is capped at 255 because the count rides in a single byte.
    if (v === cur && run < 255) { run++; continue; }
    bin += String.fromCharCode(run, cur);
    cur = v; run = 1;
  }
  if (run) bin += String.fromCharCode(run, cur);
  return bin;
}
function _unpackPixelsRLE8(bin, indices) {
  let p = 0;
  for (let i = 0; i + 1 < bin.length; i += 2) {
    const count = bin.charCodeAt(i), idx = bin.charCodeAt(i + 1) & 255;
    for (let n = 0; n < count && p < indices.length; n++) indices[p++] = idx;
  }
}

// ── The drawing's own colour table ───────────────────────────────────────
// One leading byte for how many real colours follow, then three bytes each.
// Index 0 is transparent and is never written: it has no RGB value to store,
// and giving it one would only invite a decoder to paint it.
function _packColourTable(table) {
  const n = Math.min(table.length - 1, BLOCK_PIXEL_MAX_COLOURS - 1);
  let bin = String.fromCharCode(n);
  for (let i = 1; i <= n; i++) {
    const hex = _normaliseHex(table[i]) || '#000000';
    bin += String.fromCharCode(parseInt(hex.slice(1, 3), 16),
                               parseInt(hex.slice(3, 5), 16),
                               parseInt(hex.slice(5, 7), 16));
  }
  return bin;
}

// Rebuilds a drawing's indices against a table holding ONLY the colours it
// actually paints with, in first-appearance order.
//
// This is what keeps a code from growing with the editor's history rather than
// with the picture: mixing thirty colours and then painting over all but four
// of them would otherwise ship thirty table entries forever. It also folds two
// palette slots that hold the same hex onto one index, which is easy to create
// by picking the same colour twice from the system picker.
function _compactPiecePalette(indices, pal) {
  const seen = new Map();               // hex -> index in the new table
  const table = ['transparent'];
  const out = new Uint8Array(BLOCK_PIXEL_COUNT);
  for (let i = 0; i < BLOCK_PIXEL_COUNT; i++) {
    const hex = _normaliseHex(piecePaletteHex(pal, indices[i] || 0));
    if (!hex || hex === 'transparent') { out[i] = 0; continue; }
    let slot = seen.get(hex);
    if (slot === undefined) {
      // Past the cap the pixel goes transparent rather than silently landing
      // on somebody else's colour. A hole is an obvious bug report, a wrong
      // colour is a confusing one. Unreachable from the editor, which enforces
      // the same cap when a colour is added.
      if (table.length >= BLOCK_PIXEL_MAX_COLOURS) { out[i] = 0; continue; }
      table.push(hex);
      slot = table.length - 1;
      seen.set(hex, slot);
    }
    out[i] = slot;
  }
  return { pixels: out, table };
}

// Is this compacted drawing expressible in the built-in 16 colours? If so it
// gets the older, shorter, backward-compatible packing (see the block comment
// above _packPixelsRaw for why that matters). Returns remapped 4-bit indices,
// or null when even one colour falls outside the starter palette.
function _asClassicIndices(pixels, table) {
  const map = new Uint8Array(table.length);
  for (let i = 1; i < table.length; i++) {
    const at = BLOCK_PIXEL_PALETTE.indexOf(table[i]);
    if (at < 1) return null;
    map[i] = at;
  }
  const out = new Uint8Array(BLOCK_PIXEL_COUNT);
  for (let i = 0; i < BLOCK_PIXEL_COUNT; i++) out[i] = map[pixels[i]] || 0;
  return out;
}

function encodePiecePixels(indices, palette) {
  const pal = (palette && palette.length) ? palette : BLOCK_PIXEL_PALETTE;
  const { pixels, table } = _compactPiecePalette(indices, pal);
  const classic = _asClassicIndices(pixels, table);
  if (classic) {
    const raw = _packPixelsRaw(classic);
    const rle = _packPixelsRLE(classic);
    return rle.length < raw.length ? 'R' + _pieceB64url(rle) : 'P' + _pieceB64url(raw);
  }
  const head = _packColourTable(table);
  const raw = head + _packPixelsRaw8(pixels);
  const rle = head + _packPixelsRLE8(pixels);
  return rle.length < raw.length ? 'C' + _pieceB64url(rle) : 'D' + _pieceB64url(raw);
}
// Returns { pixels, palette }. The palette is the drawing's own colour table
// for the full-colour modes, and the built-in one for the 16-colour modes.
// `legacyRaw` decodes the original untagged all-4bpp payload (VXB1- codes),
// which had no mode character in front of it.
function decodePiecePixels(payload, legacyRaw) {
  const indices = new Uint8Array(BLOCK_PIXEL_COUNT);
  let palette = BLOCK_PIXEL_PALETTE;
  try {
    const s = String(payload || '');
    if (legacyRaw) {
      _unpackPixelsRaw(_pieceB64urlDecode(s), indices);
      return { pixels: indices, palette };
    }
    const bin = _pieceB64urlDecode(s.slice(1));
    const mode = s[0];
    if (mode === 'C' || mode === 'D') {
      const n = Math.min(bin.charCodeAt(0) & 255, BLOCK_PIXEL_MAX_COLOURS - 1);
      const table = ['transparent'];
      for (let i = 0; i < n; i++) {
        const p = 1 + i * 3;
        const byte = k => (bin.charCodeAt(k) & 255) || 0;
        table.push('#' + [byte(p), byte(p + 1), byte(p + 2)]
          .map(v => v.toString(16).padStart(2, '0')).join(''));
      }
      palette = table;
      const body = bin.slice(1 + n * 3);
      if (mode === 'C') _unpackPixelsRLE8(body, indices); else _unpackPixelsRaw8(body, indices);
    } else if (mode === 'R') {
      _unpackPixelsRLE(bin, indices);
    } else {
      _unpackPixelsRaw(bin, indices);
    }
  } catch (e) { /* garbage input just yields a blank (all-transparent) texture */ }
  return { pixels: indices, palette };
}

// ── Piece code: <prefix><params>.<name>.<pixels><checksum> ──────────────
// One codec for every piece kind. Blocks and creatures differ only in their
// field table and prefix, both of which live in PIECE_KINDS — so adding a
// kind never means writing another encoder, and every kind automatically
// inherits the same clamping and checksum behaviour.
function encodePieceCode(kindName, piece) {
  const def = PIECE_KINDS[kindName];
  let bits = pieceFieldsToRaw(def.fields, piece);
  while (bits.length % 5) bits += '0';
  let params = '';
  for (let i = 0; i < bits.length; i += 5) params += MOD_B32[parseInt(bits.slice(i, i + 5), 2)];
  const nameB64 = _pieceB64url(unescape(encodeURIComponent(_modCleanText(piece.name, 24))));
  const body = def.hasPixels
    ? params + '.' + nameB64 + '.' + encodePiecePixels(piece.pixels || [], piece.palette)
    : params + '.' + nameB64;
  return def.prefix + body + modChecksum(body);
}
function decodePieceCode(s) {
  const hit = _pieceLookup(s);
  if (!hit) return null;
  const raw = String(s).slice(hit.prefix.length).trim();
  if (raw.length < 2) return null;
  const body = raw.slice(0, -2);
  if (modChecksum(body) !== raw.slice(-2).toUpperCase()) {
    console.warn('Voxeria: piece code failed its checksum — corrupt or edited.');
    return null;
  }
  const parts = body.split('.');
  let bits = '';
  for (const ch of (parts[0] || '').toUpperCase()) {
    const v = MOD_B32_LOOKUP[ch];
    if (v === undefined) return null;
    bits += v.toString(2).padStart(5, '0');
  }
  const out = pieceDefaults(hit.def.fields);
  pieceRawToFields(hit.def.fields, bits, out);
  out.kind = hit.kindName;
  const fallbackName = { CREATURE: 'Custom Creature' }[hit.kindName] || 'Custom Block';
  try { out.name = _modCleanText(decodeURIComponent(escape(_pieceB64urlDecode(parts[1]))), 24) || fallbackName; }
  catch (e) { out.name = fallbackName; }
  if (hit.def.hasPixels) {
    const art = decodePiecePixels(parts[2], hit.legacy);
    out.pixels = art.pixels;
    // Travels with the pixels from here on: every consumer that paints them
    // (the world texture, the creature sprite, the editor) needs the table the
    // indices were written against, and the built-in palette is only the right
    // answer for the two 16-colour modes.
    out.palette = art.palette;
  }
  return out;
}
// Kind-checked wrappers — a BLOCK call site must never silently accept a
// CREATURE code just because both decode cleanly.
function isBlockPieceCode(s) { return isPieceCode(s, 'BLOCK'); }
function decodeBlockPieceCode(s) { return isBlockPieceCode(s) ? decodePieceCode(s) : null; }
function encodeBlockPieceCode(piece) { return encodePieceCode('BLOCK', piece); }
function isCreaturePieceCode(s) { return isPieceCode(s, 'CREATURE'); }
function decodeCreaturePieceCode(s) { return isCreaturePieceCode(s) ? decodePieceCode(s) : null; }
function encodeCreaturePieceCode(piece) { return encodePieceCode('CREATURE', piece); }

// =========================================================
// FUNCTION GRAPHS — the visual mod system: predefined blocks wired together
// with lines. An EVENT node starts a chain ("when the player mines a grass
// block"), ACTION nodes hang off it in order, and CONDITION nodes fork the
// chain in two. One graph can hold several independent event chains, and the
// whole graph is one mod.
//
// The catalog below is the entire vocabulary — a mod can only ever combine
// entries from it, never ship code. That is the same closed-list safety rule
// the piece formats follow (see the note above MOD_SPRITES), and it is what
// makes a shared graph safe to run the moment it is pasted in.
//
// Param kinds:
//   block    — a block id, drawn in the editor as that block's real artwork
//   creature — one of the player's own saved creature pieces, by index
//   num      — integer or 1-decimal number, clamped to [min,max]
//   text     — short free text, control characters stripped
//   enum     — index into `list`
// =========================================================
// Every enum a node parameter can offer. Each list is closed on purpose: a
// value that isn't in it gets replaced by the default at decode time, so a
// hand-edited code can never name a dimension, sound or biome the game does
// not actually have.
// These are the real playSound() cases (see that function) — an earlier
// version of this list carried 'pickup' and 'break', which playSound has no
// branch for, so picking them was silently a no-op.
const GRAPH_SOUNDS   = ['reward', 'hurt', 'place', 'explode', 'portal', 'jump', 'click', 'alarm', 'denied', 'buy'];
const GRAPH_DIMS     = ['OVERWORLD', 'GOLD', 'LAVA', 'OCEAN', 'VOID', 'ERG'];
const GRAPH_BIOMES   = ['FOREST', 'SNOW'];
const GRAPH_WEATHERS = ['clear', 'storm'];
const GRAPH_TIMES    = ['dawn', 'noon', 'dusk', 'midnight'];
// Where in the day/night cycle each of those sits, as a fraction of
// DAY_LENGTH — matched to the thresholds in updateDayNightCycle so setting
// "night" really does land the game in its night phase.
const GRAPH_TIME_AT  = { dawn: 0.96, noon: 0.25, dusk: 0.52, midnight: 0.75 };
const GRAPH_COLORS   = {
  white: '#ffffff', red: '#ff4a4a', orange: '#ff9a3c', gold: '#ffd54a',
  green: '#5ce46b', cyan: '#5cd9ff', blue: '#4a7dff', purple: '#c46bff', pink: '#ff6bc4'
};
const GRAPH_COLOR_KEYS = Object.keys(GRAPH_COLORS);
// Comparison used by "If a number is". Kept as plain English rather than
// symbols (==, >=, ...) so the dropdown reads the same way every other enum
// in this catalog does — GRAPH_CONDS.ifVarCompare switches on these strings
// directly, the same pattern ifWeather/ifBiome already use.
const GRAPH_VAR_OPS = ['is exactly', 'is not', 'is more than', 'is less than', 'is at least', 'is at most'];
// Live game values a mod can pull into one of its own numbers (see the
// readStat action). This is what turns the graph from "react to a thing" into
// "compute with the state of the game": without it a mod can only compare
// against literals it was authored with.
//
// Every entry is a plain number with an obvious unit — hearts, not half-hearts;
// a percentage, not a raw frame counter — because these get shown to players
// through "Show a number" and compared against numbers they typed themselves.
// The six entries after 'random 1-100' are the ones that let a mod see PAST
// its own player. Everything above them describes the person holding the
// keyboard; a minigame is by definition about somebody else being there too,
// and without these the whole catalog could express "score points" but never
// "score points for catching them".
//
// Deliberately added HERE rather than as new condition nodes: every value slot
// in the catalog already accepts any entry in this list, so six table rows give
// "If a number ..." , "Repeat while", "Set or change a number", "Show text or a
// number" and every other slot the same reach at once. A node would have
// reached one place.
//
// APPEND ONLY, never reorder or remove: a saved graph stores the source as its
// STRING ('nearest player x'), not an index, so appending is safe for every
// code ever shared — but a renamed entry would silently become an unknown
// source and clean back to a fixed amount.
const GRAPH_STATS = ['health', 'max health', 'depth', 'position x', 'time of day',
                     'held count', 'blocks carried', 'creatures nearby', 'jumps left', 'random 1-100',
                     'players here', 'nearest player distance', 'nearest player x',
                     'nearest player y', 'nearest player team', 'my team',
                     // Die fünf letzten beziehen sich auf den Spieler, um den es
                     // im gerade laufenden Spieler-Ereignis geht (beigetreten,
                     // gegangen, Zone betreten, berührt). Ausserhalb eines
                     // solchen Ereignisses lesen sie 0, genauso still
                     // wirkungslos wie "Stop it from happening" ausserhalb
                     // einer Vorher-Kette.
                     //
                     // Der Tag ist eine Zahl, keine Kennung: der Katalog kennt
                     // ausschliesslich Zahlen, und eine Firebase-UID ist eine
                     // Zeichenkette. graphPlayerTag streut sie deterministisch
                     // auf 1..9999, sodass derselbe Spieler auf JEDEM Client
                     // dieselbe Zahl bekommt, ohne dass irgendwer sie verteilen
                     // muss. Damit lassen sich Spieler vergleichen und als
                     // Listeneintrag merken, ohne dass je Text durch den
                     // Katalog wandert.
                     'event player tag', 'event player team', 'event player x',
                     'event player y', 'event player distance'];
const GRAPH_MATH_OPS = ['set to', 'add', 'subtract', 'multiply by', 'divide by', 'smallest of', 'largest of'];
// What "Set or change a text" can do, and what "If a text is" can ask. Two
// short lists rather than one shared with the number ops above: "multiply by"
// means nothing to a text, and "is more than" would have to invent an
// alphabetical order nobody asked for.
//
// 'join with' is the whole reason a text store is worth having: it is the one
// operation that BUILDS a line the mod was not authored with. 'join with a
// space' is there because the alternative is every mod writing a lone " " into
// a second text first, which is a chore the dropdown can simply absorb.
const GRAPH_TEXT_OPS = ['set to', 'join with', 'join with a space'];
const GRAPH_TEXT_CMP_OPS = ['is', 'is not', 'contains', 'is empty'];
// Dropdown lists for the blocks that replaced a row of near-identical ones.
// Their values are switched on directly, the same way GRAPH_DIMS already was,
// so each one doubles as the label the player reads.
const GRAPH_BLOCK_VERBS  = ['touches', 'mines', 'places'];
const GRAPH_PLAYER_VERBS = ['jumps', 'gets hurt', 'dies'];
// The three moments a creature has, in the order a rule usually cares about
// them. 'attacks' fires when a creature lands a hit on the player, not when it
// merely swings, so a chain hanging off it can trust that damage happened.
const GRAPH_CREATURE_VERBS = ['dies', 'is hurt', 'attacks'];
const GRAPH_DAY_PHASES   = ['night falls', 'day breaks'];
// "is the block involved" reads ctx.block — the same field the block-flavoured
// events (onBlock) and now the inventory loop (forEachItem) already populate,
// so this one option quietly works in both without knowing which put it there.
const GRAPH_BLOCK_RELS   = ['is holding', 'is standing on', 'is carrying at least', 'is the block involved'];
const GRAPH_STATES       = ['it is night', 'the player is in water', 'the player is on the ground'];
const GRAPH_WORLD_ASPECTS= ['dimension', 'biome', 'weather'];
const GRAPH_SET_ASPECTS  = ['time of day', 'weather'];
const GRAPH_GIVE_TAKE    = ['Give', 'Take away'];
const GRAPH_HEAL_HURT    = ['Heal', 'Hurt'];
const GRAPH_TEXT_WHERE   = ['as a banner', 'floating on the player'];
const GRAPH_MOVE_HOW     = ['teleport by', 'launch with force'];
const GRAPH_EMIT_AT      = ['the player', 'the block involved'];
// Which player numbers "Set a player stat" can write, and the range each is
// allowed to land in. The two `bool` entries are the old parameterless switches
// (3x3 mining, hazard immunity): as a stat they take 0 or 1, which is also the
// first time either can be switched back OFF instead of being a one-way door.
const GRAPH_PLAYER_STATS = {
  'move speed':      { min: 0.2, max: 3,   dec: 1, def: 1.5 },
  'jump power':      { min: 0.5, max: 2.5, dec: 1, def: 1.5 },
  'gravity':         { min: 0.2, max: 2,   dec: 1, def: 0.6 },
  'max hearts':      { min: 1,   max: 15,  dec: 0, def: 8 },
  'reach bonus':     { min: 0,   max: 6,   dec: 0, def: 2 },
  'air jumps':       { min: 1,   max: 4,   dec: 0, def: 2 },
  'mining yield':    { min: 1,   max: 5,   dec: 0, def: 2 },
  'damage taken':    { min: 0,   max: 4,   dec: 1, def: 0.5 },
  '3x3 mining':      { min: 0,   max: 1,   dec: 0, def: 1, bool: true },
  'hazard immunity': { min: 0,   max: 1,   dec: 0, def: 1, bool: true }
};
const GRAPH_PLAYER_STAT_KEYS = Object.keys(GRAPH_PLAYER_STATS);
// Which values the second dropdown of the world blocks may offer, given what
// the first one picked. Both fall back to a real list rather than undefined, so
// a hand-edited code naming a nonsense aspect still cleans to something real.
function graphWorldAspectList(what) {
  if (what === 'biome') return GRAPH_BIOMES;
  if (what === 'weather') return GRAPH_WEATHERS;
  return GRAPH_DIMS;
}
function graphSetAspectList(what) {
  return what === 'weather' ? GRAPH_WEATHERS : GRAPH_TIMES;
}
// The dimensions that actually have a craftable armor set, for ifWearingArmor.
// Deliberately not GRAPH_DIMS: OVERWORLD and ERG have no armor, so offering
// them would be a dropdown entry that can never be true.
//
// Read off the engine's own ARMOR_DIMS rather than copied, so adding a fifth
// armor set there puts it in this dropdown too instead of leaving a silently
// stale list. Safe at load: voxeria-engine.js is evaluated first, and the
// fallback covers the file being loaded on its own. Order does not matter —
// a graph code stores the enum's VALUE ('GOLD'), not its index.
const GRAPH_ARMOR_DIMS = typeof ARMOR_DIMS !== 'undefined'
  ? Array.from(ARMOR_DIMS)
  : ['GOLD', 'LAVA', 'OCEAN', 'VOID'];
// How many numbers one list may hold. Bounded for the same reason a saved
// number is clamped to [-9999, 9999]: a mod is shared code from a stranger, and
// "add to the end" inside a loop must have a ceiling it cannot walk past. 20 is
// enough for the things lists are actually for here (a scoreboard, a spawn
// table, a set of waypoints, a remembered inventory) while staying small enough
// that a graph holding several of them cannot grow without limit.
const GRAPH_MAX_LIST = 20;
// Weiteste Reichweite, die eine "berührt mich"-Karte verlangen darf. Steht
// HIER und nicht unten bei der Präsenz-Logik, weil NODE_CATALOG die Zahl als
// Obergrenze seines Parameters braucht und weiter oben im Modul steht: eine
// später deklarierte Konstante wäre beim Auswerten des Katalogs noch nicht
// verfügbar und bräche das Laden der ganzen Datei.
const GRAPH_TOUCH_MAX_RANGE = 8;
// What "Change a list" can do. Closed like every other enum in this catalog, and
// switched on directly by GRAPH_ACTIONS.changeList, so each entry doubles as the
// label the player reads in the dropdown.
const GRAPH_LIST_OPS = ['add to the end', 'set the item at', 'remove the item at',
                        'remove the last', 'clear it'];
// Was "Start or stop a countdown" kann, und was die Punktetafel zeigen kann.
// Beide werden direkt darauf verglichen, jeder Eintrag ist also zugleich die
// Beschriftung im Auswahlkasten.
const GRAPH_TIMER_OPS = ['start', 'stop'];
const GRAPH_BOARD_OPS = ['per player', 'per team', 'hide it'];
// ── Panels: die eigene Anzeige eines Mods ────────────────────────────────
// Alles, was ein Mod bisher zeigen konnte, war fluechtig (Banner 2,5 Sekunden,
// schwebende Schrift) oder fest gebaut (die Arena-Punktetafel). Eine Zeile, die
// STEHEN bleibt und sich fortschreibt -- "Welle 3", "Leben: 2", "noch 45s" --
// war nicht sagbar, und genau das braucht jedes Minispiel.
//
// Bewusst KEINE freie Oberflaeche. Ein Panel ist ein Kasten in einer Ecke mit
// einer Ueberschrift und bis zu sechs Zeilen, und ein Mod beschreibt nur, WAS
// in Zeile 3 steht. Er schreibt nie Markup in die Seite, genau wie beim Dialog:
// das ist die Bedingung dafuer, dass ein geteilter Mod von einem Fremden
// harmlos bleibt. Gezeichnet wird deshalb ueber textContent, nicht innerHTML.
const GRAPH_PANEL_CORNERS = ['top left', 'top right', 'bottom left', 'bottom right'];
const GRAPH_PANEL_OPS = ['show', 'hide', 'clear'];
// Begrenzt wie graphZones und aus demselben Grund: eine Regel, die jeden Frame
// laeuft, darf den Bildschirm nicht unbegrenzt zupflastern koennen.
const GRAPH_MAX_PANELS = 4;
const GRAPH_MAX_PANEL_LINES = 6;
const GRAPH_DIALOG_HOLD = ['hold me still', 'let me keep moving'];
// Angehoben von 60 auf 150, nachdem gemessen wurde, was die alte Grenze
// überhaupt geschützt hat. Das Ergebnis war: nicht die Ausführung.
//
//   Ausführung   ein Graph mit 400 Karten läuft genauso schnell wie einer mit
//                60 (rund 6 ms im ungünstigsten Fall), weil GRAPH_MAX_STEPS
//                die Arbeit deckelt und nicht die Kartenzahl. Der Scan über
//                alle Karten aller Mods kostet bei 1200 Karten 0,0017 ms je
//                Frame, also ein Hundertstel Prozent des Frame-Budgets.
//   Teilen       war ein echter Einwand: 150 Karten wären 26,5 KB Code
//                gewesen. Seit VXG2- komprimiert, sind es rund 4,4 KB und
//                damit weniger als die Hälfte dessen, was 60 Karten vorher
//                unkomprimiert kosteten.
//   Darstellung  war der eigentliche Engpass: 234 ms, um 150 Karten
//                aufzubauen. Seit das erzwungene Reflow in ngRender aufgelöst
//                und die Icons gebacken sind, sind es rund 47 ms, ebenfalls
//                weniger als die 100 ms, die 60 Karten vorher gekostet haben.
//
// Beide Kosten liegen bei 150 Karten also unter dem, was 60 Karten vor diesen
// Änderungen verursacht haben. GRAPH_MAX_STEPS bleibt bei 2000 und unverändert:
// es ist nachweislich das, was tatsächlich schützt.
const GRAPH_MAX_NODES = 150;
// Dasselbe Verhältnis wie vorher (Karten mal 1,5). Linien kosten keine eigene
// Laufzeit, sie begrenzen nur, wie verzweigt ein Graph sein darf.
const GRAPH_MAX_WIRES = 225;
// A single "Repeat" node cannot ask for more than this many passes. The
// runtime clamps to it (graphResolveInt below) and the editor's own number
// field is built against the same constant, so the two can never disagree
// about the ceiling.
const GRAPH_MAX_LOOP_ITERS = 200;

// ── Value slots ───────────────────────────────────────────────────────────
// Anywhere the catalog used to demand a typed-in number it now takes a *slot*:
// either a fixed amount, a saved number, or one of the live readings in
// GRAPH_STATS. This is what lets one block replace a pair that only ever
// differed by which of those two it accepted. "If a number is" and "If two
// numbers compare" were the same question asked twice; so were "Do maths on a
// number" and "Do maths with another number". With a slot on the right-hand
// side there is one of each, and it can also do what neither could: compare or
// compute against a live reading without parking it in a variable first.
//
// Stored as { s: source, n: fixed number, v: saved-number name } so the shape
// is the same whichever source is picked, and an old code carrying a bare
// number upgrades to it cleanly (see GRAPH_LEGACY_NODES).
const VALUE_FIXED = 'a fixed amount';
const VALUE_VAR   = 'a saved number';
const VALUE_NONE  = 'nothing';
// The two list readings. Added as SOURCES rather than as their own condition
// and action nodes for the reason spelled out on GRAPH_STATS above: every value
// slot in the catalog already accepts any source, so two entries here give
// "If a number ...", "Repeat while", "Set or change a number", "Show text or a
// number" and every other slot the ability to read a list at once. Two nodes
// would each have reached one place.
//
// They reuse the slot's existing { s, n, v } shape instead of widening it:
// `v` carries the list name (the same field a saved number already uses for
// its name) and, for VALUE_LIST, `n` carries the position. That is what keeps
// every graph code ever shared readable by this build, since the stored shape
// did not change at all.
//
// The position is therefore a literal, not itself a slot: reading "the item at
// whatever POS currently says" is what the "For each item in a list" loop is
// for, and nesting a slot inside a slot would have changed the stored shape for
// every mod in existence to serve the rarer half of that pair.
const VALUE_LIST     = 'an item in a list';
const VALUE_LIST_LEN = 'how many in a list';
// The position AT a position: reads a list at whatever a nested value slot
// currently says, instead of the number the mod was authored with. This is
// the one thing VALUE_LIST could not express - "$LISTE[$I]" rather than only
// "$LISTE[3]" - and it is deliberately its own source rather than a fourth
// field VALUE_LIST always carries, so every old graph keeps meaning exactly
// what it always meant.
//
// Stored as { s, n, v, idx }: `v` is still the list name, `idx` is a full
// nested value slot cleaned through graphCleanValue itself with
// LIST_INDEX_SOURCES (see below), which excludes this very source. That is
// what makes "the index is itself dynamic-by-a-dynamic-index" structurally
// impossible rather than merely discouraged - the nested clean can never
// produce this source, so graphResolveValue's own recursion into it is
// bounded at exactly one level no matter what a hand-edited code claims.
const VALUE_LIST_DYNAMIC = 'an item in a list, at a position I calculate';
// Sekunden, die auf einem benannten Countdown noch stehen. Benutzt `v` als
// Namen, genauso wie die Listenlänge es tut, und wird deshalb vor den
// Messwert-Lesern behandelt: die bekommen keine Argumente und könnten den
// Namen gar nicht sehen.
const VALUE_COUNTDOWN = 'seconds left on a countdown';
// The live readings are exactly GRAPH_STATS, resolved through the same
// GRAPH_STAT_READERS table "Read a game value" already used, so a slot and a
// read can never disagree about what "health" means.
// APPEND-ONLY applies to this list for the same reason it applies to
// GRAPH_STATS: a slot stores its source as a STRING, so adding entries is safe
// but renaming one would silently turn every mod using it into a fixed amount.
const VALUE_SOURCE_KEYS = [VALUE_FIXED, VALUE_VAR, VALUE_LIST, VALUE_LIST_DYNAMIC, VALUE_LIST_LEN,
                           VALUE_COUNTDOWN, ...GRAPH_STATS];
// Everything VALUE_LIST_DYNAMIC's own `idx` may be, which is everything
// EXCEPT itself. Filtered rather than hand-listed so a future source is
// automatically available inside a dynamic index too, the same "add it once,
// every slot gets it" property the rest of this catalog already has.
const LIST_INDEX_SOURCES = VALUE_SOURCE_KEYS.filter(k => k !== VALUE_LIST_DYNAMIC);
const LIST_INDEX_SPEC = { min: 1, max: GRAPH_MAX_LIST, dec: 0, def: 1, sources: LIST_INDEX_SOURCES };

// ── Text slots ────────────────────────────────────────────────────────────
// The text counterpart of the value slot above, deliberately built as its own
// parallel type rather than a fourth source on the number slot. Two reasons,
// and the second is the load-bearing one:
//
//   * every existing slot promises a NUMBER to whatever reads it (a count, a
//     radius, a stat). A source that could hand back text would mean every one
//     of those readers needs an answer for "what if this is a word", for the
//     sake of the two places that actually want one.
//   * the stored shape of every value slot in every mod code ever shared would
//     have had to grow a field. Keeping text in its own {s, t, v} shape means
//     not one byte of an existing code changes meaning.
//
// So the rule is: a number slot is still numbers only, and a text slot is
// text only. They meet in exactly one place — "Show text or a number", which
// has one of each and always did.
const TEXT_FIXED = 'a fixed text';
const TEXT_VAR   = 'a saved text';
const TEXT_SOURCE_KEYS = [TEXT_FIXED, TEXT_VAR];
// The longest a saved text may be, and the same 48 the banner field already
// allowed when it was a fixed string. Sharing the number keeps "what I can
// type into the box" and "what a mod can build up" the same size, so a joined
// text can never be silently longer than one a player could have written.
const GRAPH_MAX_TEXT = 48;

// Mirrors graphCleanValue. Accepts a bare string as well as the {s, t, v}
// shape: that is what carries every mod code written before text slots
// existed, where showText.text and showDialog.title were plain strings. Such a
// value lands on TEXT_FIXED holding exactly the words it always held, so an
// old code shows the same banner it always did.
function graphCleanTextValue(spec, raw) {
  const allowed = spec.sources || TEXT_SOURCE_KEYS;
  const max = spec.max || GRAPH_MAX_TEXT;
  if (typeof raw === 'string' || typeof raw === 'number') {
    return { s: TEXT_FIXED, t: _modCleanText(raw, max), v: 'TEXT' };
  }
  const o = (raw && typeof raw === 'object') ? raw : {};
  const s = allowed.includes(o.s) ? o.s : (spec.defSrc || TEXT_FIXED);
  const t = _modCleanText(o.t == null ? (spec.def || '') : o.t, max);
  // Same normalisation varname uses, so #score, #Score and #SCORE are one
  // text the way $SCORE is one number.
  const v = String(o.v == null ? '' : o.v).toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 16) || 'TEXT';
  return { s, t, v };
}

// Mirrors graphResolveValue, returning '' where that one returns 0. There is
// no "nothing" source here and so no null case: a text slot that is empty is
// an empty text, which every reader can already show.
function graphResolveText(val) {
  if (typeof val === 'string') return _modCleanText(val, GRAPH_MAX_TEXT);
  if (!val || typeof val !== 'object') return '';
  if (val.s === TEXT_VAR) return graphGetText(val.v);
  return typeof val.t === 'string' ? val.t : '';
}

function graphCleanValue(spec, raw) {
  const allowed = spec.sources || VALUE_SOURCE_KEYS;
  const o = (raw && typeof raw === 'object') ? raw : {};
  const s = allowed.includes(o.s) ? o.s : (spec.defSrc || VALUE_FIXED);
  const dec = spec.dec || 0;
  const n0 = Number(o.n);
  const n = isFinite(n0)
    ? Math.max(spec.min, Math.min(spec.max, Number(n0.toFixed(dec))))
    : spec.def;
  const v = String(o.v == null ? '' : o.v).toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 16) || 'SCORE';
  const out = { s, n, v };
  if (s === VALUE_LIST_DYNAMIC) out.idx = graphCleanValue(LIST_INDEX_SPEC, o.idx);
  return out;
}

// Returns null only for the "nothing" source, so a caller can tell "no number
// was asked for" apart from "the number is 0".
function graphResolveValue(val) {
  if (!val || typeof val !== 'object') return 0;
  if (val.s === VALUE_NONE) return null;
  if (val.s === VALUE_FIXED) return val.n;
  if (val.s === VALUE_VAR) return graphGetVar(val.v);
  // Both read through the helpers next to graphGetVar, so an unset list reads
  // as "empty" (0 items, every position 0) exactly the way an unset number
  // reads as 0 rather than blowing up on the first run.
  if (val.s === VALUE_LIST) return graphGetListItem(val.v, val.n);
  if (val.s === VALUE_LIST_DYNAMIC) return graphGetListItem(val.v, graphResolveValue(val.idx));
  if (val.s === VALUE_LIST_LEN) return graphGetList(val.v).length;
  if (val.s === VALUE_COUNTDOWN) return graphCountdownLeft(val.v);
  const fn = GRAPH_STAT_READERS[val.s];
  if (!fn) return val.n;
  try {
    const n = Number(fn());
    return isFinite(n) ? n : 0;
  } catch (e) { return 0; }
}
// For a slot feeding something that only makes sense whole and bounded (an item
// count, a radius). Clamped here rather than trusted: a live reading can hand
// back whatever the world happens to be doing.
function graphResolveInt(val, min, max) {
  const n = graphResolveValue(val);
  if (n === null) return null;
  return Math.max(min, Math.min(max, Math.round(n)));
}
function graphResolveNum(val, min, max) {
  const n = graphResolveValue(val);
  if (n === null) return null;
  return Math.max(min, Math.min(max, n));
}

const NODE_CATALOG = {
  // ── Events: one output, `out` ──
  onWorldStart: { kind: 'event', label: 'When the world starts', params: [] },
  onTimer:      { kind: 'event', label: 'Every N seconds',
                  params: [{ k: 'seconds', kind: 'num', min: 1, max: 60, dec: 0, def: 5 }] },
  // One block for all three block-flavoured events. `how` is matched against
  // the context fireGraphEvent was called with, exactly like `dim` below, so
  // three entries that differed by a single verb are one entry with a verb.
  onBlock:      { kind: 'event', label: 'When the player ... a block',
                  params: [{ k: 'how', label: 'the player', kind: 'enum', list: GRAPH_BLOCK_VERBS, def: 'mines' },
                           { k: 'block', label: 'the block', kind: 'block', def: 1 }] },
  onPlayer:     { kind: 'event', label: 'When the player ...',
                  params: [{ k: 'how', label: 'the player', kind: 'enum', list: GRAPH_PLAYER_VERBS, def: 'jumps' }] },
  onEnterDim:   { kind: 'event', label: 'When entering a dimension',
                  params: [{ k: 'dim', label: 'dimension', kind: 'enum', list: GRAPH_DIMS, def: 'GOLD' }] },
  onDayPhase:   { kind: 'event', label: 'When the time of day changes',
                  params: [{ k: 'phase', label: 'when', kind: 'enum', list: GRAPH_DAY_PHASES, def: 'night falls' }] },
  // Not a real event — a named entry point. Nothing in the game fires this on
  // its own; only the "Call by name" action does (see GRAPH_ACTIONS.callSignal
  // below). Together these two are the mod system's stand-in for a function:
  // build the chain once under a name, "call" it from as many other chains as
  // you like instead of copy-pasting it, hand it one number in, and read one
  // number back out via "Return a value" — see callSignal for how the two
  // ends actually meet.
  // Three receiving slots rather than one. A helper that could only be handed a
  // single number was a function of one argument, which is what forced the
  // "park the other values in globals first, then call" shape every non-trivial
  // mod ended up writing. Each name is filled in only if the matching slot of
  // the call actually passed something (see fireGraphEvent), so a call from
  // before this existed still means exactly what it did: ARG is written, ARG2
  // and ARG3 are left holding whatever they already held.
  onSignal:     { kind: 'event', label: 'When called by name',
                  params: [{ k: 'signal', kind: 'varname', def: 'HELPER' },
                           { k: 'argVar',  label: 'receiving', kind: 'varname', def: 'ARG' },
                           { k: 'argVar2', label: 'and',       kind: 'varname', def: 'ARG2' },
                           { k: 'argVar3', label: 'and',       kind: 'varname', def: 'ARG3' }] },

  // The listening half of "Announce something happened". Deliberately NOT a
  // second spelling of "When called by name": the two differ in WHEN they run,
  // which is the whole reason this pair exists.
  //
  //   Call by name  runs its chains immediately, nested inside the caller, and
  //                 hands a value back. It is a question with an answer, and it
  //                 is bounded by GRAPH_MAX_SIGNAL_DEPTH because each nested
  //                 call sits on the stack of the one before it.
  //   Announce      queues, and the listeners run on the next tick with the
  //                 announcer already finished. Nothing is handed back, nothing
  //                 nests, and a chain reaction (a wave announces, a listener
  //                 announces the next wave) is a flat queue rather than a
  //                 stack that runs out of depth after eight steps.
  //
  // That second shape is what lets a large mod be built as independent parts
  // that never call each other directly, which is the thing neither the events
  // the game fires nor "Call by name" could express.
  onAnnounced:  { kind: 'event', label: 'When something is announced',
                  params: [{ k: 'event', label: 'announcement', kind: 'varname', def: 'WAVE' },
                           { k: 'valueVar', label: 'value into', kind: 'varname', def: 'INFO' }] },

  // ── Mehrspieler: die vier Karten, die andere Spieler MELDEN ─────────────
  // Bisher waren andere Spieler nur ablesbar ("nearest player distance"), also
  // musste eine Regel selbst nachsehen und den Unterschied zum letzten Mal
  // erraten. Diese vier melden sich von sich aus, und das ist der Unterschied
  // zwischen "ich kann fragen, wie weit jemand weg ist" und "sag mir, wenn
  // jemand kommt".
  //
  // Alle vier tragen denselben Kontext: welcher Spieler es war (als Zahl, siehe
  // graphPlayerTag), wo er ist, in welcher Mannschaft und wie weit weg. Gelesen
  // wird das über die fünf "event player"-Werte, die jeder Wert-Slot anbietet.
  //
  // Sie feuern LOKAL auf jedem Client, so wie jede andere Regel auch. Jeder
  // sieht dieselben Präsenzdaten, also kommt jeder zum selben Schluss, ohne
  // dass irgendetwas ausgehandelt werden müsste.
  onPlayerJoin:  { kind: 'event', label: 'When another player arrives', params: [] },
  onPlayerLeave: { kind: 'event', label: 'When another player leaves', params: [] },
  // Die Zone wird von "Mark a zone here" gesetzt, nicht hier: eine Karte, auf
  // der man Weltkoordinaten eintippen müsste, wäre im Spiel unbrauchbar.
  onPlayerEnterZone: { kind: 'event', label: 'When a player enters a zone',
                       params: [{ k: 'zone', label: 'zone', kind: 'varname', def: 'BASE' }] },
  // Gegenstueck zu onPlayerEnterZone, ueber dieselbe Ein-/Austritts-Erkennung
  // in graphSweepZones. Beide feuern jetzt auch fuer den lokalen Spieler
  // selbst, nicht nur fuer andere -- vorher liess sich ein Zonen-Mod nie
  // allein testen, und "Offline - solo test run" ist der haeufigste
  // Arena-Testfall ueberhaupt.
  onPlayerLeaveZone: { kind: 'event', label: 'When a player leaves a zone',
                       params: [{ k: 'zone', label: 'zone', kind: 'varname', def: 'BASE' }] },
  // Die Frage-Version der beiden Ereignisse oben: nicht "gerade betreten",
  // sondern "steht gerade drin". Damit lassen sich Dinge bauen, die
  // weiterlaufen, SOLANGE jemand in der Zone steht, statt nur einmal beim
  // Betreten zu feuern -- ein Huegel, der jede Sekunde Punkte gibt, oder eine
  // Zone ausserhalb der man Schaden nimmt. Fragt immer nach MIR, nicht nach
  // irgendeinem Spieler: die anderen Zonen-Karten sagen von sich aus Bescheid,
  // wenn jemand kommt oder geht, aber eine Bedingung braucht ein festes "wer".
  ifInZone:      { kind: 'cond', label: 'If I am standing in a zone',
                   params: [{ k: 'zone', label: 'zone', kind: 'varname', def: 'BASE' }] },
  // Das Grundelement für Fangen, Infektion und alles, was mit Anfassen zu tun
  // hat. Nähe statt Tastendruck, weil das Spiel keine Taste für "andere Spieler
  // berühren" hat und ein neuer Eingriff in die Engine dafür zu teuer wäre.
  // Feuert höchstens alle 1,5 Sekunden je Spieler, sonst löste Nebeneinanderstehen
  // sie jeden Frame aus.
  onPlayerTouch: { kind: 'event', label: 'When a player touches me',
                   params: [{ k: 'range', label: 'within', kind: 'num',
                              min: 1, max: GRAPH_TOUCH_MAX_RANGE, dec: 0, def: 2 }] },

  // Feuert genau einmal, wenn der benannte Countdown null erreicht. Die Sekunden
  // davor liest man über die Wert-Quelle "seconds left on a countdown", sodass
  // eine Regel auch WÄHREND des Laufens etwas tun kann und nicht nur am Ende.
  onCountdownEnd: { kind: 'event', label: 'When a countdown ends',
                    params: [{ k: 'timer', label: 'countdown', kind: 'varname', def: 'ROUND' }] },

  // Die Antwort auf einen Dialog. Getroffen wird ueber die AUFSCHRIFT des
  // Knopfes, nicht ueber eine Nummer: so steht in der Regel dasselbe Wort, das
  // der Spieler angeklickt hat, und ein umsortierter Dialog bricht nichts.
  //
  // Feuert nur LOKAL, also auf dem Bildschirm, auf dem geklickt wurde. Der
  // Klick eines anderen Spielers erreicht diesen Client nicht: es gibt keinen
  // Kanal dafuer. Wer das braucht, laesst die Regel nach dem Druck etwas tun,
  // das ohnehin geteilt wird, etwa "Score points" oder eine Ankuendigung.
  onButtonPress: { kind: 'event', label: 'When a dialog button is pressed',
                   params: [{ k: 'button', label: 'button', kind: 'text', def: 'OK', max: 20 }] },

  // ── The three that fire BEFORE the game acts ──
  // Everything above reports something that already happened. These three run
  // while the game is still deciding, so a chain hanging off them can change
  // the outcome with "Stop it from happening" / "Change the amount to" (see
  // GRAPH_ACTIONS.preventIt). That is the whole difference between a mod that
  // decorates the game and one that overrules it.
  //
  // They exist without touching voxeria-engine.js: installGraphHooks() below
  // wraps the engine's own takeDamage/breakSingleBlock/addToInventory.
  // The creature half of onBlock/onPlayer: one event, one verb dropdown, three
  // moments. Deliberately NOT split into three nodes, for the same reason
  // "When the player ... a block" is one node — they differ by a verb.
  //
  // It matches on the verb only, not on WHICH creature: a wave-survival rule
  // ("when a creature dies, score a point") wants every creature, and the
  // catalog's creature picker has no "any" value to offer. The creature that
  // triggered it still travels in the context, so an action hanging off this
  // acts on the right one.
  onCreature:   { kind: 'event', label: 'When a creature ...',
                  params: [{ k: 'how', label: 'a creature', kind: 'enum', list: GRAPH_CREATURE_VERBS, def: 'dies' }] },

  onBeforeHurt: { kind: 'event', label: 'Before the player is hurt', params: [] },
  onBeforeMine: { kind: 'event', label: 'Before a block breaks',
                  params: [{ k: 'block', kind: 'block', def: 1 }] },
  onPickup:     { kind: 'event', label: 'When the player picks up',
                  params: [{ k: 'block', kind: 'block', def: 1 }] },

  // ── Loops: two outputs, `body` (walked once per pass) and `done` (walked
  // once, after the last pass). Its own `kind` rather than a stretched
  // `cond`, because a loop does not pick one of its two outputs the way a
  // condition does — it walks `body` repeatedly and then, always, `done`.
  // See graphWalk for how the two outputs are actually driven, and its
  // comment for the one thing a loop body cannot contain: "Wait".
  repeatTimes: { kind: 'loop', label: 'Repeat',
                 params: [{ k: 'count', label: 'how many times', kind: 'value',
                            min: 1, max: GRAPH_MAX_LOOP_ITERS, dec: 0, def: 5 }] },
  // The other half of "Repeat": a count set once versus a question asked again
  // before every pass. Same a/op/b shape "If a number ..." uses, so whatever a
  // player already knows about that condition transfers here for free. Capped
  // at GRAPH_MAX_LOOP_ITERS passes the same way "Repeat" is capped at that many
  // — a condition that stays true is not allowed to behave differently from a
  // count that was simply set too high.
  repeatWhile: { kind: 'loop', label: 'Repeat while',
                 params: [{ k: 'a', label: 'while', kind: 'value', min: -9999, max: 9999, dec: 1, def: 0,
                            defSrc: VALUE_VAR },
                          { k: 'op', label: '', kind: 'enum', list: GRAPH_VAR_OPS, def: 'is less than' },
                          { k: 'b', label: '', kind: 'value', min: -9999, max: 9999, dec: 1, def: 10 }] },
  // The third loop: walking a real collection instead of counting or asking.
  // Bounded for free — the inventory has a fixed 58 slots, so unlike the other
  // two this one needs no cap of its own. Each pass writes the slot's block id
  // and stack size into the two saved numbers named here (see graphWalk), AND
  // sets ctx.block/ctx.count for that pass — the same ctx shape onBlock's
  // "touches/mines/places" events already carry, which is what lets "If the
  // player ... a block" → "is the block involved" and "Give or take the block
  // involved" work identically whether they are sitting inside this loop or
  // inside a mine/place event.
  forEachItem: { kind: 'loop', label: 'For each item I\'m carrying',
                 params: [{ k: 'itemVar', label: 'item into', kind: 'varname', def: 'ITEM' },
                          { k: 'countVar', label: 'count into', kind: 'varname', def: 'COUNT' }] },
  // The fourth loop, and the one that makes lists worth having: a value slot can
  // read a list at a position it was authored with, but only this can walk a
  // list whose length the mod does not know. Every "find the biggest", "add them
  // up", "is this one already in there" shape needs that, and none of them are
  // expressible with a fixed position.
  //
  // Bounded by GRAPH_MAX_LIST for free, since that is the most a list can hold.
  // Each pass writes the value and its 1-based position into the two saved
  // numbers named here, mirroring what forEachItem does with block and count.
  forEachInList: { kind: 'loop', label: 'For each item in a list',
                   params: [{ k: 'list', label: 'list', kind: 'varname', def: 'ITEMS' },
                            { k: 'itemVar', label: 'value into', kind: 'varname', def: 'ITEM' },
                            { k: 'indexVar', label: 'position into', kind: 'varname', def: 'POS' }] },

  // ── Conditions: two outputs, `yes` and `no` ──
  ifChance:       { kind: 'cond', label: 'Random chance',
                    params: [{ k: 'percent', label: 'chance %', kind: 'num', min: 1, max: 99, dec: 0, def: 30 }] },
  // Replaces "If a number is", "If two numbers compare", "If health below" and
  // "If deeper than". Those four were one question (is this number related to
  // that number?) split by what each side was allowed to be. With a slot on
  // both sides there is one block, and it reaches further than all four did:
  // health against a saved number, depth against a random roll, one live
  // reading against another, none of which was expressible before.
  ifCompare:      { kind: 'cond', label: 'If a number ...',
                    params: [{ k: 'a', label: 'if', kind: 'value', min: -9999, max: 9999, dec: 1, def: 0,
                               defSrc: VALUE_VAR },
                             { k: 'op', label: '', kind: 'enum', list: GRAPH_VAR_OPS, def: 'is at least' },
                             { k: 'b', label: '', kind: 'value', min: -9999, max: 9999, dec: 1, def: 1 }] },
  // The text counterpart of "If a number ...", with a slot on both sides for
  // the same reason that one has: comparing a saved text against a fixed one
  // and comparing two saved texts against each other are the same question,
  // and splitting them would be the duplication this catalog was collapsed to
  // remove.
  //
  // 'is empty' looks at the left side alone and ignores the right, which is
  // what lets a mod ask "has this been set yet" without inventing a separate
  // block for it — the same way "Change a list" ignores its position for the
  // operations that have no use for one.
  ifTextIs:       { kind: 'cond', label: 'If a text ...',
                    params: [{ k: 'a', label: 'if', kind: 'textvalue', def: '', defSrc: TEXT_VAR },
                             { k: 'op', label: '', kind: 'enum', list: GRAPH_TEXT_CMP_OPS, def: 'is' },
                             { k: 'b', label: '', kind: 'textvalue', def: '' }] },
  ifBlock:        { kind: 'cond', label: 'If the player ... a block',
                    params: [{ k: 'how', label: 'the player', kind: 'enum', list: GRAPH_BLOCK_RELS, def: 'is holding' },
                             { k: 'block', label: 'the block', kind: 'block', def: 1 },
                             { k: 'count', label: 'at least', kind: 'value', min: 1, max: 999, dec: 0, def: 10 }] },
  ifState:        { kind: 'cond', label: 'If right now ...',
                    params: [{ k: 'state', label: 'if', kind: 'enum', list: GRAPH_STATES, def: 'it is night' }] },
  // One block for dimension/biome/weather. The second dropdown's contents
  // follow the first, so it can only ever offer a value the aspect really has.
  ifWorldIs:      { kind: 'cond', label: 'If the world\'s ... is',
                    params: [{ k: 'what', label: 'the', kind: 'enum', list: GRAPH_WORLD_ASPECTS,
                               def: 'dimension', controls: true },
                             { k: 'value', label: 'is', kind: 'enum', def: 'OVERWORLD',
                               listBy: p => graphWorldAspectList(p.what) }] },
  // Reads the world itself, not the player: lets a chain look around before it
  // acts ("if there is lava two tiles down, don't dig").
  ifBlockAt:      { kind: 'cond', label: 'If the block nearby is',
                    params: [{ k: 'dx', kind: 'num', min: -12, max: 12, dec: 0, def: 0 },
                             { k: 'dy', kind: 'num', min: -12, max: 12, dec: 0, def: 1 },
                             { k: 'block', kind: 'block', def: 1 }] },
  ifWearingArmor: { kind: 'cond', label: 'If wearing armor of',
                    params: [{ k: 'dim', kind: 'enum', list: GRAPH_ARMOR_DIMS, def: 'GOLD' }] },

  // ── Actions: one output, `out`, so they chain ──
  // "Give the player" and "Take away" differed by a sign. The count is a slot,
  // so "give the player SCORE gold" is finally sayable.
  changeItems:   { kind: 'action', label: 'Give or take items',
                   params: [{ k: 'how', label: '', kind: 'enum', list: GRAPH_GIVE_TAKE, def: 'Give' },
                            { k: 'block', label: 'item', kind: 'block', def: 1 },
                            { k: 'count', label: 'how many', kind: 'value', min: 1, max: 64, dec: 0, def: 1 }] },
  // The picker-free sibling of "Give or take items": acts on ctx.block instead
  // of a chosen one, which is what makes it useful inside "For each item I'm
  // carrying" (act on whichever slot the loop is on) and inside a mine/place
  // event (act on whichever block just triggered it) without a block field
  // that would have to be wired up to match either one by hand.
  changeInvolvedItem: { kind: 'action', label: 'Give or take the block involved',
                   params: [{ k: 'how', label: '', kind: 'enum', list: GRAPH_GIVE_TAKE, def: 'Take away' },
                            { k: 'count', label: 'how many', kind: 'value', min: 1, max: 64, dec: 0, def: 1 }] },
  // Replaces "Show a message", "Pop up text on the player" and "Show a number".
  // The number slot may be set to "nothing" for plain text, which is what lets
  // one block cover all three: text alone, a number alone, or text plus number,
  // as a banner or floating on the player. Floating text carrying a live number
  // was impossible before, because "Show a number" could only ever do a banner.
  showText:      { kind: 'action', label: 'Show text or a number',
                   params: [{ k: 'where', label: 'show', kind: 'enum', list: GRAPH_TEXT_WHERE, def: 'as a banner' },
                            // A text SLOT rather than a typed-in string, which is
                            // what finally lets a banner show a line the mod built
                            // itself. An old code carrying a bare string here still
                            // decodes to exactly that string — see
                            // graphCleanTextValue.
                            { k: 'text', label: 'text', kind: 'textvalue', max: 48, def: 'Hello!' },
                            { k: 'number', label: 'and', kind: 'value', min: -9999, max: 9999, dec: 1, def: 0,
                              defSrc: VALUE_NONE, sources: [VALUE_NONE, ...VALUE_SOURCE_KEYS] },
                            { k: 'color', label: 'colour', kind: 'enum', list: GRAPH_COLOR_KEYS, def: 'gold' }] },
  changeHealth:  { kind: 'action', label: 'Heal or hurt the player',
                   params: [{ k: 'how', label: '', kind: 'enum', list: GRAPH_HEAL_HURT, def: 'Heal' },
                            { k: 'amount', label: 'by', kind: 'value', min: 1, max: 12, dec: 0, def: 2 }] },
  // The ten blocks this replaces (Set move speed / jump power / gravity / max
  // hearts / reach bonus / air jumps / mining yield, Scale all damage taken by,
  // Enable 3x3 mining, Enable hazard immunity) each wrote exactly one number and
  // differed in nothing else. As one dropdown they also gain what none of them
  // had: the two on/off ones can be switched back off, and any of them can be
  // driven by a saved number or a live reading.
  setStat:       { kind: 'action', label: 'Set a player stat',
                   params: [{ k: 'stat', label: 'set', kind: 'enum', list: GRAPH_PLAYER_STAT_KEYS,
                              def: 'move speed', controls: true },
                            { k: 'to', label: 'to', kind: 'value', rangeBy: p => GRAPH_PLAYER_STATS[p.stat],
                              min: 0, max: 15, dec: 1, def: 1.5 }] },
  // Teleporting and launching both move the player from A to B; one writes
  // position, the other velocity. Merged, a sideways launch becomes possible,
  // which "Launch the player up" could not express at all.
  movePlayer:    { kind: 'action', label: 'Move the player',
                   params: [{ k: 'how', label: '', kind: 'enum', list: GRAPH_MOVE_HOW, def: 'teleport by' },
                            { k: 'dx', label: 'sideways', kind: 'value', min: -40, max: 40, dec: 0, def: 0 },
                            { k: 'dy', label: 'up / down', kind: 'value', min: -40, max: 40, dec: 0, def: -6 }] },
  setWorld:      { kind: 'action', label: 'Set the world\'s ...',
                   params: [{ k: 'what', label: 'set the', kind: 'enum', list: GRAPH_SET_ASPECTS,
                              def: 'time of day', controls: true },
                            { k: 'value', label: 'to', kind: 'enum', def: 'midnight',
                              listBy: p => graphSetAspectList(p.what) }] },
  spawnCreature: { kind: 'action', label: 'Spawn my creature',
                   params: [{ k: 'creature', label: 'creature', kind: 'creature', def: 0 }] },
  // Everything the Creature Designer's value sliders used to set (Movement,
  // Size, Speed, How common, Lives in, Traits) before that screen became pure
  // canvas-and-name — see the note on setBlockMining below for why moving
  // these here rather than leaving them baked into the piece code is safe.
  // Reuses the exact same enum lists (CREATURE_MOVES, CREATURE_BIOMES) the old
  // sliders read from, so a value picked here means exactly what it always did.
  setCreatureBehavior: { kind: 'action', label: 'Set up my creature',
                   params: [{ k: 'creature', label: 'creature', kind: 'creature', def: 0 },
                            { k: 'move', label: 'moves by', kind: 'enum', list: CREATURE_MOVES, def: 'patrol' },
                            { k: 'size', label: 'size', kind: 'value', min: 8, max: 36, dec: 0, def: 16 },
                            { k: 'speed', label: 'speed', kind: 'value', min: 0.2, max: 1.6, dec: 1, def: 0.6 },
                            { k: 'rarity', label: 'how common', kind: 'value', min: 1, max: 8, dec: 0, def: 4 },
                            { k: 'biome', label: 'lives in', kind: 'enum', list: CREATURE_BIOMES, def: 'any' },
                            { k: 'traits', label: 'traits', kind: 'enum', list: ['none', 'glows', 'trail', 'both'], def: 'none' }] },
  // The switch that turns a painting into an enemy. Separate from "Set up my
  // creature" above rather than six more parameters on it, because these four
  // answer a different question: that one is what the creature IS, this is
  // what it does to you and what you can do to it. A mod that only wants a
  // faster butterfly should not have to scroll past a damage slider.
  //
  // health 0 puts it back to ambient, which is what every creature starts as.
  // That direction matters as much as the other: a mod must be able to
  // DISARM a creature it made dangerous, or the setting is a one-way door.
  setCreatureCombat: { kind: 'action', label: 'Set up my creature\'s fight',
                   params: [{ k: 'creature', label: 'creature', kind: 'creature', def: 0 },
                            { k: 'health', label: 'health', kind: 'value', min: 0, max: 40, dec: 0, def: 6 },
                            { k: 'damage', label: 'hits for', kind: 'value', min: 1, max: 12, dec: 0, def: 2 },
                            { k: 'attack', label: 'attacks by', kind: 'enum', list: CREATURE_ATTACKS, def: 'charge' },
                            { k: 'aggro', label: 'notices within', kind: 'value', min: 0, max: 24, dec: 0, def: 8 }] },
  // `power` is the spread the particle engine always supported and this block
  // used to throw away by hard-coding it, and `at` lets a burst happen on the
  // block that triggered the chain instead of always on the player. Same engine
  // call as before, with its knobs actually wired up.
  emitParticles: { kind: 'action', label: 'Emit particles',
                   params: [{ k: 'at', label: 'at', kind: 'enum', list: GRAPH_EMIT_AT, def: 'the player' },
                            { k: 'color', label: 'colour', kind: 'enum', list: GRAPH_COLOR_KEYS, def: 'cyan' },
                            { k: 'amount', label: 'how many', kind: 'value', min: 1, max: 60, dec: 0, def: 14 },
                            { k: 'power', label: 'spread', kind: 'value', min: 1, max: 14, dec: 0, def: 6 }] },
  shake:         { kind: 'action', label: 'Shake the screen',
                   params: [{ k: 'power', label: 'power', kind: 'value', min: 2, max: 30, dec: 0, def: 10 }] },
  playSound:     { kind: 'action', label: 'Play a sound',
                   params: [{ k: 'sound', label: 'sound', kind: 'enum', list: GRAPH_SOUNDS, def: 'reward' }] },

  // ── Numbers, timing & reuse ──
  // Replaces all five ways a mod used to put something into a number: "Set a
  // number", "Change a number by", "Read a game value into", "Do maths on a
  // number" and "Do maths with another number". They were one operation
  // (name := name OP something) split by which operation and which kind of
  // right-hand side each one accepted. The op list and the slot cover every
  // combination, including ones that had no block at all, like "set SCORE to the
  // largest of itself and the player's depth".
  changeVar:     { kind: 'action', label: 'Set or change a number',
                   params: [{ k: 'name', label: 'number', kind: 'varname', def: 'SCORE' },
                            { k: 'op', label: '', kind: 'enum', list: GRAPH_MATH_OPS, def: 'set to' },
                            { k: 'to', label: '', kind: 'value', min: -9999, max: 9999, dec: 1, def: 0 }] },
  // The text counterpart of the block above, same three-part shape: a name, an
  // operation, and a slot that may be a fixed text or another saved text.
  //
  // What this adds that nothing else could: a mod can now hold a WORD it did
  // not know when it was built and put it back together with others. Every
  // text in the system before this was typed into a box at build time and
  // could only ever be shown exactly as typed.
  changeText:    { kind: 'action', label: 'Set or change a text',
                   params: [{ k: 'name', label: 'text', kind: 'varname', def: 'LINE' },
                            { k: 'op', label: '', kind: 'enum', list: GRAPH_TEXT_OPS, def: 'set to' },
                            { k: 'to', label: '', kind: 'textvalue', def: 'Hello' }] },
  // The write half of the two list sources on every value slot. One node for all
  // five operations, the same way changeVar is one node for all seven maths
  // operations: they are one thing (this list changes) split by which change,
  // and a node per operation is exactly the duplication this catalog was
  // collapsed to remove.
  //
  // A list is what a mod could not express at all before, whatever it wired:
  // "remember the five best scores", "hold the spawn table", "queue up the
  // waypoints". Saved numbers could count things, never keep a collection of
  // them. `position` is ignored by the operations that have no use for it
  // (adding to the end, clearing), which is why it sits last.
  changeList:    { kind: 'action', label: 'Change a list',
                   params: [{ k: 'list', label: 'list', kind: 'varname', def: 'ITEMS' },
                            { k: 'how', label: '', kind: 'enum', list: GRAPH_LIST_OPS, def: 'add to the end' },
                            { k: 'value', label: 'value', kind: 'value', min: -9999, max: 9999, dec: 1, def: 0 },
                            { k: 'position', label: 'at position', kind: 'value',
                              min: 1, max: GRAPH_MAX_LIST, dec: 0, def: 1 }] },
  // Timing. Everything here fired in a single tick, so a chain could not say
  // "then, a moment later, ...". graphRunChain parks the rest of the chain in
  // graphPending and updateGraphRuntime resumes it, which keeps the step budget
  // honest: waiting is not a loop the game can be trapped inside.
  wait:          { kind: 'action', label: 'Wait, then carry on',
                   params: [{ k: 'seconds', label: 'wait', kind: 'value', min: 0.1, max: 60, dec: 1, def: 1 }] },

  // ── Overruling the game ──
  // Both only mean anything inside a chain started by one of the "Before …"
  // events; anywhere else the game has already committed and there is nothing
  // left to stop. Running one elsewhere is harmless, not an error — see the
  // note on graphEventCtx.
  preventIt:     { kind: 'action', label: 'Stop it from happening', params: [] },
  setEventAmount:{ kind: 'action', label: 'Change the amount to',
                   params: [{ k: 'amount', label: 'to', kind: 'value', min: 0, max: 24, dec: 0, def: 1 }] },
  // Rewrites what mining a block yields, for as long as the mod is enabled.
  // Reaches deeper than any single action: it changes a rule of the world
  // rather than doing one thing once.
  remapDrop:     { kind: 'action', label: 'Make this block drop',
                   params: [{ k: 'from', kind: 'block', def: 1 },
                            { k: 'to', kind: 'block', def: 1 }] },
  // What the Block Designer's Hardness and Mining sound sliders used to set
  // before that screen became pure canvas-and-name. Kept as a mod rule rather
  // than folded back into the piece code because a mod is the thing that
  // already reaches every block, not just custom ones — this can retune a
  // vanilla block's mining feel too, the same way remapDrop always could. A
  // block with no rule for it keeps whatever the piece itself was saved with
  // (a fixed default now that there is no slider) or, for a built-in block,
  // its normal tuning — see getBlockHardness/playBlockSound.
  setBlockMining:{ kind: 'action', label: "Set how a block mines",
                   params: [{ k: 'block', kind: 'block', def: 1 },
                            { k: 'hardness', label: 'hardness', kind: 'value', min: 1, max: 8, dec: 0, def: 2 },
                            { k: 'sound', label: 'sound', kind: 'enum', list: BLOCK_SOUND_FAMILIES, def: 'ore' }] },
  // Absorbs "Turn that block into" (a 1x1 box) and "Blast a hole" (a box of
  // air), so one block covers placing a single tile, clearing a crater, and
  // everything between, like dropping a 3x3 pool of water. `allowEmpty` is what
  // lets the material be air here while the inventory pickers stay clean.
  fillArea:      { kind: 'action', label: 'Fill a box with',
                   params: [{ k: 'block', label: 'material', kind: 'block', def: 1, allowEmpty: true },
                            { k: 'w', label: 'width', kind: 'value', min: 1, max: 9, dec: 0, def: 3 },
                            { k: 'h', label: 'height', kind: 'value', min: 1, max: 9, dec: 0, def: 3 }] },

  // See the onSignal event above — this is the "call" half of the pair.
  // Guarded by graphSignalDepth (see GRAPH_ACTIONS.callSignal) so a signal
  // that (directly or through a longer loop) ends up calling itself can't
  // freeze the game the way an unguarded recursive call would. `arg` may be
  // "nothing" (the default — an old call code still means exactly what it
  // used to), and `result` is written only if the called chain actually used
  // "Return a value" — a HELPER that never returns anything simply leaves
  // `result` untouched rather than zeroing it out.
  //
  // All three passing slots default to "nothing", so a call code shared before
  // the second and third existed decodes to a call that passes exactly what it
  // always did.
  callSignal:    { kind: 'action', label: 'Call by name',
                   params: [{ k: 'signal', kind: 'varname', def: 'HELPER' },
                            { k: 'arg', label: 'passing', kind: 'value', min: -9999, max: 9999, dec: 1, def: 0,
                              defSrc: VALUE_NONE, sources: [VALUE_NONE, ...VALUE_SOURCE_KEYS] },
                            { k: 'arg2', label: 'and', kind: 'value', min: -9999, max: 9999, dec: 1, def: 0,
                              defSrc: VALUE_NONE, sources: [VALUE_NONE, ...VALUE_SOURCE_KEYS] },
                            { k: 'arg3', label: 'and', kind: 'value', min: -9999, max: 9999, dec: 1, def: 0,
                              defSrc: VALUE_NONE, sources: [VALUE_NONE, ...VALUE_SOURCE_KEYS] },
                            { k: 'result', label: 'result into', kind: 'varname', def: 'RESULT' }] },
  // The other half of `argVar` on "When called by name": inside a called
  // chain, this writes into the SAME ctx object callSignal is holding, which
  // is what lets callSignal read it back out once the chain returns. Outside
  // a call — dropped into an ordinary chain by mistake — it writes into a ctx
  // nothing ever reads back, the same quietly-inert shape preventIt and
  // setEventAmount already have outside a "Before …" chain.
  // The firing half of "When something is announced". See that node for why
  // this is not "Call by name" with different words. `value` may be "nothing",
  // which is the common case: most announcements are the fact that they
  // happened, not a number.
  // Legt die Zone um die Stelle, an der die Kette gerade wirkt: bei einem
  // Block-Ereignis um diesen Block, sonst um den Spieler selbst. Genau das
  // Verhalten, das "Fill a box with" schon hat, und der Grund, warum hier
  // niemand Weltkoordinaten eintippen muss. Man stellt sich hin, wo die Zone
  // sein soll, und lässt die Regel laufen.
  markZone:      { kind: 'action', label: 'Mark a zone here',
                   params: [{ k: 'zone', label: 'zone', kind: 'varname', def: 'BASE' },
                            { k: 'w', label: 'width', kind: 'value', min: 1, max: 64, dec: 0, def: 8 },
                            { k: 'h', label: 'height', kind: 'value', min: 1, max: 64, dec: 0, def: 8 }] },
  // Fuer Respawns und Checkpoints: ein fester Punkt liesse jeden Respawn an
  // derselben Stelle enden (leicht campbar) und eine Rennstrecke bruachte
  // sonst eine eigene Zone pro Startplatz. Sucht wie "Move the player" den
  // naechsten freien Platz, statt jemanden in eine Wand zu setzen.
  teleportToZone: { kind: 'action', label: 'Move to a random point in a zone',
                    params: [{ k: 'zone', label: 'zone', kind: 'varname', def: 'BASE' }] },
  // Eine Karte für Starten und Abbrechen statt zweier, aus demselben Grund, aus
  // dem "Set or change a number" alle sieben Rechenarten trägt: es ist eine
  // Sache mit einem Schalter, nicht zwei Sachen.
  setCountdown:  { kind: 'action', label: 'Start or stop a countdown',
                   params: [{ k: 'how', label: '', kind: 'enum', list: GRAPH_TIMER_OPS, def: 'start' },
                            { k: 'timer', label: 'countdown', kind: 'varname', def: 'ROUND' },
                            { k: 'seconds', label: 'for', kind: 'value',
                              min: 1, max: 600, dec: 0, def: 30 }] },
  // Zeigt die Rangliste, die die Arena ohnehin schon zwischen allen Spielern
  // abgleicht. Deshalb steht hier KEIN eigener Abgleich: die Punkte kommen aus
  // "Score points", und diese Karte ist reine Anzeige. Ausserhalb eines Matches
  // ist sie still wirkungslos, genau wie "Score points" und "End the round now".
  // Stellt eine Frage und wartet auf die Antwort. Ein leer gelassener Knopf
  // wird nicht gezeigt, ein Dialog kann also einen bis drei haben.
  //
  // `freeze` ist eine Auswahl und keine feste Regel: eine Frage mitten im
  // Kampf soll den Spieler festhalten, ein Hinweis am Rand aber nicht.
  showDialog:    { kind: 'action', label: 'Ask with buttons',
                   // Nur die FRAGE ist ein Textschlitz, die Knopfbeschriftungen
                   // bleiben fest. "When a dialog button is pressed" trifft einen
                   // Knopf über seine wörtliche Aufschrift; wäre die berechenbar,
                   // könnte ein Knopf etwas anderes zeigen als das, worauf das
                   // Ereignis wartet, und der Dialog liefe ins Leere.
                   params: [{ k: 'title', label: 'question', kind: 'textvalue', def: 'Which one?', max: 60 },
                            { k: 'b1', label: 'button 1', kind: 'text', def: 'OK', max: 20 },
                            { k: 'b2', label: 'button 2', kind: 'text', def: '', max: 20 },
                            { k: 'b3', label: 'button 3', kind: 'text', def: '', max: 20 },
                            { k: 'freeze', label: '', kind: 'enum', list: GRAPH_DIALOG_HOLD, def: 'hold me still' },
                            // Leer gelassen heisst "kein Eingabefeld", genau wie ein
                            // leer gelassener Knopf nicht gezeigt wird. Steht ein Name
                            // drin, erscheint ein Feld, und was der Spieler tippt, liegt
                            // beim Knopfdruck als gespeicherter TEXT unter diesem Namen.
                            //
                            // Ans ENDE gehaengt, obwohl es direkt unter die Frage
                            // gehoerte: die Reihenfolge hier ist zugleich die Reihenfolge
                            // der Stellungsargumente im Terminal, und ein Einschub in der
                            // Mitte haette jedes bereits geteilte `Show-Dialog`-Skript
                            // um eine Stelle verrutschen lassen.
                            { k: 'into', label: 'answer into', kind: 'varname', def: '',
                              placeholder: 'leave empty for no typing field' }] },
  // Die eigene Anzeige eines Mods. Zwei Karten statt einer, obwohl der Katalog
  // sonst zusammenlegt: die beiden beantworten verschiedene Fragen. Diese sagt,
  // WO der Kasten haengt und wie er heisst, die naechste, WAS drinsteht. Auf
  // einer Karte waeren es acht Felder, von denen je nach Auswahl die Haelfte
  // wirkungslos ist, und das ist genau der Zuschnitt, den ein Anfaenger nicht
  // mehr auf einen Blick liest.
  //
  // "clear" leert die Zeilen und laesst den Kasten stehen, "hide" nimmt ihn weg
  // und behaelt die Zeilen. Beides wird gebraucht: das eine zwischen zwei
  // Runden, das andere fuer eine Anzeige, die nur zeitweise auftaucht.
  setPanel:      { kind: 'action', label: 'Show or hide a panel',
                   params: [{ k: 'panel', label: 'panel', kind: 'varname', def: 'INFO' },
                            { k: 'how', label: '', kind: 'enum', list: GRAPH_PANEL_OPS, def: 'show' },
                            { k: 'where', label: 'in the', kind: 'enum', list: GRAPH_PANEL_CORNERS,
                              def: 'top left' },
                            { k: 'title', label: 'titled', kind: 'textvalue', def: 'Info', max: 24 }] },
  // Legt das Panel beim ersten Schreiben selbst an, so wie graphGetList eine
  // Liste anlegt. Wer nur eine Zeile zeigen will, braucht die Karte darueber
  // also gar nicht.
  //
  // Text UND Zahl, dieselbe Paarung wie bei "Show text or a number", und aus
  // demselben Grund: "Leben:" und der Wert daneben ist der Normalfall einer
  // stehenden Anzeige, und ihn ueber zwei Karten zusammensetzen zu muessen
  // waere die Umstaendlichkeit, die diese Karte gerade abschafft.
  panelLine:     { kind: 'action', label: 'Write a line on a panel',
                   params: [{ k: 'panel', label: 'panel', kind: 'varname', def: 'INFO' },
                            { k: 'line', label: 'line', kind: 'num',
                              min: 1, max: GRAPH_MAX_PANEL_LINES, dec: 0, def: 1 },
                            { k: 'text', label: 'text', kind: 'textvalue', def: 'Score:' },
                            { k: 'number', label: 'and', kind: 'value', min: -9999, max: 9999, dec: 1, def: 0,
                              defSrc: VALUE_NONE, sources: [VALUE_NONE, ...VALUE_SOURCE_KEYS] },
                            { k: 'color', label: 'colour', kind: 'enum', list: GRAPH_COLOR_KEYS, def: 'white' }] },
  showBoard:     { kind: 'action', label: 'Show the scoreboard',
                   params: [{ k: 'how', label: '', kind: 'enum', list: GRAPH_BOARD_OPS, def: 'per player' },
                            { k: 'title', label: 'titled', kind: 'text', def: 'Scores', max: 24 }] },
  announce:      { kind: 'action', label: 'Announce something happened',
                   params: [{ k: 'event', label: 'announcement', kind: 'varname', def: 'WAVE' },
                            { k: 'value', label: 'with', kind: 'value', min: -9999, max: 9999, dec: 1, def: 0,
                              defSrc: VALUE_NONE, sources: [VALUE_NONE, ...VALUE_SOURCE_KEYS] }] },
  returnValue:   { kind: 'action', label: 'Return a value',
                   params: [{ k: 'value', label: 'return', kind: 'value', min: -9999, max: 9999, dec: 1, def: 0 }] },

  // ── Arena: the vocabulary a minigame needs ───────────────────────────────
  // Deliberately a handful of entries bolted onto THIS catalog rather than a
  // second rule system of its own. A minigame is not a different kind of
  // logic from a mod — it is the same "when X, do Y" with a round and a score
  // around it. Sharing the catalog means a player who learned to wire up a
  // mod already knows how to build a game mode, the editor needs no second
  // palette, and every existing node ("When the player mines", "Random
  // chance", "Teleport the player") is available inside a match for free.
  //
  // All of them are no-ops outside Arena mode — see the guards in GRAPH_CONDS
  // and GRAPH_ACTIONS below. That is on purpose: a graph is shareable, so one
  // built for an arena has to stay loadable in an Exploration world instead
  // of throwing, it just won't score anything there.
  onMatchStart: { kind: 'event', label: 'When the match starts', params: [] },
  onMatchEnd:   { kind: 'event', label: 'When the match ends', params: [] },

  ifInArena:    { kind: 'cond', label: 'If inside the arena', params: [] },
  ifScoreAtLeast: { kind: 'cond', label: 'If my score is at least',
                    params: [{ k: 'points', label: 'points', kind: 'value', min: 1, max: 999, dec: 0, def: 10 }] },
  ifLeading:    { kind: 'cond', label: 'If I am in the lead', params: [] },
  // Dieselben zwei Fragen wie oben, nur ueber die Mannschaftssumme statt den
  // eigenen Punktestand -- fuer 2-gegen-2 und Team-vs-Team statt nur
  // Einzelrennen. Kein neuer Punktezaehler: die Summe kommt direkt aus den
  // Einzelpunkten, die "Score points" ohnehin schon synchron haelt (siehe
  // VxArena.teamScore).
  ifTeamScoreAtLeast: { kind: 'cond', label: "If my team's score is at least",
                        params: [{ k: 'points', label: 'points', kind: 'value', min: 1, max: 999, dec: 0, def: 10 }] },
  ifTeamLeading: { kind: 'cond', label: 'If my team is in the lead', params: [] },

  addScore:     { kind: 'action', label: 'Score points',
                  params: [{ k: 'points', label: 'points', kind: 'value', min: -99, max: 99, dec: 0, def: 1 }] },
  endRound:     { kind: 'action', label: 'End the round now', params: [] },
  // The write half of the 'my team' / 'nearest player team' readings. There is
  // deliberately no matching "if same team" condition: with both sides
  // readable as live values, "If a number ..." already says it
  // (my team is exactly nearest player team), and a node that only restates
  // what a slot can express is the exact duplication this catalog was
  // collapsed to avoid.
  //
  // 0 is "no team" and is what everyone starts on, so a mod that never calls
  // this leaves every comparison sitting at 0 = 0 rather than at some
  // arbitrary default that would read as a real side.
  setTeam:      { kind: 'action', label: 'Join a team',
                  params: [{ k: 'team', label: 'team', kind: 'value', min: 0, max: 8, dec: 0, def: 1 }] }
};

// Every node type that existed before the catalog was collapsed, and which
// block it becomes. Applied by decodeGraphCode before it looks a type up, so a
// mod code shared earlier still loads and still does exactly what it did: its
// blocks simply arrive as the newer, wider ones set to the same values. A bare
// number in an old parameter becomes a fixed-amount slot.
const _lit = n => ({ s: VALUE_FIXED, n: Number(n) || 0, v: 'SCORE' });
const _var = name => ({ s: VALUE_VAR, n: 0, v: name || 'SCORE' });
const GRAPH_LEGACY_NODES = {
  onTouchBlock: p => ({ type: 'onBlock',  params: { how: 'touches', block: p.block } }),
  onMineBlock:  p => ({ type: 'onBlock',  params: { how: 'mines',   block: p.block } }),
  onPlaceBlock: p => ({ type: 'onBlock',  params: { how: 'places',  block: p.block } }),
  onJump:       () => ({ type: 'onPlayer', params: { how: 'jumps' } }),
  onHurt:       () => ({ type: 'onPlayer', params: { how: 'gets hurt' } }),
  onDeath:      () => ({ type: 'onPlayer', params: { how: 'dies' } }),
  onNightfall:  () => ({ type: 'onDayPhase', params: { phase: 'night falls' } }),
  onDaybreak:   () => ({ type: 'onDayPhase', params: { phase: 'day breaks' } }),

  ifHoldingBlock: p => ({ type: 'ifBlock', params: { how: 'is holding', block: p.block, count: _lit(1) } }),
  ifStandingOn:   p => ({ type: 'ifBlock', params: { how: 'is standing on', block: p.block, count: _lit(1) } }),
  ifHasBlock:     p => ({ type: 'ifBlock', params: { how: 'is carrying at least', block: p.block, count: _lit(p.count) } }),
  ifNight:        () => ({ type: 'ifState', params: { state: 'it is night' } }),
  ifInWater:      () => ({ type: 'ifState', params: { state: 'the player is in water' } }),
  ifOnGround:     () => ({ type: 'ifState', params: { state: 'the player is on the ground' } }),
  ifDimension:    p => ({ type: 'ifWorldIs', params: { what: 'dimension', value: p.dim } }),
  ifBiome:        p => ({ type: 'ifWorldIs', params: { what: 'biome', value: p.biome } }),
  ifWeather:      p => ({ type: 'ifWorldIs', params: { what: 'weather', value: p.weather } }),
  // "below N hearts" was a strict less-than, and "deeper than" a strict more-than.
  ifHealthBelow:  p => ({ type: 'ifCompare', params: {
                      a: { s: 'health', n: 0, v: 'SCORE' }, op: 'is less than', b: _lit(p.hearts) } }),
  ifDeeperThan:   p => ({ type: 'ifCompare', params: {
                      a: { s: 'depth', n: 0, v: 'SCORE' }, op: 'is more than', b: _lit(p.depth) } }),
  ifVarCompare:   p => ({ type: 'ifCompare', params: { a: _var(p.name), op: p.op, b: _lit(p.value) } }),
  ifVarVsVar:     p => ({ type: 'ifCompare', params: { a: _var(p.name), op: p.op, b: _var(p.other) } }),

  giveBlock:  p => ({ type: 'changeItems', params: { how: 'Give', block: p.block, count: _lit(p.count) } }),
  takeBlock:  p => ({ type: 'changeItems', params: { how: 'Take away', block: p.block, count: _lit(p.count) } }),
  message:    p => ({ type: 'showText', params: { where: 'as a banner', text: p.text,
                      number: { s: VALUE_NONE, n: 0, v: 'SCORE' }, color: 'gold' } }),
  floatText:  p => ({ type: 'showText', params: { where: 'floating on the player', text: p.text,
                      number: { s: VALUE_NONE, n: 0, v: 'SCORE' }, color: p.color } }),
  showVar:    p => ({ type: 'showText', params: { where: 'as a banner', text: p.prefix,
                      number: _var(p.name), color: 'gold' } }),
  heal:       p => ({ type: 'changeHealth', params: { how: 'Heal', amount: _lit(p.amount) } }),
  hurt:       p => ({ type: 'changeHealth', params: { how: 'Hurt', amount: _lit(p.amount) } }),

  setSpeed:       p => ({ type: 'setStat', params: { stat: 'move speed', to: _lit(p.mult) } }),
  setJumpPower:   p => ({ type: 'setStat', params: { stat: 'jump power', to: _lit(p.mult) } }),
  setGravity:     p => ({ type: 'setStat', params: { stat: 'gravity', to: _lit(p.mult) } }),
  setMaxHearts:   p => ({ type: 'setStat', params: { stat: 'max hearts', to: _lit(p.hearts) } }),
  setReach:       p => ({ type: 'setStat', params: { stat: 'reach bonus', to: _lit(p.amount) } }),
  setAirJumps:    p => ({ type: 'setStat', params: { stat: 'air jumps', to: _lit(p.count) } }),
  setMiningYield: p => ({ type: 'setStat', params: { stat: 'mining yield', to: _lit(p.mult) } }),
  setDamageScale: p => ({ type: 'setStat', params: { stat: 'damage taken', to: _lit(p.mult) } }),
  enableBigPickaxe:     () => ({ type: 'setStat', params: { stat: '3x3 mining', to: _lit(1) } }),
  enableHazardImmunity: () => ({ type: 'setStat', params: { stat: 'hazard immunity', to: _lit(1) } }),

  launchUp: p => ({ type: 'movePlayer', params: { how: 'launch with force',
                    dx: _lit(0), dy: _lit(-Math.abs(Number(p.power) || 0)) } }),
  teleport: p => ({ type: 'movePlayer', params: { how: 'teleport by', dx: _lit(p.dx), dy: _lit(p.dy) } }),
  // A 1x1 box is what "Turn that block into" was; a blast is the same box
  // filled with air, sized to cover the circle the old radius described.
  setBlockHere: p => ({ type: 'fillArea', params: { block: p.block, w: _lit(1), h: _lit(1) } }),
  blastArea:    p => ({ type: 'fillArea', params: { block: BLOCKS.AIR,
                        w: _lit(Math.min(9, (Number(p.radius) || 1) * 2 + 1)),
                        h: _lit(Math.min(9, (Number(p.radius) || 1) * 2 + 1)) } }),
  setTimeOfDay: p => ({ type: 'setWorld', params: { what: 'time of day', value: p.time } }),
  setWeather:   p => ({ type: 'setWorld', params: { what: 'weather', value: p.weather } }),
  particles:    p => ({ type: 'emitParticles', params: { at: 'the player', color: p.color,
                        amount: _lit(p.amount), power: _lit(6) } }),

  setVar:     p => ({ type: 'changeVar', params: { name: p.name, op: 'set to', to: _lit(p.value) } }),
  addVar:     p => ({ type: 'changeVar', params: { name: p.name, op: 'add', to: _lit(p.amount) } }),
  readStat:   p => ({ type: 'changeVar', params: { name: p.name, op: 'set to',
                      to: { s: GRAPH_STATS.includes(p.stat) ? p.stat : 'health', n: 0, v: 'SCORE' } } }),
  mathVar:    p => ({ type: 'changeVar', params: { name: p.name, op: p.op, to: _lit(p.value) } }),
  mathVarVar: p => ({ type: 'changeVar', params: { name: p.name, op: p.op, to: _var(p.other) } })
};

// Actions-and-loops palette grouping (the editor's rail draws these as
// labelled clusters within the "Actions" section — a loop is not an action by
// kind, but it lives in the same "do something" tab rather than getting a
// fourth, near-empty tab of its own). Events and Conditions stay flat — 11 and
// 13 entries each still read as one glance, but 26 did not.
// A dev-time completeness check right below this catches an action or loop
// added to NODE_CATALOG without a home here, so nothing silently falls out of
// the palette while still working fine for anyone who pastes a code using it.
const ACTION_GROUPS = [
  // First on purpose: a loop is the one thing nothing else in this catalog
  // can substitute for, so it should be the first thing a player scanning the
  // rail sees, not something they stumble onto near the bottom.
  { label: 'Loops', types: ['repeatTimes', 'repeatWhile', 'forEachItem', 'forEachInList'] },
  { label: 'Player', types: ['changeHealth', 'setStat', 'movePlayer'] },
  { label: 'Inventory', types: ['changeItems', 'changeInvolvedItem'] },
  { label: 'World editing', types: ['fillArea', 'setWorld', 'markZone', 'teleportToZone'] },
  { label: 'Spawning & effects', types: ['spawnCreature', 'setCreatureBehavior', 'setCreatureCombat', 'emitParticles', 'shake', 'playSound'] },
  // Eigenes Buendel, weil das die Frage "wie sage ich dem Spieler etwas?" ist
  // und nicht "was passiert in der Welt?". Vorher lagen die beiden Anzeige-
  // Karten zwischen Kreaturen und Partikeln, wo sie niemand sucht.
  { label: 'On-screen display', types: ['showText', 'showDialog', 'setPanel', 'panelLine'] },
  { label: 'Numbers, text, lists, timing & reuse', types: ['changeVar', 'changeText', 'changeList', 'wait', 'callSignal', 'returnValue', 'announce'] },
  // Its own cluster rather than folded into the groups above: these are the
  // ones that change how the game itself behaves, and a player scanning the
  // rail should be able to see that line.
  { label: 'Overruling the game', types: ['preventIt', 'setEventAmount', 'remapDrop', 'setBlockMining'] },
  // Own cluster for the same reason "Overruling the game" has one: these two
  // only mean anything inside an Arena match, and a player scanning the rail
  // should see that boundary rather than find "Score points" filed under
  // Inventory and wonder why it does nothing in their Exploration world.
  { label: 'Arena matches', types: ['addScore', 'endRound', 'setTeam', 'setCountdown', 'showBoard'] }
];
(function checkActionGroupsComplete() {
  const grouped = new Set(ACTION_GROUPS.flatMap(g => g.types));
  for (const [type, def] of Object.entries(NODE_CATALOG)) {
    if ((def.kind === 'action' || def.kind === 'loop') && !grouped.has(type)) {
      console.warn('Voxeria: "' + type + '" is missing from ACTION_GROUPS — it will not show in the Mod Editor palette.');
    }
  }
})();

// A node's outgoing port names, derived from its kind so the editor and the
// runtime can never disagree about what a node can connect to.
function nodePorts(type) {
  const def = NODE_CATALOG[type];
  if (!def) return [];
  if (def.kind === 'cond') return ['yes', 'no'];
  if (def.kind === 'loop') return ['body', 'done'];
  return ['out'];
}
function nodeAcceptsInput(type) {
  const def = NODE_CATALOG[type];
  return !!def && def.kind !== 'event';   // an event always starts its chain
}

// Clamps one parameter to what its catalog entry allows. Every value that
// reaches the runtime goes through here, so a hand-edited code can only ever
// produce something the game was built to handle — the same guarantee
// modRawToField gives the bit-packed formats.
function graphCleanParam(spec, raw, params) {
  if (spec.kind === 'num') {
    const r = graphSpecRange(spec, params);
    const n = Number(raw);
    if (!isFinite(n)) return r.def;
    return Math.max(r.min, Math.min(r.max, Number(n.toFixed(r.dec))));
  }
  if (spec.kind === 'value') {
    return graphCleanValue(graphSpecRange(spec, params), raw);
  }
  if (spec.kind === 'textvalue') {
    return graphCleanTextValue(spec, raw);
  }
  if (spec.kind === 'block') {
    const b = parseInt(raw, 10);
    // A world-editing slot may name the empty block; an inventory slot may not,
    // which is what keeps "give the player some air" out of the pickers.
    if (spec.allowEmpty && b === BLOCKS.AIR) return BLOCKS.AIR;
    return (Number.isInteger(b) && blockNames[b] && !NON_ITEM_BLOCK_IDS.has(b)) ? b : spec.def;
  }
  if (spec.kind === 'creature') {
    const i = parseInt(raw, 10);
    return Number.isInteger(i) && i >= 0 && i < 64 ? i : spec.def;
  }
  if (spec.kind === 'enum') {
    const list = graphSpecList(spec, params);
    if (list.includes(raw)) return raw;
    // A dependent list need not contain the spec's own default (the default of
    // ifWorldIs.value is a dimension, but the list is biomes once "biome" is
    // picked), so fall back to the first entry the list really offers.
    return list.includes(spec.def) ? spec.def : list[0];
  }
  if (spec.kind === 'varname') {
    // Uppercased and stripped to [A-Z0-9_] so "score", "Score" and "SCORE"
    // are always the same variable/signal, and so the value is always safe
    // to use as an object key or in a notification string with no further
    // escaping needed.
    const s = String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 16);
    return s || spec.def;
  }
  return _modCleanText(raw, spec.max || 48) || spec.def;
}
// A spec's list or range can depend on a sibling parameter: which stat is being
// set, which aspect of the world is being asked about. Both resolvers fall back
// to what the spec itself says, so a spec with no dependency behaves exactly as
// it always did.
function graphSpecList(spec, params) {
  if (spec.listBy) {
    const l = spec.listBy(params || {});
    if (Array.isArray(l) && l.length) return l;
  }
  return spec.list || [];
}
function graphSpecRange(spec, params) {
  const r = spec.rangeBy ? spec.rangeBy(params || {}) : null;
  if (!r) return spec;
  return { min: r.min, max: r.max, dec: r.dec, def: r.def,
           sources: spec.sources, defSrc: spec.defSrc };
}

function graphDefaultParams(type) {
  const out = {};
  // Built in spec order and fed back in, so a dependent spec sees the value its
  // controlling sibling just got rather than an empty object.
  for (const spec of NODE_CATALOG[type].params) {
    // Both slot kinds are built from `undefined` rather than from spec.def, so
    // the slot lands on the source the spec asks for (defSrc) with spec.def as
    // its contents. Handing the raw default in would take the "this is a plain
    // value from an old code" path in both cleaners and pin the source to
    // fixed, which is wrong for a spec that means to start on a saved one.
    out[spec.k] = (spec.kind === 'value')
      ? graphCleanValue(graphSpecRange(spec, out), undefined)
      : (spec.kind === 'textvalue')
        ? graphCleanTextValue(spec, undefined)
        : graphCleanParam(spec, spec.def, out);
  }
  return out;
}
function graphCleanNodeParams(type, params) {
  const out = {};
  for (const spec of NODE_CATALOG[type].params) {
    out[spec.k] = graphCleanParam(spec, params ? params[spec.k] : undefined, out);
  }
  return out;
}

// ── LZSS, the compressor behind VXG2- ────────────────────────────────────
// A graph payload is JSON and therefore extremely repetitive: the same
// parameter keys and the same source names ("a fixed amount" and friends) are
// spelled out again in every single value slot. Compressing it shrinks a
// shared code by about 84%.
//
// WHY A HAND-ROLLED LZSS AND NOT CompressionStream: that API is asynchronous,
// and encodeGraphCode/decodeGraphCode are called synchronously from a dozen
// places (saving a mod, showing a share code, registering pieces at world
// load, the terminal's own `mod code`). Making them async would ripple through
// all of it. This is the compression that fits the call sites we have.
//
// WHY NO DICTIONARY: a dictionary keyed off the catalog would have to change
// whenever the catalog does, and every code shared before that change would
// decode into something else. Back-references travel inside the stream, so a
// VXG2 code carries everything needed to read it and can never rot.
//
// The 16 bits of a reference token are split 11 for distance and 5 for
// length, which measured better on real payloads than the usual 12/4: the
// repeated runs here are long (a whole value slot is ~36 characters), so
// reach past 35 characters buys more than a wider window does.
const LZ_DIST_BITS = 11;
const LZ_LEN_BITS  = 16 - LZ_DIST_BITS;
const LZ_WINDOW    = 1 << LZ_DIST_BITS;          // 2048
const LZ_MIN_MATCH = 4;                          // below this a token costs more than it saves
const LZ_MAX_MATCH = (1 << LZ_LEN_BITS) - 1 + LZ_MIN_MATCH;   // 35
// Hard ceiling on what a decode may produce. A corrupt or hand-edited code
// could otherwise describe a few hundred bytes that expand without bound;
// this is the same "a pasted code can never hurt you" rule the rest of the
// mod pipeline follows.
const LZ_MAX_OUTPUT = 4 * 1024 * 1024;

function _lzCompress(bytes) {
  const out = [];
  let flagPos = -1, flagBit = 0;
  // Hash chain over 3-byte keys. Without it the match search is quadratic and
  // a large graph takes noticeably long to encode.
  const head = new Map();
  const remember = (pos) => {
    if (pos + 2 >= bytes.length) return;
    const key = bytes[pos] << 16 | bytes[pos + 1] << 8 | bytes[pos + 2];
    let ch = head.get(key);
    if (!ch) { ch = []; head.set(key, ch); }
    ch.push(pos);
    if (ch.length > 32) ch.shift();   // bounded, so encoding stays linear
  };
  let i = 0;
  while (i < bytes.length) {
    if (flagBit === 0) { flagPos = out.length; out.push(0); }
    let bestLen = 0, bestDist = 0;
    if (i + 2 < bytes.length) {
      const key = bytes[i] << 16 | bytes[i + 1] << 8 | bytes[i + 2];
      const chain = head.get(key);
      // Newest first: a nearer match encodes the same but keeps the window useful.
      if (chain) for (let c = chain.length - 1; c >= 0; c--) {
        const cand = chain[c], dist = i - cand;
        if (dist <= 0 || dist > LZ_WINDOW) continue;
        let len = 0;
        while (len < LZ_MAX_MATCH && i + len < bytes.length && bytes[cand + len] === bytes[i + len]) len++;
        if (len > bestLen) { bestLen = len; bestDist = dist; if (len === LZ_MAX_MATCH) break; }
      }
    }
    if (bestLen >= LZ_MIN_MATCH) {
      out[flagPos] |= (1 << flagBit);
      const code = ((bestDist - 1) << LZ_LEN_BITS) | (bestLen - LZ_MIN_MATCH);
      out.push((code >> 8) & 0xff, code & 0xff);
      for (let k = 0; k < bestLen; k++) remember(i + k);
      i += bestLen;
    } else {
      out.push(bytes[i]);
      remember(i);
      i++;
    }
    flagBit = (flagBit + 1) & 7;
  }
  return out;
}

function _lzDecompress(bytes) {
  const res = [];
  let p = 0;
  while (p < bytes.length) {
    const flags = bytes[p++];
    for (let b = 0; b < 8 && p < bytes.length; b++) {
      if (res.length > LZ_MAX_OUTPUT) throw new Error('compressed graph expands too far');
      if (flags & (1 << b)) {
        if (p + 1 >= bytes.length) return res;
        const code = (bytes[p] << 8) | bytes[p + 1]; p += 2;
        const dist = (code >> LZ_LEN_BITS) + 1;
        const len = (code & ((1 << LZ_LEN_BITS) - 1)) + LZ_MIN_MATCH;
        const start = res.length - dist;
        // A distance pointing before the start is a corrupt code, not a
        // readable one: refused rather than silently filled with rubbish.
        if (start < 0) throw new Error('compressed graph refers outside itself');
        for (let k = 0; k < len; k++) res.push(res[start + k]);
      } else {
        res.push(bytes[p++]);
      }
    }
  }
  return res;
}

// Byte array to and from the binary string btoa/atob work in. Chunked because
// String.fromCharCode.apply on a 30k array overflows the call stack.
function _lzBytesToBinary(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode.apply(null, bytes.slice(i, i + 8192));
  }
  return s;
}
function _lzBinaryToBytes(str) {
  const out = new Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

// ── Graph code: VXG2-<base64url LZSS JSON>, VXG1- still read ─────────────
// JSON rather than the bit-packing the other formats use: a graph has no
// fixed field list to pack against — the node count, their types and their
// wiring all vary per mod — so a positional bit layout would have nothing
// stable to describe.
//
// VXG1- is the same JSON without the compression step. It is still decoded,
// and always will be: every rule code shared before this existed is a VXG1.
// Nothing writes one any more, which is why the constant below is only ever
// read.
const GRAPH_PREFIX = 'VXG1-';
const GRAPH_PREFIX_C = 'VXG2-';
function isGraphCode(s) {
  return typeof s === 'string' && (s.startsWith(GRAPH_PREFIX_C) || s.startsWith(GRAPH_PREFIX));
}

function encodeGraphCode(graph) {
  const payload = {
    v: 1,
    n: _modCleanText(graph.name, 24) || 'My Mod',
    // Coordinates are rounded: a graph is a diagram, and sub-pixel node
    // positions would just inflate the shared code with noise.
    o: graph.nodes.slice(0, GRAPH_MAX_NODES).map(nd => [nd.id, nd.type, Math.round(nd.x), Math.round(nd.y), nd.params]),
    w: graph.wires.slice(0, GRAPH_MAX_WIRES).map(wr => [wr.from, wr.fromPort, wr.to])
  };
  const json = JSON.stringify(payload);
  const raw = unescape(encodeURIComponent(json));
  try {
    return GRAPH_PREFIX_C + _pieceB64url(_lzBytesToBinary(_lzCompress(_lzBinaryToBytes(raw))));
  } catch (e) {
    // A code that cannot be compressed is still worth having: fall back to the
    // uncompressed form rather than handing back nothing.
    console.warn('Voxeria: graph code could not be compressed, writing it plain.', e);
    return GRAPH_PREFIX + _pieceB64url(raw);
  }
}

function decodeGraphCode(s) {
  if (!isGraphCode(s)) return null;
  let data;
  try {
    const str = String(s).trim();
    const compressed = str.startsWith(GRAPH_PREFIX_C);
    const body = str.slice((compressed ? GRAPH_PREFIX_C : GRAPH_PREFIX).length).trim();
    let raw = _pieceB64urlDecode(body);
    if (compressed) raw = _lzBytesToBinary(_lzDecompress(_lzBinaryToBytes(raw)));
    data = JSON.parse(decodeURIComponent(escape(raw)));
  } catch (e) {
    console.warn('Voxeria: graph code is not readable.', e);
    return null;
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.o)) return null;

  const nodes = [];
  const seenIds = new Set();
  for (const row of data.o.slice(0, GRAPH_MAX_NODES)) {
    if (!Array.isArray(row)) continue;
    const [id, type, x, y, params] = row;
    // A type from before the catalog was collapsed is rewritten into the block
    // that replaced it, carrying its old setting across, so a code shared back
    // then still loads and still behaves the same.
    let useType = type, useParams = params;
    const upgrade = GRAPH_LEGACY_NODES[type];
    if (upgrade) {
      try {
        const up = upgrade(params || {});
        useType = up.type; useParams = up.params;
      } catch (e) { continue; }
    }
    // Unknown node types are dropped rather than guessed at: that is the
    // whole point of the closed catalog, and it also means a graph made in a
    // newer build degrades to "the parts this build understands" instead of
    // refusing to load at all.
    if (!NODE_CATALOG[useType]) continue;
    const nid = String(id).slice(0, 12);
    if (!nid || seenIds.has(nid)) continue;
    seenIds.add(nid);
    nodes.push({
      id: nid,
      type: useType,
      x: Math.max(-4000, Math.min(4000, Math.round(Number(x)) || 0)),
      y: Math.max(-4000, Math.min(4000, Math.round(Number(y)) || 0)),
      params: graphCleanNodeParams(useType, useParams)
    });
  }

  const byId = new Map(nodes.map(nd => [nd.id, nd]));
  const wires = [];
  const usedPorts = new Set();
  for (const row of (Array.isArray(data.w) ? data.w : []).slice(0, GRAPH_MAX_WIRES)) {
    if (!Array.isArray(row)) continue;
    const [from, fromPort, to] = row.map(v => String(v).slice(0, 12));
    const src = byId.get(from), dst = byId.get(to);
    if (!src || !dst || from === to) continue;
    if (!nodePorts(src.type).includes(fromPort)) continue;
    if (!nodeAcceptsInput(dst.type)) continue;
    // One wire per output port — a port that forked would make execution
    // order ambiguous, and the editor never creates one either.
    const key = from + '|' + fromPort;
    if (usedPorts.has(key)) continue;
    usedPorts.add(key);
    wires.push({ from, fromPort, to });
  }

  return { name: _modCleanText(data.n, 24) || 'My Mod', nodes, wires };
}

// Node graphs live outside PIECE_KINDS (their own VXG1- codec above, not the
// bit-packed one) but still need to travel inside a loadout and the "load a
// single piece" flow alongside blocks/creatures — these two are what let a
// loadout's piece list and the library importer treat all three kinds the
// same way instead of special-casing graphs at every call site.
function isAnyPieceCode(s) { return isPieceCode(s) || isGraphCode(s); }
function decodeAnyPieceCode(s) {
  if (isGraphCode(s)) {
    const g = decodeGraphCode(s);
    return g ? { kind: 'GRAPH', name: g.name } : null;
  }
  return decodePieceCode(s);
}

// ── Loadout code: VXL1-<mod code>~<piece code>~<piece code>…<checksum> ──
// The "mod" a player shares in the piece era. Rather than one fixed bitfield,
// a loadout is the existing VXM3- mod (world/rules/perks/starting items,
// encoded by the untouched functions above) followed by a variable-length list
// of piece codes.
//
// Every piece rides INLINE as its own full code rather than as an id pointing
// at a published record. That keeps the one guarantee the mod format has always
// made — a pasted code is complete and playable the instant it arrives, with no
// server round trip and nothing that can rot if a published piece is later
// deleted. The cost is length, which is why the pixel payload got the RLE
// packing above and why the builder shows the character count as pieces are
// added.
const LOADOUT_PREFIX = 'VXL1-';
const LOADOUT_SEP = '~';   // outside both base32 and base64url, so it can never appear inside a segment
const LOADOUT_MAX_PIECES = 16;

function isLoadoutCode(s) { return typeof s === 'string' && s.startsWith(LOADOUT_PREFIX); }

function encodeLoadoutCode(mod, pieceCodes) {
  const codes = (pieceCodes || []).slice(0, LOADOUT_MAX_PIECES);
  const body = [encodeModCode2(mod)].concat(codes).join(LOADOUT_SEP);
  return LOADOUT_PREFIX + body + modChecksum(body);
}

// Returns { mod, pieceCodes, skipped } — `skipped` counts segments that failed
// to decode. One bad piece drops itself rather than taking the whole loadout
// down with it: the world and every other piece are still perfectly playable,
// and the caller surfaces the count so the loss is never silent.
function decodeLoadoutCode(s) {
  if (!isLoadoutCode(s)) return null;
  const raw = String(s).slice(LOADOUT_PREFIX.length).trim();
  if (raw.length < 3) return null;
  const body = raw.slice(0, -2);
  if (modChecksum(body) !== raw.slice(-2).toUpperCase()) {
    console.warn('Voxeria: loadout code failed its checksum — corrupt or edited.');
    return null;
  }
  const segs = body.split(LOADOUT_SEP);
  const mod = decodeModCode(segs[0]);
  if (!mod) return null;
  const pieceCodes = [];
  let skipped = 0;
  for (const seg of segs.slice(1, 1 + LOADOUT_MAX_PIECES)) {
    // Decoded here purely as validation — only codes that survive a full
    // decode (checksum + clamped fields) are allowed through to the game.
    // Any registered kind is welcome; registerLoadoutPieces sorts them out.
    if (isAnyPieceCode(seg) && decodeAnyPieceCode(seg)) pieceCodes.push(seg);
    else skipped++;
  }
  return { mod, pieceCodes, skipped };
}

// ── Personal piece library ───────────────────────────────────────────────
// localStorage for now (same 'small, structured, synchronous' shape as
// VxWorlds' index) rather than IndexedDB: registerCustomBlockPieces() below
// must run synchronously before the very first chunk generates, and an async
// DB open would race that on a brand-new world. Worth revisiting once the
// library is large enough to threaten VxWorlds' BYTE_BUDGET-style ceiling.
window.VxPieces = (function () {
  const INDEX_KEY = 'voxeria_pieces';
  function readIndex() { try { return JSON.parse(localStorage.getItem(INDEX_KEY)) || []; } catch (e) { return []; } }
  // Reports failure instead of throwing. localStorage is a shared, finite space
  // — saved worlds live in it too — and setItem throws QuotaExceededError once
  // it is full. Unguarded, that exception escaped straight out of the Save
  // button's click handler, so everything after the save was skipped: no
  // re-register, no list refresh, and above all no message. The player pressed
  // Save, their drawing was not written, and nothing on screen said so.
  function writeIndex(list) {
    try { localStorage.setItem(INDEX_KEY, JSON.stringify(list)); return true; }
    catch (e) {
      console.warn('Voxeria: the piece library could not be written.', e);
      showNotification('⚠️ No space left to save. Delete a piece or a saved world and try again.');
      return false;
    }
  }
  function list(kind) { const all = readIndex(); return kind ? all.filter(p => p.kind === kind) : all; }
  // Returns the new id, or null if it could not be stored — callers must treat
  // null as "this was not saved" rather than reporting success.
  function save(kind, code, name) {
    const all = readIndex();
    const localId = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    // Ein MOD startet ausgeschaltet, ein gemalter Block oder eine Kreatur nicht.
    //
    // Der Unterschied ist Absicht: ein Block ist ein Gegenstand, den man haben
    // will, sobald man ihn gemalt hat. Ein Mod ist eine REGEL, die in die Welt
    // eingreift, und die eingeschaltete Bibliothek gilt fuer jede Welt. Ein in
    // Welt A gebauter Mod lief deshalb bisher sofort auch in jeder spaeter
    // erstellten Welt B mit, ohne dass ihn dort jemand angefordert haette.
    //
    // Angeschaltet wird er mit einem Klick in der Liste "My mods" im Mod-Editor.
    // Bestehende Eintraege bleiben unberuehrt: die Leser pruefen auf
    // `enabled !== false`, ein alter Eintrag ohne das Feld gilt also weiterhin
    // als eingeschaltet.
    const enabled = kind !== 'GRAPH';
    all.push({ localId, kind, code, name, createdAt: Date.now(), enabled });
    return writeIndex(all) ? localId : null;
  }
  function del(localId) { return writeIndex(readIndex().filter(p => p.localId !== localId)); }
  function get(localId) { return readIndex().find(p => p.localId === localId) || null; }
  function setEnabled(localId, enabled) {
    const all = readIndex();
    const p = all.find(x => x.localId === localId);
    if (!p) return false;
    p.enabled = !!enabled;
    return writeIndex(all);
  }
  return { list, save, delete: del, get, setEnabled };
})();

// ── Applying pieces to the live game ─────────────────────────────────────
// Custom blocks need runtime IDs since BLOCKS (~3756) is a compile-time enum
// — a small reserved range at the top of the id space, allocated fresh each
// time the library is (re)registered, rather than a big unification refactor
// of the six parallel block tables.
const CUSTOM_BLOCK_ID_BASE = 200;
const CUSTOM_BLOCK_ID_MAX = 255;
// customOreTiers selbst steht in voxeria-core.js, weil der Weltgenerator es
// liest und der nicht nach oben in diese Datei greifen soll. Gefuellt wird es
// weiterhin ausschliesslich hier, siehe registerLoadoutPieces() weiter unten.

// `palette` is the piece's own colour table (see decodePiecePixels). Omitted,
// it falls back to the built-in one, which is what the two 16-colour packings
// and the procedurally generated demo art in voxeria-menu-worlds.js use.
function _blockPixelsAverageColor(indices, palette) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < indices.length; i++) {
    const hex = piecePaletteHex(palette, indices[i]);
    if (hex === 'transparent') continue;
    r += parseInt(hex.slice(1, 3), 16); g += parseInt(hex.slice(3, 5), 16); b += parseInt(hex.slice(5, 7), 16); n++;
  }
  if (!n) return ['#888', '#777', '#999', '#aaa'];
  r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
  const hx = (rr, gg, bb) => '#' + [rr, gg, bb].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  return [hx(r, g, b), hx(r * 0.75, g * 0.75, b * 0.75), hx(Math.min(255, r * 1.15), Math.min(255, g * 1.15), Math.min(255, b * 1.15)), hx(r * 0.85, g * 0.85, b * 0.85)];
}
// Renders the painted pixel grid into an offscreen canvas and drops it
// straight into _blockTextures (~8120) under the custom id — that lookup is
// exactly what drawBlockMini() (~13712) and the world-tile renderer already
// prefer over the procedural swatch, so custom block art shows up identically
// to hand-authored blocks with zero renderer changes.
function _pieceCanvasFromPixels(indices, palette) {
  const cv = document.createElement('canvas');
  cv.width = BLOCK_PIXEL_SIZE; cv.height = BLOCK_PIXEL_SIZE;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(BLOCK_PIXEL_SIZE, BLOCK_PIXEL_SIZE);
  for (let i = 0; i < indices.length; i++) {
    const hex = piecePaletteHex(palette, indices[i]);
    const p = i * 4;
    if (hex === 'transparent') continue;
    const textured = _blockPixelTextured(hex, Math.floor(i / BLOCK_PIXEL_SIZE), i % BLOCK_PIXEL_SIZE);
    img.data[p] = parseInt(textured.slice(1, 3), 16);
    img.data[p + 1] = parseInt(textured.slice(3, 5), 16);
    img.data[p + 2] = parseInt(textured.slice(5, 7), 16);
    img.data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  cv.ready = true;
  return cv;
}

// Rebuilds the dynamic-id block registration + customOreTiers. Safe to call
// again at any time — it always starts from a clean id range rather than
// accumulating stale entries.
//
// With `pieceCodes` (a loadout is active): registers exactly those, so a shared
// world contains the author's blocks and nothing from the local library.
// Without it: falls back to the player's own enabled library pieces, which is
// what a plain seed / offline play uses.
// Welcher Piece-Code hinter welcher vergebenen Block-ID steckt. Gefuellt beim
// Registrieren, weil nur hier bekannt ist, welcher Code welche Nummer bekommen
// hat -- die Zuteilung ausserhalb nachzurechnen hiesse, diese Schleife ein
// zweites Mal zu schreiben und ab dann synchron zu halten. Der Koop-Modus
// (voxeria-coop-mods.js) leitet daraus ab, wem ein Block gehoert.
let customBlockSource = {};
window.customBlockSource = customBlockSource;

// ============================================================================
// CUSTOM BLOCK ID ALLOCATION: a note for external code reviewers
// ============================================================================
// TWO allocation policies meet at this one function, and the most visible sign
// of that is the `null` convention in the filter line below. It looks like a
// forgotten edge case. It is the core of the solution. Here is why.
//
// THE PROBLEM
// -----------
// `BLOCKS` is a compile-time enum; player-made blocks cannot appear in it. So
// they are handed runtime numbers out of a reserved range, 200..255
// (CUSTOM_BLOCK_ID_BASE..MAX). That number is not a display detail:
// setBlockAndBroadcast writes EXACTLY IT into the world map and ships it to
// everyone else through Firestore. A placed tile is therefore only correct for
// as long as the mapping "number -> piece" is, and stays, the same for every
// participant.
//
// What makes that hard: allocation happens on each client LOCALLY and
// ASYNCHRONOUSLY. There is no server handing numbers out. Every client
// receives the author list through a Firestore snapshot and works the numbers
// out for itself. Two clients must therefore never arrive at different
// answers, not even when their snapshots are seconds apart, when somebody
// joins mid-session, or when somebody adds or deletes a block while they are
// both playing.
//
// THE TWO POLICIES
// ----------------
// (A) Solo / own loadout -> DENSE list.
//     The `else` branch below simply takes the enabled library pieces in
//     order. Numbers are pure counting here, because there is exactly one
//     participant: if something shifts, it shifts for everyone it concerns at
//     the same moment, and the world is re-registered anyway. Nothing travels
//     over the wire.
//
// (B) Co-op (voxeria-coop-mods.js, buildCombined) -> FIXED SLICES.
//     Every author gets SLOT_SIZE = 8 consecutive numbers, in an order driven
//     by `since` (when that player first published in THIS world), which
//     therefore only ever grows at the end and never re-sorts. An author with
//     fewer than eight blocks has their remaining places arrive here as
//     `null`. The position in the array IS the identity.
//
// WHY NOT JUST PACK THEM DENSELY (the obvious alternative)
// --------------------------------------------------------
// Because then a block's id would be a function of how many blocks ALL
// PREVIOUS authors happen to have. And that changes at runtime:
//
//   Anna (2 blocks) -> 200,201     Ben (2 blocks) -> 202,203
//   Anna adds a third:
//   Anna -> 200,201,202            Ben -> 203,204
//
// Ben's first block was 202 a moment ago and is 203 now. Every tile anyone in
// the game has already built with 202 shows a different piece from this
// instant on: no error, nobody having done anything, and retroactively so in
// the world already sitting in Firestore. By acting inside HER OWN editor,
// Anna changed the meaning of blocks Ben had already placed. That is exactly
// what "players shifting each other's ids" means.
//
// The asynchrony sharpens it: while Anna's new block has not reached Ben yet,
// the two clients are already computing against different tables. They are not
// merely each wrong on their own; they are also sending each other numbers
// that mean something else on arrival. A scheme that is only correct once
// delivery is complete is not a scheme, in a system with no delivery
// guarantee.
//
// WHY FIXED SLICES SPECIFICALLY
// -----------------------------
// Because they decouple the number from everything ANOTHER player does. The id
// now depends on two things only: the author's position in the `since` order
// (which only ever appends) and the block's position inside that author's own
// slice. Neither can be influenced by a fellow player. From that follows the
// property that actually matters: EVERY client reaches the same number for the
// same block from ANY intermediate state of the author list, including an
// incomplete one. A client that has not seen everything yet has gaps, not
// wrong mappings. A gap shows a missing block; a shift shows the wrong one.
//
// Rejected alternatives, for completeness:
//   * Sorting by uid instead of `since`: tempting, because it is stable, and
//     wrong. A joiner with a smaller uid would sort ahead of everyone already
//     present and shift every one of their ids.
//   * Hashing the piece code into an id: 56 slots, birthday paradox; two
//     blocks on the same number would be silent data loss.
//   * Central allocation through Firestore: needs a transaction per block and
//     makes creating a block depend on a network connection. The editor is
//     meant to work offline.
//
// THE PRICE, stated openly
// ------------------------
// 56 ids / 8 = 7 modders per world can share blocks (MAX_AUTHORS in
// voxeria-coop-mods.js), at 8 blocks each. Unused places stay empty. That is a
// deliberate trade: a fixed, small, loudly reported ceiling (see the
// overflowWarned notification there) beats an unbounded number of participants
// where, from the eighth modder on, already-built blocks change meaning.
//
// THE INVARIANT every change here must preserve
// ---------------------------------------------
// An entry's index in `pieceCodes` determines its block id, and nothing else
// does. That is why this filter must NOT drop `null`: a filtered-out null
// would pull every following entry forward by one and reinstate precisely the
// bug the slices exist to prevent. `null` here does not mean "no value", it
// means "this place is allocated, just not occupied right now".
// ============================================================================
function registerCustomBlockPieces(pieceCodes) {
  customOreTiers = [];
  customBlockSource = {};
  window.customBlockSource = customBlockSource;

  // Wipe the whole reserved range before re-filling it. The loop below WRITES
  // into six tables the engine owns (blockNames, blockColors, BLOCK_HARDNESS,
  // BLOCK_SOUND, ORE_SPECKLE_IDS, _blockTextures) but used to clear none of
  // them, so every id it did not reach this time kept whatever the PREVIOUS
  // registration had left there.
  //
  // That is only invisible while the library grows. The moment it shrinks --
  // deleting a piece, unticking one in the Mod Editor's list, or loading a
  // loadout with fewer blocks than the last one -- the ids above the new count
  // become phantoms: still named, still coloured, still passing the
  // `blockNames[b]` test every block picker and graphCleanParam() use to decide
  // whether an id is real. A mod could be built against one, and the block
  // pickers offered it, long after the piece behind it was gone.
  //
  // Safe to clear wholesale because this range belongs to custom pieces alone
  // (see the note above), and everything still in use is written back below.
  for (let id = CUSTOM_BLOCK_ID_BASE; id <= CUSTOM_BLOCK_ID_MAX; id++) {
    delete blockNames[id];
    delete blockColors[id];
    delete BLOCK_HARDNESS[id];
    delete BLOCK_SOUND[id];
    delete _blockTextures[id];
    ORE_SPECKLE_IDS.delete(id);
  }

  let nextId = CUSTOM_BLOCK_ID_BASE;
  // `null` is a RESERVED PLACE: it consumes an id without registering a block.
  // See the long note above this function. An invalid code, by contrast, is
  // filtered out AND consumes no number: it is not a reserved place, it is
  // garbage, and it never occurs on the co-op path at all (buildCombined
  // writes only piece codes or null there).
  const codes = Array.isArray(pieceCodes)
    ? pieceCodes.filter(c => c === null || isBlockPieceCode(c))
    : VxPieces.list('BLOCK').filter(p => p.enabled !== false).map(p => p.code);
  for (const code of codes) {
    if (nextId > CUSTOM_BLOCK_ID_MAX) break; // bounded id range; LOADOUT_MAX_PIECES keeps a shared loadout well inside it
    if (code === null) { nextId++; continue; }
    const decoded = decodeBlockPieceCode(code);
    if (!decoded) continue;
    const id = nextId++;
    customBlockSource[id] = code;
    blockNames[id] = decoded.name;
    blockColors[id] = _blockPixelsAverageColor(decoded.pixels, decoded.palette);
    BLOCK_HARDNESS[id] = decoded.block.hardness;
    BLOCK_SOUND[id] = [decoded.block.soundFamily, 300 + (id - CUSTOM_BLOCK_ID_BASE) * 20];
    if (decoded.block.traits && decoded.block.traits.oreSpeckle) ORE_SPECKLE_IDS.add(id);
    _blockTextures[id] = _pieceCanvasFromPixels(decoded.pixels, decoded.palette);
    customOreTiers.push({
      key: 'CUSTOM_' + id, block: id,
      minDepth: decoded.block.minDepth,
      chance: decoded.block.chance,
      sizeMin: Math.max(1, decoded.block.veinSize - 1),
      sizeMax: decoded.block.veinSize
    });
  }
}
window.registerCustomBlockPieces = registerCustomBlockPieces;

// Live ambient creature definitions, read by spawnCustomCreatureNearPlayer()
// and drawCustomCreatures(). Each carries its own pre-rendered sprite canvas
// so nothing is decoded per frame.
customCreatureTypes = [];

function registerCustomCreaturePieces(pieceCodes) {
  customCreatureTypes = [];
  const codes = Array.isArray(pieceCodes)
    ? pieceCodes.filter(isCreaturePieceCode)
    : VxPieces.list('CREATURE').filter(p => p.enabled !== false).map(p => p.code);
  for (const code of codes) {
    const decoded = decodeCreaturePieceCode(code);
    if (!decoded) continue;
    customCreatureTypes.push({
      id: 'cc' + customCreatureTypes.length,
      // Wie customBlockSource oben: die Herkunft reist mit, damit der
      // Koop-Modus zuordnen kann, wer diese Kreatur gebaut hat.
      sourceCode: code,
      name: decoded.name,
      canvas: _pieceCanvasFromPixels(decoded.pixels, decoded.palette),
      move: decoded.creature.move,
      size: decoded.creature.size,
      speed: decoded.creature.speed,
      rarity: decoded.creature.rarity,
      biome: decoded.creature.biome,
      traits: decoded.creature.traits || {},
      // Combat is OFF by default and is not part of the piece code at all.
      // health 0 means "cannot be hurt, never attacks", which is exactly what
      // every creature did before combat existed — so every creature code ever
      // shared keeps behaving identically, and a creature only becomes
      // dangerous when a mod runs "Set up my creature's fight" on it.
      //
      // Deliberately a mod rule rather than six more fields in the piece:
      // the same reasoning that moved Hardness out of the Block Designer (see
      // setBlockMining). The drawing is the player's; how hard it hits is a
      // rule of the world the drawing was dropped into.
      health: 0, damage: 1, attack: 'none', aggro: 0
    });
  }
  // Creatures already roaming came from the previous set of definitions; drop
  // them so a library edit or loadout swap can't leave orphans animating
  // against a definition that no longer exists.
  if (typeof animals !== 'undefined') {
    for (let i = animals.length - 1; i >= 0; i--) if (animals[i].type === 'custom') animals.splice(i, 1);
  }
}
window.registerCustomCreaturePieces = registerCustomCreaturePieces;

// Kept as a separate global rather than folded into GRAVITY directly, so the
// constant stays a constant and "no mod active" is always exactly 1.
ruleGravityScale = 1;

// Rebuilds every mod-driven stat from scratch: armor baseline, then the
// legacy mod-code perk set (unchanged behaviour), then whatever the running
// node graphs' actions last asked for. Always starting from the baseline is
// what makes this safe to call again on every action firing, instead of
// stats compounding each time one runs.
function applyActiveRules() {
  applyArmorStatBonuses();
  hasSuperPickaxe = false;
  hasHazardImmunity = false;
  maxJumps = 1;
  ruleGravityScale = 1;

  if (activeMod) {
    const perks = activeMod.perks || {};
    if (perks.speed) playerSpeed *= 1.3;
    if (perks.reach) maxReach += 2;
    if (perks.digspeed) yieldMultiplier = Math.max(yieldMultiplier, 2);
    if (perks.doublejump) maxJumps = 2;
    if (perks.pickaxe) hasSuperPickaxe = true;
    if (perks.megajump) jumpForce *= 1.5;
    if (perks.hazardimmune) hasHazardImmunity = true;
    // The Mod Builder's Gravity slider. It shipped writing its value into the
    // code and describing it in the summary, but nothing ever read it back —
    // sliding it from 0.3 to 1.7 changed nothing in the world. Reading it here
    // is all it ever needed: ruleGravityScale is already the exact global
    // updatePlayer multiplies GRAVITY by. Already-shared codes that set it now
    // finally do what their own summary always claimed.
    const modGravity = activeMod.dim && activeMod.dim.gravity;
    if (typeof modGravity === 'number' && isFinite(modGravity) && modGravity > 0) {
      ruleGravityScale *= modGravity;
    }
  }

  // Node-graph actions (setSpeed, setGravity, setReach, ...) folded in last.
  playerSpeed *= graphSpeedMult;
  ruleGravityScale *= graphGravityMult;
  maxReach += graphReachBonus;
  maxJumps = Math.max(maxJumps, graphMaxJumps);
  yieldMultiplier = Math.max(yieldMultiplier, graphYieldMult);
  jumpForce *= graphJumpMult;
  if (graphBigPickaxe) hasSuperPickaxe = true;
  if (graphHazardImmune) hasHazardImmunity = true;
  jumpsLeft = Math.min(jumpsLeft, maxJumps);
  // applyArmorStatBonuses already set maxHealth from the armor baseline and
  // drew the hearts; overriding it here needs a second draw so the hearts on
  // screen match the new cap immediately.
  if (graphMaxHealth > 0) {
    maxHealth = graphMaxHealth;
    player.health = Math.min(player.health, maxHealth);
    drawHealth();
  }
}

// =========================================================
// GRAPH RUNTIME — what makes a saved node graph actually do something.
// Events are pushed in from the places in the game where they really happen
// (a block breaking, a block being placed, the world starting), then each
// matching event node's chain is walked and its actions run in order.
// =========================================================
let activeGraphs = [];
// Multipliers a graph's "set speed"/"set gravity" actions own. They are
// re-derived through applyActiveRules() rather than multiplied into
// playerSpeed directly: an action that compounded would send speed to
// infinity the moment it sat behind an "every N seconds" event.
let graphSpeedMult = 1;
let graphGravityMult = 1;
// The five stats the old Rule Designer's sliders used to drive, now set by
// their node-action equivalents instead (setReach, setAirJumps, ...). Same
// re-derive-from-baseline treatment in applyActiveRules as speed/gravity.
let graphReachBonus = 0;
let graphMaxJumps = 1;
graphYieldMult = 1;
let graphBigPickaxe = false;
let graphHazardImmune = false;
let graphJumpMult = 1;
// 0 means "the mod never touched it", so the game's own maxHealth stands.
let graphMaxHealth = 0;
// Per-node countdowns for onTimer, and the set of blocks the player is
// currently standing in, so onTouchBlock fires once on contact instead of
// every frame for as long as they stay there.
let graphTimers = {};
let graphTouching = new Set();
// A chain is walked with a hard step budget, shared across an entire trigger
// including every pass of every loop it runs (see graphWalk) — nesting a
// "Repeat 200" inside a "Repeat 200" cannot spend more than this many steps
// total, however deep the nesting goes. High enough that one ordinary "Repeat
// 200: give a block" comfortably finishes; a mod still cannot hang the game,
// it just stops early and moves on to `done`.
const GRAPH_MAX_STEPS = 2000;
// Named number storage for "Set a number" / "Change a number by" / "If a
// number is" / "Show a number". Session state only — reset with everything
// else in registerCustomGraphPieces, not carried into a saved world.
let graphVars = {};
// Name to array of numbers. Kept beside graphVars rather than inside it so a
// mod naming a list and a number the same thing gets two separate stores
// instead of one of them silently reading as 0.
let graphLists = {};
// Named TEXT storage, the third store beside the two above. Separate for the
// same reason graphLists is separate: a mod naming a number and a text the
// same thing gets two stores rather than one of them reading as the wrong
// type.
//
// This deliberately reverses an earlier decision. The store used to be numbers
// only, on the grounds that a text variable would be a second, worse way to
// spell "Show a message". That held only while text could not be BUILT: with
// "join with" a mod can now assemble a line it was never authored with, and
// compare one text against another, which is a kind of data the number store
// genuinely could not express. What it is still not is an escape from the
// closed catalog — a text is a value the catalog's own blocks read and write,
// never something handed to the game to interpret.
let graphTexts = {};
// "Call by name" (see GRAPH_ACTIONS.callSignal) re-enters fireGraphEvent, so
// a signal that calls itself — directly, or through a longer A-calls-B-calls-A
// loop — would recurse the JS call stack instead of looping inside the
// step-budgeted walk GRAPH_MAX_STEPS already guards. This is the same
// "a mod must never be able to hang the game" guarantee, for the one path
// that goes around graphRunChain's own budget.
let graphSignalDepth = 0;
const GRAPH_MAX_SIGNAL_DEPTH = 8;
// Chains parked mid-run by a "Wait" block, ticked down in updateGraphRuntime.
// Capped because an event that fires every frame could otherwise park a new
// chain every frame and grow this without limit; past the cap a wait simply
// does not start rather than the game slowing to a crawl.
let graphPending = [];
const GRAPH_MAX_PENDING = 64;
// Announcements waiting for their listeners, drained once per frame by
// updateGraphRuntime. Capped for the same reason graphPending is: a rule that
// announces every frame must not be able to grow this without limit, and past
// the cap an announcement is dropped rather than the frame getting slower.
//
// `let`, not `const`: the drain swaps the whole array out for a fresh one so
// that anything announced BY a listener lands in the next frame's batch rather
// than being delivered inside this one. That swap is what makes a chain
// reaction flat and unable to recurse into itself, which is the property this
// whole pair exists to provide.
let graphAnnounceQueue = [];
const GRAPH_MAX_ANNOUNCE = 32;

// ── Dialoge: die eine Stelle, an der ein Mod eine ENTSCHEIDUNG verlangt ──
// Bisher lief jeder Mod von selbst ab: der Spieler betritt eine Zone, bekommt
// Punkte, fertig. Ein Dialog dreht das um und laesst den Spieler waehlen.
//
// Bewusst eine FESTE Form und keine freie Oberflaeche: eine Ueberschrift und
// bis zu drei Knoepfe. Das ist der einzige Zuschnitt, der zum geschlossenen
// Katalog passt, denn ein Mod darf beschreiben, WAS zur Wahl steht, aber nie
// selbst Markup in die Seite schreiben. Damit bleibt ein geteilter Mod auch
// dann harmlos, wenn er von einem Fremden kommt.
let graphDialog = null;        // { title, buttons: [...], freeze } oder null
let graphDialogEl = null;

function graphDialogElement() {
  if (graphDialogEl && graphDialogEl.isConnected) return graphDialogEl;
  graphDialogEl = document.createElement('div');
  graphDialogEl.id = 'vx-mod-dialog';
  graphDialogEl.style.cssText =
    'position:fixed;inset:0;z-index:70;display:none;' +
    'align-items:center;justify-content:center;' +
    'background:rgba(6,5,10,0.55);';
  document.body.appendChild(graphDialogEl);
  return graphDialogEl;
}

function graphCloseDialog() {
  graphDialog = null;
  if (graphDialogEl) graphDialogEl.style.display = 'none';
}

// `into` ist der Name eines gespeicherten Textes oder leer. Leer heisst: nur
// Knoepfe, also genau der Dialog, den es vorher schon gab. Steht ein Name da,
// bekommt der Kasten ein Eingabefeld, und beim Knopfdruck landet das Getippte
// unter diesem Namen im Textspeicher.
//
// ZWEI DINGE, die man dabei wissen muss:
//
//   Die Tastatur gehoert dann dem Feld. Die Engine steigt in ihrem eigenen
//   keydown/keyup sofort aus, sobald ein INPUT den Fokus hat, ein getipptes
//   "w" laesst die Figur also nicht loslaufen. Das gilt aber auch fuer
//   "let me keep moving": ein Dialog mit Eingabefeld nimmt die Tastatur immer,
//   egal was der Auswahlkasten sagt. Die Einstellung wirkt weiter auf die
//   Physik, nicht mehr auf die Tasten.
//
//   Eine beim Oeffnen GEDRUECKTE Taste bekaeme nie ihr keyup, weil derselbe
//   Ausstieg auch das Loslassen schluckt. Sie bliebe danach dauerhaft "unten"
//   und die Figur liefe von selbst weiter. Deshalb werden die Tasten hier
//   einmal geleert, so als haette der Spieler alles losgelassen -- was optisch
//   ohnehin passiert, sobald ein Kasten den Bildschirm nimmt.
function graphOpenDialog(title, buttons, freeze, into) {
  const el = graphDialogElement();
  graphDialog = { title, buttons, freeze, into: into || '' };
  if (graphDialog.into && typeof keys !== 'undefined') {
    for (const k of Object.keys(keys)) keys[k] = false;
  }
  const box = document.createElement('div');
  box.style.cssText =
    'min-width:230px;max-width:340px;padding:16px 18px;' +
    'border:2px solid rgba(168,85,247,0.6);border-radius:5px;' +
    'background:rgba(14,12,20,0.97);color:#efe9ff;' +
    'font-family:var(--font-mono,monospace);font-size:12px;' +
    'box-shadow:0 8px 28px rgba(0,0,0,0.5);';
  const h = document.createElement('div');
  h.textContent = title;
  h.style.cssText = 'color:#c4a2ff;font-size:12.5px;line-height:1.5;margin-bottom:14px;';
  box.appendChild(h);

  // 16px, nicht 12: darunter zoomt iOS Safari beim Fokus die ganze Seite hinein
  // (dieselbe Regel, unter der jedes andere Eingabefeld im Spiel steht).
  let input = null;
  if (graphDialog.into) {
    input = document.createElement('input');
    input.type = 'text';
    input.maxLength = GRAPH_MAX_TEXT;
    input.setAttribute('aria-label', title);
    input.style.cssText =
      'display:block;width:100%;box-sizing:border-box;margin-bottom:4px;padding:8px 10px;' +
      'border:1px solid rgba(168,85,247,0.45);border-radius:3px;' +
      'background:rgba(6,5,10,0.85);color:#efe9ff;' +
      'font-family:inherit;font-size:16px;outline:none;';
    input.addEventListener('focus', () => { input.style.borderColor = 'rgba(168,85,247,0.9)'; });
    input.addEventListener('blur',  () => { input.style.borderColor = 'rgba(168,85,247,0.45)'; });
    box.appendChild(input);
  }

  // Was gerade im Feld steht, gesichert BEVOR der Knopf-Kette etwas laeuft.
  // Ohne diese Reihenfolge muesste eine Regel den Text im naechsten Frame
  // abholen, und "frag etwas, benutze die Antwort sofort" waere nicht sagbar.
  const commit = () => {
    if (graphDialog && graphDialog.into && input) graphSetText(graphDialog.into, input.value);
  };

  buttons.forEach(label => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText =
      'display:block;width:100%;margin-top:7px;padding:8px 10px;' +
      'border:1px solid rgba(168,85,247,0.45);border-radius:3px;' +
      'background:rgba(168,85,247,0.14);color:#efe9ff;' +
      'font-family:inherit;font-size:12px;cursor:pointer;text-align:left;';
    b.addEventListener('mouseenter', () => { b.style.background = 'rgba(168,85,247,0.28)'; });
    b.addEventListener('mouseleave', () => { b.style.background = 'rgba(168,85,247,0.14)'; });
    // Erst schliessen, dann feuern: eine Regel, die auf den Druck hin sofort
    // den naechsten Dialog oeffnet, wuerde sonst von ihrem eigenen Aufraeumen
    // wieder zugemacht.
    b.addEventListener('click', () => {
      commit();
      graphCloseDialog();
      fireGraphEvent('onButtonPress', graphSelfCtx(label));
    });
    box.appendChild(b);
  });

  el.innerHTML = '';
  el.appendChild(box);
  el.style.display = 'flex';

  if (input) {
    // Enter druckt den ERSTEN Knopf. Wer gerade getippt hat, greift nicht zur
    // Maus, um zu bestaetigen, und ein Feld, in dem Enter nichts tut, fuehlt
    // sich kaputt an. Der erste Knopf ist dabei die richtige Wahl, weil
    // showDialog notfalls "OK" ergaenzt: es gibt also immer einen.
    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const first = box.querySelector('button');
      if (first) first.click();
    });
    // Nach dem Einhaengen, sonst nimmt ein noch nicht im Dokument haengendes
    // Feld den Fokus gar nicht an.
    input.focus();
  }
}

// Der Kontext fuer einen Knopfdruck. Der "ausloesende Spieler" ist hier ICH,
// denn ein Dialog steht auf meinem Bildschirm und nur ich kann ihn druecken.
// Damit lesen sich die "event player"-Werte auch hier sinnvoll, statt leer zu
// bleiben: der Tag ist meiner, die Entfernung ist 0.
function graphSelfCtx(button) {
  const t = graphPlayerTile();
  return {
    button: button,
    playerUid: (typeof userId !== 'undefined' && userId) ? userId : 'me',
    playerTag: graphPlayerTag((typeof userId !== 'undefined' && userId) ? userId : 'me'),
    playerX: t.x,
    playerY: t.y,
    playerDist: 0,
    playerTeam: (window.VxArena && VxArena.getTeam) ? (VxArena.getTeam() | 0) : 0
  };
}

// ── Punktetafel, die ein Mod einblenden kann ─────────────────────────────
// Ein EIGENES Element und nicht das der Arena (#arena-scores): die Arena
// zeichnet ihres jeden Frame neu, ein Mod-Eintrag darin wäre also sofort
// wieder überschrieben. Getrennt kann beides nebeneinander bestehen.
let graphBoardEl = null;
function graphBoardElement() {
  if (graphBoardEl && graphBoardEl.isConnected) return graphBoardEl;
  graphBoardEl = document.createElement('div');
  graphBoardEl.id = 'vx-mod-board';
  graphBoardEl.style.cssText =
    'position:fixed;top:96px;right:14px;z-index:60;min-width:150px;max-width:230px;' +
    'padding:8px 10px;border:2px solid rgba(168,85,247,0.55);border-radius:4px;' +
    'background:rgba(12,10,18,0.86);color:#efe9ff;' +
    'font-family:var(--font-mono,monospace);font-size:11px;line-height:1.6;' +
    'pointer-events:none;display:none;';
  document.body.appendChild(graphBoardEl);
  return graphBoardEl;
}
function graphHideBoard() {
  if (graphBoardEl) graphBoardEl.style.display = 'none';
  // Die Spalte oben rechts weicht der Punktetafel aus, solange sie sichtbar
  // ist. Verschwindet die Tafel, darf der Platz sofort zurueckfallen.
  graphRenderPanels();
}
function graphRenderBoard(how, title, board) {
  const el = graphBoardElement();
  let rows;
  if (how === 'per team') {
    // Mannschaftssummen entstehen rein lokal aus denselben Einträgen. Es gibt
    // deshalb keinen zweiten Weg, auf dem sie auseinanderlaufen könnten.
    const totals = new Map();
    for (const s of board) totals.set(s.team, (totals.get(s.team) || 0) + s.score);
    rows = [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([team, score]) => [team === 0 ? 'No team' : 'Team ' + team, score]);
  } else {
    rows = board.slice(0, 8).map(s => [
      s.name ? String(s.name).slice(0, 12) : String(s.uid || '').slice(0, 4).toUpperCase(),
      s.score
    ]);
  }
  const head = '<div style="color:#c4a2ff;letter-spacing:0.08em;margin-bottom:4px">' +
               escapeHtml(String(title || 'Scores')) + '</div>';
  const body = rows.length
    ? rows.map(([name, score]) =>
        '<div style="display:flex;justify-content:space-between;gap:10px">' +
          '<span>' + escapeHtml(name) + '</span>' +
          '<span style="font-variant-numeric:tabular-nums">' + (score | 0) + '</span>' +
        '</div>').join('')
    : '<div style="opacity:0.6">no scores yet</div>';
  el.innerHTML = head + body;
  el.style.display = '';
  // Nach dem Einblenden, damit die Hoehe der Tafel schon messbar ist.
  graphRenderPanels();
}

// ── Panels ───────────────────────────────────────────────────────────────
// Vier Behaelter, einer je Ecke, jeder eine Spalte. Dass Panels sich stapeln
// statt zu ueberlagern, faellt damit dem Layout zu und muss nirgends gerechnet
// werden. `pointer-events:none` auf allem: ein Mod darf den Bildschirm
// beschriften, aber niemals einen Klick abfangen, den der Spieler auf die Welt
// gemeint hat.
//
// Die Abstaende oben und unten halten die bestehende Bedienung frei (Kopfleiste
// und Hotbar), dieselben 96px, mit denen Punktetafel und Debug-Anzeige schon
// arbeiten.
let graphPanelLayerEl = null;
const GRAPH_PANEL_CORNER_CSS = {
  'top left':     'left:14px;top:96px;align-items:flex-start;',
  'top right':    'right:14px;top:96px;align-items:flex-end;',
  'bottom left':  'left:14px;bottom:96px;align-items:flex-start;flex-direction:column-reverse;',
  'bottom right': 'right:14px;bottom:96px;align-items:flex-end;flex-direction:column-reverse;'
};
function graphPanelCorner(where) {
  // Dieselbe Pruefung wie bei graphBoardElement: haengt das Element noch im
  // Dokument? Ein einziger Behaelter reicht als Stichprobe, sie werden nur
  // zusammen angelegt.
  if (!graphPanelLayerEl || !graphPanelLayerEl['top left'].isConnected) {
    graphPanelLayerEl = {};
    for (const corner of GRAPH_PANEL_CORNERS) {
      const box = document.createElement('div');
      box.id = 'vx-mod-panels-' + corner.replace(' ', '-');
      box.style.cssText =
        'position:fixed;z-index:58;display:flex;flex-direction:column;gap:6px;' +
        'pointer-events:none;' + GRAPH_PANEL_CORNER_CSS[corner];
      document.body.appendChild(box);
      graphPanelLayerEl[corner] = box;
    }
  }
  return graphPanelLayerEl[GRAPH_PANEL_CORNERS.includes(where) ? where : 'top left'];
}

// Baut alle Panels neu auf. Bei hoechstens vier Panels zu je sechs Zeilen ist
// das ein knappes Dutzend Elemente; ein gezieltes Nachfuehren einzelner Zeilen
// waere mehr Zustand fuer weniger Verlaesslichkeit.
function graphRenderPanels() {
  const corners = {};
  for (const c of GRAPH_PANEL_CORNERS) { corners[c] = graphPanelCorner(c); corners[c].innerHTML = ''; }

  // Die Arena-Punktetafel sitzt fest oben rechts. Ein Panel in derselben Ecke
  // wuerde sie ueberdecken, deshalb weicht die Spalte um ihre gemessene Hoehe
  // nach unten aus, solange sie sichtbar ist.
  const boardVisible = graphBoardEl && graphBoardEl.isConnected && graphBoardEl.style.display !== 'none';
  corners['top right'].style.top = boardVisible ? (96 + graphBoardEl.offsetHeight + 8) + 'px' : '96px';

  for (const name of Object.keys(graphPanels)) {
    const p = graphPanels[name];
    if (!p || !p.shown) continue;
    const box = document.createElement('div');
    box.style.cssText =
      'min-width:132px;max-width:230px;padding:7px 9px;' +
      'border:2px solid rgba(168,85,247,0.5);border-radius:4px;' +
      'background:rgba(12,10,18,0.86);color:#efe9ff;' +
      'font-family:var(--font-mono,monospace);font-size:11px;line-height:1.6;';
    if (p.title) {
      const h = document.createElement('div');
      h.textContent = p.title;
      h.style.cssText = 'color:#c4a2ff;letter-spacing:0.08em;margin-bottom:3px;';
      box.appendChild(h);
    }
    for (let i = 1; i <= GRAPH_MAX_PANEL_LINES; i++) {
      const row = p.lines[i];
      if (!row) continue;
      const d = document.createElement('div');
      // textContent, nicht innerHTML: der Inhalt kommt aus einem geteilten Mod
      // oder sogar aus dem, was ein Spieler in einen Dialog getippt hat.
      d.textContent = row.text;
      d.style.color = GRAPH_COLORS[row.color] || '#efe9ff';
      box.appendChild(d);
    }
    corners[GRAPH_PANEL_CORNERS.includes(p.where) ? p.where : 'top left'].appendChild(box);
  }
}

// Auf den ersten Zugriff angelegt, genau wie graphGetList eine Liste anlegt:
// wer nur eine Zeile schreiben will, soll das Panel nicht vorher anmelden
// muessen. Ueber der Grenze wird nichts mehr angelegt und der Aufrufer bekommt
// null, was bei ihm still nichts tut.
function graphGetPanel(name) {
  let p = graphPanels[name];
  if (!p) {
    if (Object.keys(graphPanels).length >= GRAPH_MAX_PANELS) return null;
    p = { where: 'top left', title: '', shown: true, lines: {} };
    graphPanels[name] = p;
  }
  return p;
}

// ── Countdowns ───────────────────────────────────────────────────────────
// Name -> Zeitpunkt (ms der Wanduhr), an dem er abläuft.
//
// ABSICHTLICH OHNE NETZWERK, und das ist eine Abkehr von dem, was ich zuerst
// entworfen hatte. Der erste Plan war, dass der Host einen Endzeitpunkt in ein
// gemeinsames Dokument schreibt und alle anderen ihn lesen. Beim Lesen des
// Arena-Codes zeigte sich, dass das mehr Aufwand für weniger Ergebnis wäre:
//
//   * remainingS() rechnet dort längst aus EINEM Zeitstempel gegen die eigene
//     Wanduhr, statt Ticks zu übertragen. Dasselbe Muster reicht auch hier.
//   * Ein Countdown, den alle Clients im selben Moment starten, läuft ohnehin
//     synchron, weil jeder dieselbe verstreichende Zeit misst. Auseinander
//     laufen können sie nur um die Verzögerung des auslösenden Ereignisses,
//     und die ist bei "Wenn die Runde beginnt" ein Wimpernschlag.
//   * Ohne Netzwerkanteil funktioniert es in JEDER Welt, auch allein und
//     ausserhalb der Arena, statt nur in einem laufenden Match.
//
// Der Preis ist ehrlich benannt: startet ein Countdown durch ein Ereignis, das
// nicht alle gleichzeitig sehen, sehen auch die Uhren verschieden aus. Wer
// echten Gleichlauf braucht, startet ihn aus "When the match starts", das der
// Host treibt.
let graphCountdowns = {};
const GRAPH_MAX_COUNTDOWNS = 8;

function graphCountdownLeft(name) {
  const end = graphCountdowns[name];
  if (!end) return 0;
  return Math.max(0, (end - Date.now()) / 1000);
}

// Einmal je Frame. Ein abgelaufener Countdown wird ENTFERNT, bevor sein
// Ereignis feuert, damit eine Regel, die im selben Zug denselben Namen neu
// startet, nicht sofort wieder als abgelaufen gilt.
function graphTickCountdowns() {
  const now = Date.now();
  for (const name in graphCountdowns) {
    if (graphCountdowns[name] > now) continue;
    delete graphCountdowns[name];
    fireGraphEvent('onCountdownEnd', { timer: name });
  }
}

// ── Mehrspieler-Präsenz: wer ist da, wer ist gegangen ────────────────────
// WARUM NICHT AN FIRESTORE: der naheliegende Weg wäre, sich an die
// docChanges() in startMultiplayerSync zu hängen und added/removed zu nehmen.
// Das wäre in vier Fällen falsch, und alle vier stehen im bestehenden Code:
//
//   * ein Spieler auf einem FREMDEN Seed meldet ebenfalls "added", der
//     Seed-Filter greift erst danach
//   * wer den Seed WECHSELT, meldet "modified", nicht added oder removed,
//     obwohl er für uns beitritt oder geht
//   * wer abstürzt oder das Fenster schliesst, meldet GAR NICHTS: sein
//     Dokument bleibt liegen und wird nur still
//   * ein gebannter Spieler wird gesondert herausgefiltert
//
// otherPlayers hat all das bereits richtig gelöst. Deshalb wird hier nicht
// Firestore beobachtet, sondern otherPlayers, und Beitritt wie Weggang werden
// aus der Differenz zweier Frames abgeleitet. Ein Abgestürzter fällt damit
// über dieselbe Frist heraus, die countPlayersHere ohnehin benutzt.
const GRAPH_PRESENCE_STALE_MS = 8000;
let graphSeenPlayers = new Map();     // uid -> { tag, x, y }
// Wen der Sichtbereich schon berührt hat, mit dem Zeitpunkt: ohne das feuerte
// "berührt mich" jeden Frame neu, solange zwei Spieler nebeneinander stehen.
let graphTouchCooldown = new Map();   // uid -> ms
const GRAPH_TOUCH_COOLDOWN_MS = 1500;
// Vom Mod gesetzte Zonen. Begrenzt, weil der Durchlauf Spieler mal Zonen je
// Frame kostet; bei acht und acht sind das 64 Vergleiche, also nichts.
const GRAPH_MAX_ZONES = 8;
let graphZones = {};                  // name -> { x0, y0, x1, y1 }
let graphZoneState = {};              // name -> Set der uids, die drin waren
// name -> { where, title, shown, lines: { <nr>: { text, color } } }
// Die Zeilen sind ein Objekt und keine Reihung: eine Regel darf Zeile 4
// beschreiben, ohne dass es Zeile 1 bis 3 schon gibt, und eine Luecke soll
// dann eine leere Zeile sein statt eines Lochs im Array.
let graphPanels = {};
// Der Kontext der gerade laufenden Kette, damit die fünf "event player"-Werte
// ihn lesen können. GRAPH_STAT_READERS bekommt keine Argumente, also muss der
// Kontext hier stehen. Wird in graphWalk je Schritt gesetzt und ist deshalb
// auch nach einem "Wait" wieder korrekt, weil die geparkte Kette ihren ctx
// mitführt.
let graphCtxNow = null;

// Deterministische Streuung einer UID auf 1..9999 (FNV-1a). Gleiche UID ergibt
// auf jedem Client dieselbe Zahl, ohne Absprache und ohne Server.
function graphPlayerTag(uid) {
  let h = 2166136261;
  const s = String(uid);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (Math.abs(h) % 9999) + 1;
}

// Baut den Kontext, den ein Spieler-Ereignis mitbekommt. Die Entfernung wird
// hier einmal gerechnet, damit sie im Ereignis stabil ist, statt sich zwischen
// zwei Karten derselben Kette zu ändern.
function graphPlayerCtx(uid, p) {
  const px = player.x + player.w / 2, py = player.y + player.h / 2;
  const dx = (p.x || 0) - px, dy = (p.y || 0) - py;
  return {
    playerUid: uid,
    playerTag: graphPlayerTag(uid),
    playerX: Math.floor((p.x || 0) / TILE),
    playerY: Math.floor((p.y || 0) / TILE),
    playerDist: Math.sqrt(dx * dx + dy * dy) / TILE,
    playerTeam: (window.VxArena && VxArena.teamOf) ? (VxArena.teamOf(uid) | 0) : 0
  };
}

// Einmal je Frame aus updateGraphRuntime. Hält sich bewusst kurz, wenn gar
// keine Mods laufen: dann gibt es niemanden, der zuhören könnte.
function graphSyncPresence() {
  if (typeof otherPlayers === 'undefined' || !otherPlayers) return;
  const now = Date.now();
  const live = new Map();
  for (const uid in otherPlayers) {
    const p = otherPlayers[uid];
    if (!p) continue;
    // Dieselbe Frische-Grenze, die countPlayersHere benutzt: ein Dokument, das
    // seit acht Sekunden still ist, gehört zu jemandem, der weg ist.
    if (now - (p.ts || 0) > GRAPH_PRESENCE_STALE_MS) continue;
    live.set(uid, p);
  }

  for (const [uid, p] of live) {
    if (!graphSeenPlayers.has(uid)) fireGraphEvent('onPlayerJoin', graphPlayerCtx(uid, p));
  }
  for (const [uid, prev] of graphSeenPlayers) {
    // Abmelden, Seed-Wechsel, Bann und Absturz enden alle hier, weil sie alle
    // dazu führen, dass der Spieler nicht mehr in `live` steht.
    if (!live.has(uid)) {
      fireGraphEvent('onPlayerLeave', graphPlayerCtx(uid, prev));
      graphTouchCooldown.delete(uid);
    }
  }

  graphSweepZones(live);
  graphSweepTouch(live, now);
  graphSeenPlayers = live;
}

// Schluessel, unter dem ich mich selbst in graphZoneState fuehre. Kein echtes
// uid, damit es niemals mit einem echten Spieler kollidiert.
const GRAPH_LOCAL_ZONE_KEY = ' local';
function graphLocalZoneCtx() {
  const t = graphPlayerTile();
  return {
    playerUid: GRAPH_LOCAL_ZONE_KEY, playerTag: 0,
    playerX: t.x, playerY: t.y, playerDist: 0,
    playerTeam: (window.VxArena && VxArena.getTeam) ? (VxArena.getTeam() | 0) : 0
  };
}

function graphSweepZones(live) {
  for (const name in graphZones) {
    const z = graphZones[name];
    const was = graphZoneState[name] || (graphZoneState[name] = new Set());
    const nowIn = new Set();
    for (const [uid, p] of live) {
      const tx = Math.floor((p.x || 0) / TILE), ty = Math.floor((p.y || 0) / TILE);
      if (tx < z.x0 || tx > z.x1 || ty < z.y0 || ty > z.y1) continue;
      nowIn.add(uid);
      // Nur der Übergang zählt, nicht das Drinstehen: sonst feuerte die Regel
      // jeden Frame, solange jemand in der Zone steht.
      if (!was.has(uid)) {
        const ctx = graphPlayerCtx(uid, p);
        ctx.zone = name;
        fireGraphEvent('onPlayerEnterZone', ctx);
      }
    }
    // Verlassen: wer vorher drin war und jetzt nicht mehr, meldet sich ab, mit
    // der letzten bekannten Position, falls noch verbunden. Wer die Praesenz
    // komplett verloren hat (Absturz, Weltwechsel) bekommt onPlayerLeave schon
    // aus graphSyncPresence -- das hier ist nur der Zonenaustritt selbst.
    for (const uid of was) {
      if (uid === GRAPH_LOCAL_ZONE_KEY || nowIn.has(uid)) continue;
      const p = live.get(uid);
      const ctx = p ? graphPlayerCtx(uid, p)
                    : { playerUid: uid, playerTag: graphPlayerTag(uid), playerX: 0, playerY: 0, playerDist: 0, playerTeam: 0 };
      ctx.zone = name;
      fireGraphEvent('onPlayerLeaveZone', ctx);
    }

    // Ich selbst zaehle auch, nicht nur andere Spieler: sonst liesse sich ein
    // Zonen-Mod nie allein testen, und "Offline - solo test run" ist der
    // haeufigste Arena-Testfall ueberhaupt. Eigener Zweig statt ueber `live`,
    // weil ich dort nicht drinstehe -- otherPlayers meldet nur die anderen.
    const t = graphPlayerTile();
    const meIn = t.x >= z.x0 && t.x <= z.x1 && t.y >= z.y0 && t.y <= z.y1;
    if (meIn) {
      nowIn.add(GRAPH_LOCAL_ZONE_KEY);
      if (!was.has(GRAPH_LOCAL_ZONE_KEY)) {
        const ctx = graphLocalZoneCtx(); ctx.zone = name;
        fireGraphEvent('onPlayerEnterZone', ctx);
      }
    } else if (was.has(GRAPH_LOCAL_ZONE_KEY)) {
      const ctx = graphLocalZoneCtx(); ctx.zone = name;
      fireGraphEvent('onPlayerLeaveZone', ctx);
    }

    graphZoneState[name] = nowIn;
  }
}

function graphSweepTouch(live, now) {
  for (const [uid, p] of live) {
    const until = graphTouchCooldown.get(uid) || 0;
    if (now < until) continue;
    const px = player.x + player.w / 2, py = player.y + player.h / 2;
    const dx = (p.x || 0) - px, dy = (p.y || 0) - py;
    const distTiles = Math.sqrt(dx * dx + dy * dy) / TILE;
    // Die Reichweite steht auf der Karte, nicht hier: eine feste Zahl würde
    // "Fangen" und "in der Nähe" zu demselben Ereignis machen. Der weiteste
    // Wert, den irgendeine Karte verlangt, entscheidet, ob es überhaupt feuert.
    if (distTiles > GRAPH_TOUCH_MAX_RANGE) continue;
    const ctx = graphPlayerCtx(uid, p);
    ctx.touchDist = distTiles;
    fireGraphEvent('onPlayerTouch', ctx);
    graphTouchCooldown.set(uid, now + GRAPH_TOUCH_COOLDOWN_MS);
  }
}
// Set by the remapDrop action: mined block id -> what it yields instead. A
// standing rule rather than a one-off, so it lives here with the rest of the
// per-session graph state and is cleared with it.
let graphDropRemap = {};
// Multiplier the setDamageScale action owns, read by the takeDamage hook. 1 is
// "the mod never touched it"; 0 means every hit is scaled away to nothing,
// which is a legitimate thing for a mod to want.
let graphDamageScale = 1;
// Set by setBlockMining. A thin override layer read FIRST by getBlockHardness
// / playBlockSound (see voxeria-engine.js), never written into BLOCK_HARDNESS
// / BLOCK_SOUND directly: those two tables also carry every vanilla block's
// tuning and every custom block's OWN baked-in default, and mutating them here
// would leak a mod's override into a session that later loads a different
// loadout without that mod. An empty object is exactly "no mod has touched
// this block", which is why it is cleared on every reload below rather than
// only ever added to.
graphBlockHardness = {};
graphBlockSoundFamily = {};
// True only while the engine's own breakSingleBlock is running, so the drop
// remap applies to what a mined block yields and not to every block that ever
// enters the inventory (a shop purchase, a "Give the player" action).
let graphMining = false;
// A hook-fired event can run actions that trip the same hook again — "when the
// player picks up X, give them Y" is a reasonable mod and an infinite loop.
// Bounded the same way graphSignalDepth bounds callSignal.
let graphHookDepth = 0;
const GRAPH_MAX_HOOK_DEPTH = 4;

function registerCustomGraphPieces(pieceCodes) {
  activeGraphs = [];
  graphTimers = {};
  graphTouching.clear();
  graphSpeedMult = 1;
  graphGravityMult = 1;
  graphReachBonus = 0;
  graphMaxJumps = 1;
  graphYieldMult = 1;
  graphBigPickaxe = false;
  graphHazardImmune = false;
  graphJumpMult = 1;
  graphMaxHealth = 0;
  graphVars = {};
  graphLists = {};
  graphTexts = {};
  // Erst leeren, dann neu zeichnen: sonst blieben die Kaesten des vorigen
  // Mod-Satzes auf dem Bildschirm stehen, obwohl die Regel dahinter weg ist.
  graphPanels = {};
  graphRenderPanels();
  graphSignalDepth = 0;
  graphDropRemap = {};
  graphDamageScale = 1;
  graphBlockHardness = {};
  graphBlockSoundFamily = {};
  // Chains parked by a "Wait" belong to the mod set that started them, so a
  // reload drops them rather than letting a countdown from the previous set
  // fire into the new one.
  graphPending.length = 0;
  // Same reasoning as graphPending above: an announcement queued by the
  // previous mod set has no business reaching listeners in the new one.
  graphAnnounceQueue = [];
  // Präsenz und Zonen gehören ebenfalls dem alten Mod-Satz.
  //
  // graphSeenPlayers startet bewusst LEER, nicht mit den gerade Anwesenden
  // gefüllt. Ein frisch geladener Mod hat noch niemanden gesehen, also gilt
  // jeder, der danach auftaucht, als beigetreten. Praktisch fällt das kaum auf,
  // weil beim Weltstart ohnehin noch niemand in otherPlayers steht und die
  // anderen erst nach und nach eintreffen. Für eine Regel wie "wer kommt, wird
  // in die Liste aufgenommen" ist genau das das gewünschte Verhalten.
  graphSeenPlayers = new Map();
  graphTouchCooldown = new Map();
  graphZones = {};
  graphZoneState = {};
  graphCtxNow = null;
  // Ein Countdown des alten Mod-Satzes darf im neuen nicht weiterlaufen, und
  // eine eingeblendete Tafel gehört ebenfalls dem Mod, der sie gezeigt hat.
  graphCountdowns = {};
  graphHideBoard();
  // Ein offener Dialog gehoert dem Mod, der ihn gezeigt hat. Bliebe er beim
  // Wechsel stehen, haette niemand mehr eine Regel, die auf seinen Knopf
  // hoert, und bei "hold me still" saesse der Spieler fest.
  graphCloseDialog();
  installGraphHooks();
  const codes = Array.isArray(pieceCodes)
    ? pieceCodes.filter(isGraphCode)
    : VxPieces.list('GRAPH').filter(p => p.enabled !== false).map(p => p.code);
  for (const code of codes) {
    const g = decodeGraphCode(code);
    // sourceCode wie bei Bloecken und Kreaturen -- der Graph-Name allein
    // taugt nicht als Schluessel, zwei Spieler nennen ihren Mod problemlos
    // beide "My Mod".
    if (g && g.nodes.length) { g.sourceCode = code; activeGraphs.push(g); }
  }
}
window.registerCustomGraphPieces = registerCustomGraphPieces;

// The one interpreter, used by a fresh trigger (graphRunChain), a chain
// resuming after a "Wait" (graphResumeChain), and a loop's own body
// (recursively, from right inside this same function). `budget` is a single
// mutable counter — `{ n }` — SHARED across that entire call tree, including
// every nested loop body, so ten loops nested inside each other still spend
// from one common allowance instead of each getting their own 2000 steps.
// That is the one property that makes nesting safe: however deep the graph
// recurses, the game can only ever be asked to do GRAPH_MAX_STEPS worth of
// work for one trigger.
//
// `inLoop` is true only while walking a loop's `body` output. Its one job:
// a "Wait" inside a loop body has nowhere sensible to suspend TO — pausing
// would have to freeze the loop's remaining passes and everything queued
// after `done` along with it, which is a coroutine this interpreter does not
// have. Rather than silently drop the rest of the chain (what would happen
// today if a parked "Wait" tried to resume into a loop body it started that
// no longer exists), a "Wait" inside a loop is a documented no-op: it warns
// once to the console and simply continues, so the mod keeps working instead
// of quietly losing everything past that point.
function graphWalk(graph, byId, node, ctx, budget, inLoop) {
  while (node && budget.n++ < GRAPH_MAX_STEPS) {
    // Der Kontext dieser Kette, damit die "event player"-Werte ihn lesen
    // können. Je Schritt gesetzt und nicht einmal je Kette, weil eine
    // verschachtelte Schleife mit eigenem ctx dazwischenliegen kann: kommt sie
    // zurück, muss wieder der äussere gelten.
    graphCtxNow = ctx;
    const def = NODE_CATALOG[node.type];
    if (!def) return;
    let port = 'out';
    if (def.kind === 'cond') {
      port = graphTestCondition(node, ctx) ? 'yes' : 'no';
    } else if (node.type === 'repeatTimes') {
      const times = graphResolveInt(node.params.count, 1, GRAPH_MAX_LOOP_ITERS) || 1;
      const bodyWire = graph.wires.find(w => w.from === node.id && w.fromPort === 'body');
      const bodyStart = bodyWire ? byId.get(bodyWire.to) : null;
      if (bodyStart) {
        for (let i = 0; i < times && budget.n < GRAPH_MAX_STEPS; i++) {
          graphWalk(graph, byId, bodyStart, ctx, budget, true);
        }
      }
      port = 'done';
    } else if (node.type === 'repeatWhile') {
      const bodyWire = graph.wires.find(w => w.from === node.id && w.fromPort === 'body');
      const bodyStart = bodyWire ? byId.get(bodyWire.to) : null;
      // Capped at GRAPH_MAX_LOOP_ITERS passes regardless of what the condition
      // says: unlike "Repeat", nothing here guarantees the condition ever goes
      // false on its own (a mod that forgets to change the number it is
      // testing would otherwise spend its whole step budget on one node).
      if (bodyStart) {
        let passes = 0;
        while (passes++ < GRAPH_MAX_LOOP_ITERS && budget.n < GRAPH_MAX_STEPS &&
               graphCompare(graphResolveValue(node.params.a), node.params.op, graphResolveValue(node.params.b))) {
          graphWalk(graph, byId, bodyStart, ctx, budget, true);
        }
      }
      port = 'done';
    } else if (node.type === 'forEachItem') {
      const bodyWire = graph.wires.find(w => w.from === node.id && w.fromPort === 'body');
      const bodyStart = bodyWire ? byId.get(bodyWire.to) : null;
      if (bodyStart) {
        // A snapshot of the slots, not a live read of `inventory` on every
        // pass: the body is free to give or take items (including the one the
        // loop is currently on) without that reshuffling which slot index
        // comes next or skipping one that shifted forward.
        const slots = inventory.filter(Boolean);
        for (const it of slots) {
          if (budget.n >= GRAPH_MAX_STEPS) break;
          graphSetVar(node.params.itemVar, it.block);
          graphSetVar(node.params.countVar, it.count);
          // A fresh ctx per pass (spread, not mutated in place) so a nested
          // loop over some OTHER collection inside this body — or this same
          // loop, called again later — can never see a stale block/count left
          // over from an outer pass, the same isolation callSignal's sigCtx
          // already relies on.
          graphWalk(graph, byId, bodyStart, { ...ctx, block: it.block, count: it.count }, budget, true);
        }
      }
      port = 'done';
    } else if (node.type === 'forEachInList') {
      const bodyWire = graph.wires.find(w => w.from === node.id && w.fromPort === 'body');
      const bodyStart = bodyWire ? byId.get(bodyWire.to) : null;
      if (bodyStart) {
        // A copy, for exactly the reason forEachItem snapshots the inventory:
        // the body is free to add to or remove from the very list being walked
        // (the natural way to write "keep only the ones above 10"), and walking
        // the live array would then skip entries or never finish.
        const snapshot = graphGetList(node.params.list).slice(0, GRAPH_MAX_LIST);
        for (let i = 0; i < snapshot.length; i++) {
          if (budget.n >= GRAPH_MAX_STEPS) break;
          graphSetVar(node.params.itemVar, snapshot[i]);
          graphSetVar(node.params.indexVar, i + 1);
          // A fresh ctx per pass, the same isolation the loop above relies on.
          graphWalk(graph, byId, bodyStart, { ...ctx }, budget, true);
        }
      }
      port = 'done';
    } else if (node.type === 'wait') {
      if (inLoop) {
        console.warn('Voxeria: "Wait" inside a loop has no effect there — skipped.');
        // Falls through to the normal 'out' lookup below, so the rest of the
        // loop body still runs instead of the chain silently going dark.
      } else {
        // The one action that does not finish inside this loop: hand the rest
        // of the chain to updateGraphRuntime and stop here. The budget is not
        // reset on resume, it travels with the parked chain, so a ring of
        // waits still runs out of steps instead of ticking forever.
        const wire = graph.wires.find(w => w.from === node.id && w.fromPort === 'out');
        const next = wire ? byId.get(wire.to) : null;
        if (next && graphPending.length < GRAPH_MAX_PENDING) {
          graphPending.push({
            graph, nodeId: next.id, ctx,
            steps: budget.n,
            left: Math.max(1, Math.round(graphResolveNum(node.params.seconds, 0.1, 60) * 60))
          });
        }
        return;
      }
    } else if (def.kind === 'action') {
      try { GRAPH_ACTIONS[node.type](node.params, ctx); }
      catch (e) { console.warn('Voxeria: mod action failed', node.type, e); }
    }
    const wire = graph.wires.find(w => w.from === node.id && w.fromPort === port);
    node = wire ? byId.get(wire.to) : null;
  }
}

// ctx carries whatever the triggering event knows — the block involved and
// where it happened — so actions can refer back to it.
function graphRunChain(graph, startNode, ctx) {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  graphWalk(graph, byId, startNode, ctx, { n: 0 }, false);
}

// Resumes a chain parked by a "Wait" block, picking the walk back up at the
// node after it with the step count it had already spent.
function graphResumeChain(entry) {
  const node = entry.graph.nodes.find(n => n.id === entry.nodeId);
  if (!node) return;
  if (entry.steps >= GRAPH_MAX_STEPS) return;
  const byId = new Map(entry.graph.nodes.map(n => [n.id, n]));
  graphWalk(entry.graph, byId, node, entry.ctx, { n: entry.steps }, false);
}

// ── Shared helpers for the condition/action tables below ──
// The tile the player's feet are in, and the one they're standing on.
function graphPlayerTile() {
  return { x: Math.floor((player.x + player.w / 2) / TILE), y: Math.floor(player.y / TILE) };
}
function graphGroundBlock() {
  return getBlock(Math.floor((player.x + player.w / 2) / TILE),
                  Math.floor((player.y + player.h + 1) / TILE));
}
// Where a block-flavoured action should act. Mine/place events know the exact
// tile they happened on; everything else falls back to the player.
function graphTargetTile(ctx) {
  if (ctx && Number.isInteger(ctx.x) && Number.isInteger(ctx.y)) return { x: ctx.x, y: ctx.y };
  return graphPlayerTile();
}
function graphCountBlock(id) {
  let n = 0;
  for (const it of inventory) if (it && it.block === id) n += it.count;
  return n;
}
// Two tiles of headroom, since the player is ~1.8 tiles tall.
function graphTileIsFree(tx, ty) {
  const a = getBlock(tx, ty), b = getBlock(tx, ty + 1);
  const passable = v => v === BLOCKS.AIR || v === BLOCKS.WATER || v === BLOCKS.FLOWER;
  return passable(a) && passable(b);
}

// Conditions pick the `yes` or `no` port. Anything that throws or names
// something unknown falls through to `no`, so a broken chain simply stops
// instead of taking a branch it was never meant to.
const GRAPH_CONDS = {
  ifChance:  p => Math.random() * 100 < p.percent,
  ifCompare: p => graphCompare(graphResolveValue(p.a), p.op, graphResolveValue(p.b)),
  // Case-insensitive on purpose. These are words a player typed into two
  // different boxes, possibly weeks apart, and "Gold" failing to match "gold"
  // would read as a broken mod rather than as a rule about capitals.
  ifTextIs: p => {
    const a = graphResolveText(p.a).toLowerCase();
    if (p.op === 'is empty') return a === '';
    const b = graphResolveText(p.b).toLowerCase();
    if (p.op === 'is not') return a !== b;
    if (p.op === 'contains') return b !== '' && a.includes(b);
    return a === b;
  },
  ifBlock:   (p, ctx) => {
    if (p.how === 'is holding') {
      const h = inventory[selectedSlot];
      return !!h && h.block === p.block;
    }
    if (p.how === 'is standing on') return graphGroundBlock() === p.block;
    // Same field the block-flavoured events and "For each item I'm carrying"
    // already populate — see the note on GRAPH_BLOCK_RELS.
    if (p.how === 'is the block involved') return !!ctx && ctx.block === p.block;
    return graphCountBlock(p.block) >= graphResolveInt(p.count, 1, 999);
  },
  ifState:   p => {
    if (p.state === 'the player is in water') return !!player.inWater;
    if (p.state === 'the player is on the ground') return !!player.onGround;
    return dayPhase === 'night';
  },
  ifWorldIs: p => {
    if (p.what === 'biome') return getBiome(Math.floor(player.x / (CHUNK_W * TILE))) === p.value;
    // updateWeather bails out early outside the overworld and leaves the old
    // type standing, so a pocket dimension has to read as 'clear' explicitly
    // rather than inheriting whatever the surface weather happened to be.
    if (p.what === 'weather') return (currentDim === 'OVERWORLD' ? weather.type : 'clear') === p.value;
    return currentDim === p.value;
  },
  // Offsets are from wherever the chain is acting — the mined/placed tile for
  // a block event, the player otherwise — which is the same rule every
  // block-flavoured action already follows (see graphTargetTile).
  ifBlockAt:      (p, ctx) => {
    const t = graphTargetTile(ctx);
    return getBlock(t.x + p.dx, t.y + p.dy) === p.block;
  },
  ifWearingArmor: p => typeof equippedArmor !== 'undefined' && equippedArmor.has(p.dim),

  // Dieselbe Tile-Frage wie graphSweepZones fuer andere Spieler stellt, nur
  // fuer mich selbst und auf Abruf statt ereignisgetrieben -- damit lassen
  // sich Dinge bauen, die WEITERLAUFEN, solange jemand in der Zone steht.
  ifInZone: p => {
    const z = graphZones[p.zone];
    if (!z) return false;
    const t = graphPlayerTile();
    return t.x >= z.x0 && t.x <= z.x1 && t.y >= z.y0 && t.y <= z.y1;
  },

  // ── Arena ──
  // window.VxArena rather than a bare name: voxeria-arena.js loads AFTER this
  // file, so the object does not exist yet while this table is being built.
  // It does by the time any of these run, and the `&&` keeps a graph that uses
  // them loadable in a build where the arena script was removed.
  ifInArena:      () => {
    if (!window.VxArena || !window.VxArena.isActive()) return false;
    const t = graphPlayerTile();
    return window.VxArena.inRegion(t.x, t.y);
  },
  ifScoreAtLeast: p => !!(window.VxArena && window.VxArena.getScore() >= graphResolveInt(p.points, 1, 999)),
  ifLeading:      () => !!(window.VxArena && window.VxArena.isLeading()),
  ifTeamScoreAtLeast: p => !!(window.VxArena && window.VxArena.teamScore(window.VxArena.getTeam()) >= graphResolveInt(p.points, 1, 999)),
  ifTeamLeading:      () => !!(window.VxArena && window.VxArena.isTeamLeading())
};

// Shared by both comparison conditions so the two can never drift apart on
// what "is at least" means.
function graphCompare(a, op, b) {
  switch (op) {
    case 'is exactly':   return a === b;
    case 'is not':       return a !== b;
    case 'is more than': return a > b;
    case 'is less than': return a < b;
    case 'is at least':  return a >= b;
    case 'is at most':   return a <= b;
    default:             return false;
  }
}

// The live-value table behind readStat. Every entry returns a plain number in
// the unit its label promises — hearts rather than the engine's half-heart
// health, a 0-100 percentage rather than a raw frame count — because these
// land in the same store the player's own typed numbers do, and get compared
// against them. Anything that throws or is missing reads as 0 via graphSetVar.
const GRAPH_STAT_READERS = {
  // Die fünf Werte des Spielers, um den es im laufenden Ereignis geht. Sie
  // lesen den Kontext der gerade abgearbeiteten Kette, den graphWalk je Schritt
  // setzt. Ausserhalb eines Spieler-Ereignisses ist dort nichts, und sie
  // liefern 0, statt einen Fehler zu werfen.
  'event player tag':      () => (graphCtxNow && graphCtxNow.playerTag) || 0,
  'event player team':     () => (graphCtxNow && graphCtxNow.playerTeam) || 0,
  'event player x':        () => (graphCtxNow && graphCtxNow.playerX) || 0,
  'event player y':        () => (graphCtxNow && graphCtxNow.playerY) || 0,
  'event player distance': () => (graphCtxNow && graphCtxNow.playerDist) || 0,
  'health':           () => player.health / 2,
  'max health':       () => maxHealth / 2,
  'depth':            () => graphPlayerTile().y,
  'position x':       () => graphPlayerTile().x,
  'time of day':      () => (dayTime / DAY_LENGTH) * 100,
  'held count':       () => { const h = inventory[selectedSlot]; return h ? h.count : 0; },
  'blocks carried':   () => inventory.reduce((n, it) => n + (it ? it.count : 0), 0),
  'creatures nearby': () => (typeof animals === 'undefined' ? 0 : animals.length),
  'jumps left':       () => (typeof jumpsLeft === 'undefined' ? 0 : jumpsLeft),
  'random 1-100':     () => 1 + Math.floor(Math.random() * 100),

  // ── The other players ──
  // Counting yourself, so "players here" is the number a person would say out
  // loud when asked how many are in the world. Alone in a world reads as 1,
  // never 0, which is what makes "if players here is at least 2" the natural
  // way to write "only once somebody else turns up".
  'players here':            () => 1 + graphLivePlayers().length,
  // 9999 when nobody else is here, not 0: distance is the one reading where the
  // obvious empty value is also the most dangerous one. A tag mod asking "is
  // the nearest player at most 3 blocks away" would fire continuously in an
  // empty world if absence read as zero. 9999 is also exactly the ceiling
  // graphSetVar clamps to, so it survives being parked in a saved number.
  'nearest player distance': () => { const n = graphNearestPlayer(); return n ? Math.round(n.dist) : 9999; },
  // Absolute world tiles, the same frame 'position x' and 'depth' report in, so
  // the two can be compared and subtracted without a unit in between.
  // Falls back to the player's OWN tile rather than 0 when nobody is there:
  // 0 is a real place in the world that a chain would happily teleport to.
  'nearest player x':        () => { const n = graphNearestPlayer(); return n ? Math.floor(n.p.x / TILE) : graphPlayerTile().x; },
  'nearest player y':        () => { const n = graphNearestPlayer(); return n ? Math.floor(n.p.y / TILE) : graphPlayerTile().y; },
  // Teams live in the Arena's own score documents, not in the position feed, so
  // this asks VxArena rather than reading otherPlayers. 0 outside a match and
  // for anyone who never joined a team, which is also what 'my team' reports
  // there — so "same team" is a comparison that stays true rather than a
  // special case.
  'nearest player team':     () => {
    const n = graphNearestPlayer();
    return (n && window.VxArena && window.VxArena.teamOf) ? window.VxArena.teamOf(n.id) : 0;
  },
  'my team':                 () => (window.VxArena && window.VxArena.getTeam ? window.VxArena.getTeam() : 0)
};

// ── Who else is actually here ─────────────────────────────────────────────
// Three filters, and all three matter. `seed` because otherPlayers can still
// hold somebody who has since switched worlds; `dim` because a player inside a
// pocket dimension is not two blocks away from you even when their last known
// x/y says so; and the 5-second staleness cut because a document outlives the
// player who stopped sending updates.
//
// 5000ms is not a fresh number — it is exactly what drawOtherPlayers() uses to
// decide whether to draw somebody. That is the point: a mod must never be able
// to score a hit on a player who is no longer on screen, and tying the two to
// one number is what guarantees it rather than hoping two constants stay equal.
function graphLivePlayers() {
  if (typeof otherPlayers === 'undefined') return [];
  const now = Date.now();
  const out = [];
  for (const id in otherPlayers) {
    const p = otherPlayers[id];
    if (!p || p.seed !== rawSeedString || p.dim !== currentDim) continue;
    if (now - (p.ts || 0) > 5000) continue;
    out.push({ id, p });
  }
  return out;
}
// Straight-line distance from body centre to body centre, in blocks. Not the
// horizontal gap alone: a player standing on the roof directly above you is not
// nearby in any sense a minigame means, and every "tag" rule would have been
// wrong about it.
function graphNearestPlayer() {
  const list = graphLivePlayers();
  if (!list.length) return null;
  const px = player.x + player.w / 2, py = player.y + player.h / 2;
  let best = null, bestD = Infinity;
  for (const e of list) {
    const dx = (e.p.x + player.w / 2) - px;
    const dy = (e.p.y + player.h / 2) - py;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best ? { id: best.id, p: best.p, dist: bestD / TILE } : null;
}

// An unset name reads as 0 rather than undefined, so "If a number is at
// least 1" behaves sensibly on the very first run instead of comparing
// against nothing.
function graphGetVar(name) {
  const v = graphVars[name];
  return typeof v === 'number' && isFinite(v) ? v : 0;
}
// Clamped to the same range the catalog allows a literal, so repeatedly
// running "Change a number by 999" can only ever walk to the ceiling instead
// of drifting toward Infinity. Anything unusable (NaN, Infinity, a missing
// value) lands on 0 rather than poisoning every later sum that touches it.
function graphClampNum(value) {
  const n = Number(value);
  return isFinite(n) ? Math.max(-9999, Math.min(9999, Number(n.toFixed(1)))) : 0;
}
function graphSetVar(name, value) {
  graphVars[name] = graphClampNum(value);
}

// The text half of the pair above. An unset name reads as "" rather than
// undefined, so "If a text is" behaves sensibly on the very first run.
function graphGetText(name) {
  const t = graphTexts[name];
  return typeof t === 'string' ? t : '';
}
// Bounded the way graphClampNum bounds a number, and for the same reason:
// "join with" run on a timer would otherwise grow one string without limit.
// GRAPH_MAX_TEXT is the length a banner already allows, so a text that fits
// the store always fits the place it is shown.
function graphClampText(value) {
  return _modCleanText(value == null ? '' : value, GRAPH_MAX_TEXT);
}
function graphSetText(name, value) {
  graphTexts[name] = graphClampText(value);
}

// ── Lists ────────────────────────────────────────────────────────────────
// Created on first touch, so a mod never has to declare one and an unset name
// behaves like an empty list rather than a crash. Every entry that goes in
// passes through graphClampNum, which is what lets a list item be used
// anywhere a saved number can without a second range check.
function graphGetList(name) {
  let l = graphLists[name];
  if (!Array.isArray(l)) { l = []; graphLists[name] = l; }
  return l;
}
// Positions are 1-based, because these are read and written by people through
// a dropdown that says "at position", not by code. Anything outside the list
// reads as 0, the same answer graphGetVar gives for a number nobody set yet.
function graphGetListItem(name, position) {
  const l = graphLists[name];
  if (!Array.isArray(l)) return 0;
  const i = Math.round(Number(position)) - 1;
  if (!(i >= 0 && i < l.length)) return 0;
  return isFinite(l[i]) ? l[i] : 0;
}

// Divide by zero returns the left side untouched rather than Infinity or NaN:
// graphSetVar would collapse either to 0, silently wiping a number the mod had
// been building up, which is a far worse surprise than "that step did nothing".
function graphApplyMath(a, op, b) {
  switch (op) {
    case 'set to':      return b;
    case 'add':         return a + b;
    case 'subtract':    return a - b;
    case 'multiply by': return a * b;
    case 'divide by':   return b === 0 ? a : a / b;
    case 'smallest of': return Math.min(a, b);
    case 'largest of':  return Math.max(a, b);
    default:            return a;
  }
}

function graphTestCondition(node, ctx) {
  const fn = GRAPH_CONDS[node.type];
  if (!fn) return false;
  try { return !!fn(node.params, ctx); }
  catch (e) { console.warn('Voxeria: mod condition failed', node.type, e); return false; }
}

// Shared by changeItems and changeInvolvedItem, which differ only in where
// the block id comes from (a picker vs ctx.block) — the give/take mechanics
// underneath are identical either way.
function graphGiveOrTake(how, block, n) {
  if (!blockNames[block]) return;
  if (how === 'Give') {
    addToInventory(block, n);
  } else {
    let left = n;
    for (let i = 0; i < inventory.length && left > 0; i++) {
      const it = inventory[i];
      if (!it || it.block !== block) continue;
      const take = Math.min(it.count, left);
      it.count -= take;
      left -= take;
      if (it.count <= 0) inventory[i] = null;
    }
  }
  drawHotbar();
}

const GRAPH_ACTIONS = {
  changeItems(p) { graphGiveOrTake(p.how, p.block, graphResolveInt(p.count, 1, 64)); },
  changeInvolvedItem(p, ctx) {
    if (!ctx) return;
    graphGiveOrTake(p.how, ctx.block, graphResolveInt(p.count, 1, 64));
  },
  showText(p) {
    // The number slot resolves to null when it is set to "nothing", which is
    // how one block covers text alone, a number alone, and both together.
    const n = graphResolveValue(p.number);
    let out = graphResolveText(p.text);
    if (n !== null) {
      // Whole numbers read as "3", not "3.0": the store keeps one decimal so
      // half-steps are possible, but most mods only ever count whole things.
      const shown = Number.isInteger(n) ? String(n) : n.toFixed(1);
      out = out ? out + ' ' + shown : shown;
    }
    if (!out) return;
    if (p.where === 'floating on the player') {
      addJuiceText(player.x + player.w / 2, player.y, out, GRAPH_COLORS[p.color] || '#ffffff');
    } else {
      showNotification(out);
    }
  },
  changeHealth(p) {
    const n = graphResolveInt(p.amount, 1, 12);
    if (p.how === 'Hurt') { takeDamage(n); return; }
    player.health = Math.min(maxHealth, player.health + n);
    drawHealth();
  },
  // One writer for every player number. The range comes from the same table the
  // editor's input uses, so a saved number driving a stat lands inside what that
  // stat allows instead of wherever the mod's own arithmetic wandered off to.
  setStat(p) {
    const def = GRAPH_PLAYER_STATS[p.stat];
    if (!def) return;
    const v = graphResolveNum(p.to, def.min, def.max);
    switch (p.stat) {
      case 'move speed':      graphSpeedMult = v; break;
      case 'jump power':      graphJumpMult = v; break;
      case 'gravity':         graphGravityMult = v; break;
      case 'max hearts':      graphMaxHealth = Math.round(v) * 2; break;
      case 'reach bonus':     graphReachBonus = Math.round(v); break;
      case 'air jumps':       graphMaxJumps = Math.round(v); break;
      case 'mining yield':    graphYieldMult = Math.round(v); break;
      case 'damage taken':    graphDamageScale = v; break;
      // 0 turns it back off, which is the thing the old one-way switches could
      // not do at all.
      case '3x3 mining':      graphBigPickaxe = v >= 0.5; break;
      case 'hazard immunity': graphHazardImmune = v >= 0.5; break;
      default: return;
    }
    applyActiveRules();
  },
  movePlayer(p) {
    const dx = graphResolveInt(p.dx, -40, 40);
    const dy = graphResolveInt(p.dy, -40, 40);
    if (p.how === 'launch with force') {
      // dy is up-negative like the rest of the engine, so "up / down = -8"
      // launches upward and a positive value slams the player down.
      player.vx = dx;
      player.vy = dy;
      player.onGround = false;
      return;
    }
    const t = graphPlayerTile();
    let tx = t.x + dx, ty = t.y + dy;
    // Landing inside rock would either suffocate the player or let the
    // collision pass shove them somewhere arbitrary, so climb to the nearest
    // free spot above the requested one. If there is none, the jump is skipped
    // rather than performed badly.
    let found = false;
    for (let i = 0; i < 12 && ty - i >= 0; i++) {
      if (graphTileIsFree(tx, ty - i)) { ty -= i; found = true; break; }
    }
    if (!found) return;
    player.x = tx * TILE + (TILE - player.w) / 2;
    player.y = ty * TILE;
    player.vx = 0; player.vy = 0;
    spawnJuiceBurst(player.x + player.w / 2, player.y + player.h / 2, '#c9a6ff', 16, 5);
  },
  setWorld(p) {
    if (p.what === 'weather') {
      weather.type = p.value;
      weather.targetIntensity = p.value === 'clear' ? 0 : 1.0;
      // Push the change out past updateWeather's own countdown so it isn't
      // rerolled a frame later.
      weather.timer = 0;
      weather.nextChange = 400 + Math.random() * 800;
      return;
    }
    dayTime = (GRAPH_TIME_AT[p.value] || 0) * DAY_LENGTH;
  },
  emitParticles(p, ctx) {
    // "the block involved" is the tile the event happened on, the same rule
    // every other block-flavoured action follows (see graphTargetTile).
    let x, y;
    if (p.at === 'the block involved') {
      const t = graphTargetTile(ctx);
      x = t.x * TILE + TILE / 2; y = t.y * TILE + TILE / 2;
    } else {
      x = player.x + player.w / 2; y = player.y + player.h / 2;
    }
    spawnJuiceBurst(x, y, GRAPH_COLORS[p.color] || '#ffffff',
                    graphResolveInt(p.amount, 1, 60), graphResolveInt(p.power, 1, 14));
  },
  shake(p) { screenShake = Math.max(screenShake, graphResolveInt(p.power, 2, 30)); },
  spawnCreature(p) {
    const def = customCreatureTypes[p.creature] || customCreatureTypes[0];
    if (!def || currentDim !== 'OVERWORLD') return;
    const px = Math.floor(player.x / TILE);
    for (let d = 3; d < 14; d++) {
      for (const s of [1, -1]) {
        const wx = px + s * d;
        const sy = canSpawnCustomCreatureAt(wx, def);
        if (sy !== null) { animals.push(createCustomCreature(def, wx, sy)); return; }
      }
    }
  },
  // Mutates the live definition registerCustomCreaturePieces() already built
  // for this creature — the same object spawnCustomCreatureNearPlayer() and
  // every already-roaming instance of it read from — rather than a separate
  // override table. Safe because piece registration always runs before a
  // mod's own onWorldStart chain (see the note on registerLoadoutPieces in
  // applySeedFromUI), so there is always something here to mutate, and because
  // that registration rebuilds this object fresh on every world load, so
  // nothing from a previous session's mod can leak into this one.
  setCreatureBehavior(p) {
    const def = customCreatureTypes[p.creature];
    if (!def) return;
    def.move = p.move;
    def.size = graphResolveInt(p.size, 8, 36);
    def.speed = graphResolveNum(p.speed, 0.2, 1.6);
    def.rarity = graphResolveInt(p.rarity, 1, 8);
    def.biome = p.biome;
    def.traits = { glows: p.traits === 'glows' || p.traits === 'both', trail: p.traits === 'trail' || p.traits === 'both' };
  },
  // Mutates the same live definition setCreatureBehavior does, and for the
  // same reasons (see its note). One difference worth knowing: creatures
  // ALREADY roaming keep the health they spawned with, because an instance
  // copies `health` once at birth. Retuning mid-fight therefore changes what
  // spawns next rather than healing or executing whatever is on screen, which
  // is the only behaviour that does not produce a creature at 3 of 6 health
  // suddenly sitting at 3 of 40.
  setCreatureCombat(p) {
    const def = customCreatureTypes[p.creature];
    if (!def) return;
    def.health = graphResolveInt(p.health, 0, 40);
    def.damage = graphResolveInt(p.damage, 1, 12);
    def.attack = p.attack;
    def.aggro  = graphResolveInt(p.aggro, 0, 24);
  },
  playSound(p) { playSound(p.sound); },
  // The one writer for saved numbers. Every old way of filling one (set, add,
  // read a game value, maths against a literal, maths against another name) is
  // this single line with a different op and a different slot source.
  changeVar(p) { graphSetVar(p.name, graphApplyMath(graphGetVar(p.name), p.op, graphResolveValue(p.to))); },
  // graphSetText clamps the result, so joining in a loop walks up to the
  // ceiling and stops there rather than growing without limit — the same
  // shape graphClampNum gives "add 999" on a number.
  changeText(p) {
    const cur = graphGetText(p.name);
    const add = graphResolveText(p.to);
    if (p.op === 'join with') graphSetText(p.name, cur + add);
    else if (p.op === 'join with a space') graphSetText(p.name, cur ? cur + ' ' + add : add);
    else graphSetText(p.name, add);
  },
  // Every branch is a no-op rather than an error when it cannot apply (adding
  // to a full list, removing from an empty one, naming a position past the
  // end): a mod is shared code, and "that step did nothing" is a far better
  // failure than a chain that stops halfway through.
  changeList(p) {
    const list = graphGetList(p.list);
    const pos = graphResolveInt(p.position, 1, GRAPH_MAX_LIST) || 1;
    switch (p.how) {
      case 'add to the end':
        if (list.length < GRAPH_MAX_LIST) list.push(graphClampNum(graphResolveValue(p.value)));
        break;
      case 'set the item at': {
        const i = pos - 1;
        if (i < 0 || i >= GRAPH_MAX_LIST) break;
        // Writing past the end grows the list with zeros up to that spot, so
        // "set position 5" on an empty list gives a list of five rather than
        // silently doing nothing. That is what makes a list usable as a fixed
        // set of slots (four team scores, say) without filling it first.
        while (list.length <= i) list.push(0);
        list[i] = graphClampNum(graphResolveValue(p.value));
        break;
      }
      case 'remove the item at':
        if (pos - 1 < list.length) list.splice(pos - 1, 1);
        break;
      case 'remove the last':
        list.pop();
        break;
      case 'clear it':
        list.length = 0;
        break;
    }
  },
  // Never reached: graphWalk intercepts a wait before the action table is
  // consulted. Present so the completeness check and anything that walks
  // GRAPH_ACTIONS still finds every action type.
  wait() {},
  // Never reached either, for the same reason: graphWalk drives a loop's two
  // outputs itself and never looks it up here.
  repeatTimes() {},
  repeatWhile() {},
  forEachItem() {},
  forEachInList() {},

  // The two overrule actions write into the context the chain is walking, and
  // the hook that started the chain reads it back afterwards. Outside a
  // "Before …" chain there is no such reader, so these are quietly inert
  // rather than an error — a mod author dragging one into the wrong chain gets
  // "nothing happens", not a broken mod.
  preventIt(p, ctx)      { if (ctx) ctx.cancel = true; },
  setEventAmount(p, ctx) { if (ctx) ctx.amount = graphResolveInt(p.amount, 0, 24); },
  // The same shape as preventIt/setEventAmount, one level of indirection
  // deeper: writes into the ctx THIS call is holding, which is a fresh object
  // callSignal built (see below) — not the ctx of whatever chain called the
  // signal in the first place. A signal cannot reach back and cancel or
  // resize its caller's outer event; it can only hand back the one number it
  // was asked for.
  returnValue(p, ctx) { if (ctx) ctx.result = graphResolveValue(p.value); },

  remapDrop(p) {
    if (!blockNames[p.from] || !blockNames[p.to]) return;
    graphDropRemap[p.from] = p.to;
  },
  // See the note on graphBlockHardness above: writes into the override layer,
  // never into BLOCK_HARDNESS/BLOCK_SOUND themselves.
  setBlockMining(p) {
    if (!blockNames[p.block]) return;
    graphBlockHardness[p.block] = graphResolveInt(p.hardness, 1, 8);
    graphBlockSoundFamily[p.block] = p.sound;
  },

  fillArea(p, ctx) {
    // AIR is a legitimate material here (that is what the old "Blast a hole"
    // became), so the guard allows it explicitly rather than through blockNames,
    // which has no entry for it.
    if (p.block !== BLOCKS.AIR && !blockNames[p.block]) return;
    const t = graphTargetTile(ctx);
    const w = graphResolveInt(p.w, 1, 9), h = graphResolveInt(p.h, 1, 9);
    // Centred on the target so a 3x3 wraps the tile the event happened on,
    // which is what "fill a box here" reads as. Odd and even sizes both work;
    // an even one simply sits one tile further right/down.
    const x0 = t.x - ((w / 2) | 0), y0 = t.y - ((h / 2) | 0);
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        // Same two exclusions blastArea makes, and for the same reasons:
        // BEDROCK is the world floor and a pocket run's walls, PORTAL is
        // session state the teleport code owns.
        const b = getBlock(x0 + dx, y0 + dy);
        if (b === BLOCKS.BEDROCK || b === BLOCKS.PORTAL) continue;
        setBlock(x0 + dx, y0 + dy, p.block);
      }
    }
  },

  // Queued, never delivered here: see the note on graphAnnounceQueue for why
  // the whole point is that the listeners do NOT run inside this chain. Over
  // the cap the announcement is dropped, which is the same "that step did
  // nothing" failure a full wait queue already has.
  announce(p) {
    if (graphAnnounceQueue.length >= GRAPH_MAX_ANNOUNCE) return;
    graphAnnounceQueue.push({ event: p.event, value: graphResolveValue(p.value) });
  },

  // Über der Zonen-Obergrenze wird eine NEUE Zone verworfen, eine bestehende
  // aber weiterhin verschoben: sonst könnte eine Regel, die ihre eigene Zone
  // jedes Mal neu setzt, sich selbst aussperren.
  setCountdown(p) {
    if (p.how === 'stop') { delete graphCountdowns[p.timer]; return; }
    // Über der Obergrenze wird ein NEUER Countdown verworfen, ein bestehender
    // aber weiterhin neu gestellt: sonst könnte eine Regel, die ihren eigenen
    // Countdown regelmässig erneuert, sich selbst aussperren.
    if (!graphCountdowns[p.timer] && Object.keys(graphCountdowns).length >= GRAPH_MAX_COUNTDOWNS) return;
    graphCountdowns[p.timer] = Date.now() + graphResolveInt(p.seconds, 1, 600) * 1000;
  },

  showDialog(p) {
    // MINDESTENS EIN KNOPF, immer. Ein Dialog ohne Knopf liesse sich nicht
    // schliessen, und bei "hold me still" waere der Spieler damit dauerhaft
    // festgehalten, ohne Ausweg. Das ist die eine Stelle, an der ein Mod den
    // Spieler wirklich aussperren koennte, deshalb wird hier notfalls ein
    // Knopf ergaenzt statt sich auf die Eingabe zu verlassen.
    const labels = [p.b1, p.b2, p.b3]
      .map(t => String(t == null ? '' : t).trim())
      .filter(Boolean)
      .slice(0, 3);
    if (!labels.length) labels.push('OK');
    graphOpenDialog(graphResolveText(p.title).trim() || 'Choose', labels,
                    p.freeze === 'hold me still', p.into);
  },

  setPanel(p) {
    // "hide" und "clear" legen NICHTS an. Ein Panel zu verstecken, das es gar
    // nicht gibt, soll nichts tun, statt eines der vier Plaetze zu verbrauchen.
    if (p.how !== 'show') {
      const ex = graphPanels[p.panel];
      if (!ex) return;
      if (p.how === 'hide') ex.shown = false;
      else ex.lines = {};
      graphRenderPanels();
      return;
    }
    const panel = graphGetPanel(p.panel);
    if (!panel) return;
    panel.where = p.where;
    panel.title = graphResolveText(p.title);
    panel.shown = true;
    graphRenderPanels();
  },

  panelLine(p) {
    const panel = graphGetPanel(p.panel);
    if (!panel) return;
    // Dieselbe Zusammensetzung wie bei showText, damit "Leben: 3" hier und dort
    // gleich zustande kommt: die Zahl faellt weg, wenn ihr Schlitz auf "nichts"
    // steht, und ganze Zahlen stehen als "3" da, nicht als "3.0".
    const n = graphResolveValue(p.number);
    let out = graphResolveText(p.text);
    if (n !== null) {
      const shown = Number.isInteger(n) ? String(n) : n.toFixed(1);
      out = out ? out + ' ' + shown : shown;
    }
    const line = Math.max(1, Math.min(GRAPH_MAX_PANEL_LINES, Math.round(Number(p.line) || 1)));
    // Eine leer geschriebene Zeile verschwindet, statt als leere Luecke stehen
    // zu bleiben. So raeumt eine Regel eine einzelne Zeile wieder ab, ohne dass
    // es dafuer eine eigene Karte braucht.
    if (out) panel.lines[line] = { text: out, color: p.color };
    else delete panel.lines[line];
    panel.shown = true;
    graphRenderPanels();
  },

  showBoard(p) {
    if (p.how === 'hide it') { graphHideBoard(); return; }
    // Ohne laufendes Match gibt es keine abgeglichenen Punkte, also auch nichts
    // zu zeigen. Still, nicht fehlerhaft: ein für die Arena gebauter Mod soll
    // in einer Exploration-Welt trotzdem laden.
    if (!window.VxArena || !VxArena.board) return;
    graphRenderBoard(p.how, p.title, VxArena.board());
  },

  markZone(p, ctx) {
    if (!graphZones[p.zone] && Object.keys(graphZones).length >= GRAPH_MAX_ZONES) return;
    const t = graphTargetTile(ctx);
    const w = graphResolveInt(p.w, 1, 64), h = graphResolveInt(p.h, 1, 64);
    const x0 = t.x - ((w / 2) | 0), y0 = t.y - ((h / 2) | 0);
    graphZones[p.zone] = { x0, y0, x1: x0 + w - 1, y1: y0 + h - 1 };
    // Der bisherige Stand wird verworfen, nicht behalten: wer nach dem
    // Verschieben schon drinsteht, soll als "betritt sie" gelten und nicht
    // stumm bleiben, weil er zufällig auch vorher drin war.
    delete graphZoneState[p.zone];
  },

  // Zufällige Versuche statt eines Rasterdurchlaufs: eine 64x64-Zone hätte bis
  // zu 4096 Felder, und die allermeisten Zonen finden schon im ersten oder
  // zweiten Griff einen freien Platz. Bleibt die Zone leer oder ist sie
  // komplett zugebaut, tut die Karte einfach nichts -- kein Absturz in eine
  // Wand ist besser als ein Absturz IN die Wand.
  teleportToZone(p) {
    const z = graphZones[p.zone];
    if (!z) return;
    const w = z.x1 - z.x0 + 1, h = z.y1 - z.y0 + 1;
    for (let i = 0; i < 20; i++) {
      const tx = z.x0 + Math.floor(Math.random() * w);
      const ty = z.y0 + Math.floor(Math.random() * h);
      if (!graphTileIsFree(tx, ty)) continue;
      player.x = tx * TILE + (TILE - player.w) / 2;
      player.y = ty * TILE;
      player.vx = 0; player.vy = 0;
      return;
    }
  },

  callSignal(p, ctx) {
    if (graphSignalDepth >= GRAPH_MAX_SIGNAL_DEPTH) {
      console.warn('Voxeria: mod signal "' + p.signal + '" nested too deep — stopped.');
      return;
    }
    graphSignalDepth++;
    // A fresh object, not a mutation of `ctx`: the called chain gets its own
    // `result` to write into (via "Return a value") with no leftover value
    // inherited from whatever `ctx.result` may already have held — otherwise
    // a nested call whose own callee never returns anything would still read
    // back its OUTER caller's stale result instead of "nothing came back".
    const sigCtx = { ...ctx, signal: p.signal,
                     arg:  graphResolveValue(p.arg),
                     arg2: graphResolveValue(p.arg2),
                     arg3: graphResolveValue(p.arg3),
                     result: undefined };
    // Restored in `finally` so an action that throws inside the called chain
    // can't leak the depth upward and permanently wedge every later call.
    try { fireGraphEvent('onSignal', sigCtx); }
    finally { graphSignalDepth--; }
    if (sigCtx.result !== undefined) graphSetVar(p.result, sigCtx.result);
  },

  // ── Arena ──
  // Both silently do nothing outside a running match. VxArena.addScore already
  // enforces that itself, which is where the rule belongs: the score is its
  // state, not this table's, and a second check here could only ever drift
  // away from the first one.
  addScore(p) {
    if (window.VxArena) window.VxArena.addScore(graphResolveInt(p.points, -99, 99));
  },
  endRound() {
    if (window.VxArena) window.VxArena.endMatch('Round ended by a rule');
  },
  // Unlike addScore/endRound this is allowed OUTSIDE a running match on
  // purpose: teams are picked during the build phase, before the round starts,
  // which is the one moment a "join the red side" button has to work.
  // VxArena.setTeam is the only writer, so the value still travels to everyone
  // else through the same score document it always did.
  setTeam(p) {
    if (window.VxArena && window.VxArena.setTeam) window.VxArena.setTeam(graphResolveInt(p.team, 0, 8));
  }
};

// The one entry point the game calls. `type` is an event node type; only
// nodes of that type whose own parameters match the context are started.
// What each name the engine still calls now means in the collapsed catalog:
// the node type to look for, and the parameter that has to match for a node to
// count. Keeping this table here rather than renaming the call sites means the
// eleven `fireGraphEvent('onJump')`-style lines scattered through the engine and
// dimension files stay exactly as they are, including any in files this project
// marks "nicht anfassen".
const GRAPH_EVENT_ALIASES = {
  onTouchBlock: { type: 'onBlock',  key: 'how', value: 'touches' },
  onMineBlock:  { type: 'onBlock',  key: 'how', value: 'mines' },
  onPlaceBlock: { type: 'onBlock',  key: 'how', value: 'places' },
  onJump:       { type: 'onPlayer', key: 'how', value: 'jumps' },
  onHurt:       { type: 'onPlayer', key: 'how', value: 'gets hurt' },
  onDeath:      { type: 'onPlayer', key: 'how', value: 'dies' },
  onNightfall:  { type: 'onDayPhase', key: 'phase', value: 'night falls' },
  onDaybreak:   { type: 'onDayPhase', key: 'phase', value: 'day breaks' }
};

function fireGraphEvent(type, ctx) {
  if (!activeGraphs.length) return;
  ctx = ctx || {};
  const alias = GRAPH_EVENT_ALIASES[type];
  const wanted = alias ? alias.type : type;
  for (const g of activeGraphs) {
    for (const node of g.nodes) {
      if (node.type !== wanted) continue;
      // A merged event only fires for the verb its dropdown is set to.
      if (alias && node.params[alias.key] !== alias.value) continue;
      // The block-flavoured events only fire for the block they name.
      if ((wanted === 'onBlock' || type === 'onBeforeMine' || type === 'onPickup') &&
          node.params.block !== ctx.block) continue;
      // Same idea for dimension entry: only the dimension the node picked.
      if (type === 'onEnterDim' && node.params.dim !== ctx.dim) continue;
      // And for creatures: only the verb the node picked. No creature filter
      // here on purpose — see the note on onCreature in the catalog.
      if (wanted === 'onCreature' && node.params.how !== ctx.how) continue;
      // And for a named signal: only the "When called by name" node whose
      // name matches what "Call by name" asked for. If the call passed a
      // value, it lands in the saved number this node names BEFORE its chain
      // runs, so "receiving ARG" already holds it from the very first node.
      // A call that passed nothing (ctx.arg is null, see graphResolveValue)
      // leaves whatever ARG already held untouched rather than zeroing it.
      // Each of the three is written only if the call actually passed one, so
      // the slots a call leaves at "nothing" leave the matching name holding
      // whatever it already held rather than being zeroed.
      // Only the listeners for this announcement, and only those. The value is
      // written before the chain starts, the same way a signal's is, so
      // "value into INFO" already holds it at the very first node.
      if (type === 'onAnnounced') {
        if (node.params.event !== ctx.event) continue;
        if (ctx.value !== null && ctx.value !== undefined) graphSetVar(node.params.valueVar, ctx.value);
      }
      // Nur die Karte, die diese Zone benennt.
      if ((type === 'onPlayerEnterZone' || type === 'onPlayerLeaveZone') && node.params.zone !== ctx.zone) continue;
      // Und nur die, die genau diesen Countdown benennt.
      if (type === 'onCountdownEnd' && node.params.timer !== ctx.timer) continue;
      // Der Knopf wird ueber die Aufschrift getroffen. Gross- und Kleinschreibung
      // sowie Leerraum aussen bleiben unberuecksichtigt: die Aufschrift wird an
      // zwei Stellen von Hand getippt (im Dialog und in der Regel), und ein
      // stiller Fehlschlag wegen eines Grossbuchstabens waere sehr schwer zu
      // finden.
      if (type === 'onButtonPress' &&
          String(node.params.button).trim().toLowerCase() !== String(ctx.button).trim().toLowerCase()) continue;
      // Der Durchlauf feuert bis zur weitesten erlaubten Reichweite; welche
      // Karte tatsächlich gemeint ist, entscheidet sich hier an ihrem eigenen
      // Wert. So kann eine Regel auf 2 Feldern und eine andere auf 6 hören,
      // ohne dass der Durchlauf zweimal laufen müsste.
      if (type === 'onPlayerTouch' && ctx.touchDist > node.params.range) continue;
      if (type === 'onSignal') {
        if (node.params.signal !== ctx.signal) continue;
        if (ctx.arg  !== null && ctx.arg  !== undefined) graphSetVar(node.params.argVar,  ctx.arg);
        if (ctx.arg2 !== null && ctx.arg2 !== undefined) graphSetVar(node.params.argVar2, ctx.arg2);
        if (ctx.arg3 !== null && ctx.arg3 !== undefined) graphSetVar(node.params.argVar3, ctx.arg3);
      }
      graphRunChain(g, node, ctx);
    }
  }
}
window.fireGraphEvent = fireGraphEvent;

// Same thing, but for the four wrappers below: bounded against a chain whose
// own actions trip the hook that started it.
function fireHookEvent(type, ctx) {
  if (graphHookDepth >= GRAPH_MAX_HOOK_DEPTH) return ctx;
  graphHookDepth++;
  try { fireGraphEvent(type, ctx); }
  finally { graphHookDepth--; }
  return ctx;
}

// =========================================================
// ENGINE HOOKS — where a mod stops merely reacting and starts overruling.
//
// The events above this point are pushed IN by the engine at points it chose:
// by the time a mod hears about them the game has already acted. The three
// "Before …" events cannot work that way — they have to run while the outcome
// is still open. So instead of new call sites, this wraps four functions the
// engine already exports and re-publishes the wrapped versions.
//
// WHY WRAPPING RATHER THAN EDITING THE ENGINE: every .js file here is a
// classic script sharing one global scope (see DATEISTRUKTUR.md), so a
// top-level `function takeDamage()` in voxeria-engine.js is a property of the
// global object. Reassigning it means every existing call site in the engine
// resolves to the wrapper, with no edit to a file the project marks
// "nicht anfassen". Load order makes it safe: voxeria-modding.js runs after
// voxeria-engine.js, so all four originals exist by the time this runs.
//
// The wrappers stay cheap when nothing is modded — fireGraphEvent returns
// immediately with no active graphs, and both lookup tables are empty objects.
// =========================================================
let graphHooksInstalled = false;
function installGraphHooks() {
  if (graphHooksInstalled) return;
  graphHooksInstalled = true;

  // ── Bewegungssperre waehrend eines Dialogs ──
  // Umhuellt statt in die Engine geschrieben, genau wie die drei Hooks
  // darunter. Der bestehende goldFrozenTimer waere der naheliegende Weg
  // gewesen, zeichnet aber eine goldene Ummantelung um den Spieler (siehe
  // drawPlayer) und wuerde einen Dialog wie einen Gold-Schleim-Treffer
  // aussehen lassen.
  //
  // Unterdrueckt werden nur die BEWEGUNGSTASTEN, nicht der ganze Aufruf: die
  // Physik laeuft weiter, damit der Spieler stehenbleibt statt in der Luft zu
  // haengen. Der Auslauf im Original (`player.vx *= 0.7^dt`) bremst ihn dabei
  // weich ab, statt ihn hart anzuhalten.
  if (typeof updatePlayer === 'function') {
    const originalUpdate = updatePlayer;
    window.updatePlayer = function (dt) {
      if (!graphDialog || !graphDialog.freeze || typeof keys === 'undefined') {
        return originalUpdate(dt);
      }
      // Die Belegung wird bei jedem Aufruf frisch gelesen, weil sie umlegbar
      // ist und eine einmal gemerkte Liste nach dem Umlegen die falschen
      // Tasten sperren wuerde.
      const bind = (typeof keyBinds !== 'undefined') ? keyBinds : {};
      const held = [bind.left, bind.right, bind.jump, 'arrowleft', 'arrowright', 'arrowup', 'w']
        .filter(Boolean);
      const was = {};
      for (const k of held) { was[k] = keys[k]; keys[k] = false; }
      try { return originalUpdate(dt); }
      finally { for (const k of held) keys[k] = was[k]; }
    };
  }

  // ── Damage: cancellable, and re-scalable ──
  if (typeof takeDamage === 'function') {
    const original = takeDamage;
    window.takeDamage = function (amount) {
      // The engine drops any hit landing inside the invulnerability window.
      // Checking it here too means "Before the player is hurt" fires once per
      // hit that will actually land, instead of once per frame of contact.
      if (typeof damageCooldown === 'number' && damageCooldown > 0) return original(amount);
      const shown = Math.max(0, Math.round(amount));
      const ctx = fireHookEvent('onBeforeHurt', { amount: shown, cancel: false });
      if (ctx.cancel) return;
      // Only take the mod's number if it actually replaced one; otherwise pass
      // `amount` through untouched. Handing back `shown` unconditionally would
      // round every hit twice — once here and once inside the engine, after the
      // armor multiplier — which can land a half-point off on a fractional hit.
      let next = ctx.amount === shown ? amount : Number(ctx.amount);
      if (!isFinite(next) || next < 0) next = amount;
      next *= graphDamageScale;
      // Stopped here rather than passed on, because the engine floors damage
      // at 1: without this, "scale damage by 0" would still take half a heart.
      if (next <= 0) return;
      return original(next);
    };
  }

  // ── Mining: cancellable, and the gate the drop remap hangs off ──
  if (typeof breakSingleBlock === 'function') {
    const original = breakSingleBlock;
    window.breakSingleBlock = function (wx, wy, isSuper) {
      const b = getBlock(wx, wy);
      // The same two gates the engine's own breakSingleBlock opens with, applied
      // BEFORE the event rather than after. Without them "Before a block breaks"
      // fires for every swing that can never break anything — one at bedrock, or
      // at a tile out of reach — and a chain hanging off it would pay out on each
      // of those. Verified: both cases fired before this guard existed.
      const unbreakable = b === BLOCKS.AIR || b === BLOCKS.BEDROCK || b === BLOCKS.PORTAL ||
                          b === BLOCKS.WATER || b === BLOCKS.DEEP_WATER;
      if (unbreakable || !isInRange(wx, wy)) return original(wx, wy, isSuper);
      const ctx = fireHookEvent('onBeforeMine', { block: b, x: wx, y: wy, cancel: false });
      if (ctx.cancel) return;
      graphMining = true;
      try { return original(wx, wy, isSuper); }
      finally { graphMining = false; }
    };
  }

  // ── What a block actually yields ──
  // Both the inventory add and the flying pickup are remapped, so the two
  // agree. The engine's own "+2 Stone" floating text is not: it is built from
  // a local inside breakSingleBlock that nothing out here can reach. It names
  // the block that was MINED, which is still true — just not what lands in
  // the bag once a mod has rewritten the drop.
  if (typeof addToInventory === 'function') {
    const original = addToInventory;
    window.addToInventory = function (block, count) {
      const b = graphMining && graphDropRemap[block] !== undefined ? graphDropRemap[block] : block;
      const result = original(b, count);
      // Only on a real add. addToInventory returns false when there is no room,
      // and a full bag firing "When the player picks up" would let a mod pay out
      // for items that never arrived.
      if (result) fireHookEvent('onPickup', { block: b });
      return result;
    };
  }
  if (typeof spawnItemDrop === 'function') {
    const original = spawnItemDrop;
    window.spawnItemDrop = function (wx, wy, block) {
      const b = graphMining && graphDropRemap[block] !== undefined ? graphDropRemap[block] : block;
      return original(wx, wy, b);
    };
  }
}

// Called every frame from the game loop: drives onTimer countdowns and the
// enter-detection for onTouchBlock.
function updateGraphRuntime(dt) {
  // Chains parked by a "Wait" block. Ticked BEFORE the early return below:
  // a parked chain has to finish on its own terms, and tying that to whether
  // any graph is currently active would make the resume depend on an invariant
  // held somewhere else entirely. Costs nothing while the list is empty.
  // Walked back to front so an entry can be removed in place, and resumed only
  // once it is off the list, so a chain that waits again pushes a fresh entry
  // instead of fighting this loop.
  for (let i = graphPending.length - 1; i >= 0; i--) {
    const entry = graphPending[i];
    entry.left -= dt;
    if (entry.left > 0) continue;
    graphPending.splice(i, 1);
    try { graphResumeChain(entry); }
    catch (e) { console.warn('Voxeria: mod chain failed to resume', e); }
  }

  // Announcements queued since the last frame. The whole batch is taken and the
  // queue replaced before any listener runs, so an announcement made BY a
  // listener is delivered next frame instead of extending this pass. That is
  // what bounds a chain reaction without a depth counter: each round of it
  // costs one frame, and the queue cap bounds how wide one round can get.
  if (graphAnnounceQueue.length) {
    const batch = graphAnnounceQueue;
    graphAnnounceQueue = [];
    for (const item of batch) {
      try { fireGraphEvent('onAnnounced', { event: item.event, value: item.value }); }
      catch (e) { console.warn('Voxeria: announcement failed', item.event, e); }
    }
  }

  if (!activeGraphs.length) return;

  // Beitritt, Weggang, Zonen und Berührung. Erst hier, nach dem frühen
  // Ausstieg: ohne laufende Mods gibt es niemanden, der zuhören könnte, und
  // dann muss auch nichts verglichen werden.
  graphSyncPresence();
  graphTickCountdowns();

  for (const g of activeGraphs) {
    for (const node of g.nodes) {
      if (node.type !== 'onTimer') continue;
      const key = g.name + '|' + node.id;
      // dt is in frame units (see gameLoop), so 60 of them is one second.
      const period = node.params.seconds * 60;
      graphTimers[key] = (graphTimers[key] || 0) + dt;
      if (graphTimers[key] >= period) {
        graphTimers[key] = 0;
        graphRunChain(g, node, {});
      }
    }
  }

  // Which blocks is the player's body overlapping right now?
  const now = new Set();
  const x0 = Math.floor(player.x / TILE), x1 = Math.floor((player.x + player.w - 0.001) / TILE);
  const y0 = Math.floor(player.y / TILE), y1 = Math.floor((player.y + player.h - 0.001) / TILE);
  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = y0; ty <= y1; ty++) {
      const b = getBlock(tx, ty);
      if (b && b !== BLOCKS.AIR) now.add(b);
    }
  }
  // Also the block being stood on — the one players actually mean by "touch".
  const under = getBlock(Math.floor((player.x + player.w / 2) / TILE), Math.floor((player.y + player.h + 1) / TILE));
  if (under && under !== BLOCKS.AIR) now.add(under);

  for (const b of now) if (!graphTouching.has(b)) fireGraphEvent('onTouchBlock', { block: b });
  graphTouching = now;
}

// One entry point for "apply this exact set of pieces", used by the loadout
// path. Each kind picks out the codes it understands and ignores the rest.
function registerLoadoutPieces(pieceCodes) {
  registerCustomBlockPieces(pieceCodes);
  registerCustomCreaturePieces(pieceCodes);
  registerCustomGraphPieces(pieceCodes);
}

// What the designers call after any library edit. Editing the library while
// playing someone else's loadout must not quietly swap that world's pieces
// out from under it, so an active loadout always wins.
function reapplyCustomPieces() {
  registerLoadoutPieces(activeLoadoutPieceCodes || undefined);
  // Player-stat rules take hold immediately, so toggling one in the designer
  // is visible without starting a new world. Block/terrain rules still need a
  // fresh world, since existing chunks are already generated.
  if (typeof player !== 'undefined') applyActiveRules();
}
// Kept as the old name a few call sites still use.
function reapplyCustomBlockPieces() { reapplyCustomPieces(); }

function showModBanner(mod) {
  const el = document.getElementById('mod-banner');
  if (!el) return;
  el.textContent = "🧩 Mod active: " + mod.name + (mod.author ? " by " + mod.author : "");
  el.classList.add('visible');
}
function hideModBanner() {
  const el = document.getElementById('mod-banner');
  if (el) el.classList.remove('visible');
}

// =========================================================
// MODE GATE — the creator tools belong to Exploration, not to Normal.
//
// The rule itself lives with the modes in voxeria-menu-worlds.js (see MODES);
// this only asks. Hiding the menu buttons is what a player sees, but a button
// is not the only way in — the modding tip's link opens the builder directly,
// and a designer can be reached from the new-world panel — so every toggle
// asks here before it opens anything.
//
// Checked at call time, never at load time: voxeria-menu-worlds.js is loaded
// AFTER this file, so window.vxStudioAllowed does not exist yet while this is
// being evaluated. A missing gate means "allowed", so the designers still work
// if this file is ever used without the menu layer.
// =========================================================
function vxCreatorAllowed() {
  return typeof window.vxStudioAllowed !== 'function' || window.vxStudioAllowed();
}
function vxCreatorDenied() {
  showNotification('🔒 The creator tools are part of Exploration worlds. Normal is a fixed run.');
}
// Guards the OPENING of a modal only. A modal that is already open must always
// be closeable, or a mode change with one on screen would trap the player
// behind it.
function vxCreatorBlocks(modalId) {
  const modal = document.getElementById(modalId);
  const opening = !modal || !modal.classList.contains('open');
  if (opening && !vxCreatorAllowed()) { vxCreatorDenied(); return true; }
  return false;
}

// =========================================================
// F10 -- random mod code. Every MOD_FIELDS entry gets a random raw value
// inside its own bit width and is decoded straight back through
// modRawToField(), the exact same clamp a hand-typed or corrupt code goes
// through — so unlike guessing a code string, this can never land on
// something the game would have to reject or clamp later.
//
// Actually LOADS, not just generates: dropping the code into #seed-input
// and calling applySeedFromUI() is exactly what happens when a player
// pastes a mod code there by hand (see applySeedFromUI's isModCode branch)
// -- reusing that path is what makes this a mod that really runs (creatures
// spawn, gravity/terrain/weather change, the reskin applies) instead of just
// a string that happens to decode cleanly.
// =========================================================
function generateRandomModCode() {
  if (!vxCreatorAllowed()) { vxCreatorDenied(); return; }
  const mod = { name: 'Random Mod', visual: {}, behavior: {}, dim: {}, world: {}, perks: {} };
  for (const f of MOD_FIELDS) {
    const raw = Math.floor(Math.random() * (1 << f.bits));
    const v = modRawToField(f, raw);
    if (f.k === '__flags') mod[f.g] = v; else mod[f.g][f.k] = v;
  }
  const code = encodeModCode2(mod);
  const seedInput = document.getElementById('seed-input');
  if (seedInput) seedInput.value = code;
  applySeedFromUI();
  copyTextWithFallback(code, '🎲 Random mod loaded — code copied: ' + code);
}
window.generateRandomModCode = generateRandomModCode;

// =========================================================
// F8 -- COMMAND CONSOLE (Exploration mode only)
// A handful of debug commands, not a devtools replacement: every one of them
// just calls something the game already exposes (inventory, player state,
// the day/night clock) instead of reaching into anything new. Typed with a
// leading '*' so a command can never be confused with, say, a seed field.
// =========================================================
let vxConsoleOpen = false;
function toggleCommandConsole() {
  if (!vxConsoleOpen && !vxCreatorAllowed()) { vxCreatorDenied(); return; }
  vxConsoleOpen = !vxConsoleOpen;
  const el = document.getElementById('vx-console');
  const input = document.getElementById('vx-console-input');
  if (el) el.classList.toggle('open', vxConsoleOpen);
  if (vxConsoleOpen) {
    if (input) {
      input.value = '*';
      // Focusing synchronously, the same frame the 'open' class is applied,
      // can lose the click/keydown that triggered this on some browsers —
      // the modal-open dance elsewhere in this file doesn't hit that because
      // it doesn't focus anything. One rAF is enough to dodge it.
      requestAnimationFrame(() => { input.focus(); input.setSelectionRange(1, 1); });
    }
  } else if (input) {
    input.blur();
  }
}
// Always safe to call regardless of mode or gating — a console left open
// must always be closeable, same reasoning as vxCreatorBlocks() above for
// the creator modals.
function closeCommandConsole() {
  vxConsoleOpen = false;
  const el = document.getElementById('vx-console');
  const input = document.getElementById('vx-console-input');
  if (el) el.classList.remove('open');
  if (input) input.blur();
}

// Every entry's `run` only ever touches state the game already exposes and
// re-derives from (inventory, player, the day/night clock, the graph-mod
// multipliers applyActiveRules() reapplies from scratch every time it's
// called — see that function's own "safe to call again" comment). Nothing
// here is a new mechanic, just a shortcut to ones that already exist.
// F12's help panel (renderCommandHelp) reads `usage`/`desc` straight off
// this object, so it can never drift out of sync with what actually runs.
const VX_COMMANDS = {
  help: {
    usage: '*help', desc: 'List every command',
    run: () => showNotification('⌨️ ' + Object.keys(VX_COMMANDS).sort().map(c => '*' + c).join('  ') + '  — full list: F12'),
  },
  heal: {
    usage: '*heal', desc: 'Restore full health',
    run: () => {
      player.health = maxHealth;
      if (typeof drawHealth === 'function') drawHealth();
      showNotification('❤️ Healed to full');
    },
  },
  tp: {
    usage: '*tp <x> <y>', desc: 'Teleport to block coordinates',
    run: (args) => {
      const x = parseFloat(args[0]), y = parseFloat(args[1]);
      if (!isFinite(x) || !isFinite(y)) { showNotification('⌨️ Usage: *tp <x> <y>  (block coordinates)'); return; }
      player.x = x * TILE; player.y = y * TILE; player.vx = 0; player.vy = 0;
      // Snapped instead of left to the camera's own smoothing (see camX's
      // per-frame lerp in the game loop) — a debug teleport should cut, not pan.
      camX = player.x - (COLS >> 1) * TILE;
      camY = player.y - (ROWS >> 1) * TILE;
      showNotification('🧭 Teleported to ' + x + ', ' + y);
    },
  },
  give: {
    usage: '*give <block> [count]', desc: 'Add a block/item to your inventory',
    run: (args) => {
      const name = (args[0] || '').toUpperCase();
      const id = BLOCKS[name];
      if (id === undefined || NON_ITEM_BLOCK_IDS.has(id)) {
        showNotification('⌨️ Unknown block: ' + (args[0] || '?') + ' — try its name, e.g. *give wood 10');
        return;
      }
      const count = Math.max(1, Math.min(99, parseInt(args[1], 10) || 1));
      if (addToInventory(id, count)) {
        drawHotbar();
        showNotification('🎒 +' + count + ' ' + (blockNames[id] || name));
      }
    },
  },
  time: {
    usage: '*time day|night', desc: 'Force the day/night clock',
    run: (args) => {
      const phase = (args[0] || '').toLowerCase();
      // Midpoints of updateDayNightCycle()'s own day/night bands (t<0.5 day,
      // 0.56..0.94 night) rather than the boundary values, so this doesn't
      // land exactly on a dusk/dawn transition tick.
      if (phase === 'day') dayTime = DAY_LENGTH * 0.25;
      else if (phase === 'night') dayTime = DAY_LENGTH * 0.75;
      else { showNotification('⌨️ Usage: *time day|night'); return; }
      showNotification('🕐 Time set to ' + phase);
    },
  },
  weather: {
    usage: '*weather clear|storm', desc: 'Force the weather (overworld only)',
    run: (args) => {
      const type = (args[0] || '').toLowerCase();
      if (type !== 'clear' && type !== 'storm') { showNotification('⌨️ Usage: *weather clear|storm'); return; }
      // rain/snow are folded into 'clear' now (see updateWeather) — clear and
      // storm are the only two states that still do anything.
      weather.type = type;
      weather.targetIntensity = type === 'storm' ? 1.0 : 0;
      weather.timer = 0;
      showNotification('🌦️ Weather set to ' + type);
    },
  },
  despawn: {
    usage: '*despawn', desc: 'Clear every animal/creature on screen',
    run: () => {
      const n = animals.length;
      animals.length = 0;
      showNotification('🧹 Despawned ' + n + ' creature(s)');
    },
  },
  speed: {
    usage: '*speed <mult>', desc: 'Move-speed multiplier, e.g. *speed 2',
    run: (args) => {
      const v = parseFloat(args[0]);
      if (!isFinite(v) || v <= 0) { showNotification('⌨️ Usage: *speed <mult>  e.g. *speed 2'); return; }
      graphSpeedMult = v;
      applyActiveRules();
      showNotification('🏃 Speed ×' + v);
    },
  },
  gravity: {
    usage: '*gravity <mult>', desc: 'Gravity multiplier, e.g. *gravity 0.4 for low-g',
    run: (args) => {
      const v = parseFloat(args[0]);
      if (!isFinite(v) || v <= 0) { showNotification('⌨️ Usage: *gravity <mult>  e.g. *gravity 0.4'); return; }
      graphGravityMult = v;
      applyActiveRules();
      showNotification('🌗 Gravity ×' + v);
    },
  },
  jump: {
    usage: '*jump <n>', desc: 'Air jumps allowed, e.g. *jump 2 for a double jump',
    run: (args) => {
      const n = Math.max(1, Math.min(9, parseInt(args[0], 10) || 0));
      if (!n) { showNotification('⌨️ Usage: *jump <n>  e.g. *jump 2'); return; }
      graphMaxJumps = n;
      applyActiveRules();
      showNotification('🦘 ' + n + ' jump(s) allowed');
    },
  },
  reach: {
    usage: '*reach <blocks>', desc: 'Extra mining/placing reach',
    run: (args) => {
      const n = parseFloat(args[0]);
      if (!isFinite(n) || n < 0) { showNotification('⌨️ Usage: *reach <blocks>  e.g. *reach 3'); return; }
      graphReachBonus = n;
      applyActiveRules();
      showNotification('📏 Reach +' + n);
    },
  },
  pickaxe: {
    usage: '*pickaxe', desc: 'Toggle the instant-mine super pickaxe',
    run: () => {
      graphBigPickaxe = !graphBigPickaxe;
      applyActiveRules();
      showNotification(graphBigPickaxe ? '⛏️ Super pickaxe on' : '⛏️ Super pickaxe off');
    },
  },
  immune: {
    usage: '*immune', desc: 'Toggle hazard immunity (lava, fall damage, etc.)',
    run: () => {
      graphHazardImmune = !graphHazardImmune;
      applyActiveRules();
      showNotification(graphHazardImmune ? '🛡️ Hazard immunity on' : '🛡️ Hazard immunity off');
    },
  },
  reset: {
    usage: '*reset', desc: 'Undo every *speed/*gravity/*jump/*reach/*pickaxe/*immune buff',
    run: () => {
      graphSpeedMult = 1; graphGravityMult = 1; graphReachBonus = 0; graphMaxJumps = 1;
      graphJumpMult = 1; graphBigPickaxe = false; graphHazardImmune = false;
      applyActiveRules();
      showNotification('🔄 Console buffs reset');
    },
  },
  randommod: {
    usage: '*randommod', desc: 'Same as F10 — load a freshly rolled random mod',
    run: () => generateRandomModCode(),
  },
};

function runConsoleCommand() {
  const input = document.getElementById('vx-console-input');
  if (!input) return;
  const raw = input.value.trim();
  closeCommandConsole();
  if (!raw.startsWith('*')) { showNotification('⌨️ Commands start with * — try *help'); return; }
  const parts = raw.slice(1).trim().split(/\s+/).filter(Boolean);
  const name = (parts.shift() || '').toLowerCase();
  const cmd = VX_COMMANDS[name];
  if (!cmd) { showNotification('⌨️ Unknown command: *' + name + ' — try *help'); return; }
  try { cmd.run(parts); }
  catch (e) { console.error('Voxeria console command error:', e); showNotification('⚠️ *' + name + ' failed'); }
}

document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('vx-console-input');
  if (!input) return;
  input.addEventListener('keydown', (e) => {
    // Stops this from ever reaching the document-level keydown handler too —
    // that handler already bails out on an INPUT-focused activeElement (see
    // its `tag === 'INPUT'` guard), so this is defence in depth, not the
    // only thing standing between a command and the WASD movement handler.
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); runConsoleCommand(); }
    else if (e.key === 'Escape' || e.key === 'F8') { e.preventDefault(); closeCommandConsole(); }
  });
});
window.toggleCommandConsole = toggleCommandConsole;

// =========================================================
// F12 -- command reference panel. Pure readout, built from VX_COMMANDS
// itself (see its own comment above) so this can never list a command that
// doesn't exist or describe one wrong.
// =========================================================
let vxHelpOpen = false;
function toggleCommandHelp() {
  if (!vxHelpOpen && !vxCreatorAllowed()) { vxCreatorDenied(); return; }
  vxHelpOpen = !vxHelpOpen;
  const modal = document.getElementById('vx-help-modal');
  if (!modal) return;
  modal.classList.toggle('open', vxHelpOpen);
  if (vxHelpOpen) renderCommandHelp();
}
function renderCommandHelp() {
  const body = document.getElementById('vxh-body');
  if (!body) return;
  body.innerHTML = '';
  Object.keys(VX_COMMANDS).sort().forEach(name => {
    const cmd = VX_COMMANDS[name];
    const row = document.createElement('div');
    row.className = 'vxh-row';
    const usage = document.createElement('div');
    usage.className = 'vxh-usage';
    usage.textContent = cmd.usage;
    const desc = document.createElement('div');
    desc.className = 'vxh-desc';
    desc.textContent = cmd.desc;
    row.appendChild(usage);
    row.appendChild(desc);
    body.appendChild(row);
  });
}
window.toggleCommandHelp = toggleCommandHelp;

// Shuts any creator modal that is currently open. Guarding the doors is not
// enough on its own: a designer opened in an Exploration world stayed open
// straight through loading a Normal one, sitting fully usable on top of a mode
// that is not supposed to have it. Called from applyModeGating, so the gate
// closing takes effect immediately rather than at the next click.
//
// Routed through each toggle rather than by stripping the class, so the close
// side effects still run — the creature designer's preview loop is rAF-driven
// and would otherwise keep ticking behind the world forever.
const VX_CREATOR_MODALS = [
  ['mod-editor-modal', 'toggleModEditor'],
  ['block-designer-modal', 'toggleBlockDesigner'],
  ['creature-designer-modal', 'toggleCreatureDesigner'],
  ['mod-builder-modal', 'toggleModBuilder'],
  ['mod-creator-modal', 'toggleModCreator']
];
function vxCloseCreatorModals() {
  // A forced close-all (mode change) means "everything shuts, full stop" —
  // without this, closing the block/creature designer mid "Create" flow would
  // reopen the Mod Editor it just came from instead of actually closing.
  ngReturnToEditor = false;
  for (const [id, fn] of VX_CREATOR_MODALS) {
    const modal = document.getElementById(id);
    if (modal && modal.classList.contains('open') && typeof window[fn] === 'function') window[fn]();
  }
}
window.vxCloseCreatorModals = vxCloseCreatorModals;

// =========================================================
// CREATE-YOUR-OWN-MOD PANEL — block reskin + creature toggles UI
// =========================================================
const CREATURE_DISPLAY_NAMES = {
  butterfly: '🦋 Butterfly (Forest)'
};

function toggleModCreator() {
  if (vxCreatorBlocks('mod-creator-modal')) return;
  const modal = document.getElementById('mod-creator-modal');
  modal.classList.toggle('open');
  if (modal.classList.contains('open')) renderModCreatorPanel();
}

function renderModCreatorPanel() {
  const reskinEl = document.getElementById('reskin-list');
  if (reskinEl) {
    reskinEl.innerHTML = '';
    for (const origId of RESKIN_ELIGIBLE_IDS) {
      const row = document.createElement('div');
      row.className = 'reskin-row';
      const currentTarget = blockReskin[origId] !== undefined ? Number(blockReskin[origId]) : origId;
      const swatchColor = (blockColors[currentTarget] && blockColors[currentTarget][0]) || '#888';
      let options = '';
      for (const candId of RESKIN_ELIGIBLE_IDS) {
        options += `<option value="${candId}" ${candId === currentTarget ? 'selected' : ''}>${blockNames[candId]}</option>`;
      }
      row.innerHTML = `<span class="reskin-label"><span class="reskin-swatch" style="background:${swatchColor}"></span>${blockNames[origId]}</span><select onchange="setBlockReskin(${origId}, this.value)">${options}</select>`;
      reskinEl.appendChild(row);
    }
  }
  const creatureEl = document.getElementById('creature-toggle-list');
  if (creatureEl) {
    creatureEl.innerHTML = '';
    for (const type of Object.keys(creatureToggles)) {
      const row = document.createElement('div');
      row.className = 'creature-row';
      row.innerHTML = `<span class="creature-label">${CREATURE_DISPLAY_NAMES[type] || type}</span><input type="checkbox" ${creatureToggles[type] ? 'checked' : ''} onchange="toggleCreature('${type}', this.checked)">`;
      creatureEl.appendChild(row);
    }
  }
}


function setBlockReskin(origId, newIdStr) {
  const newId = Number(newIdStr);
  if (newId === origId) delete blockReskin[origId];
  else blockReskin[origId] = newId;
  saveBlockReskin();
  _invalidateBlockSprites();
  renderModCreatorPanel();
}

function resetBlockReskin() {
  blockReskin = {};
  saveBlockReskin();
  _invalidateBlockSprites();
  renderModCreatorPanel();
}

function toggleCreature(type, checked) {
  creatureToggles[type] = checked;
  saveCreatureToggles();
}

// =========================================================
// MOD SPRITES — the visual building blocks
// =========================================================
// Every creature a mod can define is one of MOD_SPRITES drawn procedurally
// here, then tuned by the visual parameters. Nothing is loaded from disk or
// from a URL: the shapes are code, the tuning is numbers in the mod code. That
// is the whole reason a mod code is safe to run the moment it is pasted in —
// there is no asset for anyone to smuggle anything into.
//
// Each draw function works in a 32x32 box with the origin at its top-left and
// gets its palette from one tint colour, so recolouring is free.
const MOD_SPRITE_BOX = 32;

function _modShade(hex, amt) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  if (amt >= 0) { r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt; }
  else { r *= (1 + amt); g *= (1 + amt); b *= (1 + amt); }
  return 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
}
function _modEyes(c, x1, x2, y, r) {
  c.fillStyle = '#fff';
  c.beginPath(); c.arc(x1, y, r, 0, 6.284); c.arc(x2, y, r, 0, 6.284); c.fill();
  c.fillStyle = '#1a1020';
  c.beginPath(); c.arc(x1, y + r * 0.15, r * 0.5, 0, 6.284); c.arc(x2, y + r * 0.15, r * 0.5, 0, 6.284); c.fill();
}

const MOD_SPRITE_DRAW = {
  blob(c, col) {
    c.fillStyle = col;
    c.beginPath(); c.moveTo(4, 26); c.quadraticCurveTo(2, 10, 16, 8); c.quadraticCurveTo(30, 10, 28, 26); c.closePath(); c.fill();
    c.fillStyle = _modShade(col, -0.28); c.fillRect(4, 24, 24, 2);
    c.fillStyle = _modShade(col, 0.4);
    c.beginPath(); c.ellipse(11, 14, 3.5, 2.2, -0.5, 0, 6.284); c.fill();
    _modEyes(c, 12, 21, 18, 2.6);
  },
  crawler(c, col) {
    // Legs are bent and reach well past the body outline — drawn straight and
    // short they hid behind it and the whole thing read as a hat.
    c.strokeStyle = _modShade(col, -0.42); c.lineWidth = 2; c.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const y = 14 + i * 3.5;
      c.beginPath(); c.moveTo(12, y); c.quadraticCurveTo(5, y - 3, 2.5, y + 6); c.stroke();
      c.beginPath(); c.moveTo(20, y); c.quadraticCurveTo(27, y - 3, 29.5, y + 6); c.stroke();
    }
    c.fillStyle = col; c.beginPath(); c.ellipse(16, 18, 6.5, 5.5, 0, 0, 6.284); c.fill();
    c.fillStyle = _modShade(col, 0.3); c.beginPath(); c.ellipse(16, 12.5, 4.5, 3.5, 0, 0, 6.284); c.fill();
    _modEyes(c, 14, 18, 11.5, 1.7);
  },
  flyer(c, col) {
    c.fillStyle = _modShade(col, -0.2);
    c.beginPath(); c.moveTo(16, 16); c.lineTo(2, 9); c.lineTo(5, 20); c.closePath(); c.fill();
    c.beginPath(); c.moveTo(16, 16); c.lineTo(30, 9); c.lineTo(27, 20); c.closePath(); c.fill();
    c.fillStyle = col; c.beginPath(); c.ellipse(16, 16, 5, 7, 0, 0, 6.284); c.fill();
    c.fillStyle = col;
    c.beginPath(); c.moveTo(12, 11); c.lineTo(13, 6); c.lineTo(16, 10); c.closePath(); c.fill();
    c.beginPath(); c.moveTo(20, 11); c.lineTo(19, 6); c.lineTo(16, 10); c.closePath(); c.fill();
    _modEyes(c, 14, 18, 15, 1.8);
  },
  orb(c, col) {
    const g = c.createRadialGradient(13, 12, 1, 16, 16, 11);
    g.addColorStop(0, _modShade(col, 0.55)); g.addColorStop(1, _modShade(col, -0.25));
    c.fillStyle = g; c.beginPath(); c.arc(16, 16, 10, 0, 6.284); c.fill();
    c.strokeStyle = _modShade(col, 0.35); c.lineWidth = 1.5;
    c.beginPath(); c.ellipse(16, 16, 13, 4, -0.35, 0, 6.284); c.stroke();
    _modEyes(c, 13, 19, 15, 2.2);
  },
  golem(c, col) {
    c.fillStyle = _modShade(col, -0.3); c.fillRect(6, 13, 4, 12); c.fillRect(22, 13, 4, 12);
    c.fillStyle = col; c.fillRect(10, 10, 12, 16);
    c.fillStyle = _modShade(col, 0.25); c.fillRect(10, 10, 12, 4);
    c.fillStyle = _modShade(col, -0.4); c.fillRect(12, 26, 3, 3); c.fillRect(17, 26, 3, 3);
    _modEyes(c, 13, 19, 17, 2);
  },
  spike(c, col) {
    c.fillStyle = _modShade(col, -0.2);
    c.beginPath();
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * 6.284, r = i % 2 ? 6 : 13;
      const fn = i ? 'lineTo' : 'moveTo';
      c[fn](16 + Math.cos(a) * r, 16 + Math.sin(a) * r);
    }
    c.closePath(); c.fill();
    c.fillStyle = col; c.beginPath(); c.arc(16, 16, 6.5, 0, 6.284); c.fill();
    _modEyes(c, 14, 18, 16, 1.8);
  },
  ghost(c, col) {
    c.fillStyle = col;
    c.beginPath(); c.moveTo(5, 25); c.lineTo(5, 15);
    c.quadraticCurveTo(5, 5, 16, 5); c.quadraticCurveTo(27, 5, 27, 15); c.lineTo(27, 25);
    for (let i = 0; i < 4; i++) c.quadraticCurveTo(27 - i * 5.5 - 2.75, 29, 27 - (i + 1) * 5.5, 25);
    c.closePath(); c.fill();
    c.fillStyle = _modShade(col, 0.35); c.beginPath(); c.ellipse(11, 12, 3, 4, -0.3, 0, 6.284); c.fill();
    _modEyes(c, 12, 20, 14, 2.8);
  },
  crystal(c, col) {
    c.fillStyle = col;
    c.beginPath(); c.moveTo(16, 3); c.lineTo(26, 14); c.lineTo(20, 28); c.lineTo(12, 28); c.lineTo(6, 14); c.closePath(); c.fill();
    c.fillStyle = _modShade(col, 0.45);
    c.beginPath(); c.moveTo(16, 3); c.lineTo(26, 14); c.lineTo(16, 18); c.closePath(); c.fill();
    c.fillStyle = _modShade(col, -0.3);
    c.beginPath(); c.moveTo(16, 18); c.lineTo(20, 28); c.lineTo(12, 28); c.closePath(); c.fill();
  },
  worm(c, col) {
    // Tail-to-head so the head sits on top, and each segment gets its own
    // highlight — overlapping same-tone circles just merged into a cloud.
    for (let i = 4; i >= 0; i--) {
      const x = 8.5 + i * 4.7, y = 20 - Math.sin(i * 0.95) * 5.5, r = 6.2 - i * 0.85;
      c.fillStyle = _modShade(col, -0.34 + i * 0.03);
      c.beginPath(); c.arc(x, y, r, 0, 6.284); c.fill();
      c.fillStyle = _modShade(col, 0.22);
      c.beginPath(); c.arc(x, y - r * 0.35, r * 0.5, 0, 6.284); c.fill();
    }
    c.fillStyle = col; c.beginPath(); c.arc(8.5, 20, 6.2, 0, 6.284); c.fill();
    c.fillStyle = _modShade(col, 0.3); c.beginPath(); c.arc(7.5, 17.5, 3, 0, 6.284); c.fill();
    _modEyes(c, 6.5, 11, 18.5, 1.7);
  },
  turret(c, col) {
    // Barrel points sideways, not up: a vertical barrel over a dome just read
    // as a laboratory flask.
    c.fillStyle = _modShade(col, -0.35);
    c.beginPath(); c.moveTo(3, 29); c.lineTo(8, 20); c.lineTo(22, 20); c.lineTo(27, 29); c.closePath(); c.fill();
    c.fillStyle = _modShade(col, -0.18); c.fillRect(14, 12, 15, 5);
    c.fillStyle = _modShade(col, 0.4); c.fillRect(26, 10.5, 4, 8);
    c.fillStyle = col; c.beginPath(); c.arc(14, 19, 7.5, Math.PI, 6.284); c.fill();
    c.fillStyle = _modShade(col, 0.3); c.beginPath(); c.arc(11.5, 16, 2.6, 0, 6.284); c.fill();
    c.fillStyle = '#ff5555'; c.beginPath(); c.arc(16, 16.5, 1.9, 0, 6.284); c.fill();
  },
  wisp(c, col) {
    const g = c.createRadialGradient(16, 15, 0, 16, 15, 13);
    g.addColorStop(0, _modShade(col, 0.75)); g.addColorStop(0.45, col);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.beginPath(); c.arc(16, 15, 13, 0, 6.284); c.fill();
    c.fillStyle = '#fff'; c.beginPath(); c.arc(16, 15, 3.2, 0, 6.284); c.fill();
    c.fillStyle = _modShade(col, 0.3);
    for (let i = 0; i < 3; i++) { c.globalAlpha = 0.5 - i * 0.14; c.beginPath(); c.arc(16, 22 + i * 3, 2.4 - i * 0.6, 0, 6.284); c.fill(); }
    c.globalAlpha = 1;
  },
  beetle(c, col) {
    c.fillStyle = _modShade(col, -0.4);
    c.beginPath(); c.ellipse(16, 20, 11, 8, 0, 0, 6.284); c.fill();
    c.fillStyle = col; c.beginPath(); c.ellipse(16, 18, 10, 7.5, 0, 0, 6.284); c.fill();
    c.strokeStyle = _modShade(col, -0.5); c.lineWidth = 1.4;
    c.beginPath(); c.moveTo(16, 11); c.lineTo(16, 25); c.stroke();
    c.fillStyle = _modShade(col, -0.2); c.beginPath(); c.ellipse(16, 10, 5, 4, 0, 0, 6.284); c.fill();
    c.strokeStyle = _modShade(col, -0.5); c.lineWidth = 1.2; c.lineCap = 'round';
    c.beginPath(); c.moveTo(13, 7); c.lineTo(10, 3); c.stroke();
    c.beginPath(); c.moveTo(19, 7); c.lineTo(22, 3); c.stroke();
    _modEyes(c, 14, 18, 10, 1.4);
  }
};

// ── Overlay textures ─────────────────────────────────────────────────────────
// 'stripes' / 'dots' / 'checker' are painted with source-atop so they only mark
// the creature's own pixels instead of a square patch around it. 'glow' sits
// BEHIND the sprite and deliberately spills outside the silhouette; 'sparks' is
// animated and handled at draw time, not baked into the cached bitmap.
function _modPaintOverlay(c, kind, col, box, pad) {
  if (kind === 'stripes' || kind === 'dots' || kind === 'checker') {
    c.save();
    c.globalCompositeOperation = 'source-atop';
    c.globalAlpha = 0.42;
    c.fillStyle = _modShade(col, -0.55);
    if (kind === 'stripes') {
      c.strokeStyle = _modShade(col, -0.55); c.lineWidth = 2.5;
      for (let i = -box; i < box * 2; i += 6) { c.beginPath(); c.moveTo(pad + i, pad); c.lineTo(pad + i + box, pad + box); c.stroke(); }
    } else if (kind === 'dots') {
      for (let y = 3; y < box; y += 6) for (let x = 3; x < box; x += 6) { c.beginPath(); c.arc(pad + x, pad + y, 1.6, 0, 6.284); c.fill(); }
    } else {
      for (let y = 0; y < box; y += 5) for (let x = 0; x < box; x += 5) if (((x / 5) + (y / 5)) % 2 === 0) c.fillRect(pad + x, pad + y, 5, 5);
    }
    c.restore();
  }
}
function _modPaintGlow(c, col, box, pad) {
  const cx = pad + box / 2;
  const g = c.createRadialGradient(cx, cx, box * 0.24, cx, cx, box * 0.85);
  g.addColorStop(0, _modShade(col, 0.3).replace('rgb', 'rgba').replace(')', ',0.75)'));
  g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g; c.fillRect(0, 0, pad * 2 + box, pad * 2 + box);
}

// Cached per sprite+tint+overlay. Hue, scale, rotation and opacity are applied
// at blit time instead — they are pure canvas-transform work, so caching a
// variant per slider position would burn memory for nothing.
const _modSpriteCache = new Map();
function getModSpriteCanvas(sprite, tint, overlay) {
  const key = sprite + '|' + tint + '|' + overlay;
  const hit = _modSpriteCache.get(key);
  if (hit) return hit;

  const box = MOD_SPRITE_BOX, pad = box >> 1;      // room for 'glow' to spill
  const cv = document.createElement('canvas');
  cv.width = cv.height = box + pad * 2;
  const c = cv.getContext('2d');

  const draw = MOD_SPRITE_DRAW[sprite] || MOD_SPRITE_DRAW.blob;
  const col = MOD_TINTS.includes(tint) ? tint : MOD_TINTS[0];

  if (overlay === 'glow') _modPaintGlow(c, col, box, pad);
  c.save(); c.translate(pad, pad); draw(c, col); c.restore();
  _modPaintOverlay(c, overlay, col, box, pad);

  if (_modSpriteCache.size > 120) _modSpriteCache.clear();
  _modSpriteCache.set(key, cv);
  return cv;
}

// Draws a configured creature centred on (cx, cy). `t` is a free-running time
// in seconds and only matters for the animated bits (sparks + particles), so a
// still frame can pass 0.
function drawModSprite(ctx, v, cx, cy, size, t) {
  const cv = getModSpriteCanvas(v.sprite, v.tint, v.overlay);
  const full = size * (cv.width / MOD_SPRITE_BOX);   // keep the glow padding in proportion
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((v.rotation || 0) * Math.PI / 180);
  ctx.scale(v.scale || 1, v.scale || 1);
  ctx.globalAlpha = v.alpha === undefined ? 1 : v.alpha;
  // Canvas `filter` is the cheap way to hue-shift a whole bitmap; skipped
  // entirely at 0 so the common case never pays for it.
  if (v.hue) ctx.filter = 'hue-rotate(' + v.hue + 'deg)';
  ctx.drawImage(cv, -full / 2, -full / 2, full, full);
  ctx.filter = 'none';

  const n = v.particles | 0;
  if (n > 0 || v.overlay === 'sparks') {
    const count = v.overlay === 'sparks' ? Math.max(4, n * 2) : n * 2;
    const r = size * 0.62;
    ctx.globalAlpha = (v.alpha === undefined ? 1 : v.alpha) * 0.85;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * 6.284 + t * (v.overlay === 'sparks' ? 1.6 : 0.7);
      const wobble = Math.sin(t * 2.4 + i * 1.7) * size * 0.09;
      const px = Math.cos(a) * (r + wobble), py = Math.sin(a) * (r + wobble);
      const s = size * (v.overlay === 'sparks' ? 0.055 : 0.045) * (0.6 + Math.sin(t * 3 + i) * 0.4 + 0.4);
      ctx.fillStyle = v.overlay === 'sparks' ? _modShade(v.tint, 0.6) : v.tint;
      ctx.beginPath(); ctx.arc(px, py, Math.max(0.4, s), 0, 6.284); ctx.fill();
    }
  }
  ctx.restore();
}

// =========================================================
// MOD BUILDER — full mod creation & publishing, in-game.
// Writes to the same "voxeria_mods" Firestore collection the
// Voxeria Hub website reads from, so published mods show up in
// both places, and produces the same "MOD1-"+base64url(JSON)
// codes the Seed field / decodeModCode() already understand.
// =========================================================
const MB_ICONS = ['🧩','⛏️','🌋','🔥','❤️','🚀','💎','🌲','❄️','🏜️','🔮','🌊','⚡','🏆','💀','🧨','🌈','🐉','🏰','🎯'];
const MB_DEFAULT_ICON = MB_ICONS[0];

// Reserved author name (mirrors the Hub website) — only the SHA-256 hash is
// stored here, never the plaintext, so publishing as "Paco Interactive"
// still requires the password even from in-game.
const MB_RESERVED_AUTHOR_KEY = 'pacointeractive';
const MB_RESERVED_AUTHOR_PASSWORD_HASH = 'e3e629177c06b4dc8da280ba3a25f7fdf3a6adb5d3c71801013cc37501b3d3d8';
function mbNormalizeAuthorKey(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function mbIsReservedAuthor(name) { return mbNormalizeAuthorKey(name) === MB_RESERVED_AUTHOR_KEY; }
async function mbSha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(str)));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function mbCheckReservedAuthorPassword(pw) {
  if (!pw) return false;
  return (await mbSha256Hex(pw)) === MB_RESERVED_AUTHOR_PASSWORD_HASH;
}

// The v1 encoder used to live here. Nothing writes MOD1- codes any more —
// encodeModCode2() does the writing, decodeModCode() still does the reading, so
// every code ever shared keeps working.

// ── Display wording ──────────────────────────────────────────────────────────
// Deliberately NOT part of MOD_FIELDS: that table is the frozen wire format and
// must not be touched to reword a button, while everything here is free to
// change at any time.
// The sprite/overlay/move/attack/trigger/spawnTable label lists that used to
// sit here went with the controls they named. biomeFocus/forceWeather must
// keep every entry, including the retired ones: these are positional — index N
// names MOD_BIOMES[N] / MOD_WEATHERS[N] — so dropping 'Desert' or 'Always rain'
// would silently relabel every entry after it. REMOVED_BIOMES/REMOVED_WEATHER
// are what actually hide them from the dropdowns (see mbBuildSelect).
const MB_LABELS = {
  biomeFocus:   ['Mixed (normal)','Forest','Desert','Jungle','Snow','Volcano','Mystic'],
  forceWeather: ['Normal (changes naturally)','Always clear','Always rain','Always storm','Always snow']
};
// MB_BEHAVIOR_HINTS lived here: three tables describing what a creature's
// movement, attack and trigger would do. The game has no combat system at all,
// so "Hurts you when it touches you" and "Shoots at you from a distance" were
// describing machinery that does not exist. Gone with the controls.

// ── Plain-English layer ──────────────────────────────────────────────────────
// The builder used the wire-format field names as its UI labels, which meant
// players were reading "Hue shift", "Overlay texture" and "Portal build cost 8"
// with no idea what any of it meant. Labels and meanings live here instead:
// `label` renames a control, `meaning` turns the current NUMBER into a sentence
// so the slider explains itself while you drag it. Nothing here touches
// MOD_FIELDS, so rewording is always safe.
const MB_FIELD_TEXT = {
  // The five 'visual.*' entries and 'dim.spawnRate' that used to be here named
  // sliders on the removed Creature tab and the removed spawn-rate control.
  'dim.gravity': { label: 'Gravity',
    meaning: v => v <= 0.4 ? 'Floaty — huge, slow moon jumps' : v <= 0.8 ? 'Light — you hang in the air' :
                  v <= 1.1 ? 'Normal, like the main world' : v <= 1.4 ? 'Heavy — jumps feel short' : 'Very heavy — you barely leave the ground' },

  'world.heightMult': { label: 'How hilly the land is',
    meaning: v => v <= 0.6 ? 'Almost flat — easy to build on' : v <= 1.3 ? 'Gentle rolling hills' :
                  v <= 2.2 ? 'Tall hills and deep valleys' : 'Extreme mountains and cliffs' }
};
function mbText(f) { return MB_FIELD_TEXT[f.g + '.' + f.k] || {}; }
function mbLabelFor(f) { return mbText(f).label || f.label; }
function mbMeaningFor(f) {
  const m = mbText(f).meaning;
  return m ? m(mbMod[f.g][f.k]) : '';
}

// ── Starting points ──────────────────────────────────────────────────────────
// A blank builder is the hardest thing to face: twenty sliders and no idea
// which ones matter. Each preset is a complete, playable mod, so the first move
// is picking something that already works and then changing what you don't like.
const MB_PRESETS = [
  // Each preset used to also set m.visual, m.behavior, m.dim.spawnRate and
  // m.dim.spawnTable, and its description sold the creature those described
  // ("slow, harmless wanderers", "Constant shooters", "the glowing things that
  // chase you"). None of it ever reached the world. The assignments are gone
  // and the descriptions now promise only what the preset actually delivers.
  {
    id: 'sandbox', icon: '🌲', name: 'Peaceful Sandbox',
    desc: 'A calm, gently rolling forest with generous gear. Good for building.',
    apply(m) {
      m.dim.gravity = 1;
      m.world = { heightMult:0.9, biomeFocus:'FOREST', forceWeather:'clear' };
      m.perks = { speed:false, reach:true, digspeed:true, doublejump:false, pickaxe:true, megajump:false, hazardimmune:true };
    }
  },
  {
    // Was "Hardcore Desert" with biomeFocus:'DESERT' — Desert no longer
    // generates (see REMOVED_BIOMES), so a preset still called that would
    // silently hand out plain Forest terrain while its own name and
    // description promised sand. Re-themed around the storm instead of the
    // biome, since that part of the harshness is still real.
    id: 'hardcore', icon: '💀', name: 'Hardcore Storm',
    desc: 'A storm-battered mountain range. Heavy gravity and nothing handed to you.',
    apply(m) {
      m.dim.gravity = 1.2;
      m.world = { heightMult:2.3, biomeFocus:'', forceWeather:'storm' };
      m.perks = { speed:false, reach:false, digspeed:false, doublejump:false, pickaxe:false, megajump:false, hazardimmune:false };
    }
  },
  {
    id: 'moon', icon: '🚀', name: 'Low Gravity',
    desc: 'Barely any gravity. Huge, floaty jumps over tall hills.',
    apply(m) {
      m.dim.gravity = 0.3;
      // Was biomeFocus:'MYSTIC' — Mystic no longer generates (see
      // REMOVED_BIOMES); the preset's own name/description never named the
      // biome, so this is a silent, purely mechanical fix.
      m.world = { heightMult:1.7, biomeFocus:'', forceWeather:'' };
      m.perks = { speed:true, reach:false, digspeed:false, doublejump:true, pickaxe:false, megajump:true, hazardimmune:false };
    }
  },
  {
    id: 'blank', icon: '📄', name: 'Start from scratch',
    desc: 'Everything at its normal setting. Build it up yourself.',
    apply(m) {
      const d = modDefaults();
      m.visual = d.visual; m.behavior = d.behavior; m.dim = d.dim; m.world = d.world; m.perks = d.perks;
    }
  }
];

// ── "What did I just build?" ─────────────────────────────────────────────────
// Shown permanently at the bottom of the builder. This is the single answer to
// the complaint that the panels felt like unrelated piles of sliders: it reads
// the whole mod back as two sentences, and updates as you change anything.
function mbSummaryText() {
  const m = mbMod;
  const biome = m.world.biomeFocus
    ? (MB_LABELS.biomeFocus[MOD_BIOMES.indexOf(m.world.biomeFocus)] || '').toLowerCase()
    : 'mixed';
  const weather = { clear:'sunny ', rain:'rainy ', storm:'storm-swept ', snow:'snowy ' }[m.world.forceWeather] || '';
  const hills = m.world.heightMult <= 0.6 ? 'almost flat' : m.world.heightMult <= 1.3 ? 'gently rolling'
              : m.world.heightMult <= 2.2 ? 'hilly' : 'mountainous';
  const grav = m.dim.gravity <= 0.8 ? ', with low gravity' : m.dim.gravity >= 1.4 ? ', with heavy gravity' : '';

  // This used to also describe the creature ("Your blob patrols the ground,
  // hurting you on contact the moment it sees you. It shows up often.") — a
  // sentence describing a creature that never spawned, attacking with a combat
  // system that does not exist. Removed along with the controls behind it.
  const perks = MOD_PERK_KEYS.filter(k => m.perks[k]).length;
  const items = mbStartInventory.length;
  const gear = (perks || items)
    ? 'You start with ' + [perks ? perks + ' perk' + (perks > 1 ? 's' : '') : null,
                           items ? items + ' item stack' + (items > 1 ? 's' : '') : null].filter(Boolean).join(' and ') + '.'
    : 'You start with nothing special.';

  return 'A ' + weather + biome + ' world, ' + hills + grav + '. ' + gear;
}

function mbField(g, k) { return MOD_FIELDS.find(f => f.g === g && f.k === k); }
// Explicit "group.key" lists let a panel show exactly the sliders that belong
// together for the player, in the order that reads best — independent of how
// the fields are grouped in the wire format.
function mbFields(...keys) {
  return keys.map(s => mbField(s.split('.')[0], s.split('.')[1])).filter(Boolean);
}

let mbMod = modDefaults();          // the mod currently being edited
let mbStartInventory = [];
let mbCurrentIcon = MB_DEFAULT_ICON;
let mbSelectedTags = new Set();
let mbCurrentModData = null;
let mbCurrentModCode = null;
let mbInitDone = false;

function mbRenderInvList() {
  const el = document.getElementById('mb-inv-list');
  if (!el) return;
  if (!mbStartInventory.length) { el.innerHTML = '<span class="mb-hint">No items added yet.</span>'; return; }
  el.innerHTML = mbStartInventory.map((it, i) => {
    const name = blockNames[it.block] || ('Block ' + it.block);
    return `<span class="mb-inv-chip">${escapeHtml(name)} ×${it.count} <button type="button" data-i="${i}">✕</button></span>`;
  }).join('');
}

// ── Generated controls ───────────────────────────────────────────────────────
// Built from MOD_FIELDS rather than hand-written, so a new parameter shows up in
// the UI the moment it is added to the table — and, more importantly, a slider's
// stops ARE the field's raw values (0..2^bits-1). The UI is therefore physically
// unable to produce a value the code format cannot store, which is the same
// guarantee the decoder enforces, coming from the other direction.
function mbBuildSliders(hostId, fields) {
  const host = document.getElementById(hostId);
  if (!host) return;
  host.innerHTML = fields.map(f =>
    '<div class="mb-field" style="margin-bottom:12px;">' +
      '<label class="mb-label">' + escapeHtml(mbLabelFor(f)) + '</label>' +
      '<div class="mb-slider-row">' +
        '<input type="range" min="0" max="' + _modFieldMax(f) + '" step="1" data-g="' + f.g + '" data-k="' + f.k + '">' +
        '<span class="mb-slider-val" data-val="' + f.g + '.' + f.k + '"></span>' +
      '</div>' +
      '<div class="mb-meaning" data-meaning="' + f.g + '.' + f.k + '"></div>' +
    '</div>'
  ).join('');
  host.addEventListener('input', (e) => {
    const inp = e.target.closest('input[type="range"]');
    if (!inp) return;
    const f = mbField(inp.dataset.g, inp.dataset.k);
    if (!f) return;
    mbMod[f.g][f.k] = modRawToField(f, parseInt(inp.value, 10));
    mbSyncValueLabels();
    mbRefreshVisuals();
  });
}

// mbBuildSeg (segmented button rows) lived here. Its only four callers were
// the overlay/move/attack/trigger controls on the removed Creature tab; both
// remaining dropdowns use mbBuildSelect instead.

// `hide` lets a select skip specific values in the rendered dropdown without
// touching f.list itself — f.list IS the wire-format enum (see MOD_FIELDS),
// so removing an entry there would shift every later index and silently
// reinterpret already-shared mod codes. REMOVED_BIOMES needs exactly this:
// Desert/Jungle/Volcano/Mystic must disappear from the picker (getBiome() no
// longer generates them) while staying at their original enum positions so
// an old code that still names one of them decodes to the same harmless,
// already-neutralised value it always would.
function mbBuildSelect(id, g, k, labels, hide) {
  const el = document.getElementById(id);
  const f = mbField(g, k);
  if (!el || !f) return;
  el.innerHTML = f.list.map((v, i) =>
    hide && hide.has(v) ? '' : '<option value="' + escapeHtml(v) + '">' + escapeHtml(labels[i] || v) + '</option>'
  ).join('');
  el.addEventListener('change', () => { mbMod[g][k] = el.value; });
}

// mbBuildSpriteGrid / mbBuildSwatches / mbBuildSpawnTable lived here. All three
// built controls on the removed Creature tab and the removed "Extra creatures"
// list; their values are still carried by the codec, just no longer editable.

// ── Syncing UI <- mbMod ──────────────────────────────────────────────────────
// One direction only: mbMod is the truth, every control reads from it. That is
// what lets "load a code back in" work without any per-control restore logic.
function mbSyncValueLabels() {
  document.querySelectorAll('#mod-builder-modal [data-val]').forEach(el => {
    const [g, k] = el.dataset.val.split('.');
    const f = mbField(g, k);
    if (f) el.textContent = mbMod[g][k] + (f.unit || '');
  });
  document.querySelectorAll('#mod-builder-modal [data-meaning]').forEach(el => {
    const [g, k] = el.dataset.meaning.split('.');
    const f = mbField(g, k);
    if (f) el.textContent = mbMeaningFor(f);
  });
  mbUpdateSummary();
}

function mbUpdateSummary() {
  const el = document.getElementById('mb-summary-text');
  if (el) el.textContent = mbSummaryText();
}

// Applying a preset rewrites every parameter, so the whole UI has to be rebuilt
// from mbMod — which mbRefreshVisuals already does.
function mbApplyPreset(id) {
  const p = MB_PRESETS.find(x => x.id === id);
  if (!p) return;
  p.apply(mbMod);
  document.querySelectorAll('#mb-preset-list .mb-preset').forEach(b =>
    b.classList.toggle('sel', b.dataset.id === id));
  mbRefreshVisuals();
  showNotification(p.icon + ' Loaded "' + p.name + '" — now change whatever you like.');
}

function mbBuildPresets() {
  const host = document.getElementById('mb-preset-list');
  if (!host) return;
  host.innerHTML = MB_PRESETS.map(p =>
    '<button type="button" class="mb-preset" data-id="' + p.id + '">' +
      '<span class="mb-preset-icon">' + p.icon + '</span>' +
      '<span class="mb-preset-body">' +
        '<span class="mb-preset-name">' + escapeHtml(p.name) + '</span>' +
        '<span class="mb-preset-desc">' + escapeHtml(p.desc) + '</span>' +
      '</span>' +
    '</button>'
  ).join('');
  host.addEventListener('click', (e) => {
    const b = e.target.closest('.mb-preset');
    if (b) mbApplyPreset(b.dataset.id);
  });
}

function mbSyncControls() {
  document.querySelectorAll('#mod-builder-modal input[type="range"][data-g]').forEach(inp => {
    const f = mbField(inp.dataset.g, inp.dataset.k);
    if (f) inp.value = modFieldToRaw(f, mbMod[f.g][f.k]);
  });
  mbSyncValueLabels();

  const biome = document.getElementById('mb-biome');
  if (biome) biome.value = mbMod.world.biomeFocus;
  const weather = document.getElementById('mb-weather');
  if (weather) weather.value = mbMod.world.forceWeather;

  MOD_PERK_KEYS.forEach(key => {
    const cb = document.getElementById('mb-p-' + key);
    if (cb) cb.checked = !!mbMod.perks[key];
  });
}

// Was "repaint the creature preview, its sprite grid and its swatches, then
// sync the controls". The creature tab is gone (see the tab-bar comment in the
// markup), so only the sync is left — kept under its old name because a dozen
// call sites already mean "the UI changed, refresh it" by it.
function mbRefreshVisuals() {
  mbSyncControls();
}

function mbShowPanel(name) {
  document.querySelectorAll('#mod-builder-modal .mb-panel').forEach(p =>
    p.classList.toggle('active', p.dataset.panel === name));
  document.querySelectorAll('#mb-tabs-bar .mb-tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.panel === name));
}

// Pulls a code back into the builder. Doubles as the honest test of the
// decoder: whatever a shared code actually contains is what shows up here.
function mbImportCode() {
  const input = document.getElementById('mb-import-code');
  const raw = input.value.trim();
  if (!raw) return;
  if (!isModCode(raw)) { showNotification('⚠️ That is not a Voxeria mod code.'); return; }
  const decoded = decodeModCode(raw);
  if (!decoded) { showNotification('⚠️ Code is corrupt or was edited (checksum failed).'); return; }
  mbMod = decoded;
  mbStartInventory = decoded.startInventory || [];
  document.getElementById('mb-name').value = decoded.name === 'Unnamed Mod' ? '' : decoded.name;
  document.getElementById('mb-author').value = decoded.author || '';
  document.getElementById('mb-seed').value = decoded.seed || '';
  mbRenderInvList();
  mbRefreshVisuals();
  input.value = '';
  showNotification('🧩 Mod loaded: ' + decoded.name);
}

function mbInit() {
  if (mbInitDone) return;
  mbInitDone = true;

  const blockSelect = document.getElementById('mb-inv-block');
  blockSelect.innerHTML = Object.keys(blockNames).map(Number).filter(id => !NON_ITEM_BLOCK_IDS.has(id)).sort((a, b) => a - b)
    .map(id => `<option value="${id}">${escapeHtml(blockNames[id])}</option>`).join('');

  mbBuildPresets();

  // The creature-tab builders (sprite grid, swatches, overlay/move/attack/
  // trigger segments, visual sliders) and the spawn-rate slider + spawn table
  // used to be built here. Their controls are gone from the markup, so
  // building them would just write into nothing — see the tab-bar comment in
  // the HTML for why the whole tab went. The underlying fields still round-
  // trip through the codec untouched.

  // Grouped by what the player is thinking about, not by which group the field
  // happens to sit in: gravity is stored under `dim` but it is obviously a
  // property of the world, so that is where the slider lives.
  mbBuildSliders('mb-world-sliders', mbFields('world.heightMult', 'dim.gravity'));
  mbBuildSelect('mb-biome',   'world', 'biomeFocus',   MB_LABELS.biomeFocus, REMOVED_BIOMES);
  mbBuildSelect('mb-weather', 'world', 'forceWeather', MB_LABELS.forceWeather, REMOVED_WEATHER);

  document.getElementById('mb-tabs-bar').addEventListener('click', (e) => {
    const b = e.target.closest('.mb-tab-btn');
    if (b) mbShowPanel(b.dataset.panel);
  });
  MOD_PERK_KEYS.forEach(key => {
    const cb = document.getElementById('mb-p-' + key);
    if (cb) cb.addEventListener('change', () => { mbMod.perks[key] = cb.checked; });
  });
  document.getElementById('mb-import-btn').addEventListener('click', mbImportCode);

  const iconPop = document.getElementById('mb-icon-pop');
  const iconPickerBtn = document.getElementById('mb-icon-picker-btn');
  iconPop.innerHTML = MB_ICONS.map(ic =>
    `<button type="button" data-icon="${ic}"${ic === mbCurrentIcon ? ' class="sel"' : ''}>${ic}</button>`
  ).join('');
  iconPickerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    iconPop.classList.toggle('open');
  });
  iconPop.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-icon]');
    if (!btn) return;
    mbCurrentIcon = btn.dataset.icon;
    document.getElementById('mb-icon-current').textContent = mbCurrentIcon;
    iconPop.querySelectorAll('button').forEach(b => b.classList.toggle('sel', b === btn));
    iconPop.classList.remove('open');
  });
  document.addEventListener('click', (e) => {
    if (!iconPop.contains(e.target) && e.target !== iconPickerBtn) iconPop.classList.remove('open');
  });

  document.getElementById('mb-author').addEventListener('input', (e) => {
    document.getElementById('mb-author-password-field').style.display = mbIsReservedAuthor(e.target.value) ? 'block' : 'none';
  });

  document.getElementById('mb-inv-add-btn').addEventListener('click', () => {
    if (mbStartInventory.length >= 8) { showNotification('⚠️ Maximum of 8 items.'); return; }
    const block = parseInt(blockSelect.value, 10);
    const count = Math.max(1, Math.min(99, parseInt(document.getElementById('mb-inv-count').value, 10) || 1));
    const existing = mbStartInventory.find(it => it.block === block);
    if (existing) existing.count = Math.min(99, existing.count + count);
    else mbStartInventory.push({ block, count });
    mbRenderInvList();
  });
  document.getElementById('mb-inv-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-i]');
    if (!btn) return;
    mbStartInventory.splice(parseInt(btn.dataset.i, 10), 1);
    mbRenderInvList();
  });

  document.getElementById('mb-tags').addEventListener('click', (e) => {
    const btn = e.target.closest('.mb-tag');
    if (!btn) return;
    const tag = btn.dataset.tag;
    if (mbSelectedTags.has(tag)) { mbSelectedTags.delete(tag); btn.classList.remove('active'); }
    else { mbSelectedTags.add(tag); btn.classList.add('active'); }
  });

  document.getElementById('mb-generate-btn').addEventListener('click', mbGenerate);
  document.getElementById('mb-copy-code-btn').addEventListener('click', () => {
    if (mbCurrentModCode) copyTextWithFallback(mbCurrentModCode);
  });
  document.getElementById('mb-copy-link-btn').addEventListener('click', mbCopyLink);
  document.getElementById('mb-publish-btn').addEventListener('click', mbPublish);

  mbRenderInvList();
  mbRefreshVisuals();
  mbShowPanel('start');
}

function toggleModBuilder() {
  if (vxCreatorBlocks('mod-builder-modal')) return;
  const modal = document.getElementById('mod-builder-modal');
  modal.classList.toggle('open');
  if (modal.classList.contains('open')) mbInit();
}
window.toggleModBuilder = toggleModBuilder;

// =========================================================
// PIXEL EDITOR — the shared 32x32 painting surface. Blocks and creatures use
// the same one; there is no shape/template library for either, because the
// whole point of the piece system is that the art belongs to the player.
// =========================================================
// How many steps back Undo can reach. 60 snapshots x 1KB is negligible, and
// a stroke (not a pixel) is one step, so this is a long working history.
const PIXEL_HISTORY_CAP = 60;

function createPixelEditor(ids) {
  const S = BLOCK_PIXEL_SIZE;
  const el = id => (id ? document.getElementById(id) : null);
  const state = {
    pixels: new Uint8Array(BLOCK_PIXEL_COUNT),
    // This drawing's own colour table. Starts as a copy of the built-in
    // swatches and grows as the painter adds colours; index 0 stays
    // transparent, which every consumer of `pixels` relies on.
    palette: defaultPiecePalette(),
    // A mid-palette colour rather than index 0, so the first stroke is visible
    // instead of painting transparent onto transparent.
    selectedIdx: 8,
    tool: 'pencil',
    painting: false,
    strokeDirty: false,
    mirror: !!ids.mirrorDefault,
    grid: true,
    history: [],
    histIdx: -1,
    // Live line/box preview: drawn every frame but only committed on release,
    // so a shape can be dragged into position before it touches the artwork.
    shape: null
  };

  // ── history ────────────────────────────────────────────────────────────
  // Snapshots record the canvas AFTER each completed edit, with entry 0 being
  // the empty canvas. Recording the state BEFORE an edit instead looks like it
  // works — Undo still steps back correctly — but the newest artwork is then
  // never in the list at all, so Redo can only ever return to a pre-edit
  // snapshot and silently throws the last change away.
  // A snapshot is pixels AND palette, not pixels alone: recolouring a swatch
  // repaints every pixel that uses it, so a history that only remembered
  // indices would "undo" back to the right shapes in the wrong colours.
  function pushHistory() {
    state.history.length = state.histIdx + 1;   // a new edit discards the redo tail
    state.history.push({ pixels: state.pixels.slice(), palette: state.palette.slice() });
    if (state.history.length > PIXEL_HISTORY_CAP) state.history.shift();
    state.histIdx = state.history.length - 1;
    syncHistoryButtons();
  }
  function restoreHistory(i) {
    const snap = state.history[i];
    state.pixels.set(snap.pixels);
    state.palette = snap.palette.slice();
    // Stepping back past the point a colour was added leaves the selection
    // pointing at a slot that no longer exists.
    if (state.selectedIdx >= state.palette.length) state.selectedIdx = 0;
    state.histIdx = i;
    syncHistoryButtons();
    renderPalette();
    redraw();
  }
  function undo() { if (state.histIdx > 0) restoreHistory(state.histIdx - 1); }
  function redo() { if (state.histIdx < state.history.length - 1) restoreHistory(state.histIdx + 1); }
  function syncHistoryButtons() {
    const u = el(ids.undoBtn), r = el(ids.redoBtn);
    if (u) u.disabled = state.histIdx <= 0;
    if (r) r.disabled = state.histIdx >= state.history.length - 1;
  }

  // ── colours ────────────────────────────────────────────────────────────
  // The whole strip is rebuilt from state.palette rather than patched in
  // place: a colour can be added, recoloured, or replaced wholesale when a
  // saved piece is loaded, and one build path is easier to trust than three
  // separate mutation paths that must each leave the DOM consistent.
  function syncPalette() {
    document.querySelectorAll('#' + ids.palette + ' .mb-swatch').forEach(s =>
      s.classList.toggle('selected', parseInt(s.dataset.idx, 10) === state.selectedIdx));
    syncColourControls();
  }

  function renderPalette() {
    const pal = el(ids.palette);
    if (!pal) return;
    pal.innerHTML = state.palette.map((hex, i) => {
      const bg = hex === 'transparent'
        ? 'repeating-conic-gradient(#888 0% 25%, #bbb 0% 50%) 0 0/8px 8px'
        : hex;
      return `<div class="mb-swatch${i === state.selectedIdx ? ' selected' : ''}" data-idx="${i}" style="background:${bg}" title="${hex === 'transparent' ? 'Transparent' : hex}"></div>`;
    }).join('');
    pal.querySelectorAll('.mb-swatch').forEach(sw => sw.addEventListener('click', () => {
      state.selectedIdx = parseInt(sw.dataset.idx, 10);
      syncPalette();
    }));
    syncColourControls();
  }

  function syncColourControls() {
    const cur = state.palette[state.selectedIdx];
    const editBtn = el(ids.colourEditBtn);
    // Index 0 is transparent, so there is no colour there to edit.
    if (editBtn) editBtn.disabled = !(state.selectedIdx >= 1 && cur && cur !== 'transparent');
    const info = el(ids.colourInfo);
    if (info) {
      info.textContent = (cur && cur !== 'transparent' ? cur.toUpperCase() : 'Transparent') +
        ' · ' + state.palette.length + '/' + BLOCK_PIXEL_MAX_COLOURS + ' in this drawing';
    }
  }

  // One <input type="color"> reused by both buttons. It has to live in the
  // document rather than be constructed on demand: a detached input ignores
  // .click() in several browsers, and the whole point is to open the system
  // picker without asking the player to find a hidden field first.
  let colourInput = null;
  let colourInputMode = 'add';   // 'add' | 'replace'

  function ensureColourInput() {
    if (colourInput) return colourInput;
    colourInput = document.createElement('input');
    colourInput.type = 'color';
    colourInput.className = 'ae-colour-input';
    const host = el(ids.palette);
    (host && host.parentNode ? host.parentNode : document.body).appendChild(colourInput);
    // 'input' fires continuously while the picker is being dragged, so the
    // canvas recolours live underneath it. In 'add' mode the FIRST such value
    // creates the swatch and the mode flips to 'replace', so one long drag
    // through the colour wheel leaves exactly one new swatch behind instead of
    // one per pixel of travel.
    colourInput.addEventListener('input', () => {
      const hex = _normaliseHex(colourInput.value);
      if (!hex) return;
      if (colourInputMode === 'add') {
        if (addColour(hex)) colourInputMode = 'replace';
      } else {
        replaceSelectedColour(hex);
      }
    });
    // 'change' is the picker being dismissed: one Undo step for the whole
    // interaction, however many live updates it streamed on the way.
    colourInput.addEventListener('change', () => pushHistory());
    return colourInput;
  }

  function addColour(hex) {
    const at = state.palette.indexOf(hex);
    // Already on the strip: select it instead of stacking a second identical
    // swatch, which is easy to do by reaching for the same colour twice.
    if (at >= 0) { state.selectedIdx = at; renderPalette(); return true; }
    if (state.palette.length >= BLOCK_PIXEL_MAX_COLOURS) {
      showNotification('⚠️ This drawing already holds ' + BLOCK_PIXEL_MAX_COLOURS + ' colours.');
      return false;
    }
    state.palette.push(hex);
    state.selectedIdx = state.palette.length - 1;
    renderPalette();
    return true;
  }

  // Recolours a swatch IN PLACE, so every pixel already painted with it
  // changes too. That is deliberate: it turns the palette into a live control
  // over the finished drawing rather than a "choose correctly before you
  // paint" step you can only take back with Undo.
  function replaceSelectedColour(hex) {
    if (state.selectedIdx < 1) return;
    if (state.palette[state.selectedIdx] === hex) return;
    state.palette[state.selectedIdx] = hex;
    renderPalette();
    redraw();
  }

  function openColourPicker(mode) {
    if (mode === 'replace' && !(state.selectedIdx >= 1)) {
      showNotification('⚠️ Select a colour swatch first.');
      return;
    }
    const inp = ensureColourInput();
    colourInputMode = mode;
    const cur = state.palette[state.selectedIdx];
    // A sensible starting point for "add": the colour in hand, or mid-grey
    // when the transparent slot is selected and there is nothing to start from.
    inp.value = (cur && cur !== 'transparent') ? cur : '#7a7a7a';
    inp.click();
  }

  // ── geometry ───────────────────────────────────────────────────────────
  function setPixel(x, y, v) {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    state.pixels[y * S + x] = v;
    if (state.mirror) {
      const mx = S - 1 - x;
      if (mx !== x) state.pixels[y * S + mx] = v;
    }
  }
  // Bresenham — whole-pixel steps only, so a dragged line lands on the same
  // cells the finished art will use rather than an anti-aliased approximation.
  function lineCells(x0, y0, x1, y1) {
    const out = [];
    let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      out.push([x0, y0]);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
    return out;
  }
  function rectCells(x0, y0, x1, y1) {
    const out = [];
    const xa = Math.min(x0, x1), xb = Math.max(x0, x1);
    const ya = Math.min(y0, y1), yb = Math.max(y0, y1);
    for (let x = xa; x <= xb; x++) { out.push([x, ya], [x, yb]); }
    for (let y = ya; y <= yb; y++) { out.push([xa, y], [xb, y]); }
    return out;
  }
  function shapeCells(s) {
    const base = s.tool === 'rect' ? rectCells(s.x0, s.y0, s.x1, s.y1) : lineCells(s.x0, s.y0, s.x1, s.y1);
    if (!state.mirror) return base;
    const out = base.slice();
    for (const [x, y] of base) { const mx = S - 1 - x; if (mx !== x) out.push([mx, y]); }
    return out;
  }
  function floodFill(x, y, target, replacement) {
    if (target === replacement) return;
    const stack = [[x, y]];
    const seen = new Set();
    while (stack.length) {
      const [cx, cy] = stack.pop();
      if (cx < 0 || cy < 0 || cx >= S || cy >= S) continue;
      const key = cx + ',' + cy;
      if (seen.has(key)) continue;
      seen.add(key);
      const i = cy * S + cx;
      if (state.pixels[i] !== target) continue;
      state.pixels[i] = replacement;
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
  }
  // Reads from a snapshot so a transform can't feed its own output back in
  // half-way through the sweep.
  function transform(map) {
    const src = state.pixels.slice();
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const [sx, sy] = map(x, y);
        state.pixels[y * S + x] = src[sy * S + sx];
      }
    }
    pushHistory();
    redraw();
  }

  // ── rendering ──────────────────────────────────────────────────────────
  function redraw() {
    const canvas = el(ids.canvas);
    if (!canvas) return;
    const c = canvas.getContext('2d');
    c.clearRect(0, 0, canvas.width, canvas.height);
    const cell = canvas.width / S;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const hex = piecePaletteHex(state.palette, state.pixels[y * S + x]);
        if (hex === 'transparent') continue;
        c.fillStyle = _blockPixelTextured(hex, y, x);
        c.fillRect(x * cell, y * cell, cell, cell);
      }
    }
    if (state.shape) {
      const hex = piecePaletteHex(state.palette, state.selectedIdx);
      // An eraser/transparent shape still needs to be visible while dragging,
      // hence the white stand-in rather than drawing nothing.
      c.fillStyle = (hex === 'transparent') ? 'rgba(255,255,255,0.45)' : hex;
      c.globalAlpha = 0.7;
      for (const [x, y] of shapeCells(state.shape)) c.fillRect(x * cell, y * cell, cell, cell);
      c.globalAlpha = 1;
    }
    if (state.grid) {
      c.strokeStyle = 'rgba(255,255,255,0.09)';
      c.lineWidth = 1;
      c.beginPath();
      for (let i = 1; i < S; i++) {
        const p = Math.round(i * cell) + 0.5;
        c.moveTo(p, 0); c.lineTo(p, canvas.height);
        c.moveTo(0, p); c.lineTo(canvas.width, p);
      }
      c.stroke();
      // Every 8th line a touch stronger: counting to 32 one faint cell at a
      // time is the main thing that makes pixel grids hard to read.
      c.strokeStyle = 'rgba(255,255,255,0.2)';
      c.beginPath();
      for (let i = 8; i < S; i += 8) {
        const p = Math.round(i * cell) + 0.5;
        c.moveTo(p, 0); c.lineTo(p, canvas.height);
        c.moveTo(0, p); c.lineTo(canvas.width, p);
      }
      c.stroke();
    }
    if (state.mirror) {
      c.strokeStyle = 'rgba(220,160,255,0.55)';
      c.lineWidth = 2;
      c.beginPath();
      const mid = Math.round(S / 2 * cell);
      c.moveTo(mid, 0); c.lineTo(mid, canvas.height);
      c.stroke();
    }
    if (ids.onChange) ids.onChange(state.pixels);
  }

  function wire() {
    renderPalette();
    if (el(ids.colourAddBtn)) el(ids.colourAddBtn).addEventListener('click', () => openColourPicker('add'));
    if (el(ids.colourEditBtn)) el(ids.colourEditBtn).addEventListener('click', () => openColourPicker('replace'));

    document.querySelectorAll('#' + ids.tools + ' .bd-tool').forEach(btn => {
      btn.addEventListener('click', () => {
        state.tool = btn.dataset.tool;
        document.querySelectorAll('#' + ids.tools + ' .bd-tool').forEach(b => b.classList.toggle('active', b === btn));
      });
    });

    el(ids.clearBtn).addEventListener('click', () => { state.pixels.fill(0); pushHistory(); redraw(); });
    if (el(ids.undoBtn)) el(ids.undoBtn).addEventListener('click', undo);
    if (el(ids.redoBtn)) el(ids.redoBtn).addEventListener('click', redo);
    if (el(ids.flipHBtn)) el(ids.flipHBtn).addEventListener('click', () => transform((x, y) => [S - 1 - x, y]));
    if (el(ids.flipVBtn)) el(ids.flipVBtn).addEventListener('click', () => transform((x, y) => [x, S - 1 - y]));
    if (el(ids.rotateBtn)) el(ids.rotateBtn).addEventListener('click', () => transform((x, y) => [y, S - 1 - x]));
    if (el(ids.gridBtn)) el(ids.gridBtn).addEventListener('click', () => {
      state.grid = !state.grid;
      el(ids.gridBtn).classList.toggle('active', state.grid);
      redraw();
    });
    if (el(ids.mirrorBtn)) {
      el(ids.mirrorBtn).classList.toggle('active', state.mirror);
      el(ids.mirrorBtn).addEventListener('click', () => {
        state.mirror = !state.mirror;
        el(ids.mirrorBtn).classList.toggle('active', state.mirror);
        redraw();
      });
    }

    const canvas = el(ids.canvas);
    function posToCell(e) {
      const rect = canvas.getBoundingClientRect();
      const x = Math.floor((e.clientX - rect.left) / rect.width * S);
      const y = Math.floor((e.clientY - rect.top) / rect.height * S);
      return { x: Math.max(0, Math.min(S - 1, x)), y: Math.max(0, Math.min(S - 1, y)) };
    }
    function paintAt(x, y) {
      setPixel(x, y, state.tool === 'eraser' ? 0 : state.selectedIdx);
      redraw();
    }

    canvas.addEventListener('pointerdown', e => {
      const { x, y } = posToCell(e);
      const t = state.tool;
      // Picking a colour is not an edit — no history entry, no stroke started.
      if (t === 'eyedrop') { state.selectedIdx = state.pixels[y * S + x]; syncPalette(); return; }
      if (t === 'fill') {
        const target = state.pixels[y * S + x];
        floodFill(x, y, target, state.selectedIdx);
        if (state.mirror) {
          const mx = S - 1 - x;
          if (mx !== x) floodFill(mx, y, state.pixels[y * S + mx], state.selectedIdx);
        }
        pushHistory();
        redraw();
        return;
      }
      if (t === 'line' || t === 'rect') {
        state.painting = true;
        state.shape = { tool: t, x0: x, y0: y, x1: x, y1: y };
        redraw();
        return;
      }
      // The snapshot is taken when the stroke ENDS (see pointerup), so a whole
      // drag is one Undo step rather than one per pixel crossed.
      state.painting = true;
      state.strokeDirty = true;
      paintAt(x, y);
    });
    canvas.addEventListener('pointermove', e => {
      if (!state.painting) return;
      const { x, y } = posToCell(e);
      if (state.shape) { state.shape.x1 = x; state.shape.y1 = y; redraw(); return; }
      paintAt(x, y);
    });
    // On window, not the canvas: releasing outside the grid must still end the
    // stroke, otherwise the next hover keeps painting without a button held.
    window.addEventListener('pointerup', () => {
      if (state.shape) {
        for (const [x, y] of shapeCells(state.shape)) {
          if (x >= 0 && y >= 0 && x < S && y < S) state.pixels[y * S + x] = state.selectedIdx;
        }
        state.shape = null;
        pushHistory();
        redraw();
      } else if (state.strokeDirty) {
        state.strokeDirty = false;
        pushHistory();
      }
      state.painting = false;
    });

    pushHistory();   // history[0] is the empty canvas, so Undo can reach it
    redraw();
  }

  return {
    state, wire, redraw, undo, redo,
    // Used when loading an existing piece into the editor: replaces the art
    // and restarts the history from that point.
    //
    // `palette` is the loaded piece's own colour table. Omitted (or empty), the
    // drawing falls back to the built-in swatches, which is the correct answer
    // for a piece stored in one of the two 16-colour packings, since its
    // indices were written against exactly that list.
    setArt(src, palette) {
      state.pixels.set(src);
      state.palette = (palette && palette.length) ? palette.slice() : defaultPiecePalette();
      if (state.selectedIdx >= state.palette.length) state.selectedIdx = 0;
      state.history.length = 0; state.histIdx = -1;
      pushHistory();
      renderPalette();
      redraw();
    },
    isBlank: () => !state.pixels.some(v => v !== 0)
  };
}

// =========================================================
// BLOCK DESIGNER — see PIECE_KINDS / encodeBlockPieceCode /
// registerCustomBlockPieces above. Lazily wired up on first open, same pattern
// as mbInit()/toggleModBuilder().
// =========================================================
let bdInitDone = false;
let bdEditor = null;
// Set while a saved block is loaded for editing; bdSave() replaces that piece
// instead of adding a second copy. Cleared on save or on a fresh drawing.
let bdEditingId = null;
// Hardness/soundFamily no longer have sliders (see setBlockMining in the Mod
// Editor), but the codec still carries both fields for backward compatibility
// with every already-shared block code. Re-saving an edited block should keep
// whatever it already had, not silently reset it to the new-block default —
// this is where the decoded original is held between "Edit" and "Save" so
// bdSave() can tell the two cases apart. null means "this is a new block",
// which is exactly when the field default is correct.
let bdEditingBlockMeta = null;

function _bdField(k) { return BLOCK_PIECE_FIELDS.find(f => f.k === k); }

function bdRenderPieceList() {
  const el = document.getElementById('bd-piece-list');
  const pieces = VxPieces.list('BLOCK');
  if (!pieces.length) { el.innerHTML = '<div class="mb-hint">No custom blocks yet — paint one above.</div>'; return; }
  el.innerHTML = pieces.map(p => `
    <div class="bd-piece-row" data-id="${p.localId}">
      <label class="mb-check"><input type="checkbox" class="bd-piece-enable" ${p.enabled !== false ? 'checked' : ''}></label>
      <span class="bd-piece-name">${escapeHtml(p.name)}</span>
      <button type="button" class="bd-piece-edit">Edit</button>
      <button type="button" class="bd-piece-delete">Delete</button>
    </div>
  `).join('');
  el.querySelectorAll('.bd-piece-enable').forEach(cb => cb.addEventListener('change', e => {
    const id = e.target.closest('.bd-piece-row').dataset.id;
    VxPieces.setEnabled(id, e.target.checked);
    reapplyCustomBlockPieces();
  }));
  // Loads a saved block back onto the canvas AND into every field, so a piece
  // can be refined instead of only deleted and redrawn from scratch. Saving
  // afterwards deletes the original, which is what makes it read as an edit
  // rather than silently leaving a near-duplicate behind.
  el.querySelectorAll('.bd-piece-edit').forEach(btn => btn.addEventListener('click', e => {
    const id = e.target.closest('.bd-piece-row').dataset.id;
    const rec = VxPieces.get(id);
    const decoded = rec && decodeBlockPieceCode(rec.code);
    if (!decoded) { showNotification('⚠️ That block could not be opened.'); return; }
    bdEditor.setArt(decoded.pixels, decoded.palette);
    document.getElementById('bd-name').value = decoded.name;
    const setRange = (elId, key) => {
      const input = document.getElementById(elId);
      input.value = modFieldToRaw(_bdField(key), decoded.block[key]);
      input.dispatchEvent(new Event('input'));
    };
    setRange('bd-mindepth', 'minDepth');
    setRange('bd-chance', 'chance');
    setRange('bd-veinsize', 'veinSize');
    document.getElementById('bd-t-glows').checked = !!(decoded.block.traits && decoded.block.traits.glows);
    document.getElementById('bd-t-orespeckle').checked = !!(decoded.block.traits && decoded.block.traits.oreSpeckle);
    bdEditingId = id;
    bdEditingBlockMeta = { hardness: decoded.block.hardness, soundFamily: decoded.block.soundFamily };
    showNotification('✏️ Editing "' + decoded.name + '" — Save replaces it.');
  }));
  el.querySelectorAll('.bd-piece-delete').forEach(btn => btn.addEventListener('click', e => {
    const id = e.target.closest('.bd-piece-row').dataset.id;
    if (bdEditingId === id) { bdEditingId = null; bdEditingBlockMeta = null; }
    VxPieces.delete(id);
    reapplyCustomBlockPieces();
    bdRenderPieceList();
  }));
}

function bdSave() {
  const name = document.getElementById('bd-name').value.trim().slice(0, 24);
  if (!name) { showNotification('⚠️ Give your block a name first.'); document.getElementById('bd-name').focus(); return; }
  if (bdEditor.isBlank()) { showNotification('⚠️ Draw something first — the block is fully transparent right now.'); return; }
  const piece = {
    name,
    pixels: bdEditor.state.pixels,
    palette: bdEditor.state.palette,
    block: {
      // No slider sets these anymore (see setBlockMining in the Mod Editor) —
      // carry forward whatever this block already had if it's being
      // re-saved, or the catalog default for a brand new one.
      hardness: bdEditingBlockMeta ? bdEditingBlockMeta.hardness : _bdField('hardness').def,
      soundFamily: bdEditingBlockMeta ? bdEditingBlockMeta.soundFamily : _bdField('soundFamily').def,
      minDepth: modRawToField(_bdField('minDepth'), parseInt(document.getElementById('bd-mindepth').value, 10)),
      chance: modRawToField(_bdField('chance'), parseInt(document.getElementById('bd-chance').value, 10)),
      veinSize: modRawToField(_bdField('veinSize'), parseInt(document.getElementById('bd-veinsize').value, 10)),
      traits: {
        glows: document.getElementById('bd-t-glows').checked,
        oreSpeckle: document.getElementById('bd-t-orespeckle').checked
      }
    }
  };
  const code = encodeBlockPieceCode(piece);
  const wasEditing = bdEditingId && VxPieces.get(bdEditingId);
  // Written BEFORE the old copy is removed, so a failed write leaves the
  // original intact rather than deleting it and then failing to replace it.
  // VxPieces.save has already explained itself if it returns null.
  if (!VxPieces.save('BLOCK', code, name)) return;
  if (wasEditing) VxPieces.delete(bdEditingId);
  bdEditingId = null;
  bdEditingBlockMeta = null;
  reapplyCustomBlockPieces();
  bdRenderPieceList();
  showNotification(wasEditing
    ? '✅ "' + name + '" updated.'
    : '✅ "' + name + '" saved — mixed into new worlds from now on.');
}

function bdInit() {
  if (bdInitDone) return;
  bdInitDone = true;

  bdEditor = createPixelEditor({
    canvas: 'bd-pixel-canvas', palette: 'bd-palette', tools: 'bd-tools', clearBtn: 'bd-clear-btn',
    colourAddBtn: 'bd-colour-add', colourEditBtn: 'bd-colour-edit', colourInfo: 'bd-colour-info',
    undoBtn: 'bd-undo-btn', redoBtn: 'bd-redo-btn',
    flipHBtn: 'bd-fliph-btn', flipVBtn: 'bd-flipv-btn', rotateBtn: 'bd-rotate-btn',
    gridBtn: 'bd-grid-btn', mirrorBtn: 'bd-mirror-btn'
  });
  bdEditor.wire();

  const mind = document.getElementById('bd-mindepth');
  mind.value = modFieldToRaw(_bdField('minDepth'), _bdField('minDepth').def);
  mind.addEventListener('input', () => { document.getElementById('bd-mindepth-val').textContent = modRawToField(_bdField('minDepth'), parseInt(mind.value, 10)) + ' blocks deep'; });
  mind.dispatchEvent(new Event('input'));

  const chance = document.getElementById('bd-chance');
  chance.value = modFieldToRaw(_bdField('chance'), _bdField('chance').def);
  chance.addEventListener('input', () => { document.getElementById('bd-chance-val').textContent = Math.round(modRawToField(_bdField('chance'), parseInt(chance.value, 10)) * 100) + '% chance per chunk'; });
  chance.dispatchEvent(new Event('input'));

  const vein = document.getElementById('bd-veinsize');
  vein.value = modFieldToRaw(_bdField('veinSize'), _bdField('veinSize').def);
  vein.addEventListener('input', () => { document.getElementById('bd-veinsize-val').textContent = 'Up to ' + modRawToField(_bdField('veinSize'), parseInt(vein.value, 10)) + ' blocks per vein'; });
  vein.dispatchEvent(new Event('input'));

  document.getElementById('bd-save-btn').addEventListener('click', bdSave);

  document.getElementById('bd-loadout-btn').addEventListener('click', bdGenerateLoadout);
  document.getElementById('bd-loadout-import-btn').addEventListener('click', bdImportLoadout);
  document.getElementById('bd-loadout-copy-btn').addEventListener('click', () => {
    if (bdCurrentLoadoutCode) copyTextWithFallback(bdCurrentLoadoutCode);
  });
  document.getElementById('bd-loadout-copy-link-btn').addEventListener('click', () => {
    if (bdCurrentLoadoutCode) copyTextWithFallback(mbBuildLocalPlayLink(bdCurrentLoadoutCode));
  });

  bdRenderPieceList();
}

// ── Loadout: bundle the enabled blocks into one shareable code ───────────
// The enabled/disabled state in the "My blocks" list doubles as the loadout's
// contents. A second, parallel "which pieces go in the code" selection was the
// obvious alternative and was deliberately not built: it would let the world a
// player is testing locally silently disagree with the code they hand out.
let bdCurrentLoadoutCode = null;

// Blocks AND creatures — one loadout carries whatever the player has enabled,
// so sharing "my world" means sharing all of it, not one category at a time.
function bdEnabledPieceCodes() {
  return VxPieces.list().filter(p => p.enabled !== false).map(p => p.code);
}

function bdGenerateLoadout() {
  const codes = bdEnabledPieceCodes();
  if (!codes.length) { showNotification('⚠️ Enable at least one block or creature to put in the loadout.'); return; }
  const mod = modDefaults();
  mod.name = 'My Loadout';
  mod.seed = document.getElementById('bd-loadout-seed').value.trim().slice(0, 60);
  const included = codes.slice(0, LOADOUT_MAX_PIECES);
  bdCurrentLoadoutCode = encodeLoadoutCode(mod, included);
  document.getElementById('bd-loadout-card').style.display = '';
  document.getElementById('bd-loadout-output').textContent = bdCurrentLoadoutCode;
  const nBlocks = included.filter(isBlockPieceCode).length;
  const nCreatures = included.filter(isCreaturePieceCode).length;
  const nGraphs = included.filter(isGraphCode).length;
  const dropped = codes.length - included.length;
  document.getElementById('bd-loadout-note').textContent =
    nBlocks + ' block(s) + ' + nCreatures + ' creature(s) + ' + nGraphs + ' mod(s) packed · ' + bdCurrentLoadoutCode.length + ' characters' +
    (dropped ? ' · ' + dropped + ' left out (max ' + LOADOUT_MAX_PIECES + ' per loadout)' : '');
  if (dropped) showNotification('⚠️ Only the first ' + LOADOUT_MAX_PIECES + ' enabled pieces fit in one loadout.');
}

// Pulls every piece out of someone else's loadout into the local library, so
// they behave exactly like self-made pieces (playable, editable, re-shareable)
// rather than being locked to that one code.
function bdImportLoadout() {
  const raw = document.getElementById('bd-loadout-import').value.trim();
  if (!raw) return;
  if (!isLoadoutCode(raw)) { showNotification('⚠️ That is not a loadout code (they start with VXL1-).'); return; }
  const loadout = decodeLoadoutCode(raw);
  if (!loadout) { showNotification('⚠️ That loadout code is corrupt or incomplete.'); return; }
  let added = 0;
  let ranOut = false;
  for (const code of loadout.pieceCodes) {
    const decoded = decodeAnyPieceCode(code);
    if (!decoded) continue;
    // Stop at the first failed write instead of grinding through the rest:
    // every remaining piece would fail the same way and fire the same toast.
    // Whatever was already added stays — a partial import is still useful, and
    // the count below reports honestly how much of it arrived.
    if (!VxPieces.save(decoded.kind, code, decoded.name)) { ranOut = true; break; }
    added++;
  }
  reapplyCustomPieces();
  bdRenderPieceList();
  if (cdInitDone) cdRenderPieceList();
  if (ngInitDone) ngRenderPieceList();
  document.getElementById('bd-loadout-import').value = '';
  // The out-of-space toast writeIndex already fired says what went wrong; this
  // one would only overwrite it with a cheerier, less accurate number.
  if (ranOut) return;
  showNotification(added
    ? '✅ Added ' + added + ' piece(s) to your library.'
    : '⚠️ That loadout contained no readable pieces.');
  if (loadout.skipped) showNotification('⚠️ ' + loadout.skipped + ' piece(s) were unreadable and were skipped.');
}

// Set by ngCreateBlock/ngCreateCreature right before they hand off from the
// Mod Editor to a designer it launched. Closing that designer then reopens
// the Mod Editor instead of falling through to the Studio panel — painting a
// block is a step inside the editor now, not a separate destination. Reset by
// vxCloseCreatorModals so a forced close-all (mode change) never bounces back
// into a modal it just closed.
let ngReturnToEditor = false;

function toggleBlockDesigner() {
  if (vxCreatorBlocks('block-designer-modal')) return;
  const modal = document.getElementById('block-designer-modal');
  modal.classList.toggle('open');
  if (modal.classList.contains('open')) bdInit();
  else if (ngReturnToEditor) { ngReturnToEditor = false; toggleModEditor(); }
  else vxStudioRefreshIfOpen();
}
window.toggleBlockDesigner = toggleBlockDesigner;

// Opens the Block Designer as a "Create a block" step from inside the Mod
// Editor — same modal, same canvas, just reached from the other side.
function ngCreateBlock() {
  ngReturnToEditor = true;
  toggleModEditor();
  toggleBlockDesigner();
}
window.ngCreateBlock = ngCreateBlock;

// Closing a designer that was opened from the main menu's Creator Studio
// drops the player back onto that panel — refresh it so a piece they just
// made is counted and shown there immediately.
function vxStudioRefreshIfOpen() {
  if (typeof window.vxStudioRefresh === 'function') {
    const panel = document.getElementById('vx-studio');
    if (panel && panel.classList.contains('show')) window.vxStudioRefresh();
  }
}

// =========================================================
// CREATURE DESIGNER — the same painted 32x32 grid as blocks, plus the
// behaviour knobs that decide how the finished creature moves through the
// world. Shares createPixelEditor() so both designers stay identical to use.
// =========================================================
let cdInitDone = false;
let cdEditor = null;
// See bdEditingId — same replace-on-save behaviour for creatures.
let cdEditingId = null;
// Move/size/speed/rarity/biome/traits no longer have sliders (see
// setCreatureBehavior in the Mod Editor) — same role as bdEditingBlockMeta:
// holds the decoded original while editing, so re-saving keeps it instead of
// resetting to the new-creature default. null means "this is a new creature."
let cdEditingCreatureMeta = null;

function _cdField(k) { return CREATURE_PIECE_FIELDS.find(f => f.k === k); }

function cdRenderPieceList() {
  const el = document.getElementById('cd-piece-list');
  const pieces = VxPieces.list('CREATURE');
  if (!pieces.length) { el.innerHTML = '<div class="mb-hint">No creatures yet — draw one above.</div>'; return; }
  el.innerHTML = pieces.map(p => `
    <div class="bd-piece-row" data-id="${p.localId}">
      <label class="mb-check"><input type="checkbox" class="bd-piece-enable" ${p.enabled !== false ? 'checked' : ''}></label>
      <span class="bd-piece-name">${escapeHtml(p.name)}</span>
      <button type="button" class="bd-piece-edit">Edit</button>
      <button type="button" class="bd-piece-delete">Delete</button>
    </div>
  `).join('');
  el.querySelectorAll('.bd-piece-enable').forEach(cb => cb.addEventListener('change', e => {
    VxPieces.setEnabled(e.target.closest('.bd-piece-row').dataset.id, e.target.checked);
    reapplyCustomPieces();
  }));
  // Same edit-in-place flow as the Block Designer's list — see the comment
  // there for why saving replaces the original rather than adding a copy.
  el.querySelectorAll('.bd-piece-edit').forEach(btn => btn.addEventListener('click', e => {
    const id = e.target.closest('.bd-piece-row').dataset.id;
    const rec = VxPieces.get(id);
    const decoded = rec && decodeCreaturePieceCode(rec.code);
    if (!decoded) { showNotification('⚠️ That creature could not be opened.'); return; }
    cdEditor.setArt(decoded.pixels, decoded.palette);
    document.getElementById('cd-name').value = decoded.name;
    cdEditingId = id;
    cdEditingCreatureMeta = {
      move: decoded.creature.move, size: decoded.creature.size, speed: decoded.creature.speed,
      rarity: decoded.creature.rarity, biome: decoded.creature.biome,
      traits: decoded.creature.traits || {}
    };
    showNotification('✏️ Editing "' + decoded.name + '" — Save replaces it.');
  }));
  el.querySelectorAll('.bd-piece-delete').forEach(btn => btn.addEventListener('click', e => {
    const id = e.target.closest('.bd-piece-row').dataset.id;
    if (cdEditingId === id) { cdEditingId = null; cdEditingCreatureMeta = null; }
    VxPieces.delete(id);
    reapplyCustomPieces();
    cdRenderPieceList();
  }));
}

function cdSave() {
  const name = document.getElementById('cd-name').value.trim().slice(0, 24);
  if (!name) { showNotification('⚠️ Give your creature a name first.'); document.getElementById('cd-name').focus(); return; }
  if (cdEditor.isBlank()) { showNotification('⚠️ Draw something first — the creature is fully transparent right now.'); return; }
  // No slider sets move/size/speed/rarity/biome/traits anymore (see
  // setCreatureBehavior in the Mod Editor) — carry forward whatever this
  // creature already had if it's being re-saved, or the catalog default for
  // a brand new one. Same reasoning as bdSave's hardness/soundFamily.
  const creature = cdEditingCreatureMeta || {
    move: _cdField('move').def, size: _cdField('size').def, speed: _cdField('speed').def,
    rarity: _cdField('rarity').def, biome: _cdField('biome').def, traits: {}
  };
  const code = encodeCreaturePieceCode({
    name, pixels: cdEditor.state.pixels, palette: cdEditor.state.palette, creature
  });
  const wasEditing = cdEditingId && VxPieces.get(cdEditingId);
  // See bdSave: save first, and only retire the old copy once the new one is
  // safely stored.
  if (!VxPieces.save('CREATURE', code, name)) return;
  if (wasEditing) VxPieces.delete(cdEditingId);
  cdEditingId = null;
  cdEditingCreatureMeta = null;
  reapplyCustomPieces();
  cdRenderPieceList();
  showNotification(wasEditing
    ? '✅ "' + name + '" updated.'
    : '✅ "' + name + '" saved — it will start appearing in the Overworld.');
}

function cdInit() {
  if (cdInitDone) return;
  cdInitDone = true;

  cdEditor = createPixelEditor({
    canvas: 'cd-pixel-canvas', palette: 'cd-palette', tools: 'cd-tools', clearBtn: 'cd-clear-btn',
    colourAddBtn: 'cd-colour-add', colourEditBtn: 'cd-colour-edit', colourInfo: 'cd-colour-info',
    undoBtn: 'cd-undo-btn', redoBtn: 'cd-redo-btn',
    flipHBtn: 'cd-fliph-btn', flipVBtn: 'cd-flipv-btn', rotateBtn: 'cd-rotate-btn',
    gridBtn: 'cd-grid-btn', mirrorBtn: 'cd-mirror-btn',
    // Creatures are almost always left/right symmetrical, so mirror starts on
    // here (the Block Designer leaves it off — ore textures usually aren't).
    mirrorDefault: true
  });
  cdEditor.wire();

  document.getElementById('cd-save-btn').addEventListener('click', cdSave);
  cdRenderPieceList();
}

function toggleCreatureDesigner() {
  if (vxCreatorBlocks('creature-designer-modal')) return;
  const modal = document.getElementById('creature-designer-modal');
  modal.classList.toggle('open');
  if (modal.classList.contains('open')) cdInit();
  else if (ngReturnToEditor) { ngReturnToEditor = false; toggleModEditor(); }
  else vxStudioRefreshIfOpen();
}
window.toggleCreatureDesigner = toggleCreatureDesigner;

// Opens the Creature Designer as a "Create a creature" step from inside the
// Mod Editor — same modal, same canvas, just reached from the other side.
function ngCreateCreature() {
  ngReturnToEditor = true;
  toggleModEditor();
  toggleCreatureDesigner();
}
window.ngCreateCreature = ngCreateCreature;

// =========================================================
// NODE ICONS — a pixel glyph per catalog entry, so a board reads as a rack of
// labelled parts rather than a flowchart of identical rectangles.
//
// Authored the same way as the game's own icon set (see VX_ICONS in the
// engine): flat fillRects on a 16px grid, two or three tones, then run through
// _vxCrispen so nothing ships a half-transparent edge next to real 32x32 block
// art. They are NOT in VX_ICONS because that set is drawn once at load by
// _initVxIcons() over static markup — these are minted per node as the board
// is built, so they need their own factory (ngMakeIcon below).
//
// The map is deliberately many-to-one: 'cube' covers every block parameter,
// 'heart' every health action, and so on. Shared glyphs are the point — they
// make the families visible at a glance, which a unique doodle per entry
// would not.
// =========================================================
const NG_ICON_PX = 16;
const NG_INK      = '#e6e6ee';
const NG_INK_DIM  = '#8f8fa0';
const NG_INK_DARK = '#14161f';

function _ngPx(c, colour, rects) {
  c.fillStyle = colour;
  for (const [x, y, w, h] of rects) c.fillRect(x, y, w, h);
}

const NG_ICONS = {
  bolt: c => _ngPx(c, '#ffd166', [
    [8,2,2,1],[7,3,3,1],[6,4,4,1],[5,5,5,1],[4,6,8,1],[4,7,7,1],
    [8,8,3,1],[7,9,3,1],[6,10,3,1],[5,11,3,1],[4,12,3,1],[4,13,2,1]]),
  // A filled disc with the hands cut into it in the shade tone. The earlier
  // outline ring lost its stroke to _vxCrispen in places and read as lopsided.
  clock: c => {
    _ngPx(c, NG_INK, [[6,2,4,1],[4,3,8,1],[3,4,10,1],[2,5,12,2],[1,7,14,2],
                      [2,9,12,2],[3,11,10,1],[4,12,8,1],[6,13,4,1]]);
    _ngPx(c, NG_INK_DARK, [[7,4,2,5],[9,8,4,2]]);
  },
  // The head is one continuous arc that the handle passes through. Drawn as
  // separate left and right chunks it broke into two floating blades.
  pick: c => {
    _ngPx(c, NG_INK, [[6,2,4,1],[4,3,8,1],[2,4,5,1],[9,4,5,1]]);
    _ngPx(c, '#8b6914', [[7,4,2,10]]);
  },
  // Three tones on a bevelled top: two flat greys side by side read as a split
  // rectangle, not as a block with volume.
  cube: c => {
    _ngPx(c, NG_INK, [[4,2,8,1],[3,3,10,1],[2,4,12,1]]);
    _ngPx(c, '#b9b9c8', [[2,5,6,9]]);
    _ngPx(c, NG_INK_DIM, [[8,5,6,9]]);
  },
  // Fingers sit on x4/x7/x10 with a clear column between each — without the
  // gaps the whole thing merges into one blob at 14px. The middle one reaches
  // higher than its neighbours and the thumb juts clear of the palm; with all
  // three the same length and the thumb tucked in, this read as a mitten.
  hand: c => _ngPx(c, NG_INK, [[4,5,2,5],[7,3,2,7],[10,5,2,5],[1,9,3,2],[4,9,8,5]]),
  // Shaft, then a foot that steps out to the right over a sole that overhangs
  // at both ends. A plain two-rect L had no toe and no heel, so it read as the
  // letter rather than as footwear.
  boot: c => {
    _ngPx(c, NG_INK, [[5,2,5,8],[5,10,7,1],[5,11,8,2]]);
    _ngPx(c, NG_INK_DIM, [[4,13,10,2]]);
  },
  heart: c => _ngPx(c, '#ff5d6c', [[3,3,4,3],[9,3,4,3],[2,5,12,3],[3,8,10,2],[4,10,8,2],[6,12,4,2]]),
  skull: c => {
    _ngPx(c, NG_INK, [[3,2,10,8],[4,10,8,2],[5,12,2,2],[9,12,2,2]]);
    _ngPx(c, NG_INK_DARK, [[5,5,2,3],[9,5,2,3],[7,8,2,2]]);
  },
  // A true oval ring: the old straight-sided version read as a battery. Built
  // as a filled oval with a smaller one punched out of it in the dark tone,
  // which keeps the ring an even thickness all the way round.
  portal: c => {
    _ngPx(c, '#c084fc', [[6,1,4,1],[4,2,8,1],[3,3,10,1],[2,4,12,8],[3,12,10,1],[4,13,8,1],[6,14,4,1]]);
    _ngPx(c, '#3b1f57', [[6,3,4,1],[5,4,6,1],[4,5,8,6],[5,11,6,1],[6,12,4,1]]);
  },
  moon: c => {
    _ngPx(c, NG_INK, [[5,1,6,2],[3,3,10,2],[2,5,12,6],[3,11,10,2],[5,13,6,2]]);
    // The bite is cleared rather than painted over: anything drawn on top
    // would still be opaque ink once _vxCrispen runs.
    c.clearRect(7, 0, 9, 12);
    _ngPx(c, NG_INK, [[7,10,3,3],[7,4,2,2]]);
    c.clearRect(9, 3, 7, 9);
  },
  sun: c => _ngPx(c, '#ffd166', [[5,5,6,6],[7,1,2,3],[7,12,2,3],[1,7,3,2],[12,7,3,2],[2,2,2,2],[12,2,2,2],[2,12,2,2],[12,12,2,2]]),
  // Third attempt, and the one that works: the universal broadcast fan — a dot
  // with three widening arcs over it. A mast read as a wine glass; rings drawn
  // around the emitter read as a table.
  signal: c => {
    _ngPx(c, NG_INK, [[7,12,3,3]]);
    _ngPx(c, '#5cd9ff', [[5,9,6,2],[4,10,1,2],[11,10,1,2],
                         [3,5,10,2],[2,6,1,3],[13,6,1,3],
                         [1,1,14,2],[0,2,1,4],[15,2,1,4]]);
  },
  dice: c => {
    _ngPx(c, NG_INK, [[2,2,12,12]]);
    _ngPx(c, NG_INK_DARK, [[4,4,2,2],[10,4,2,2],[7,7,2,2],[4,10,2,2],[10,10,2,2]]);
  },
  // A ring (same construction as `portal`, punched with the same technique)
  // with a gap left open at the top-right and a small arrowhead sitting in
  // that gap, tangent to the curve — the same shorthand every OS uses for
  // "refresh / repeat": a circle that is visibly still turning rather than a
  // closed "O", which would read as a letter or a target instead of a loop.
  loop: c => {
    _ngPx(c, '#4fd07f', [[6,1,4,1],[4,2,8,1],[3,3,10,1],[2,4,12,8],[3,12,10,1],[4,13,8,1],[6,14,4,1]]);
    _ngPx(c, NG_INK_DARK, [[6,3,4,1],[5,4,6,1],[4,5,8,6],[5,11,6,1],[6,12,4,1],
                            // The gap: eats back into the ring's top-right quarter.
                            [10,1,4,3],[12,3,3,2]]);
    // Arrowhead pointing clockwise into the gap it just made.
    _ngPx(c, '#4fd07f', [[11,4,3,2],[9,5,2,2]]);
  },
  tree: c => {
    _ngPx(c, '#5fd06a', [[6,1,4,3],[4,4,8,3],[2,7,12,3]]);
    _ngPx(c, '#8b6914', [[7,10,2,5]]);
  },
  // Three slots, three different fills — reads as "a handful of different
  // items", not one big pile of the same thing. Green top slot ties it to the
  // other two loop icons without being just a copy of the plain ring.
  stack: c => {
    _ngPx(c, NG_INK_DARK, [[1,3,14,4],[1,9,14,4]]);
    _ngPx(c, '#4fd07f', [[2,4,4,2],[8,4,4,2]]);
    _ngPx(c, NG_INK_DIM, [[2,10,3,2],[6,10,3,2],[10,10,3,2]]);
  },
  drop: c => _ngPx(c, '#5cd9ff', [[7,1,2,3],[6,4,4,2],[5,6,6,3],[4,9,8,4],[5,13,6,2]]),
  down: c => _ngPx(c, NG_INK, [[6,1,4,7],[3,8,10,1],[4,9,8,1],[5,10,6,1],[6,11,4,1],[7,12,2,1]]),
  // A label that tapers to a point, rather than a rounded blob with a stub —
  // the taper is what makes it read as a tag and not a purse.
  tag: c => {
    _ngPx(c, '#ffd166', [[2,3,8,10],[10,4,1,8],[11,5,1,6],[12,6,1,4],[13,7,1,2]]);
    _ngPx(c, NG_INK_DARK, [[4,6,2,2]]);
  },
  speech: c => {
    _ngPx(c, NG_INK, [[2,2,12,9],[4,11,4,3]]);
    _ngPx(c, NG_INK_DARK, [[4,5,2,2],[7,5,2,2],[10,5,2,2]]);
  },
  // A heater shield: broad and flat across the top, then tapering to a point.
  // The previous one was narrow and rounded at the crown, which read as a
  // lightbulb — with the blue stripe down the middle, a thermometer.
  shield: c => {
    _ngPx(c, NG_INK, [[3,2,10,1],[2,3,12,5],[3,8,10,1],[4,9,8,1],[5,10,6,1],[6,11,4,1],[7,12,2,1]]);
    _ngPx(c, '#7fc9ff', [[7,4,2,5]]);
  },
  // Spikes of deliberately uneven length and angle. The evenly spaced version
  // was indistinguishable from 'gear' and 'sun' at 14px — regular spokes read
  // as machinery no matter what colour they are.
  boom: c => {
    _ngPx(c, '#ff9a3c', [[5,5,6,1],[4,6,8,1],[3,7,10,2],[4,9,8,1],[5,10,6,1],
                         [7,1,2,4],[11,3,3,2],[12,7,4,2],[11,10,2,3],
                         [6,11,2,4],[3,10,2,3],[0,6,4,2],[3,3,2,3]]);
    _ngPx(c, '#ffd166', [[6,6,4,4]]);
  },
  star: c => _ngPx(c, '#ffd166', [[7,1,2,4],[6,4,4,3],[1,6,14,3],[4,9,8,2],[3,11,3,3],[10,11,3,3]]),
  // The waves are cyan, not grey: in the ink tone they read as two loose
  // fragments of the cone rather than as sound leaving it.
  speaker: c => {
    _ngPx(c, NG_INK, [[2,6,3,4],[5,4,3,8],[8,2,3,12]]);
    _ngPx(c, '#5cd9ff', [[12,6,1,4],[14,4,1,8]]);
  },
  // A side-on quadruped: anything with two eyes over a rounded body kept
  // reading as the 'skull' glyph next to it. Body and legs are thicker than
  // the first pass, which came out skeletal at icon size.
  beast: c => {
    _ngPx(c, NG_INK, [[3,7,10,5],[10,3,5,5],[4,12,2,3],[7,12,2,3],[11,12,2,3],[1,6,2,2],[2,5,1,2],[11,2,2,2]]);
    _ngPx(c, NG_INK_DARK, [[13,5,2,2]]);
  },
  // Arrowheads on both arms. Without them the shape is a plain bracket and
  // reads as plumbing rather than as a chain splitting in two.
  fork: c => _ngPx(c, NG_INK, [[1,7,7,2],[8,3,2,10],[10,3,3,2],[13,2,2,4],[10,11,3,2],[13,10,2,4]]),
  // A ring with a bar through it. Drawn as an outline plus a stepped diagonal
  // rather than a rotated rect, because a rotation would need the canvas
  // transform and land back on half-pixels.
  ban: c => {
    _ngPx(c, '#ff5d6c', [[5,1,6,2],[3,3,2,2],[11,3,2,2],[1,5,2,6],[13,5,2,6],[3,11,2,2],[11,11,2,2],[5,13,6,2]]);
    _ngPx(c, '#ff5d6c', [[4,10,2,2],[6,8,2,2],[8,6,2,2],[10,4,2,2]]);
  },
  math: c => {
    _ngPx(c, '#5cd9ff', [[6,1,3,3],[3,4,9,3],[6,7,3,2]]);          // plus
    _ngPx(c, '#5cd9ff', [[3,11,9,3]]);                              // minus
  },
  // A wide, flat lens. Earlier attempts made the iris large relative to the
  // white and the whole thing read as a gem instead of an eye.
  eye: c => {
    _ngPx(c, NG_INK, [[5,4,6,1],[3,5,10,1],[1,6,14,4],[3,10,10,1],[5,11,6,1]]);
    _ngPx(c, NG_INK_DARK, [[6,6,4,4]]);
    _ngPx(c, '#5cd9ff', [[7,7,2,2]]);
  },
  // Two arrows passing each other. The heads are full six-row triangles: a
  // three-row head on a two-row shaft is barely wider than the shaft itself,
  // so the earlier pair read as a wrench and a key rather than as arrows.
  swap: c => _ngPx(c, '#ffd166', [
    [2,4,9,2],  [10,2,2,1],[10,3,3,1],[10,4,4,2],[10,6,3,1],[10,7,2,1],   // upper, right
    [5,10,9,2], [4,8,2,1], [3,9,3,1], [2,10,4,2], [3,12,3,1], [4,13,2,1]]), // lower, left
  grid: c => {
    _ngPx(c, NG_INK, [[2,2,12,12]]);
    _ngPx(c, NG_INK_DARK, [[6,2,1,12],[10,2,1,12],[2,6,12,1],[2,10,12,1]]);
  },
  // Arena: a pennant on a pole. The pennant tapers by one row per step rather
  // than being a clean triangle -- at 16px a true diagonal is three grey
  // stair-steps that _vxCrispen then hardens into something lopsided, while
  // stacked rows of decreasing width stay a flag at any zoom.
  flag: c => {
    _ngPx(c, NG_INK_DIM, [[3,2,2,12]]);                                  // pole
    _ngPx(c, '#5ce46b', [[5,3,8,1],[5,4,7,1],[5,5,6,1],[5,6,5,1],[5,7,4,1]]);
  },
  // Arena: the cup. A bowl, a stem and a foot -- the handles are left off on
  // purpose, they cost two pixels a side and turn into noise next to the
  // 14px-wide rail entries.
  trophy: c => {
    _ngPx(c, '#ffd166', [[4,2,8,5],[5,7,6,1],[6,8,4,2]]);                // bowl + stem
    _ngPx(c, '#ffd166', [[4,12,8,2],[6,10,4,2]]);                        // foot
    _ngPx(c, NG_INK_DARK, [[6,4,4,2]]);                                  // shade in the bowl
  },
  // The handle is an open arch with daylight under it. Closed, it was a grey
  // lump sitting on the bag rather than something you could pick it up by.
  bag: c => {
    _ngPx(c, NG_INK_DIM, [[5,2,2,4],[10,2,2,4],[6,1,5,2]]);
    _ngPx(c, NG_INK, [[2,5,12,9]]);
    _ngPx(c, NG_INK_DARK, [[6,8,4,2]]);
  },
  gear: c => {
    _ngPx(c, NG_INK, [[6,1,4,3],[6,12,4,3],[1,6,3,4],[12,6,3,4],[3,3,3,3],[10,3,3,3],[3,10,3,3],[10,10,3,3],[4,4,8,8]]);
    _ngPx(c, NG_INK_DARK, [[6,6,4,4]]);
  }
};

const NG_KIND_ICON = { event: 'bolt', cond: 'fork', action: 'gear', loop: 'loop' };
const NODE_ICONS = {
  onWorldStart: 'bolt',   onTimer: 'clock',   onBlock: 'pick',       onPlayer: 'boot',
  onEnterDim: 'portal',   onDayPhase: 'moon', onSignal: 'signal',
  onAnnounced: 'speech',  announce: 'speech',
  onPlayerJoin: 'hand',   onPlayerLeave: 'hand',
  onPlayerEnterZone: 'grid', onPlayerLeaveZone: 'grid', ifInZone: 'grid',
  onPlayerTouch: 'hand', markZone: 'grid', teleportToZone: 'portal',
  onCountdownEnd: 'clock', setCountdown: 'clock', showBoard: 'trophy',
  setPanel: 'eye',        panelLine: 'eye',
  showDialog: 'speech',  onButtonPress: 'hand',
  onBeforeHurt: 'heart',  onBeforeMine: 'pick', onPickup: 'bag',
  onCreature: 'beast',

  repeatTimes: 'loop',   repeatWhile: 'loop',   forEachItem: 'stack',
  forEachInList: 'loop',

  ifChance: 'dice',       ifCompare: 'math',      ifBlock: 'cube',    ifState: 'drop',
  ifTextIs: 'speech',     changeText: 'speech',
  ifWorldIs: 'portal',    ifBlockAt: 'cube',      ifWearingArmor: 'shield',

  changeItems: 'cube',    changeInvolvedItem: 'stack', showText: 'speech', changeHealth: 'heart',
  setStat: 'boot',        movePlayer: 'portal',   setWorld: 'sun',
  spawnCreature: 'beast', setCreatureBehavior: 'beast', setCreatureCombat: 'beast',
  emitParticles: 'star',  shake: 'boom',      playSound: 'speaker',
  changeVar: 'tag',       changeList: 'stack',    wait: 'clock',
  callSignal: 'signal',   returnValue: 'signal',
  preventIt: 'ban',       setEventAmount: 'math', remapDrop: 'swap', setBlockMining: 'pick',
  fillArea: 'grid',

  onMatchStart: 'flag',   onMatchEnd: 'flag',     endRound: 'flag',
  ifInArena: 'grid',      ifScoreAtLeast: 'trophy', ifLeading: 'trophy',
  ifTeamScoreAtLeast: 'trophy', ifTeamLeading: 'trophy',
  addScore: 'trophy',
  // 'flag' rather than 'trophy': picking a side is what the match is played
  // BETWEEN, not something you win — the same reason the phase nodes carry it.
  setTeam: 'flag'
};
// Same dev-time completeness check ACTION_GROUPS gets: an unmapped node still
// works (it falls back to its kind's glyph) but loses the family cue the map
// exists to give, and that is invisible unless something says so.
(function checkNodeIconsComplete() {
  for (const type of Object.keys(NODE_CATALOG)) {
    if (!NODE_ICONS[type]) console.warn('Voxeria: node "' + type + '" has no entry in NODE_ICONS — falling back to its kind glyph.');
    else if (!NG_ICONS[NODE_ICONS[type]]) console.warn('Voxeria: node "' + type + '" points at unknown icon "' + NODE_ICONS[type] + '".');
  }
})();

function ngIconFor(type) {
  const def = NODE_CATALOG[type];
  return NODE_ICONS[type] || (def && NG_KIND_ICON[def.kind]) || 'gear';
}
// Ein Canvas je Icon war der teuerste Einzelposten beim Öffnen eines Boards:
// 60 Karten kosteten allein dafür rund 39 ms, weil jedes Mal ein Canvas samt
// 2D-Kontext entsteht und neu gezeichnet wird, obwohl höchstens 34 verschiedene
// Icons existieren.
//
// Jedes Icon wird deshalb genau einmal gezeichnet und als Data-URL behalten;
// die Karten bekommen davon ein <img>, das um ein Vielfaches billiger ist.
// Sicher ist das, weil die Zeichenfunktionen in NG_ICONS mit festen Farbwerten
// arbeiten und nichts aus dem Stil der Seite lesen. Ein Icon sieht deshalb
// gebacken genauso aus wie frisch gezeichnet.
const _ngIconUrls = new Map();
function ngIconDataUrl(key) {
  let url = _ngIconUrls.get(key);
  if (url !== undefined) return url;
  const cv = document.createElement('canvas');
  cv.width = NG_ICON_PX; cv.height = NG_ICON_PX;
  (NG_ICONS[key] || NG_ICONS.gear)(cv.getContext('2d'));
  if (typeof _vxCrispen === 'function') _vxCrispen(cv);
  url = cv.toDataURL();
  _ngIconUrls.set(key, url);
  return url;
}
function ngMakeIcon(type, className) {
  const img = document.createElement('img');
  img.className = className;
  img.src = ngIconDataUrl(ngIconFor(type));
  img.alt = '';
  // Sonst zieht der Browser das Bild beim Verschieben einer Karte als eigenes
  // Drag-Objekt mit, was die Karte selbst am Ziehen hindert.
  img.draggable = false;
  return img;
}

// The editor's own look, injected from here so the whole mod system stays in
// one file. index.html carries the base .ng-* rules and these override them on
// source order alone (same specificity), so the tag has to land AFTER the
// document's own — which means the end of <body>, not <head>: the game's main
// stylesheet is a <style> inside the body, so anything appended to the head
// would lose to it.
let ngStyleDone = false;
function ngInjectStyle() {
  if (ngStyleDone) return;
  ngStyleDone = true;
  const st = document.createElement('style');
  st.textContent = `
    .ng-node-icon, .ng-pal-icon {
      width: 14px; height: 14px; flex-shrink: 0; image-rendering: pixelated;
    }
    /* Bedingungs-Marke an einem Mod in der Liste "My mods". Bernstein, weil es
       eine Einschraenkung ist und keine Auszeichnung. */
    .ng-needs {
      display: inline-block; margin-left: 6px; padding: 1px 5px;
      border: 1px solid rgba(255, 213, 74, 0.45); border-radius: 3px;
      background: rgba(255, 213, 74, 0.10); color: #ffd54a;
      font-size: 9.5px; letter-spacing: 0.04em; vertical-align: middle;
      white-space: nowrap;
    }
    .ng-pal-btn { display: flex; align-items: center; gap: 7px; }
    .ng-pal-icon { opacity: 0.85; }
    .ng-pal-btn:hover .ng-pal-icon { opacity: 1; }

    /* Ports as physical connectors, not dots: the output is a plug with two
       prongs, the input a socket with a slot. Both keep the original 13x13
       box so their centres still line up with ngPortPos()'s maths — only the
       prongs stick out, via pseudo-elements that don't affect layout. */
    .ng-port { border-radius: 0; image-rendering: pixelated; }
    .ng-port-in {
      background: #10131c; border-color: #3a4055;
    }
    .ng-port-in::after {
      content: ''; position: absolute; left: 1px; right: 1px; top: 3px;
      height: 3px; background: #5c6478;
    }
    .ng-port-out { background: #7fd0ff; border-color: #24304a; }
    .ng-port-out[data-port="no"] { background: #e0a642; }
    .ng-port-out::before, .ng-port-out::after {
      content: ''; position: absolute; right: -6px; width: 6px; height: 2px;
      background: inherit;
    }
    .ng-port-out::before { top: 1px; }
    .ng-port-out::after  { bottom: 1px; }
    .ng-port-out:hover, .ng-port-out[data-port="no"]:hover { background: var(--accent); }
    .ng-port-out:hover { border-color: var(--accent); }

    /* Nodes read as machined parts: square corners and a lit top edge, so a
       board of them looks assembled rather than drawn. */
    .ng-node { border-radius: 2px; }

    /* ── Board tools ─────────────────────────────────────────────────── */
    .ng-tools {
      position: absolute; top: 10px; left: 10px; z-index: 6;
      display: flex; align-items: center; gap: 3px;
      background: rgba(12,14,20,0.92); border: 1px solid var(--line-2);
      border-radius: 3px; padding: 3px;
      box-shadow: 0 4px 14px rgba(0,0,0,0.45);
    }
    .ng-tool {
      width: 26px; height: 26px; padding: 0;
      background: transparent; border: 1px solid transparent; border-radius: 2px;
      color: var(--text-2); font-size: 13px; line-height: 1;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
    }
    .ng-tool:hover:not(:disabled) { background: var(--surface-3); color: var(--text-1); border-color: var(--line-2); }
    .ng-tool:disabled { opacity: 0.3; cursor: default; }
    .ng-tool.active { background: var(--accent-dim); border-color: var(--accent); color: var(--text-1); }
    .ng-tool-sep { width: 1px; height: 16px; background: var(--line-2); margin: 0 2px; }
    /* Shown again only by the landscape-phone block in index.html, where the
       palette and settings columns become drawers that need a way back. */
    .ng-tool.ng-mobile-only, .ng-tool-sep.ng-mobile-only { display: none; }
    .ng-scrim { display: none; }

    /* ── Selection ───────────────────────────────────────────────────── */
    .ng-node.picked { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-dim), 0 6px 18px rgba(0,0,0,0.5); }
    .ng-marquee {
      position: absolute; z-index: 5; pointer-events: none;
      border: 1px solid var(--accent); background: var(--accent-dim);
    }

    /* ── Minimap ─────────────────────────────────────────────────────── */
    .ng-minimap {
      position: absolute; right: 10px; bottom: 10px; z-index: 6;
      background: rgba(12,14,20,0.92); border: 1px solid var(--line-2);
      border-radius: 3px; padding: 3px; cursor: pointer;
      box-shadow: 0 4px 14px rgba(0,0,0,0.45);
    }
    .ng-minimap canvas { display: block; }

    /* ── First-run coach ─────────────────────────────────────────────── */
    .ng-coach {
      position: absolute; left: 10px; bottom: 10px; z-index: 6; width: 232px;
      background: rgba(12,14,20,0.94); border: 1px solid var(--line-2);
      border-left: 3px solid var(--accent);
      border-radius: 3px; padding: 9px 11px;
      box-shadow: 0 4px 14px rgba(0,0,0,0.45);
      font-size: 11px; color: var(--text-2);
    }
    .ng-coach-title {
      font-weight: 800; color: var(--text-1); font-size: 11.5px;
      margin-bottom: 6px; display: flex; align-items: center; justify-content: space-between;
    }
    .ng-coach-close {
      background: transparent; border: none; color: var(--text-3);
      cursor: pointer; font-size: 12px; line-height: 1; padding: 0 2px;
    }
    .ng-coach-close:hover { color: var(--text-1); }
    .ng-coach-step { display: flex; gap: 7px; align-items: flex-start; margin-bottom: 5px; }
    .ng-coach-step:last-child { margin-bottom: 0; }
    .ng-coach-tick {
      flex-shrink: 0; width: 14px; height: 14px; border-radius: 50%;
      border: 1px solid var(--line-2); color: transparent;
      font-size: 9px; line-height: 12px; text-align: center; margin-top: 1px;
    }
    .ng-coach-step.done .ng-coach-tick { background: #3fae6a; border-color: #3fae6a; color: #fff; }
    .ng-coach-step.done .ng-coach-text { color: var(--text-3); text-decoration: line-through; }
    .ng-coach-step.now .ng-coach-text { color: var(--text-1); font-weight: 700; }

    /* While a wire is in flight. The socket the plug would enter lights up and
       lifts slightly; nodes that could never take it (events, and the node the
       wire came from) fade back so the eye goes straight to the real options.
       Transitions are short: this has to feel like a latch, not an animation. */
    .ng-node.snap-target {
      border-color: #8effa0;
      box-shadow: 0 0 0 2px rgba(142,255,160,0.55), 0 8px 22px rgba(0,0,0,0.5);
    }
    .ng-node.snap-target .ng-port-in {
      background: #8effa0; border-color: #8effa0;
      transform: scale(1.35);
    }
    .ng-node.snap-blocked { opacity: 0.45; }
    .ng-node, .ng-port-in { transition: opacity 0.1s, box-shadow 0.1s, border-color 0.1s, transform 0.1s; }
    .ng-node-head { border-radius: 1px 1px 0 0; box-shadow: inset 0 1px 0 rgba(255,255,255,0.22); }
  `;
  document.body.appendChild(st);
}

// =========================================================
// MOD EDITOR — the node graph UI. Nodes are real DOM elements (so their
// inputs, selects and buttons just work) positioned inside a pannable
// world layer; the wires between them are one SVG underneath. Everything
// here only ever edits `ngGraph`, and ngRender() redraws from it — there is
// no second copy of the truth living in the DOM.
// =========================================================
// Ready-made small graphs offered on the empty board — the node-editor
// equivalent of the Mod Builder's MB_PRESETS (see mbApplyPreset). A beginner
// facing a blank canvas has to already know which two of ~55 blocks to reach
// for; these are exactly that starting point, pre-picked and pre-wired.
// Loaded verbatim, then the player owns and can rewire every part of it —
// nothing here is special or protected once it's on the board.
// Node ids follow ngNewId()'s own scheme ('n' + base36 counter) so a loaded
// example's ids look indistinguishable from ones the editor would generate
// itself, and ngLoadGraph's own id-scan (see there) picks up the counter
// correctly for whatever gets added next.
// Jedes Beispiel traegt drei Dinge: was es IST (name), was es TUT (desc) und
// welche Faehigkeit des Systems es VORFUEHRT (teaches). Das dritte ist der
// eigentliche Zweck der Liste. Ohne es liest sich die Sammlung als "hier sind
// ein paar fertige Mods"; mit ihm als Landkarte dessen, was der Katalog
// ueberhaupt kann, und das ist die Frage, mit der jemand den Editor aufmacht.
//
// teaches nennt die Bausteine und beschreibt nicht noch einmal, was passiert:
// das steht schon in desc und stuende sonst zweimal auf derselben Karte.
//
// Eine Bedingungsmarke ("Arena", "2+ players") gibt es hier bewusst NICHT als
// Feld. Sie kommt aus den Knoten des Beispiels selbst (ngNeedsHtml), also aus
// dem, was das Beispiel tatsaechlich benutzt, statt aus einer Angabe, die
// jemand beim Hinzufuegen vergessen koennte.
const NG_EXAMPLES = [
  {
    name: 'Double Jump Rune',
    desc: 'Touch the block to get an extra jump in the air.',
    teaches: 'Block trigger + player stat',
    nodes: [
      { id: 'n1', type: 'onBlock', x: 40,  y: 40, params: { how: 'touches', block: BLOCKS.TORCH } },
      { id: 'n2', type: 'setStat', x: 300, y: 40, params: { stat: 'air jumps', to: { s: VALUE_FIXED, n: 2, v: 'SCORE' } } }
    ],
    wires: [ { from: 'n1', fromPort: 'out', to: 'n2' } ]
  },
  {
    name: 'Reward Trigger',
    desc: 'Touch the block to receive an item.',
    teaches: 'Block trigger + inventory',
    nodes: [
      { id: 'n1', type: 'onBlock', x: 40,  y: 40, params: { how: 'touches', block: BLOCKS.RAINBOW_ORE } },
      { id: 'n2', type: 'changeItems', x: 300, y: 40,
        params: { how: 'Give', block: BLOCKS.DIAMOND_ORE, count: { s: VALUE_FIXED, n: 1, v: 'SCORE' } } }
    ],
    wires: [ { from: 'n1', fromPort: 'out', to: 'n2' } ]
  },
  {
    name: 'Night Watcher',
    desc: 'Sparkles appear the moment night falls.',
    teaches: 'World event + effects',
    nodes: [
      { id: 'n1', type: 'onDayPhase', x: 40,  y: 40, params: { phase: 'night falls' } },
      { id: 'n2', type: 'emitParticles', x: 300, y: 40,
        params: { at: 'the player', color: 'cyan',
                  amount: { s: VALUE_FIXED, n: 14, v: 'SCORE' },
                  power: { s: VALUE_FIXED, n: 6, v: 'SCORE' } } }
    ],
    wires: [ { from: 'n1', fromPort: 'out', to: 'n2' } ]
  },
  // Shows the two things the collapsed catalog made sayable that nothing could
  // say before: a number driven by a live reading, and a pause inside a chain.
  {
    name: 'Depth Meter',
    desc: 'Every few seconds, tell the player how deep they are.',
    teaches: 'Timer + live reading in a number slot',
    nodes: [
      { id: 'n1', type: 'onTimer', x: 40, y: 40, params: { seconds: 5 } },
      { id: 'n2', type: 'changeVar', x: 300, y: 40,
        params: { name: 'DEPTH', op: 'set to', to: { s: 'depth', n: 0, v: 'SCORE' } } },
      { id: 'n3', type: 'showText', x: 560, y: 40,
        params: { where: 'floating on the player', text: 'Depth',
                  number: { s: VALUE_VAR, n: 0, v: 'DEPTH' }, color: 'cyan' } }
    ],
    wires: [ { from: 'n1', fromPort: 'out', to: 'n2' },
             { from: 'n2', fromPort: 'out', to: 'n3' } ]
  }
];

// Im selben Geist wie checkActionGroupsComplete weiter oben: teaches ist der
// Grund, aus dem diese Liste existiert, also faellt ein Beispiel ohne es beim
// Laden auf und nicht erst, wenn jemand die Karten anschaut.
(function checkExamplesTeach() {
  for (const ex of NG_EXAMPLES) {
    if (!ex.teaches) console.warn('Voxeria: example "' + ex.name + '" has no teaches: line, so its card cannot say what it demonstrates.');
  }
})();

// Deep-cloned per load — ngLoadGraph hands the array straight to ngGraph, and
// every edit after that (drag, param change, delete) mutates it in place. Without
// the clone, loading "Doppelsprung-Rune" twice and dragging a node the first
// time would move it in NG_EXAMPLES itself, so the SECOND load would already
// be someone's edited copy instead of the original.
function ngLoadExample(ex) {
  ngEditingId = null; // an example is not "editing" a saved piece — Save makes a new one
  ngLoadGraph(JSON.parse(JSON.stringify({ name: ex.name, nodes: ex.nodes, wires: ex.wires })));
  showNotification('📋 Loaded "' + ex.name + '". Look it over and change anything you like.');
}

let ngInitDone = false;
let ngGraph = { name: '', nodes: [], wires: [] };
let ngEditingId = null;      // set while a saved mod is loaded, see ngSave
let ngPan = { x: 40, y: 40 };
let ngZoom = 1;
const NG_ZOOM_MIN = 0.4, NG_ZOOM_MAX = 1.6;
// How close (in board units) the plug has to get to a socket before it snaps
// in. Generous on purpose: the socket itself is a 13px dot, and asking anyone
// to hit that while dragging is needless precision work.
const NG_SNAP_RADIUS = 60;

// ── Touch ─────────────────────────────────────────────────────────────────
// Live pointers on the board, by pointerId. Only ever more than one on a touch
// screen, and that is exactly what a pinch is: the second finger landing turns
// whatever single-finger gesture was in progress into a zoom.
const ngPointers = new Map();
let ngPinch = null;   // { dist, zoom, cx, cy } while two fingers are down

// The drawers only exist in the landscape-phone layout; on desktop the rail and
// the side column are ordinary columns and these do nothing. Opening one closes
// the other, because at this size they overlap.
function ngSetDrawer(which, open) {
  const modal = document.getElementById('mod-editor-modal');
  if (!modal) return;
  const cls = which === 'rail' ? 'rail-open' : 'side-open';
  const other = which === 'rail' ? 'side-open' : 'rail-open';
  modal.classList.remove(other);
  modal.classList.toggle(cls, open === undefined ? !modal.classList.contains(cls) : !!open);
}
function ngCloseDrawers() {
  const modal = document.getElementById('mod-editor-modal');
  if (modal) modal.classList.remove('rail-open', 'side-open');
}

// ── Undo / redo ───────────────────────────────────────────────────────────
// Whole-board snapshots rather than a log of reversible operations. A graph is
// small (60 nodes at most, and the same JSON the share code already round-trips)
// so copying it is cheap, and it removes a whole category of bug: there is no
// "undo of a delete" that has to remember which wires the delete also removed,
// because the snapshot already has them.
//
// Snapshots are taken BEFORE a change, by ngCommit(), so undo lands on the state
// as it was just before the thing you regret. ngHistory[ngHistoryIdx] is always
// the state currently on screen.
let ngHistory = [];
let ngHistoryIdx = -1;
const NG_HISTORY_MAX = 60;
// Set while undo/redo is itself writing to the board, so the change it makes
// does not get recorded as a new step.
let ngRestoring = false;

function ngSnapshot() {
  return JSON.stringify({
    name: ngGraph.name,
    nodes: ngGraph.nodes.map(n => ({ id: n.id, type: n.type, x: n.x, y: n.y, params: n.params })),
    wires: ngGraph.wires.map(w => ({ from: w.from, fromPort: w.fromPort, to: w.to }))
  });
}

// Called before every board-changing action. Records the state as it is right
// now, and drops any redo steps ahead of it: once you change something after
// undoing, the branch you had undone is gone, which is what every editor does.
function ngCommit() { ngCommitSnapshot(ngSnapshot()); }

// Records one specific snapshot as the step to come back to. Split out from
// ngCommit for the text fields, which have to record the state as it was when
// typing STARTED rather than when the change was noticed (by then the field has
// already written its new value into the node).
function ngCommitSnapshot(snap) {
  if (ngRestoring) return;
  // Truncation happens even when the snapshot turns out to be identical to the
  // current entry. That case is the norm right after an undo, and skipping it
  // there left the redo branch alive after the board had already moved on, so
  // Redo would replay a future that no longer belonged to this board.
  if (ngHistoryIdx < ngHistory.length - 1) ngHistory = ngHistory.slice(0, ngHistoryIdx + 1);
  // Nothing actually differs (a drag that ended where it began, a dropdown set
  // to what it already was) — recording it would make Ctrl+Z appear broken by
  // spending a press on a step with no visible effect.
  if (ngHistoryIdx >= 0 && ngHistory[ngHistoryIdx] === snap) { ngUpdateTools(); return; }
  ngHistory.push(snap);
  if (ngHistory.length > NG_HISTORY_MAX) ngHistory.shift();
  ngHistoryIdx = ngHistory.length - 1;
  ngUpdateTools();
}

// Wires a text-ish field so one visit to it costs exactly one undo step, taken
// from before the first keystroke. `focus` alone would record on a mere click
// (and throw away the redo branch for a field nobody ended up editing); `change`
// alone would record the value that was just typed.
function ngWireTextHistory(el) {
  let atFocus = null;
  el.addEventListener('focus', () => { atFocus = ngSnapshot(); });
  el.addEventListener('change', () => {
    if (atFocus !== null) { ngCommitSnapshot(atFocus); atFocus = null; }
  });
}

// Starts a fresh timeline. Used when the board is replaced wholesale (load,
// new board, an example), where undoing back into the previous mod would be
// surprising rather than helpful.
function ngResetHistory() {
  ngHistory = [ngSnapshot()];
  ngHistoryIdx = 0;
  ngUpdateTools();
}

function ngRestore(snap) {
  const g = JSON.parse(snap);
  ngRestoring = true;
  try {
    ngGraph.name = g.name;
    ngGraph.nodes = g.nodes;
    ngGraph.wires = g.wires;
    ngSelection.clear();
    const nameEl = document.getElementById('ng-name');
    if (nameEl && nameEl.value !== g.name) nameEl.value = g.name;
    // The DOM is thrown away rather than diffed: a restored node may differ in
    // any of its fields, and rebuilding is both simpler and fast enough here.
    const world = ngWorld();
    if (world) world.querySelectorAll('.ng-node').forEach(el => el.remove());
    ngHeights.clear();
    ngWidths.clear();
    ngRender();
  } finally {
    ngRestoring = false;
  }
  ngUpdateTools();
}

function ngUndo() {
  // ngCommit only records the state BEFORE a change, so the newest change is
  // never on the stack yet — it is only live on the board. Park it as the last
  // entry AND move the cursor onto it, so that stepping back lands on the entry
  // before it. Moving the cursor is the part that matters: without it the first
  // undo skips a step (it walked back from the entry the live state had just
  // been pushed past), which showed up as one Ctrl+Z undoing two things.
  if (ngHistoryIdx === ngHistory.length - 1) {
    const live = ngSnapshot();
    if (live !== ngHistory[ngHistoryIdx]) {
      ngHistory.push(live);
      if (ngHistory.length > NG_HISTORY_MAX) ngHistory.shift();
      ngHistoryIdx = ngHistory.length - 1;
    }
  }
  if (ngHistoryIdx <= 0) return;
  ngHistoryIdx--;
  ngRestore(ngHistory[ngHistoryIdx]);
  playSound('modNodePull');
}

function ngRedo() {
  if (ngHistoryIdx >= ngHistory.length - 1) return;
  ngHistoryIdx++;
  ngRestore(ngHistory[ngHistoryIdx]);
  playSound('modNodePull');
}

// ── Selection ─────────────────────────────────────────────────────────────
// Ids rather than node objects, so a selection survives an undo that replaced
// every node object with a fresh one parsed from JSON.
let ngSelection = new Set();
let ngGridSnap = false;
const NG_GRID = 20;

// ── Rubber-band selection ─────────────────────────────────────────────────
let ngMarquee = null;   // { x0, y0, x1, y1 } in STAGE pixels while shift-dragging

function ngDrawMarquee() {
  const el = document.getElementById('ng-marquee');
  if (!el) return;
  if (!ngMarquee) { el.hidden = true; return; }
  el.hidden = false;
  el.style.left = Math.min(ngMarquee.x0, ngMarquee.x1) + 'px';
  el.style.top = Math.min(ngMarquee.y0, ngMarquee.y1) + 'px';
  el.style.width = Math.abs(ngMarquee.x1 - ngMarquee.x0) + 'px';
  el.style.height = Math.abs(ngMarquee.y1 - ngMarquee.y0) + 'px';
}

// Anything the rectangle touches counts, not only what it fully encloses:
// having to lasso a whole node to catch it is fussy at low zoom, where the
// nodes are small but the wires between them are what you are actually aiming at.
function ngApplyMarquee() {
  if (!ngMarquee) return;
  const x0 = (Math.min(ngMarquee.x0, ngMarquee.x1) - ngPan.x) / ngZoom;
  const y0 = (Math.min(ngMarquee.y0, ngMarquee.y1) - ngPan.y) / ngZoom;
  const x1 = (Math.max(ngMarquee.x0, ngMarquee.x1) - ngPan.x) / ngZoom;
  const y1 = (Math.max(ngMarquee.y0, ngMarquee.y1) - ngPan.y) / ngZoom;
  ngSelection.clear();
  for (const n of ngGraph.nodes) {
    const nx1 = n.x + ngNodeWidth(n), ny1 = n.y + ngNodeHeight(n);
    if (n.x < x1 && nx1 > x0 && n.y < y1 && ny1 > y0) ngSelection.add(n.id);
  }
  ngMarkSelection();
}

// ── Fit and tidy ──────────────────────────────────────────────────────────
// Frames every node with a margin. Also the recovery route for a board that
// has been panned into empty space, which otherwise looks like lost work.
function ngFitToScreen() {
  if (!ngGraph.nodes.length) return;
  const stage = ngStage().getBoundingClientRect();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of ngGraph.nodes) {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + ngNodeWidth(n));
    maxY = Math.max(maxY, n.y + ngNodeHeight(n));
  }
  const pad = 40;
  const zx = stage.width / (maxX - minX + pad * 2);
  const zy = stage.height / (maxY - minY + pad * 2);
  ngZoom = Math.max(NG_ZOOM_MIN, Math.min(NG_ZOOM_MAX, Math.min(zx, zy)));
  ngPan.x = stage.width / 2 - ((minX + maxX) / 2) * ngZoom;
  ngPan.y = stage.height / 2 - ((minY + maxY) / 2) * ngZoom;
  ngRender();
}

// Lays the board out left to right in the order the chains actually run:
// every event starts a column, and each node it reaches sits one column right
// of the furthest thing that reaches it. That last part is what stops a node
// with two inputs from being dragged back on top of its own feeder.
function ngTidyLayout() {
  if (!ngGraph.nodes.length) return;
  ngCommit();
  const byId = new Map(ngGraph.nodes.map(n => [n.id, n]));
  const depth = new Map();
  const roots = ngGraph.nodes.filter(n => (NODE_CATALOG[n.type] || {}).kind === 'event');
  // Nodes nothing points at, but which are not events either (an orphan left
  // over from deleting its trigger), still deserve a column of their own.
  const targeted = new Set(ngGraph.wires.map(w => w.to));
  const starts = roots.length ? roots : ngGraph.nodes.filter(n => !targeted.has(n.id));
  for (const r of starts) depth.set(r.id, 0);
  // Repeated relaxation rather than a topological sort: a graph here can
  // contain a cycle (a signal that calls back into its own chain), which a
  // topological sort has no answer for. Bounded by the node count, so a cycle
  // simply stops improving instead of looping forever.
  for (let pass = 0; pass < ngGraph.nodes.length; pass++) {
    let changed = false;
    for (const w of ngGraph.wires) {
      if (!depth.has(w.from)) continue;
      const want = depth.get(w.from) + 1;
      if (!depth.has(w.to) || depth.get(w.to) < want) {
        if (want <= ngGraph.nodes.length) { depth.set(w.to, want); changed = true; }
      }
    }
    if (!changed) break;
  }
  // Anything still unplaced (fully disconnected) goes in the first column.
  for (const n of ngGraph.nodes) if (!depth.has(n.id)) depth.set(n.id, 0);

  const cols = new Map();
  for (const n of ngGraph.nodes) {
    const d = depth.get(n.id);
    if (!cols.has(d)) cols.set(d, []);
    cols.get(d).push(n);
  }
  const COL_W = 300, ROW_GAP = 26, X0 = 40, Y0 = 40;
  for (const [d, list] of cols) {
    let y = Y0;
    for (const n of list) {
      n.x = X0 + d * COL_W;
      n.y = y;
      y += ngNodeHeight(n) + ROW_GAP;
    }
  }
  ngRender();
  ngFitToScreen();
}

// ── Minimap ───────────────────────────────────────────────────────────────
// Drawn from the same node boxes the board uses, so it cannot disagree with
// what is on screen. Hidden while everything already fits, where it would be
// a second copy of a picture you can see in full anyway.
function ngRenderMinimap() {
  const wrap = document.getElementById('ng-minimap');
  const cv = document.getElementById('ng-minimap-cv');
  if (!wrap || !cv) return;
  const stage = ngStage();
  if (!stage || !ngGraph.nodes.length) { wrap.hidden = true; return; }
  const sr = stage.getBoundingClientRect();

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of ngGraph.nodes) {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + ngNodeWidth(n));
    maxY = Math.max(maxY, n.y + ngNodeHeight(n));
  }
  const viewX0 = -ngPan.x / ngZoom, viewY0 = -ngPan.y / ngZoom;
  const viewX1 = viewX0 + sr.width / ngZoom, viewY1 = viewY0 + sr.height / ngZoom;
  const fits = minX >= viewX0 && maxX <= viewX1 && minY >= viewY0 && maxY <= viewY1;
  if (fits) { wrap.hidden = true; return; }
  wrap.hidden = false;

  // The union of board and viewport, so the frame stays inside the map even
  // when the view has been panned right off the nodes.
  const bx0 = Math.min(minX, viewX0), by0 = Math.min(minY, viewY0);
  const bx1 = Math.max(maxX, viewX1), by1 = Math.max(maxY, viewY1);
  const pad = 20;
  const scale = Math.min(cv.width / (bx1 - bx0 + pad * 2), cv.height / (by1 - by0 + pad * 2));
  const tx = v => (v - bx0 + pad) * scale;
  const ty = v => (v - by0 + pad) * scale;

  const c = cv.getContext('2d');
  c.clearRect(0, 0, cv.width, cv.height);
  const KIND_COL = { event: '#7a4bd0', cond: '#b8862a', loop: '#2f8f5c', action: '#2f6f8f' };
  for (const n of ngGraph.nodes) {
    const def = NODE_CATALOG[n.type] || {};
    c.fillStyle = ngSelection.has(n.id) ? '#ffffff' : (KIND_COL[def.kind] || '#666');
    c.fillRect(tx(n.x), ty(n.y), Math.max(2, ngNodeWidth(n) * scale), Math.max(2, ngNodeHeight(n) * scale));
  }
  c.strokeStyle = 'rgba(255,255,255,0.85)';
  c.lineWidth = 1;
  c.strokeRect(tx(viewX0) + 0.5, ty(viewY0) + 0.5, (viewX1 - viewX0) * scale, (viewY1 - viewY0) * scale);
  // Stashed for the click handler, which turns a point on the map back into a
  // board position without recomputing any of this.
  cv._ngMap = { bx0, by0, pad, scale };
}

// ── First-run coach ───────────────────────────────────────────────────────
// Three steps, ticked off by watching the board rather than by asking the
// player to press "next": the checklist reflects what they have actually done,
// so it can never claim a step is finished when it is not. Dismissed for good
// once closed, and never shown again after the first mod is saved.
const NG_COACH_KEY = 'voxeria_ng_coach_done';
let ngCoachHidden = false;
try { ngCoachHidden = localStorage.getItem(NG_COACH_KEY) === '1'; } catch (e) {}

function ngCoachDismiss(permanent) {
  ngCoachHidden = true;
  if (permanent) { try { localStorage.setItem(NG_COACH_KEY, '1'); } catch (e) {} }
  ngCoachRefresh();
}

function ngCoachRefresh() {
  const host = document.getElementById('ng-coach');
  if (!host) return;
  const hasEvent = ngGraph.nodes.some(n => (NODE_CATALOG[n.type] || {}).kind === 'event');
  const hasSecond = ngGraph.nodes.length >= 2;
  const hasWire = ngGraph.wires.length > 0;
  // Gone once it has nothing left to teach, so it does not linger as clutter
  // over a finished board.
  if (ngCoachHidden || (hasEvent && hasSecond && hasWire)) { host.hidden = true; return; }
  host.hidden = false;
  const steps = [
    { done: hasEvent,   text: 'Pick a purple <b>event</b> from the left rail' },
    { done: hasSecond,  text: 'Add a blue <b>action</b> underneath it' },
    { done: hasWire,    text: 'Drag from the event’s right dot onto the action' }
  ];
  const firstOpen = steps.findIndex(s => !s.done);
  host.innerHTML =
    '<div class="ng-coach-title">Your first mod' +
    '<button type="button" class="ng-coach-close" id="ng-coach-close" ' +
    'title="Don’t show this again" aria-label="Dismiss">✕</button></div>' +
    steps.map((s, i) =>
      '<div class="ng-coach-step' + (s.done ? ' done' : (i === firstOpen ? ' now' : '')) + '">' +
      '<span class="ng-coach-tick">✓</span>' +
      '<span class="ng-coach-text">' + s.text + '</span></div>').join('');
  const close = document.getElementById('ng-coach-close');
  if (close) close.addEventListener('click', () => ngCoachDismiss(true));
}

function ngUpdateTools() {
  const set = (id, on) => { const b = document.getElementById(id); if (b) b.disabled = !on; };
  set('ng-undo-btn', ngHistoryIdx > 0);
  set('ng-redo-btn', ngHistoryIdx >= 0 && ngHistoryIdx < ngHistory.length - 1);
  set('ng-dup-btn', ngSelection.size > 0);
  set('ng-del-btn', ngSelection.size > 0);
  const g = document.getElementById('ng-grid-btn');
  if (g) g.classList.toggle('active', ngGridSnap);
}

function ngMarkSelection() {
  const world = ngWorld();
  if (!world) return;
  world.querySelectorAll('.ng-node').forEach(el => {
    el.classList.toggle('picked', ngSelection.has(el.dataset.id));
  });
  ngUpdateTools();
}

function ngSelectOnly(id) {
  ngSelection.clear();
  if (id) ngSelection.add(id);
  ngMarkSelection();
}

function ngDeleteSelection() {
  if (!ngSelection.size) return;
  ngCommit();
  ngGraph.nodes = ngGraph.nodes.filter(n => !ngSelection.has(n.id));
  ngGraph.wires = ngGraph.wires.filter(w => !ngSelection.has(w.from) && !ngSelection.has(w.to));
  ngSelection.clear();
  ngRender();
}

// Copies the selected nodes, offset so the copy is visibly its own thing, and
// keeps any wire whose BOTH ends were copied. A wire to something outside the
// selection is dropped rather than pointed at the original, which would silently
// wire the copy into the old chain.
function ngDuplicateSelection() {
  if (!ngSelection.size) return;
  if (ngGraph.nodes.length + ngSelection.size > GRAPH_MAX_NODES) {
    showNotification('⚠️ That would be more blocks than one mod can hold (' + GRAPH_MAX_NODES + ').');
    return;
  }
  ngCommit();
  const idMap = new Map();
  const copies = [];
  for (const n of ngGraph.nodes) {
    if (!ngSelection.has(n.id)) continue;
    const id = ngNewId();
    idMap.set(n.id, id);
    copies.push({ id, type: n.type, x: n.x + 24, y: n.y + 24,
                  params: JSON.parse(JSON.stringify(n.params)) });
  }
  const newWires = [];
  for (const w of ngGraph.wires) {
    if (idMap.has(w.from) && idMap.has(w.to)) {
      newWires.push({ from: idMap.get(w.from), fromPort: w.fromPort, to: idMap.get(w.to) });
    }
  }
  ngGraph.nodes.push(...copies);
  ngGraph.wires.push(...newWires.slice(0, Math.max(0, GRAPH_MAX_WIRES - ngGraph.wires.length)));
  ngSelection = new Set(copies.map(c => c.id));
  ngRender();
  playSound('modNodePull');
}
let ngNextId = 1;
let ngDrag = null;           // { id, dx, dy } while a node is being moved
let ngLink = null;           // { from, fromPort, x, y } while a wire is being pulled
// While a wire is being pulled, the id of the node its plug would snap into, or
// null when the cursor is not near a valid one. Drives both the preview (the
// wire jumps to the real socket instead of trailing the cursor) and the drop
// itself, so what you see before releasing is exactly what you get.
let ngSnapTo = null;
let ngPanDrag = null;
// The guide was summoned with [?] and stays up until it is closed. Without
// this flag the guide hangs entirely on whether the board is empty, which is
// what made it unreachable once the first node had been placed.
let ngHelpForced = false;

// Wider than it was: a value slot puts a source dropdown and its amount on one
// row, and at 208 the dropdown had no room to show which source is picked.
const NG_NODE_W = 248;

function ngNewId() { return 'n' + (ngNextId++).toString(36); }

function ngStage() { return document.getElementById('ng-stage'); }
function ngWorld() { return document.getElementById('ng-world'); }

// A port box is 13px square (border-box), so its centre sits 6.5px in from
// whichever edge it is pinned to. Single ports are pinned 12px from the top;
// a condition's two are pinned from the BOTTOM (see ngBuildNode) so that
// placing them needs no height at all at build time.
const NG_PORT_HALF = 6.5;
const NG_PORT_TOP = 12;
const NG_PORT_BOTTOM = { yes: 34, no: 12, body: 34, done: 12 };
// A port is positioned against the node's PADDING box, which starts one pixel
// inside the border. ngNodeHeight measures the border box (offsetHeight), so
// every offset below has to cross that 1px or the wire lands a pixel off.
const NG_NODE_BORDER = 1;

// Where a port's CENTRE sits inside the world layer — the centre, not its top
// edge, because that is where a wire has to meet it. Getting that wrong is
// invisible on a single port (the error is half a pixel) but put a
// condition's yes/no wires 7.5px above their plugs.
function ngPortPos(node, port) {
  // left:-8px / right:-8px, both from the padding box.
  const xIn  = node.x + NG_NODE_BORDER - 8 + NG_PORT_HALF;
  const xOut = node.x + ngNodeWidth(node) - NG_NODE_BORDER + 8 - NG_PORT_HALF;
  const yTop = node.y + NG_NODE_BORDER + NG_PORT_TOP + NG_PORT_HALF;
  if (port === 'in') return { x: xIn, y: yTop };
  const outs = nodePorts(node.type);
  if (outs.length < 2) return { x: xOut, y: yTop };
  const bottom = NG_PORT_BOTTOM[port] !== undefined ? NG_PORT_BOTTOM[port] : NG_PORT_BOTTOM.no;
  return { x: xOut, y: node.y + ngNodeHeight(node) - NG_NODE_BORDER - bottom - NG_PORT_HALF };
}

// Real laid-out heights, refreshed by ngRender. Measuring beats computing: the
// estimate below was out by 4-13px depending on which parameter rows a node
// carries (a block chip row is taller than a number row), and every condition's
// wires inherited that error.
const ngHeights = new Map();
function ngNodeHeight(node) {
  const measured = ngHeights.get(node.id);
  if (measured) return measured;
  // Only reached before a node's first layout — a rough shape-based guess is
  // enough to get the first frame drawn, and ngRender corrects it immediately.
  const def = NODE_CATALOG[node.type];
  const rows = def.params.length;
  return 30 + (rows ? rows * 29 + 8 : 8) + ((def.kind === 'cond' || def.kind === 'loop') ? 26 : 0);
}
// Widths get the same treatment, for a reason found the hard way: NG_NODE_W and
// the stylesheet's own `.ng-node { width }` are two copies of one number, and
// when they drifted apart every output wire started 40px clear of its plug.
// Measuring makes the rendered box the authority, so a future style change can
// no longer strand the wires.
const ngWidths = new Map();
function ngNodeWidth(node) {
  return ngWidths.get(node.id) || NG_NODE_W;
}

function ngRender() {
  const world = ngWorld();
  if (!world) return;
  world.style.transform = 'translate(' + ngPan.x + 'px,' + ngPan.y + 'px) scale(' + ngZoom + ')';
  // Two reasons to show the guide: the board is empty (automatic), or somebody
  // pressed [?] (requested). Only in the second case can it sit over existing
  // nodes, which is when it needs a background and a close button.
  const guide = document.getElementById('ng-empty');
  if (guide) {
    const boardEmpty = !ngGraph.nodes.length;
    guide.style.display = (ngHelpForced || boardEmpty) ? '' : 'none';
    guide.classList.toggle('forced', ngHelpForced && !boardEmpty);
  }
  const helpBtn = document.getElementById('ng-help-btn');
  if (helpBtn) helpBtn.classList.toggle('active', ngHelpForced);
  // The mini-sandbox's trigger list is derived from the event nodes on the
  // board, so it is refreshed here; otherwise it would show a stale set after
  // every add or delete. The LOG is deliberately left standing: it is the
  // result of the last run, and clearing it every time a node is dragged would
  // be annoying at exactly the moment you want to compare it with the chain
  // next to it.
  ngRenderTryPanel();

  // Nodes: reuse existing elements where possible so an input the player is
  // typing into does not get destroyed and lose focus on every redraw.
  const keep = new Set(ngGraph.nodes.map(n => n.id));
  world.querySelectorAll('.ng-node').forEach(elx => { if (!keep.has(elx.dataset.id)) elx.remove(); });
  for (const id of ngHeights.keys()) if (!keep.has(id)) ngHeights.delete(id);
  for (const id of ngWidths.keys()) if (!keep.has(id)) ngWidths.delete(id);
  // ZWEI Durchgänge, und das ist der Punkt: schreiben und messen dürfen sich
  // nicht abwechseln. Vorher hing in derselben Schleife ein Einhängen, ein
  // Setzen von left/top und direkt danach ein Lesen von offsetHeight. Jedes
  // Lesen zwingt den Browser, das eben Geschriebene sofort durchzurechnen, also
  // einmal pro Karte statt einmal für alle. Gemessen: 87 ms für 60 Karten so,
  // 9 ms getrennt.
  //
  // Der zweite Durchgang liest weiterhin ALLE Maße, weil ngRenderWires sie
  // gleich darauf aus den Maps nimmt und sonst selbst je Linie ein Reflow
  // auslösen würde.
  const touched = [];
  for (const node of ngGraph.nodes) {
    let elx = world.querySelector('.ng-node[data-id="' + node.id + '"]');
    if (!elx) { elx = ngBuildNode(node); world.appendChild(elx); }
    elx.style.left = node.x + 'px';
    elx.style.top = node.y + 'px';
    // Re-applied on every pass: a node element that was just rebuilt has none
    // of these classes yet, and a selection has to survive that.
    elx.classList.toggle('picked', ngSelection.has(node.id));
    touched.push([node.id, elx]);
  }
  for (const [id, elx] of touched) {
    if (elx.offsetHeight) ngHeights.set(id, elx.offsetHeight);
    if (elx.offsetWidth) ngWidths.set(id, elx.offsetWidth);
  }
  ngRenderMinimap();
  ngCoachRefresh();
  ngUpdateTools();
  // A selection can be left holding ids of nodes that no longer exist (undo,
  // delete, a fresh board), which would keep the toolbar buttons armed for
  // something that is not there.
  for (const id of [...ngSelection]) if (!keep.has(id)) ngSelection.delete(id);
  ngRenderWires();
}

// The little two-line caption under a two-port node's fields, naming what each
// output means in plain words instead of leaving the player to guess from a
// bare dot. Shared by ngBuildNode and ngRebuildNodeBody so the two can never
// drift into describing the same node kind differently.
function ngPortLabelsHtml(def) {
  if (def.kind === 'cond') {
    return '<span class="ng-port-label" style="top:-8px">yes</span>' +
           '<span class="ng-port-label" style="top:14px">no</span>';
  }
  if (def.kind === 'loop') {
    return '<span class="ng-port-label" style="top:-8px">each time</span>' +
           '<span class="ng-port-label" style="top:14px">then</span>';
  }
  return '';
}

function ngBuildNode(node) {
  const def = NODE_CATALOG[node.type];
  const elx = document.createElement('div');
  elx.className = 'ng-node k-' + def.kind;
  elx.dataset.id = node.id;

  const head = document.createElement('div');
  head.className = 'ng-node-head';
  head.appendChild(ngMakeIcon(node.type, 'ng-node-icon'));
  head.insertAdjacentHTML('beforeend', '<span class="ng-node-title">' + escapeHtml(def.label) + '</span>');
  const del = document.createElement('button');
  del.className = 'ng-node-del'; del.textContent = '✕'; del.title = 'Delete this block';
  del.addEventListener('pointerdown', e => e.stopPropagation());
  del.addEventListener('click', () => { ngDeleteNode(node.id); });
  head.appendChild(del);
  head.addEventListener('pointerdown', e => {
    // Shift adds to the selection; grabbing an unselected node makes it the
    // selection. Grabbing one that is already selected keeps the rest, which is
    // what makes dragging a group of nodes work.
    if (e.shiftKey) {
      if (ngSelection.has(node.id)) ngSelection.delete(node.id); else ngSelection.add(node.id);
      ngMarkSelection();
    } else if (!ngSelection.has(node.id)) {
      ngSelectOnly(node.id);
    }
    // Start positions for everything being moved, captured once here rather
    // than accumulated per frame, so a drag cannot drift.
    const moving = (ngSelection.has(node.id) ? [...ngSelection] : [node.id])
      .map(id => ngGraph.nodes.find(n => n.id === id))
      .filter(Boolean)
      .map(n => ({ id: n.id, startX: n.x, startY: n.y }));
    ngDrag = { id: node.id, cx: e.clientX, cy: e.clientY, moving, moved: false };
    e.stopPropagation();
  });
  elx.appendChild(head);

  const body = document.createElement('div');
  body.className = 'ng-node-body';
  for (const spec of def.params) body.appendChild(ngBuildParamRow(node, spec));
  const labels = ngPortLabelsHtml(def);
  if (labels) {
    const lab = document.createElement('div');
    lab.style.cssText = 'position:relative;height:18px';
    lab.innerHTML = labels;
    body.appendChild(lab);
  }
  elx.appendChild(body);

  if (nodeAcceptsInput(node.type)) {
    const pin = document.createElement('div');
    pin.className = 'ng-port ng-port-in';
    elx.appendChild(pin);
  }
  const outs = nodePorts(node.type);
  outs.forEach(port => {
    const p = document.createElement('div');
    p.className = 'ng-port ng-port-out';
    p.dataset.port = port;
    // Pinned from the bottom for a condition's pair, from the top for a single
    // port. Anchoring to the bottom is what lets this run before the node has
    // ever been laid out — the old version needed a height here and used an
    // estimate that was several pixels out.
    if (outs.length > 1) { p.style.top = 'auto'; p.style.bottom = NG_PORT_BOTTOM[port] + 'px'; }
    else p.style.top = NG_PORT_TOP + 'px';
    p.addEventListener('pointerdown', e => {
      e.stopPropagation();
      const from = ngPortPos(node, port);
      ngLink = { from: node.id, fromPort: port, x: from.x, y: from.y };
      ngSnapTo = null;
      // Marks which nodes could take this wire before the plug has moved at
      // all, so the answer to "where can this go?" is on screen from the first
      // frame of the drag rather than only once you happen to hover somewhere.
      ngMarkSnapTargets();
      // Exactly once per pull: this handler runs once per pointerdown, i.e.
      // once per wire started, not once per pointermove frame while it is
      // being dragged (the move handler further down only updates ngLink.x/y
      // and never touches sound).
      playSound('modNodePull');
    });
    elx.appendChild(p);
  });
  return elx;
}

// ── Auswahllisten, die erst beim Öffnen gefüllt werden ───────────────────
// Ein Board mit 60 Karten erzeugte 3360 <option>-Elemente, im Schnitt 56 je
// Karte, weil jeder Wert-Slot alle 20 Quellen als DOM-Einträge anlegt. Das war
// der Hauptteil der Zeit, die das Öffnen eines Mods gekostet hat, und fast
// alles davon war umsonst: eine Auswahlliste braucht ihre Einträge erst, wenn
// jemand sie aufklappt.
//
// Bis dahin genügt genau ein Eintrag, nämlich der gerade gewählte, damit die
// Liste richtig beschriftet dasteht. Die Einträge selbst werden als JS-Array
// weiterhin sofort berechnet: teuer sind die DOM-Knoten, nicht die Liste.
function ngFillSelect(sel) {
  if (sel._vxFilled) return;
  sel._vxFilled = true;
  const want = sel.value;
  const opts = sel._vxOptions();
  sel.innerHTML = opts.map(o =>
    '<option value="' + escapeHtml(String(o.v)) + '">' + escapeHtml(String(o.l)) + '</option>').join('');
  ngSetSelectValue(sel, want);
}
// Setzt einen Wert auch dann, wenn seine Option noch nicht angelegt ist. Ohne
// das würde eine Zuweisung an einen noch nicht gefüllten Auswahlkasten still
// auf den leeren String fallen, und die Karte zeigte plötzlich nichts an.
function ngSetSelectValue(sel, value) {
  const v = String(value == null ? '' : value);
  let has = false;
  for (let i = 0; i < sel.options.length; i++) if (sel.options[i].value === v) { has = true; break; }
  if (!has) {
    const o = document.createElement('option');
    o.value = v;
    // Beschriftung aus der echten Liste, damit ein noch ungefüllter Kasten
    // denselben Text zeigt wie ein gefüllter (bei Kreaturen ist der Wert ein
    // Index, die Beschriftung aber ein Name).
    let label = v;
    try {
      const hit = sel._vxOptions ? sel._vxOptions().find(x => String(x.v) === v) : null;
      if (hit) label = String(hit.l);
    } catch (e) {}
    o.textContent = label;
    sel.appendChild(o);
  }
  sel.value = v;
}
function ngLazySelect(className, optionsFn, current) {
  const sel = document.createElement('select');
  if (className) sel.className = className;
  sel._vxOptions = optionsFn;
  sel._vxFilled = false;
  ngSetSelectValue(sel, current);
  const fill = () => ngFillSelect(sel);
  // Jeder Weg, auf dem die Liste aufgehen kann: Maus, Tastatur, Fokus.
  sel.addEventListener('pointerdown', fill);
  sel.addEventListener('focus', fill);
  sel.addEventListener('keydown', fill);
  return sel;
}

function ngBuildParamRow(node, spec) {
  const row = document.createElement('div');
  row.className = 'ng-row';
  const label = document.createElement('span');
  label.className = 'ng-row-label';
  // The catalog's own wording, falling back to the internal key only for a spec
  // that never got one. The key is a variable name ("mult", "dx"), not
  // something a player should have to read off a block.
  label.textContent = spec.label != null ? spec.label : spec.k;
  row.appendChild(label);

  if (spec.kind === 'value') {
    // A slot is two controls in one row: what the number comes from, and, when
    // that is a fixed amount or a saved number, the amount or the name. Only
    // one of the latter two is ever shown, so the row stays one line.
    const range = graphSpecRange(spec, node.params);
    const sources = spec.sources || VALUE_SOURCE_KEYS;
    const cur = (node.params[spec.k] || {}).s;
    const sel = ngLazySelect('ng-val-src', () => sources.map(v => ({ v, l: v })), cur);
    const num = document.createElement('input');
    num.className = 'ng-val-num';
    num.type = 'number';
    num.min = range.min; num.max = range.max; num.step = range.dec ? 0.1 : 1;
    const name = document.createElement('input');
    name.className = 'ng-val-name';
    name.type = 'text';
    name.maxLength = 16;
    name.placeholder = 'SCORE';
    // The full source name as a tooltip: even with the wider share, the longest
    // entries can still be clipped at this font size, and hovering is a cheaper
    // escape hatch than making every node wider still.
    sel.title = 'Where this number comes from';
    // The nested "at position" row for VALUE_LIST_DYNAMIC. Only built when
    // this slot's own sources actually include that source: LIST_INDEX_SOURCES
    // (what the nested row itself is restricted to) deliberately excludes it,
    // so building this unconditionally would have the nested row try to build
    // a nested row of its own, forever. Guarding on `sources.includes(...)`
    // is what turns "one level of indirection" from a convention into
    // something the recursion cannot get past even if the guard were removed
    // by mistake somewhere else.
    const supportsDynList = sources.includes(VALUE_LIST_DYNAMIC);
    let idxRow = null;
    if (supportsDynList) {
      // A thin host whose `params` is a GETTER re-reading node.params[spec.k]
      // on every access rather than a value captured once: the outer write()
      // below replaces that object wholesale on every edit (same as it
      // always did), so a snapshot taken at build time would go stale the
      // first time the source, number or name field changed. A getter
      // instead means the nested row's own read/write always lands on
      // whichever object is CURRENTLY there, including one the outer write()
      // just swapped in.
      const idxHost = { get params() { return node.params[spec.k]; } };
      const idxSpecOwn = { k: 'idx', label: 'at position', kind: 'value', sources: LIST_INDEX_SOURCES,
                            min: 1, max: GRAPH_MAX_LIST, dec: 0, def: 1 };
      idxRow = ngBuildParamRow(idxHost, idxSpecOwn);
      idxRow.classList.add('ng-subrow');
      idxRow.style.marginLeft = '14px';
      idxRow.style.display = 'none';
    }

    const sync = () => {
      const val = node.params[spec.k] || {};
      // Nicht sel.value =, weil die Liste noch ungefüllt sein kann.
      ngSetSelectValue(sel, val.s);
      num.value = val.n;
      name.value = val.v;
      // "An item in a list" needs the number AND the name at once: the name
      // says which list, the number says which fixed position in it. The
      // dynamic version needs the name plus the nested row instead of the
      // number, since its position is no longer a single typed-in figure.
      const isList = val.s === VALUE_LIST;
      const isDynList = val.s === VALUE_LIST_DYNAMIC;
      const isTimer = val.s === VALUE_COUNTDOWN;
      const namesSomething = val.s === VALUE_VAR || isList || isDynList ||
                             val.s === VALUE_LIST_LEN || isTimer;
      num.style.display = (val.s === VALUE_FIXED || isList) ? '' : 'none';
      name.style.display = namesSomething ? '' : 'none';
      if (idxRow) idxRow.style.display = isDynList ? '' : 'none';
      // The placeholder names what the field is being asked for, since the same
      // two controls mean "amount"/"number name" or "position"/"list name"
      // depending on the source above them.
      name.placeholder = isTimer ? 'ROUND'
        : (isList || isDynList || val.s === VALUE_LIST_LEN) ? 'ITEMS' : 'SCORE';
      num.title = isList ? 'Which position in the list (1 is the first)' : '';
    };
    const write = () => {
      // Before the write, so undo lands on the value as it was. `change` fires
      // after the CONTROL has updated but before node.params has, which is
      // exactly the moment the old value is still readable.
      ngCommit();
      // `idx` rides along untouched so switching away from and back to this
      // source, or just renaming the list, does not reset a position the
      // player already set up in the nested row below.
      const prevIdx = node.params[spec.k] && node.params[spec.k].idx;
      node.params[spec.k] = graphCleanValue(graphSpecRange(spec, node.params),
        { s: sel.value, n: num.value, v: name.value, idx: prevIdx });
      sync();
    };
    [sel, num, name].forEach(el => el.addEventListener('pointerdown', e => e.stopPropagation()));
    sel.addEventListener('change', write);
    num.addEventListener('change', write);
    // A typed name updates live (so the board always matches the field) but
    // costs one undo step per visit, not one per keystroke.
    ngWireTextHistory(name);
    name.addEventListener('input', () => {
      const prevIdx = node.params[spec.k] && node.params[spec.k].idx;
      node.params[spec.k] = graphCleanValue(graphSpecRange(spec, node.params),
        { s: sel.value, n: num.value, v: name.value, idx: prevIdx });
    });
    sync();
    row.appendChild(sel); row.appendChild(num); row.appendChild(name);
    if (idxRow) row.appendChild(idxRow);
  } else if (spec.kind === 'textvalue') {
    // The same two-controls-in-one-row shape the number slot above uses, with
    // a text box where that one has a number box. Only one of the two is ever
    // visible, so the row stays one line like every other.
    const sources = spec.sources || TEXT_SOURCE_KEYS;
    const cur = (node.params[spec.k] || {}).s;
    const sel = ngLazySelect('ng-val-src', () => sources.map(v => ({ v, l: v })), cur);
    sel.title = 'Where this text comes from';
    const txt = document.createElement('input');
    txt.className = 'ng-val-text';
    txt.type = 'text';
    txt.maxLength = spec.max || GRAPH_MAX_TEXT;
    const name = document.createElement('input');
    name.className = 'ng-val-name';
    name.type = 'text';
    name.maxLength = 16;
    name.placeholder = 'LINE';

    const sync = () => {
      const val = node.params[spec.k] || {};
      ngSetSelectValue(sel, val.s);
      txt.value = val.t == null ? '' : val.t;
      name.value = val.v;
      txt.style.display = val.s === TEXT_FIXED ? '' : 'none';
      name.style.display = val.s === TEXT_VAR ? '' : 'none';
    };
    const write = () => {
      ngCommit();
      node.params[spec.k] = graphCleanTextValue(spec, { s: sel.value, t: txt.value, v: name.value });
      sync();
    };
    [sel, txt, name].forEach(el => el.addEventListener('pointerdown', e => e.stopPropagation()));
    sel.addEventListener('change', write);
    // Both typed fields update live but cost one undo step per visit rather
    // than one per keystroke, the same as the number slot's name field.
    ngWireTextHistory(txt);
    ngWireTextHistory(name);
    const liveWrite = () => {
      node.params[spec.k] = graphCleanTextValue(spec, { s: sel.value, t: txt.value, v: name.value });
    };
    txt.addEventListener('input', liveWrite);
    name.addEventListener('input', liveWrite);
    sync();
    row.appendChild(sel); row.appendChild(txt); row.appendChild(name);
  } else if (spec.kind === 'block') {
    const chip = document.createElement('div');
    chip.className = 'ng-blockchip';
    const cv = document.createElement('canvas');
    cv.width = 24; cv.height = 24;
    const name = document.createElement('span');
    chip.appendChild(cv); chip.appendChild(name);
    const paint = () => {
      drawBlockMini(cv, node.params[spec.k]);
      name.textContent = node.params[spec.k] === BLOCKS.AIR
        ? 'Empty (air)'
        : (blockNames[node.params[spec.k]] || '?');
    };
    paint();
    chip.addEventListener('pointerdown', e => e.stopPropagation());
    chip.addEventListener('click', e => {
      ngOpenBlockPicker(e.currentTarget, id => { node.params[spec.k] = id; paint(); }, spec.allowEmpty);
    });
    row.appendChild(chip);
  } else if (spec.kind === 'creature') {
    // Die Liste wird bei jedem Öffnen neu abgefragt, nicht einmal beim Bauen:
    // wer eine Kreatur malt, während das Board offen ist, findet sie danach
    // sofort im Kasten, statt bis zum nächsten Neuaufbau zu warten.
    const sel = ngLazySelect('', () => {
      const list = VxPieces.list('CREATURE');
      return list.length ? list.map((p, i) => ({ v: i, l: p.name }))
                         : [{ v: 0, l: '(no creatures yet)' }];
    }, String(node.params[spec.k]));
    sel.addEventListener('pointerdown', e => e.stopPropagation());
    sel.addEventListener('change', () => { node.params[spec.k] = parseInt(sel.value, 10) || 0; });
    row.appendChild(sel);
  } else if (spec.kind === 'enum') {
    // Die Liste hängt an den Nachbar-Parametern (welche Werte ein Weltaspekt
    // hat), deshalb wird sie beim Öffnen ausgewertet und nicht eingefroren.
    const sel = ngLazySelect('', () => graphSpecList(spec, node.params).map(v => ({ v, l: v })),
                             node.params[spec.k]);
    sel.addEventListener('pointerdown', e => e.stopPropagation());
    sel.addEventListener('change', () => {
      ngCommit();
      node.params[spec.k] = sel.value;
      // A controlling dropdown decides what the rows below it may offer (which
      // values a world aspect has, what range a stat allows), so those rows are
      // rebuilt against the new choice and re-cleaned rather than left showing
      // a list that no longer applies.
      if (spec.controls) {
        node.params = graphCleanNodeParams(node.type, node.params);
        ngRebuildNodeBody(node);
      }
    });
    row.appendChild(sel);
  } else if (spec.kind === 'num') {
    const range = graphSpecRange(spec, node.params);
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.min = range.min; inp.max = range.max; inp.step = range.dec ? 0.1 : 1;
    inp.value = node.params[spec.k];
    inp.addEventListener('pointerdown', e => e.stopPropagation());
    // Clamped on the way in as well as on decode: the runtime should never
    // see a value the catalog does not allow, whatever the player types.
    inp.addEventListener('change', () => {
      ngCommit();
      node.params[spec.k] = graphCleanParam(spec, inp.value, node.params);
      inp.value = node.params[spec.k];
    });
    row.appendChild(inp);
  } else {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.maxLength = spec.max || 48;
    inp.value = node.params[spec.k];
    // Was ein leer gelassenes Feld bedeutet, steht sonst nirgends. Genau das
    // braucht ein Feld, dessen Leersein die Einstellung IST.
    if (spec.placeholder) inp.placeholder = spec.placeholder;
    inp.addEventListener('pointerdown', e => e.stopPropagation());
    // Same reasoning as the value slot's name field: live update, one history
    // step per visit to the field rather than one per keystroke.
    ngWireTextHistory(inp);
    inp.addEventListener('input', () => { node.params[spec.k] = graphCleanParam(spec, inp.value, node.params); });
    row.appendChild(inp);
  }
  return row;
}

// Redraws just the parameter rows of one node, in place. Used when a
// controlling dropdown changes what the rows under it may offer.
function ngRebuildNodeBody(node) {
  const elx = ngWorld() && ngWorld().querySelector('.ng-node[data-id="' + node.id + '"]');
  if (!elx) return;
  const body = elx.querySelector('.ng-node-body');
  if (!body) return;
  const def = NODE_CATALOG[node.type];
  body.innerHTML = '';
  for (const spec of def.params) body.appendChild(ngBuildParamRow(node, spec));
  const labels = ngPortLabelsHtml(def);
  if (labels) {
    const lab = document.createElement('div');
    lab.style.cssText = 'position:relative;height:18px';
    lab.innerHTML = labels;
    body.appendChild(lab);
  }
  ngRender();
}

function ngRenderWires() {
  const svg = document.getElementById('ng-wires');
  const byId = new Map(ngGraph.nodes.map(n => [n.id, n]));
  const parts = [];
  for (const w of ngGraph.wires) {
    const a = byId.get(w.from), b = byId.get(w.to);
    if (!a || !b) continue;
    const p0 = ngPortPos(a, w.fromPort), p1 = ngPortPos(b, 'in');
    // 'no' and 'body' get their own colour so a busy board reads at a glance;
    // every other port (including 'done', which is the ordinary "keep going"
    // exit) falls back to the same blue 'out'/'yes' already uses.
    const colour = w.fromPort === 'no' ? '#b8862a' : w.fromPort === 'body' ? '#3fae6a' : '#7fd0ff';
    parts.push(ngWirePath(p0, p1, colour, w.from + '|' + w.fromPort));
  }
  if (ngLink) {
    const a = byId.get(ngLink.from);
    if (a) {
      const from = ngPortPos(a, ngLink.fromPort);
      // Snapped: the wire ends in the real socket, not under the cursor, so the
      // preview already shows the finished connection. Loose: it trails the
      // cursor and carries a plug head, which is the bit that makes it read as
      // a cable being carried rather than a line being drawn.
      const snapNode = ngSnapTo ? byId.get(ngSnapTo) : null;
      const to = snapNode ? ngPortPos(snapNode, 'in') : { x: ngLink.x, y: ngLink.y };
      const colour = snapNode ? '#8effa0' : 'rgba(255,255,255,0.55)';
      parts.push(ngWirePath(from, to, colour, ''));
      parts.push(ngPlugHead(to, colour, !!snapNode));
    }
  }
  svg.innerHTML = parts.join('');
}

// The head of a wire that is currently being dragged. Two rings rather than one
// dot: the outer dark ring keeps it visible over a pale node, and the inner one
// grows when the plug is over a socket it can actually enter, which is the
// difference between "hovering somewhere" and "let go now".
function ngPlugHead(p, colour, snapped) {
  const r = snapped ? 7 : 5;
  return '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + (r + 2) +
         '" fill="rgba(8,10,16,0.85)"></circle>' +
         '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + r + '" fill="' + colour + '"></circle>';
}

// Which node the plug currently hovers close enough to enter, or null. Distance
// is measured to the node's own input socket rather than to its box, so a plug
// dragged over the far side of a wide node does not claim to be plugging in.
// Only nodes that can actually take an input are eligible, which is what makes
// an event node refuse the plug instead of accepting a wire that could never run.
function ngFindSnap(x, y, fromId) {
  let best = null, bestDist = NG_SNAP_RADIUS;
  for (const n of ngGraph.nodes) {
    if (n.id === fromId || !nodeAcceptsInput(n.type)) continue;
    const p = ngPortPos(n, 'in');
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bestDist) { bestDist = d; best = n.id; }
  }
  return best;
}

// Marks every node on the board while a wire is in flight: the one the plug
// would enter, and the ones that could never accept it. Done with classes on
// the real elements rather than by redrawing, so dragging stays cheap.
function ngMarkSnapTargets() {
  const world = ngWorld();
  if (!world) return;
  world.querySelectorAll('.ng-node').forEach(el => {
    const id = el.dataset.id;
    const node = ngGraph.nodes.find(n => n.id === id);
    const eligible = !!ngLink && node && id !== ngLink.from && nodeAcceptsInput(node.type);
    el.classList.toggle('snap-target', !!ngLink && id === ngSnapTo);
    el.classList.toggle('snap-blocked', !!ngLink && !eligible);
  });
}
function ngWirePath(p0, p1, colour, key) {
  // Horizontal-first bezier: the control points lean sideways so a wire
  // leaves and enters its port flat, which is what makes a dense board
  // readable instead of a bowl of spaghetti.
  const dx = Math.max(40, Math.abs(p1.x - p0.x) * 0.5);
  const d = 'M' + p0.x + ',' + p0.y + ' C' + (p0.x + dx) + ',' + p0.y + ' ' + (p1.x - dx) + ',' + p1.y + ' ' + p1.x + ',' + p1.y;
  // Drawn twice: a dark casing under a brighter core, which is what makes the
  // line read as a cable plugged between two parts instead of an arrow. The
  // casing carries data-wire too, so the click-to-unhook target got wider for
  // free rather than the core becoming harder to hit.
  const path = (w, col) => '<path d="' + d + '" fill="none" stroke="' + col + '" stroke-width="' + w +
                           '" stroke-linecap="round" data-wire="' + key + '"></path>';
  return path(6, 'rgba(8,10,16,0.85)') + path(2.5, colour);
}

// `preset` fills some of the new node's parameters instead of leaving them at
// their catalog defaults. Used by the "My blocks" palette group (see
// voxeria-terminal.js), where every entry is the same "Call by name" card with
// a different signal already filled in -- without this the palette could only
// offer the bare card and the player would have to retype the name it was
// dropped there to save them typing.
function ngAddNode(type, preset) {
  if (ngGraph.nodes.length >= GRAPH_MAX_NODES) {
    showNotification('⚠️ That is the most blocks one mod can hold (' + GRAPH_MAX_NODES + ').');
    return;
  }
  ngCommit();
  const stage = ngStage().getBoundingClientRect();
  // Dropped near the middle of whatever the player is currently looking at,
  // then nudged so a run of new nodes does not land in one stack.
  const jitter = (ngGraph.nodes.length % 6) * 26;
  // Routed through graphCleanNodeParams like every other parameter that
  // reaches a node, so a preset can only ever set something the catalog
  // allows.
  const params = preset
    ? graphCleanNodeParams(type, Object.assign(graphDefaultParams(type), preset))
    : graphDefaultParams(type);
  ngGraph.nodes.push({
    id: ngNewId(), type,
    x: Math.round(stage.width / 2 - ngPan.x - NG_NODE_W / 2 + jitter),
    y: Math.round(stage.height / 2 - ngPan.y - 60 + jitter),
    params
  });
  ngRender();
}

function ngDeleteNode(id) {
  ngCommit();
  ngGraph.nodes = ngGraph.nodes.filter(n => n.id !== id);
  ngGraph.wires = ngGraph.wires.filter(w => w.from !== id && w.to !== id);
  ngSelection.delete(id);
  ngRender();
}

function ngConnect(fromId, fromPort, toId) {
  if (fromId === toId) return;
  const to = ngGraph.nodes.find(n => n.id === toId);
  if (!to || !nodeAcceptsInput(to.type)) return;
  // The source is checked as strictly as the target. A wire is pulled across
  // several events, and the node it started from can be gone by the time it is
  // dropped — the board would then keep a wire pointing at nothing: invisible
  // (ngRenderWires skips it), silently dropped again on the next load
  // (decodeGraphCode rejects it), but counting the whole time against
  // GRAPH_MAX_WIRES. Also guards the port, so a 'yes' wire cannot survive its
  // node being retyped into something with only an 'out'.
  const from = ngGraph.nodes.find(n => n.id === fromId);
  if (!from || !nodePorts(from.type).includes(fromPort)) return;
  if (ngGraph.wires.length >= GRAPH_MAX_WIRES) { showNotification('⚠️ Too many connections in one mod.'); return; }
  // After every guard, so a refused connection does not spend an undo step on
  // a change that never happened.
  ngCommit();
  // One wire per output port: replacing rather than refusing means dragging a
  // new line onto a busy port just re-points it, which is what people expect.
  ngGraph.wires = ngGraph.wires.filter(w => !(w.from === fromId && w.fromPort === fromPort));
  ngGraph.wires.push({ from: fromId, fromPort, to: toId });
  // Only reached once every guard above has passed and a wire has actually
  // been added: the snap sound for a connection that really landed, not for
  // a drop on empty space or on an invalid target (both return earlier).
  playSound('modNodePlop');
  ngRender();
}

function ngOpenBlockPicker(anchor, onPick, allowEmpty) {
  const pop = document.getElementById('ng-blockpicker');
  const grid = document.getElementById('ng-bp-grid');
  grid.innerHTML = '';
  // A world-editing slot can choose "nothing", which is how "Fill a box with"
  // absorbed the old "Blast a hole". Offered as an explicit cell rather than by
  // putting AIR in the list above, so the inventory pickers stay unaffected.
  if (allowEmpty) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'ng-bp-cell'; b.title = 'Empty (air)';
    b.textContent = '·';
    b.style.cssText = 'font-size:18px;opacity:.65;';
    grid.appendChild(b);
    b.addEventListener('click', () => { onPick(BLOCKS.AIR); pop.classList.remove('open'); });
  }
  // Every block the game knows, including the player's own painted ones once
  // they are registered — the whole point of "you see the grass block". Minus
  // NON_ITEM_BLOCK_IDS: those never reach a real inventory in normal play, so
  // offering them as something to give/hold/carry would just be a trap.
  const ids = Object.keys(blockNames).map(Number).filter(id => !NON_ITEM_BLOCK_IDS.has(id)).sort((a, b) => a - b);
  for (const id of ids) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'ng-bp-cell'; b.title = blockNames[id];
    const cv = document.createElement('canvas');
    cv.width = 26; cv.height = 26;
    b.appendChild(cv);
    grid.appendChild(b);
    drawBlockMini(cv, id);
    b.addEventListener('click', () => { ngCommit(); onPick(id); pop.classList.remove('open'); });
  }
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.min(window.innerWidth - 280, r.left) + 'px';
  pop.style.top = Math.min(window.innerHeight - 330, r.bottom + 6) + 'px';
  pop.classList.add('open');
}

// Welche Karten nur unter bestimmten Bedingungen etwas tun. Aus dem Katalog
// abgeleitet und nicht von Hand gepflegt, damit eine neue Karte hier nicht
// vergessen wird.
//
// ARENA: diese Karten sind ausserhalb eines laufenden Matches still
// wirkungslos (siehe die Wachen in GRAPH_ACTIONS und GRAPH_CONDS).
// MEHRSPIELER: diese brauchen einen ZWEITEN Spieler in derselben Welt, sonst
// gibt es niemanden, der sie ausloesen koennte.
const NG_ARENA_ONLY = new Set(['onMatchStart', 'onMatchEnd', 'ifInArena',
  'ifScoreAtLeast', 'ifLeading', 'ifTeamScoreAtLeast', 'ifTeamLeading',
  'addScore', 'endRound', 'setTeam', 'showBoard']);
// onPlayerEnterZone/onPlayerLeaveZone stehen bewusst NICHT mehr hier: seit
// graphSweepZones auch den lokalen Spieler prueft, feuern beide auch allein.
const NG_NEEDS_OTHERS = new Set(['onPlayerJoin', 'onPlayerLeave', 'onPlayerTouch']);

// Was ein Graph zum Laufen braucht, aus seinen eigenen Karten gelesen. Nimmt
// die Knotenliste statt eines Codes, damit auch ein Beispiel aus NG_EXAMPLES
// hier durchgehen kann: das liegt als offene Knotenliste vor und war nie ein
// Code. Ein Beispiel, das jemand laedt und das dann still nichts tut, weil er
// allein in einer Erkundungswelt steht, saehe fuer ihn nicht nach "passt hier
// nicht" aus, sondern nach "Modding ist kaputt".
function ngNeedsForNodes(nodes) {
  const types = new Set((nodes || []).map(n => n.type));
  const needs = [];
  if ([...types].some(t => NG_ARENA_ONLY.has(t))) needs.push('Arena');
  if ([...types].some(t => NG_NEEDS_OTHERS.has(t))) needs.push('2+ players');
  return needs;
}
// Der Satz zur Marke, an einer Stelle, damit die Modliste und die
// Beispielkarte dieselbe Bedingung nicht unterschiedlich erklaeren.
function ngNeedsTitle(need) {
  return need === 'Arena'
    ? 'This only does something in a running Arena match'
    : 'This only does something when another player is in the world';
}
function ngNeedsHtml(nodes) {
  return ngNeedsForNodes(nodes).map(n =>
    '<span class="ng-needs" title="' + ngNeedsTitle(n) + '">' + escapeHtml(n) + '</span>').join('');
}

function ngRenderPieceList() {
  const elx = document.getElementById('ng-piece-list');
  const mods = VxPieces.list('GRAPH');
  if (!mods.length) { elx.innerHTML = '<div class="mb-hint">No mods yet. Build one on the board.</div>'; return; }
  elx.innerHTML = mods.map(p => {
    // Der Hinweis steht an der Liste und nicht nur beim Speichern: dort sucht
    // man, wenn ein Mod "nichts tut", und genau dann ist die Bedingung die
    // wahrscheinlichste Ursache.
    const g = decodeGraphCode(p.code);
    const needs = ngNeedsHtml(g ? g.nodes : []);
    return `
    <div class="bd-piece-row" data-id="${p.localId}">
      <label class="mb-check"><input type="checkbox" class="bd-piece-enable" ${p.enabled !== false ? 'checked' : ''}></label>
      <span class="bd-piece-name">${escapeHtml(p.name)}${needs}</span>
      <button type="button" class="bd-piece-edit">Edit</button>
      <button type="button" class="bd-piece-delete">Delete</button>
    </div>
  `;
  }).join('');
  elx.querySelectorAll('.bd-piece-enable').forEach(cb => cb.addEventListener('change', e => {
    VxPieces.setEnabled(e.target.closest('.bd-piece-row').dataset.id, e.target.checked);
    reapplyCustomPieces();
  }));
  elx.querySelectorAll('.bd-piece-edit').forEach(btn => btn.addEventListener('click', e => {
    const id = e.target.closest('.bd-piece-row').dataset.id;
    const rec = VxPieces.get(id);
    const g = rec && decodeGraphCode(rec.code);
    if (!g) { showNotification('⚠️ That mod could not be opened.'); return; }
    ngLoadGraph(g);
    ngEditingId = id;
    showNotification('✏️ Editing "' + g.name + '". Save replaces it.');
  }));
  elx.querySelectorAll('.bd-piece-delete').forEach(btn => btn.addEventListener('click', e => {
    const id = e.target.closest('.bd-piece-row').dataset.id;
    if (ngEditingId === id) ngEditingId = null;
    VxPieces.delete(id);
    reapplyCustomPieces();
    ngRenderPieceList();
  }));
}

function ngLoadGraph(g) {
  ngGraph = { name: g.name, nodes: g.nodes, wires: g.wires };
  document.getElementById('ng-name').value = g.name;
  // Ids from a shared code follow no local counter, so restart ours above the
  // highest number already in use rather than risking a collision.
  ngNextId = 1;
  for (const n of g.nodes) {
    const m = /^n([0-9a-z]+)$/.exec(n.id);
    if (m) ngNextId = Math.max(ngNextId, parseInt(m[1], 36) + 1);
  }
  ngPan = { x: 40, y: 40 };
  ngZoom = 1;
  ngSelection.clear();
  ngHeights.clear();
  ngWidths.clear();
  document.querySelectorAll('#ng-world .ng-node').forEach(e => e.remove());
  ngRender();
  // The board was replaced wholesale, so the timeline starts here. Undoing back
  // into the mod that was open before would be a surprise, not a rescue.
  ngResetHistory();
  ngCoachRefresh();
}

function ngSave() {
  const name = document.getElementById('ng-name').value.trim().slice(0, 24);
  if (!name) { showNotification('⚠️ Give your mod a name first.'); document.getElementById('ng-name').focus(); return; }
  if (!ngGraph.nodes.length) { showNotification('⚠️ The board is empty. Add an event block first.'); return; }
  if (!ngGraph.nodes.some(n => NODE_CATALOG[n.type].kind === 'event')) {
    showNotification('⚠️ A mod needs at least one event block to start it off.');
    return;
  }
  ngGraph.name = name;
  const code = encodeGraphCode(ngGraph);
  const wasEditing = ngEditingId && VxPieces.get(ngEditingId);
  // See bdSave: save first, and only retire the old copy once the new one is
  // safely stored.
  const newId = VxPieces.save('GRAPH', code, name);
  if (!newId) return;
  if (wasEditing) {
    // Bearbeiten legt technisch eine neue Kopie an und wirft die alte weg. Ohne
    // das Uebertragen des Schalters wuerde ein eingeschalteter Mod sich beim
    // Speichern selbst abschalten, weil ein neuer Mod ausgeschaltet startet.
    if (wasEditing.enabled !== false) VxPieces.setEnabled(newId, true);
    VxPieces.delete(ngEditingId);
  }
  ngEditingId = null;
  reapplyCustomPieces();
  ngRenderPieceList();
  if (wasEditing) {
    showNotification('✅ "' + name + '" updated.');
  } else {
    // Beim ERSTEN Speichern ist der Mod bewusst noch aus, siehe VxPieces.save.
    // Das muss dastehen, sonst sucht man den Fehler im Mod statt im Schalter.
    showNotification('✅ "' + name + '" saved, still switched off. Tick it under "My mods" to run it.');
  }
}

// =========================================================
// MINI-SANDBOX: trying the built chain out inside the editor
// =========================================================
// A DRY RUN, not a second runtime. The chain is walked exactly the way
// graphRunChain() would walk it (same order, same wiring, same step budget),
// but instead of calling GRAPH_ACTIONS every node is merely DESCRIBED.
//
// Why not actually execute it: the actions reach straight into the running
// world (setBlock, takeDamage, teleport, addToInventory). In the editor there
// is no world the player is standing in, so a "Blast a hole" would be a real
// hole in the world behind the editor, in a spot nobody chose. The dry run
// still answers the question that matters while building: does my chain run in
// the order I think it does, and does it reach everywhere?
//
// If a real miniature world is added later, exactly ONE place changes: the
// else branch in ngSimulateChain() that describes today instead of doing.
// Trigger selection, chain walking and the log all stay as they are.
const NG_SIM_MAX_STEPS = GRAPH_MAX_STEPS;
// Every node type graphWalk drives with its own body/done wiring rather than
// dispatching through GRAPH_CONDS/GRAPH_ACTIONS. Kept as its own set (not
// `def.kind === 'loop'`) because the dry run needs a different one-line
// summary for each, not just "this is some loop or other".
const NG_LOOP_TYPES = new Set(['repeatTimes', 'repeatWhile', 'forEachItem', 'forEachInList']);
let ngTrySelectedId = null;   // which event node the dummy block fires
let ngTryStance = 'yes';      // which branch a condition takes in the dry run
let ngTryLog = [];

// A value slot in words. Reuses the exact source words its own dropdown
// already shows the player (VALUE_FIXED/VALUE_VAR/VALUE_NONE, or one of
// GRAPH_STATS for a live reading) rather than inventing separate phrasing to
// keep in sync — the same "don't hand-author a second table" rule
// ngDescribeNode's own comment states, applied one level deeper.
function ngDescribeValue(val) {
  if (!val || typeof val !== 'object') return String(val);
  if (val.s === VALUE_NONE) return 'nothing';
  if (val.s === VALUE_FIXED) return String(val.n);
  if (val.s === VALUE_VAR) return 'saved “' + val.v + '”';
  if (val.s === VALUE_LIST) return 'item ' + val.n + ' of list “' + val.v + '”';
  if (val.s === VALUE_LIST_DYNAMIC) return 'item at (' + ngDescribeValue(val.idx) + ') of list “' + val.v + '”';
  if (val.s === VALUE_LIST_LEN) return 'how many in list “' + val.v + '”';
  if (val.s === VALUE_COUNTDOWN) return 'seconds left on “' + val.v + '”';
  return val.s;
}

// The text counterpart of ngDescribeValue. Also handles a bare string, since
// that is what a mod code written before text slots existed carries.
function ngDescribeTextValue(val) {
  if (typeof val === 'string') return '“' + val + '”';
  if (!val || typeof val !== 'object') return '“”';
  if (val.s === TEXT_VAR) return 'saved text “' + val.v + '”';
  return '“' + (val.t || '') + '”';
}

// A human-readable line built from the catalog label plus the parameters.
// Deliberately GENERATED from NODE_CATALOG rather than from a second table: a
// hand-written text list for ~54 nodes would be the next thing to go quietly
// stale the moment somebody adds a node.
function ngDescribeNode(node) {
  const def = NODE_CATALOG[node.type];
  if (!def) return node.type;
  if (!def.params.length) return def.label;
  const parts = def.params.map(spec => {
    const v = node.params[spec.k];
    if (spec.kind === 'block') return blockNames[v] || ('block ' + v);
    if (spec.kind === 'creature') {
      const list = VxPieces.list('CREATURE');
      return (list[v] && list[v].name) || ('creature ' + v);
    }
    if (spec.kind === 'text' || spec.kind === 'varname') return '“' + v + '”';
    if (spec.kind === 'textvalue') return ngDescribeTextValue(v);
    if (spec.kind === 'value') return ngDescribeValue(v);
    return String(v);
  });
  return def.label + ' ' + parts.join(', ');
}

// Which output a condition takes in the dry run.
//
// "Random chance" is REALLY rolled: it is the one condition whose result
// depends on nothing but chance in the live game either, so the dry run is as
// truthful here as it can get. All the others read game state (health, depth,
// weather, ...) that does not exist in the editor; those follow the configured
// stance, and the log says so by marking the outcome as assumed.
function ngSimCondition(node) {
  if (node.type === 'ifChance') {
    const pct = Number(node.params.percent) || 0;
    return (Math.random() * 100 < pct) ? 'yes' : 'no';
  }
  return ngTryStance === 'no' ? 'no' : 'yes';
}

function ngSimulateChain(startNode) {
  const byId = new Map(ngGraph.nodes.map(n => [n.id, n]));
  const out = [];
  ngSimWalk(byId, startNode, 0, out, { n: 0 });
  return out;
}

// `depth` is 0 at the top level and +1 for every loop body nested inside —
// used only to indent the log (see ngRenderTryLog) so a "Repeat" node's
// contents visually sit inside it instead of reading as one more line at the
// same level as everything around it. `budget` is shared across the whole
// recursive walk, the same way graphWalk's real budget is: a loop previewed
// here cannot make the dry run hang any more than the real one can.
function ngSimWalk(byId, startNode, depth, out, budget) {
  let node = startNode;
  let localStep = 0;
  while (node && budget.n++ < NG_SIM_MAX_STEPS) {
    const def = NODE_CATALOG[node.type];
    if (!def) break;
    let port = 'out';
    if (def.kind === 'cond') {
      port = ngSimCondition(node);
      const assumed = node.type !== 'ifChance';
      out.push({
        kind: 'cond', indent: depth,
        text: ngDescribeNode(node) + ' → ' + port +
              (assumed ? ' (assumed)' : ' (rolled)')
      });
    } else if (NG_LOOP_TYPES.has(node.type)) {
      // Previewed as ONE pass, not run to completion: a "Repeat 200", a
      // "Repeat while" that stays true the whole time, or walking a full
      // inventory would otherwise print that many duplicate lines and bury
      // everything wired after the loop.
      let suffix;
      if (node.type === 'repeatTimes') {
        suffix = ' — showing one pass of ' + (graphResolveInt(node.params.count, 1, GRAPH_MAX_LOOP_ITERS) || 1) + ':';
      } else if (node.type === 'repeatWhile') {
        suffix = ' — showing one pass (up to ' + GRAPH_MAX_LOOP_ITERS + ' while the condition holds):';
      } else if (node.type === 'forEachInList') {
        suffix = ' (showing one pass, once per item the list holds):';
      } else {
        suffix = ' — showing one pass, once per item actually carried:';
      }
      out.push({ kind: 'loop', indent: depth, text: ngDescribeNode(node) + suffix });
      const bodyWire = ngGraph.wires.find(w => w.from === node.id && w.fromPort === 'body');
      const bodyStart = bodyWire ? byId.get(bodyWire.to) : null;
      if (bodyStart) ngSimWalk(byId, bodyStart, depth + 1, out, budget);
      else out.push({ kind: 'dead', indent: depth + 1, text: 'Nothing is wired to “each time”, so this loop does nothing.' });
      port = 'done';
    } else {
      // <<< A real sandbox would call GRAPH_ACTIONS[node.type] against a
      //     miniature world here. Today it only describes. >>>
      out.push({ kind: def.kind, indent: depth, text: ngDescribeNode(node) });
    }
    const wire = ngGraph.wires.find(w => w.from === node.id && w.fromPort === port);
    const next = wire ? byId.get(wire.to) : null;
    if (!next) {
      // The end of a chain is a statement, not a blank: a condition with
      // nothing hanging off its "no", or a loop with nothing after "then", is
      // the most common reason a mod "sometimes does nothing" / "stops after
      // one round".
      if (def.kind === 'cond') out.push({ kind: 'dead', indent: depth, text: 'Nothing is wired to the “' + port + '” output, so the chain stops here.' });
      else if (NG_LOOP_TYPES.has(node.type)) out.push({ kind: 'dead', indent: depth, text: 'Nothing is wired to “then”, so nothing happens once the loop finishes.' });
      else if (depth === 0 && localStep === 0) out.push({ kind: 'dead', indent: depth, text: 'Nothing is wired to this event yet.' });
      return;
    }
    node = next;
    localStep++;
  }
}

// The event nodes on the board, in board order. Those are exactly the triggers
// there are to test.
function ngTryEventNodes() {
  return ngGraph.nodes.filter(n => (NODE_CATALOG[n.type] || {}).kind === 'event');
}
function ngTrySelectedNode() {
  const events = ngTryEventNodes();
  if (!events.length) return null;
  return events.find(n => n.id === ngTrySelectedId) || events[0];
}

// Which block the dummy shows: the one the selected event listens for. An
// event with no block parameter (nightfall, a timer) gets stone as a neutral
// stand-in; clicking still fires it.
function ngTryDummyBlock(node) {
  if (node && node.params && Number.isInteger(node.params.block)) return node.params.block;
  return (typeof BLOCKS !== 'undefined' && BLOCKS.STONE) ? BLOCKS.STONE : 1;
}

function ngRenderTryPanel() {
  const host = document.getElementById('ng-try-events');
  if (!host) return;
  const events = ngTryEventNodes();
  const sel = ngTrySelectedNode();

  host.innerHTML = '';
  for (const n of events) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ng-try-event' + (sel && n.id === sel.id ? ' sel' : '');
    b.textContent = (NODE_CATALOG[n.type] || {}).label || n.type;
    b.title = ngDescribeNode(n);
    b.addEventListener('click', () => { ngTrySelectedId = n.id; ngRenderTryPanel(); });
    host.appendChild(b);
  }

  const cv = document.getElementById('ng-try-block');
  if (cv) {
    cv.classList.toggle('empty', !sel);
    if (typeof drawBlockMini === 'function') drawBlockMini(cv, ngTryDummyBlock(sel));
  }
  const hint = document.getElementById('ng-try-hint');
  if (hint) {
    hint.textContent = sel
      ? 'Click the block to run “' + ((NODE_CATALOG[sel.type] || {}).label || sel.type) + '”.'
      : 'Add an event to the board first: that is what a test can trigger.';
  }
  const stance = document.getElementById('ng-try-stance');
  if (stance) stance.textContent = 'Ifs: ' + ngTryStance;
}

function ngRenderTryLog() {
  const log = document.getElementById('ng-try-log');
  if (!log) return;
  log.innerHTML = '';
  ngTryLog.forEach((entry, i) => {
    const row = document.createElement('div');
    row.className = 'ng-try-line k-' + entry.kind;
    // Indented one notch per loop it sits inside, so a "Repeat" node's body
    // visibly reads as being INSIDE it rather than as one more line at the
    // same level as everything around it.
    if (entry.indent) row.style.marginLeft = (entry.indent * 16) + 'px';
    const step = document.createElement('span');
    step.className = 'ng-try-step';
    step.textContent = entry.kind === 'dead' ? '·' : (i + 1) + '.';
    const text = document.createElement('span');
    text.className = 'ng-try-text';
    text.textContent = entry.text;
    row.appendChild(step); row.appendChild(text);
    log.appendChild(row);
  });
  log.scrollTop = log.scrollHeight;
}

function ngRunTry() {
  const node = ngTrySelectedNode();
  if (!node) { showNotification('⚠️ Put an event on the board first.'); return; }
  const cv = document.getElementById('ng-try-block');
  if (cv) { cv.classList.add('hit'); setTimeout(() => cv.classList.remove('hit'), 120); }
  ngTryLog = ngSimulateChain(node);
  ngRenderTryLog();
}

function ngInit() {
  if (ngInitDone) return;
  ngInitDone = true;
  ngInjectStyle();

  // Mini-sandbox: the dummy block IS the trigger; the buttons under it are
  // only the more convenient second way to reach the same thing.
  const tryBlock = document.getElementById('ng-try-block');
  if (tryBlock) tryBlock.addEventListener('click', ngRunTry);
  const tryRun = document.getElementById('ng-try-run');
  if (tryRun) tryRun.addEventListener('click', ngRunTry);
  const tryClear = document.getElementById('ng-try-clear');
  if (tryClear) tryClear.addEventListener('click', () => { ngTryLog = []; ngRenderTryLog(); });
  const tryStance = document.getElementById('ng-try-stance');
  if (tryStance) {
    tryStance.addEventListener('click', () => {
      ngTryStance = ngTryStance === 'yes' ? 'no' : 'yes';
      ngRenderTryPanel();
    });
  }

  // Populated once — the cards are static (NG_EXAMPLES never changes at
  // runtime), only their container's visibility toggles, piggybacking on the
  // same ngRender() line that already shows/hides #ng-empty based on whether
  // the board has any nodes on it.
  const exHost = document.getElementById('ng-examples');
  if (exHost) {
    for (const ex of NG_EXAMPLES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ng-example-btn';
      // Reihenfolge mit Absicht: Name, daneben die Bedingungsmarke (sie
      // gehoert zum Namen, nicht zur Erklaerung), darunter was es tut, zuletzt
      // die Faehigkeit. Wer die Liste ueberfliegt, liest die Namen; wer sucht,
      // was das System kann, liest die unterste Zeile.
      b.innerHTML = '<span class="ng-example-name">' + escapeHtml(ex.name) +
                      ngNeedsHtml(ex.nodes) + '</span>' +
                    '<span class="ng-example-desc">' + escapeHtml(ex.desc) + '</span>' +
                    (ex.teaches ? '<span class="ng-example-teaches">' + escapeHtml(ex.teaches) + '</span>' : '');
      b.addEventListener('click', () => ngLoadExample(ex));
      exHost.appendChild(b);
    }
  }

  // [?] brings the guide back at any time, including on a full board. A toggle,
  // so the same button also puts it away again.
  const helpBtn = document.getElementById('ng-help-btn');
  if (helpBtn) {
    helpBtn.addEventListener('click', () => {
      ngHelpForced = !ngHelpForced;
      ngRender();
    });
  }
  const helpClose = document.getElementById('ng-help-close');
  if (helpClose) {
    helpClose.addEventListener('click', e => {
      // Otherwise the stage's pointerdown handler catches the click and starts
      // panning instead.
      e.stopPropagation();
      ngHelpForced = false;
      ngRender();
    });
  }

  // Palette: one tab per node kind, so the rail reads as "start / split / do"
  // three blocks at a time instead of as one 54-entry scroll.
  const makePalBtn = (type, def) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ng-pal-btn k-' + def.kind;
    b.appendChild(ngMakeIcon(type, 'ng-pal-icon'));
    // A <span> rather than the button's own text node: applyPaletteFilter
    // matches on btn.textContent, which a canvas contributes nothing to, so
    // searching keeps working unchanged.
    const lab = document.createElement('span');
    lab.textContent = def.label;
    b.appendChild(lab);
    b.addEventListener('click', () => ngAddNode(type));
    return b;
  };
  // Events and Conditions are short enough to drop in catalog order, flat.
  for (const [type, def] of Object.entries(NODE_CATALOG)) {
    if (def.kind === 'event') document.getElementById('ng-pal-event').appendChild(makePalBtn(type, def));
    else if (def.kind === 'cond') document.getElementById('ng-pal-cond').appendChild(makePalBtn(type, def));
  }
  // Actions are the long list, so they're built from ACTION_GROUPS instead —
  // each cluster is its own wrapper so the search filter below can hide a
  // cluster's heading along with its buttons when nothing in it matches.
  const actionBox = document.getElementById('ng-pal-action');
  for (const grp of ACTION_GROUPS) {
    const wrap = document.createElement('div');
    wrap.className = 'ng-pal-subgroup';
    const head = document.createElement('div');
    head.className = 'ng-pal-subgroup-label';
    head.textContent = grp.label;
    wrap.appendChild(head);
    for (const type of grp.types) {
      const def = NODE_CATALOG[type];
      if (!def) continue; // guards against a group listing a removed type
      wrap.appendChild(makePalBtn(type, def));
    }
    actionBox.appendChild(wrap);
  }

  // Per-tab totals, shown as the little pill in each tab so the split is
  // visible before you click anything.
  const KINDS = ['event', 'cond', 'action'];
  for (const kind of KINDS) {
    document.getElementById('ng-pal-n-' + kind).textContent =
      Object.values(NODE_CATALOG).filter(d => d.kind === kind).length;
  }

  const palBody = document.getElementById('ng-pal-body');
  const palEmpty = document.getElementById('ng-pal-empty');
  const search = document.getElementById('ng-pal-search');

  function ngShowPalTab(kind) {
    for (const k of KINDS) {
      document.getElementById('ng-pal-panel-' + k).classList.toggle('active', k === kind);
    }
    for (const t of document.querySelectorAll('.ng-pal-tab')) {
      const on = t.dataset.kind === kind;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    // A tab switch should start at the top of the new list, not wherever the
    // previous one happened to be scrolled to.
    palBody.scrollTop = 0;
  }
  document.getElementById('ng-pal-tabs').addEventListener('click', e => {
    const t = e.target.closest('.ng-pal-tab');
    if (!t) return;
    // Switching tabs by hand means you're browsing, not searching any more.
    if (search.value) { search.value = ''; applyPaletteFilter(); }
    ngShowPalTab(t.dataset.kind);
  });

  // With a query, the tabs step aside and every match from all three kinds is
  // listed at once under its own heading — you shouldn't have to know which
  // category a block lives in to find it by name. With the box empty, the
  // panels go back to being tabs.
  function applyPaletteFilter() {
    const q = search.value.trim().toLowerCase();
    palBody.classList.toggle('searching', !!q);
    document.getElementById('ng-pal-tabs').classList.toggle('muted', !!q);
    let total = 0;
    for (const kind of KINDS) {
      const panel = document.getElementById('ng-pal-panel-' + kind);
      let shown = 0;
      for (const btn of panel.querySelectorAll('.ng-pal-btn')) {
        const hit = !q || btn.textContent.toLowerCase().includes(q);
        btn.style.display = hit ? '' : 'none';
        if (hit) shown++;
      }
      // Actions also carry their ACTION_GROUPS sub-clusters; hide a cluster
      // whose every button just got filtered out so its heading doesn't hang
      // over an empty gap.
      for (const grp of panel.querySelectorAll('.ng-pal-subgroup')) {
        const any = [...grp.querySelectorAll('.ng-pal-btn')].some(b => b.style.display !== 'none');
        grp.style.display = any ? '' : 'none';
      }
      panel.classList.toggle('no-match', shown === 0);
      total += shown;
    }
    palEmpty.style.display = total === 0 ? 'block' : 'none';
    palBody.scrollTop = 0;
  }
  search.addEventListener('input', applyPaletteFilter);
  // Esc clears the search and hands the rail back to the tabs.
  search.addEventListener('keydown', e => {
    if (e.key === 'Escape' && search.value) {
      e.stopPropagation();          // don't let it also close the whole editor
      search.value = '';
      applyPaletteFilter();
    }
  });

  const stage = ngStage();
  // Every pointer that touches the board is tracked, including the ones that
  // land on a node, because the second finger of a pinch often does.
  stage.addEventListener('pointerdown', e => {
    ngPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ngPointers.size === 2) {
      // A pinch supersedes whatever one finger had started. Abandoning them
      // here rather than letting both run is what stops a node being flung
      // across the board while the other hand is zooming.
      const [p1, p2] = [...ngPointers.values()];
      ngPinch = {
        dist: Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y)),
        zoom: ngZoom,
        cx: (p1.x + p2.x) / 2, cy: (p1.y + p2.y) / 2
      };
      ngDrag = null; ngPanDrag = null; ngLink = null; ngSnapTo = null;
      if (ngMarquee) { ngMarquee = null; ngDrawMarquee(); }
      ngMarkSnapTargets();
      ngRenderWires();
    }
  }, true);
  stage.addEventListener('pointerdown', e => {
    if (ngPointers.size > 1) return;   // pinching, not drawing
    if (e.target.closest('.ng-node')) return;
    // The guide and the [?] button live INSIDE the stage. Without this
    // exception, clicking either would start panning the board and the text
    // would slide out from under the pointer.
    if (e.target.closest('.ng-empty') || e.target.closest('.ng-help-btn')) return;
    // Clicking a wire deletes it — the only way to unhook something without
    // deleting the node it belongs to.
    const wireKey = e.target.dataset && e.target.dataset.wire;
    if (wireKey) {
      ngCommit();
      const [from, port] = wireKey.split('|');
      ngGraph.wires = ngGraph.wires.filter(w => !(w.from === from && w.fromPort === port));
      ngRender();
      return;
    }
    // Shift on empty board starts a rubber-band selection; a plain drag still
    // pans, which is the gesture that was here first and is worth not breaking.
    if (e.shiftKey) {
      const r = stage.getBoundingClientRect();
      ngMarquee = { x0: e.clientX - r.left, y0: e.clientY - r.top,
                    x1: e.clientX - r.left, y1: e.clientY - r.top };
      ngDrawMarquee();
      return;
    }
    // A plain click on empty board clears the selection, the same as every
    // canvas app: otherwise a stale selection quietly stays armed and the next
    // Del press deletes something you stopped thinking about.
    if (ngSelection.size) ngSelectOnly(null);
    ngPanDrag = { x: e.clientX - ngPan.x, y: e.clientY - ngPan.y };
    stage.classList.add('panning');
  });
  // Zooms toward whatever the cursor is over, not the board's centre — the
  // same feel as Blender/Unreal, and the only way zooming out while eyeing
  // one corner doesn't fling that corner off-screen.
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const worldX = (mx - ngPan.x) / ngZoom, worldY = (my - ngPan.y) / ngZoom;
    const factor = Math.exp(-e.deltaY * 0.001);
    ngZoom = Math.max(NG_ZOOM_MIN, Math.min(NG_ZOOM_MAX, ngZoom * factor));
    ngPan.x = mx - worldX * ngZoom;
    ngPan.y = my - worldY * ngZoom;
    ngRender();
  }, { passive: false });
  window.addEventListener('pointermove', e => {
    if (ngPointers.has(e.pointerId)) {
      ngPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    // Pinch to zoom, anchored on the midpoint between the two fingers so the
    // board grows out of the spot being pinched rather than the corner.
    if (ngPinch && ngPointers.size >= 2) {
      const [p1, p2] = [...ngPointers.values()];
      const dist = Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y));
      const r = ngStage().getBoundingClientRect();
      const mx = ngPinch.cx - r.left, my = ngPinch.cy - r.top;
      const worldX = (mx - ngPan.x) / ngZoom, worldY = (my - ngPan.y) / ngZoom;
      ngZoom = Math.max(NG_ZOOM_MIN, Math.min(NG_ZOOM_MAX, ngPinch.zoom * (dist / ngPinch.dist)));
      ngPan.x = mx - worldX * ngZoom;
      ngPan.y = my - worldY * ngZoom;
      ngRender();
      return;
    }
    if (ngDrag) {
      const dx = (e.clientX - ngDrag.cx) / ngZoom;
      const dy = (e.clientY - ngDrag.cy) / ngZoom;
      // Recorded once the pointer has actually travelled, so a plain click on a
      // node header selects it without spending an undo step on a non-move.
      if (!ngDrag.moved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) {
        ngDrag.moved = true;
        ngCommit();
      }
      for (const m of ngDrag.moving) {
        const n = ngGraph.nodes.find(x => x.id === m.id);
        if (!n) continue;
        let nx = m.startX + dx, ny = m.startY + dy;
        // Snapping applies to the node under the cursor and the rest follow by
        // the same offset, so a group keeps its internal spacing instead of
        // every node collapsing onto its own nearest grid line.
        if (ngGridSnap) {
          nx = Math.round(nx / NG_GRID) * NG_GRID;
          ny = Math.round(ny / NG_GRID) * NG_GRID;
        }
        n.x = Math.round(nx);
        n.y = Math.round(ny);
      }
      ngRender();
    } else if (ngMarquee) {
      const r = ngStage().getBoundingClientRect();
      ngMarquee.x1 = e.clientX - r.left;
      ngMarquee.y1 = e.clientY - r.top;
      ngDrawMarquee();
      ngApplyMarquee();
    } else if (ngLink) {
      const r = ngStage().getBoundingClientRect();
      ngLink.x = (e.clientX - r.left - ngPan.x) / ngZoom;
      ngLink.y = (e.clientY - r.top - ngPan.y) / ngZoom;
      const wasSnapped = ngSnapTo;
      ngSnapTo = ngFindSnap(ngLink.x, ngLink.y, ngLink.from);
      // A click as the plug enters a socket, once per socket rather than every
      // frame it hovers there, so the sound reports an event instead of buzzing.
      if (ngSnapTo && ngSnapTo !== wasSnapped) playSound('modNodePull');
      if (ngSnapTo !== wasSnapped) ngMarkSnapTargets();
      ngRenderWires();
    } else if (ngPanDrag) {
      ngPan.x = e.clientX - ngPanDrag.x;
      ngPan.y = e.clientY - ngPanDrag.y;
      ngRender();
    }
  });
  window.addEventListener('pointerup', e => {
    if (ngLink) {
      // The snapped socket wins, because that is what the preview was already
      // showing. Dropping straight onto a node still counts as a fallback, for
      // a release that happens before a move event set the snap.
      let target = ngSnapTo;
      if (!target) {
        const overNode = e.target.closest && e.target.closest('.ng-node');
        if (overNode) target = overNode.dataset.id;
      }
      if (target) ngConnect(ngLink.from, ngLink.fromPort, target);
      ngLink = null;
      ngSnapTo = null;
      ngMarkSnapTargets();
      ngRender();
    }
    // Always, on every release of a dragged node, not gated on whether it
    // actually moved, and not shared with the wire-pull path above (ngDrag
    // and ngLink are set by two different pointerdown targets, the node
    // header vs. an output port, so exactly one of them is ever active in a
    // single pointer session).
    if (ngDrag) playSound('modNodeTouch');
    ngDrag = null;
    ngPanDrag = null;
    if (ngMarquee) { ngMarquee = null; ngDrawMarquee(); }
    stage.classList.remove('panning');
    ngPointers.delete(e.pointerId);
    // Only once BOTH fingers are gone. Ending the pinch on the first release
    // would hand the remaining finger a pan that starts from a stale origin,
    // and the board would jump.
    if (ngPointers.size < 2) ngPinch = null;
  });
  // A finger leaving the surface any other way (cancelled by the system, an
  // incoming call) has to clear its pointer too, or the board stays convinced
  // a pinch is still in progress and refuses every later single-finger drag.
  window.addEventListener('pointercancel', e => {
    ngPointers.delete(e.pointerId);
    if (ngPointers.size < 2) ngPinch = null;
  });
  // Any click outside the popup closes it.
  window.addEventListener('pointerdown', e => {
    const pop = document.getElementById('ng-blockpicker');
    if (pop.classList.contains('open') && !pop.contains(e.target) && !e.target.closest('.ng-blockchip')) {
      pop.classList.remove('open');
    }
  }, true);

  // ── Drawers (landscape phone only; inert everywhere else) ──
  document.getElementById('ng-rail-btn').addEventListener('click', () => ngSetDrawer('rail'));
  document.getElementById('ng-side-btn').addEventListener('click', () => ngSetDrawer('side'));
  document.getElementById('ng-scrim').addEventListener('pointerdown', e => {
    e.stopPropagation();
    ngCloseDrawers();
  });
  // Picking a block closes the palette: on a phone the drawer covers the board,
  // and leaving it open would hide the very node that was just placed.
  document.getElementById('ng-pal-body').addEventListener('click', e => {
    if (e.target.closest('.ng-pal-btn')) ngCloseDrawers();
  });

  // ── Board tools ──
  document.getElementById('ng-undo-btn').addEventListener('click', ngUndo);
  document.getElementById('ng-redo-btn').addEventListener('click', ngRedo);
  document.getElementById('ng-dup-btn').addEventListener('click', ngDuplicateSelection);
  document.getElementById('ng-del-btn').addEventListener('click', ngDeleteSelection);
  document.getElementById('ng-fit-btn').addEventListener('click', ngFitToScreen);
  document.getElementById('ng-tidy-btn').addEventListener('click', ngTidyLayout);
  document.getElementById('ng-grid-btn').addEventListener('click', () => {
    ngGridSnap = !ngGridSnap;
    ngUpdateTools();
    showNotification(ngGridSnap ? '▦ Grid snapping on' : '▦ Grid snapping off');
  });
  // Click anywhere on the overview to centre the board there.
  document.getElementById('ng-minimap-cv').addEventListener('pointerdown', e => {
    e.stopPropagation();
    const cv = e.currentTarget;
    const m = cv._ngMap;
    if (!m) return;
    const r = cv.getBoundingClientRect();
    const bx = (e.clientX - r.left) / m.scale + m.bx0 - m.pad;
    const by = (e.clientY - r.top) / m.scale + m.by0 - m.pad;
    const sr = ngStage().getBoundingClientRect();
    ngPan.x = sr.width / 2 - bx * ngZoom;
    ngPan.y = sr.height / 2 - by * ngZoom;
    ngRender();
  });

  // Keyboard. Bound to the modal rather than the window so these keys keep
  // their normal meaning everywhere else in the game, and ignored while a text
  // field has focus so typing "d" into a mod name cannot duplicate a node.
  document.getElementById('mod-editor-modal').addEventListener('keydown', e => {
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); ngUndo(); return; }
    if (ctrl && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
      e.preventDefault(); ngRedo(); return;
    }
    if (typing) return;
    if (ctrl && e.key.toLowerCase() === 'd') { e.preventDefault(); ngDuplicateSelection(); return; }
    if (ctrl && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      ngSelection = new Set(ngGraph.nodes.map(n => n.id));
      ngMarkSelection();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); ngDeleteSelection(); return; }
    if (e.key === 'Escape' && ngSelection.size) { e.preventDefault(); ngSelectOnly(null); }
  });

  document.getElementById('ng-save-btn').addEventListener('click', ngSave);
  document.getElementById('ng-new-btn').addEventListener('click', () => {
    ngEditingId = null;
    ngLoadGraph({ name: '', nodes: [], wires: [] });
    document.getElementById('ng-name').value = '';
  });
  document.getElementById('ng-export-btn').addEventListener('click', () => {
    if (!ngGraph.nodes.length) { showNotification('⚠️ Nothing on the board to share yet.'); return; }
    ngGraph.name = document.getElementById('ng-name').value.trim().slice(0, 24) || 'My Mod';
    const code = encodeGraphCode(ngGraph);
    document.getElementById('ng-export-card').style.display = '';
    document.getElementById('ng-export-output').textContent = code;
    document.getElementById('ng-export-note').textContent =
      ngGraph.nodes.length + ' block(s), ' + ngGraph.wires.length + ' connection(s) · ' + code.length + ' characters';
    document.getElementById('ng-copy-btn').onclick = () => copyTextWithFallback(code);
  });
  document.getElementById('ng-import-btn').addEventListener('click', () => {
    const raw = document.getElementById('ng-import').value.trim();
    if (!raw) return;
    const g = decodeGraphCode(raw);
    if (!g) { showNotification('⚠️ That is not a readable mod code (they start with VXG1-).'); return; }
    ngEditingId = null;
    ngLoadGraph(g);
    document.getElementById('ng-import').value = '';
    showNotification('✅ Loaded "' + g.name + '" onto the board.');
  });

  ngRenderPieceList();
  ngRender();
  // The timeline needs a first entry to undo back TO, and this is the only
  // place that runs exactly once per editor session.
  ngResetHistory();
}

// =========================================================
// SMART ROUTING: ein Code, der im falschen Feld gelandet ist
// =========================================================
// Voxeria has five text formats that look confusingly alike: a rule graph
// (VXG1-), a loadout (VXL1-), a mod (VXM3-/MOD1-), a block or creature piece
// (VXB2-/VXB1-/VXC1-) and a room code (VOX-). They all get copied and pasted,
// they all look like "one of those Voxeria codes", and they belong in five
// different fields.
//
// When one of them landed in the WORLD SEED field, nothing visible happened:
// createWorld() takes the contents literally as a seed. So the player got a
// completely ordinary world with no sign of their mod in it, and no hint as to
// why. This is what clears that silent mis-step out of the way: recognise,
// move, say so.
//
// Recognition is by PREFIX, case-insensitively. The rest of a code is base64url
// or base32 and must never be rewritten or it falls apart, so only the prefix
// is pulled to its canonical spelling and the body is taken verbatim.
//
// `minLength` is not polish, it is necessary: routing hangs off the input
// event (see vxGuardSeedField), so it also sees every single KEYSTROKE.
// Without a minimum length, a player typing a room code by hand would be
// interrupted after the sixth character and half a code would be moved. Real
// codes are considerably longer than their prefix.
const VX_STRAY_CODE_ROUTES = [
  {
    prefixes: [GRAPH_PREFIX_C, GRAPH_PREFIX],
    minLength: 16,
    what: 'Rule code',
    // The field exists in the document from page load on, even if the Mod
    // Editor has never been opened. Writing the value into it is therefore
    // enough: it waits there until the editor is opened. Throwing a modal open
    // from a menu screen would be the worse answer (the main menu sits above
    // it) and would drag the player somewhere else mid-task.
    field: 'ng-import',
    where: 'the Mod Editor'
  },
  { prefixes: [LOADOUT_PREFIX], minLength: 16, what: 'Loadout code', field: 'bd-loadout-import', where: 'the Block Designer' },
  { prefixes: [MOD2_PREFIX, MOD_PREFIX], minLength: 16, what: 'Mod code', field: 'mb-import-code', where: 'the Mod Builder' },
  {
    // Block and creature pieces have no paste field; their right place is the
    // library itself. So they go straight in, rather than into a field that
    // does not exist.
    prefixes: ['VXB2-', BLOCK_PIECE_PREFIX_V1, 'VXC1-'],
    minLength: 16,
    what: 'Piece code',
    where: 'your library',
    deliver(code) {
      const decoded = decodeAnyPieceCode(code);
      if (!decoded) return { ok: false, message: '⚠️ That piece code is corrupt and could not be read.' };
      if (!VxPieces.save(decoded.kind, code, decoded.name)) return { ok: false, message: null };
      reapplyCustomPieces();
      if (bdInitDone) bdRenderPieceList();
      if (cdInitDone) cdRenderPieceList();
      return { ok: true, message: '🧩 "' + decoded.name + '" was a piece code, added to your library.' };
    }
  },
  {
    // A room code in the seed field is the same mis-step. It goes to the
    // Multiplayer screen's join field, and since that lives in the same main
    // menu, the screen can be switched over at the same time.
    prefixes: [typeof ROOM_PREFIX === 'string' ? ROOM_PREFIX : 'VOX-'],
    // Room codes are the prefix plus exactly six characters.
    minLength: 10,
    what: 'Room code',
    field: 'vx-mp-code',
    where: 'the Multiplayer screen',
    after() { if (window.VxWorlds && typeof VxWorlds.view === 'function') VxWorlds.view('mp'); }
  }
];

// Pulls the prefix to its canonical spelling and leaves the body alone.
function _vxCanonicalPrefix(value, prefix) {
  return prefix + value.slice(prefix.length);
}

// `accepts` lists the prefixes that are perfectly correct in the ASKING field,
// a room code in the room-code field for instance. This function deliberately
// reports nothing for those: they are not a mis-step, and clearing them away
// would be one.
function vxMatchStrayCode(value, accepts) {
  const v = String(value || '').trim();
  const up = v.toUpperCase();
  for (const route of VX_STRAY_CODE_ROUTES) {
    for (const p of route.prefixes) {
      if (!p || !up.startsWith(p)) continue;
      if (accepts && accepts.indexOf(p) !== -1) return null;
      if (v.length < (route.minLength || 16)) return null;
      return { route, code: _vxCanonicalPrefix(v, p) };
    }
  }
  return null;
}

// Returns true when the value was a code and got rerouted; the caller should
// then treat its own field as dealt with.
function vxRouteStrayCode(value, sourceEl, accepts) {
  const hit = vxMatchStrayCode(value, accepts);
  if (!hit) return false;
  const { route, code } = hit;
  // The code is already where it belongs. Without this guard, delivery would
  // write it back into the very field the line below then clears, and the
  // player would watch their own input disappear.
  if (route.field && sourceEl && document.getElementById(route.field) === sourceEl) return false;

  let result;
  if (typeof route.deliver === 'function') {
    result = route.deliver(code);
  } else {
    const target = document.getElementById(route.field);
    if (!target) {
      result = { ok: false, message: '⚠️ That is a ' + route.what.toLowerCase() + ', not a world seed.' };
    } else {
      target.value = code;
      // A brief flash, in case the target field happens to be on screen. If it
      // is not, this costs nothing and the notification says where the code
      // went anyway.
      target.classList.remove('vx-routed');
      void target.offsetWidth;          // force the animation to restart
      target.classList.add('vx-routed');
      result = { ok: true, message: '📦 ' + route.what + ' recognised, moved to ' + route.where + '.' };
    }
  }

  // The wrong field is ALWAYS cleared, even when delivery failed: the code does
  // not belong there, and leaving it would let the player trigger the silent
  // failure after all.
  if (sourceEl) sourceEl.value = '';
  if (result && result.message) showNotification(result.message);
  if (result && result.ok && typeof route.after === 'function') route.after();
  return true;
}
window.vxRouteStrayCode = vxRouteStrayCode;
window.vxMatchStrayCode = vxMatchStrayCode;

// Attaches smart routing to a field a code does not belong in.
// 'input' rather than just 'paste': pasting happens via Ctrl+V, via the
// context menu and by dragging with the mouse, and only the first of those
// three raises a paste event that could be read.
function vxGuardSeedField(id, accepts) {
  const el = document.getElementById(id);
  if (!el || el._vxGuarded) return;
  el._vxGuarded = true;
  el.addEventListener('input', () => { vxRouteStrayCode(el.value, el, accepts); });
}
window.vxGuardSeedField = vxGuardSeedField;

window.addEventListener('DOMContentLoaded', () => {
  const roomPrefix = typeof ROOM_PREFIX === 'string' ? ROOM_PREFIX : 'VOX-';
  // The world seed field takes a seed and nothing else; every one of the five
  // code formats is a mis-step here.
  vxGuardSeedField('vx-new-seed');
  // The two room-code fields obviously take room codes; they only report when
  // somebody pastes a MOD code into them.
  vxGuardSeedField('vx-mp-code', [roomPrefix]);
  vxGuardSeedField('rp-join-input', [roomPrefix]);
});

function toggleModEditor() {
  if (vxCreatorBlocks('mod-editor-modal')) return;
  const modal = document.getElementById('mod-editor-modal');
  modal.classList.toggle('open');
  if (modal.classList.contains('open')) {
    ngInit(); ngRender();
    // Cascade the node cards in after the modal's own fade has started. CSS
    // cannot do this part: the cards are created by ngRender() at runtime, so
    // there is no static selector to hang a per-child stagger delay on.
    // Guarded — voxeria-juice.js is optional and the editor must work without it.
    if (window.VxJuice) requestAnimationFrame(() => VxJuice.revealNodes());
  }
  else vxStudioRefreshIfOpen();
}
window.toggleModEditor = toggleModEditor;

// Puts a SHARED rule onto the editor's board. Called from the gallery's
// "look inside" button, which is the rung between playing someone's mod and
// building one: almost nobody starts at an empty board, they start by changing
// one thing about something that already works and that they just enjoyed.
//
// Deliberately the same shape as the editor's own Import field rather than a
// second path beside it: ngEditingId stays null, so the board holds a copy and
// Save writes the player's OWN mod instead of overwriting the piece they
// opened. Looking inside somebody's work can't damage it, and can't damage
// anything of theirs either.
//
// Returns false if the editor refused to open, which happens in Normal worlds
// where the creator tools are gated. toggleModEditor has already said so in
// that case, so there is nothing to add here.
function vxOpenGraphInEditor(code, note) {
  const g = decodeGraphCode(code);
  if (!g) { showNotification('� That rule could not be read.'); return false; }
  const modal = document.getElementById('mod-editor-modal');
  if (!modal) return false;
  if (!modal.classList.contains('open')) {
    toggleModEditor();
    if (!modal.classList.contains('open')) return false;
  }
  ngEditingId = null;
  ngLoadGraph(g);
  showNotification('🔍 "' + g.name + '" is on the board. Change anything you like, Save makes your own copy.' +
                   (note ? ' ' + note : ''));
  return true;
}
window.vxOpenGraphInEditor = vxOpenGraphInEditor;

async function mbBuildModData() {
  const name = document.getElementById('mb-name').value.trim().slice(0, 30);
  if (!name) {
    showNotification('⚠️ Your mod needs a name first.');
    document.getElementById('mb-name').focus();
    return null;
  }
  const author = document.getElementById('mb-author').value.trim().slice(0, 24);
  if (mbIsReservedAuthor(author)) {
    const pw = document.getElementById('mb-author-password').value;
    if (!(await mbCheckReservedAuthorPassword(pw))) {
      showNotification('⚠️ Incorrect password for this author name.');
      return null;
    }
  }
  // mbMod already holds every tuned parameter (the controls write straight into
  // it), so this only has to fold in the free-text fields. Routing the result
  // through normalizeModData() means the builder's own output is held to
  // exactly the same limits as a code arriving from a stranger.
  const data = normalizeModData(Object.assign({}, mbMod, {
    name, author,
    seed: document.getElementById('mb-seed').value.trim().slice(0, 60),
    startInventory: mbStartInventory.slice(0, 8)
  }));
  data._description = document.getElementById('mb-desc').value.trim().slice(0, 140);
  return data;
}

async function mbGenerate() {
  const data = await mbBuildModData();
  if (!data) return;
  mbCurrentModData = data;
  mbCurrentModCode = encodeModCode2(data);

  // Verifying our own output before showing it: if this ever failed, we would
  // be handing the player a code that cannot be played.
  const check = decodeModCode2(mbCurrentModCode);
  const codeBox = document.getElementById('mb-code-output');
  codeBox.textContent = mbCurrentModCode;
  codeBox.classList.toggle('mb-code-bad', !check);
  document.getElementById('mb-code-note').innerHTML = check
    ? escapeHtml(mbCurrentModCode.length + ' characters, ending in the checksum ') +
      '<span class="mb-checksum-note">' + escapeHtml(mbCurrentModCode.slice(-2)) + '</span>' +
      escapeHtml('. Every value is range-checked again when the code is loaded.')
    : '⚠️ This code did not survive its own check — please report it.';

  document.getElementById('mb-link-output').textContent = mbBuildLocalPlayLink(mbCurrentModCode);
  document.getElementById('mb-result-card').style.display = 'flex';
  document.getElementById('mb-publish-btn').disabled = !db;
  document.getElementById('mb-result-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function mbBuildLocalPlayLink(code) {
  return window.location.href.split('?')[0] + '?mod=' + encodeURIComponent(code);
}

async function mbCopyLink() {
  if (!mbCurrentModCode) return;
  copyTextWithFallback(mbBuildLocalPlayLink(mbCurrentModCode));
}

async function mbPublish() {
  if (!mbCurrentModCode || !mbCurrentModData) { showNotification('⚠️ Generate a mod code first.'); return; }
  if (!mbSelectedTags.size) {
    showNotification('⚠️ Pick at least one tag so players can find your mod.');
    document.getElementById('mb-tags').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  if (!db || !appId) { showNotification('⚠️ Not connected to the database.'); return; }
  if (mbIsReservedAuthor(mbCurrentModData.author)) {
    const pw = document.getElementById('mb-author-password').value;
    if (!(await mbCheckReservedAuthorPassword(pw))) { showNotification('⚠️ Incorrect password for this author name.'); return; }
  }
  const btn = document.getElementById('mb-publish-btn');
  btn.disabled = true;
  // btn.innerHTML = '...' would rebuild the icon canvas from an HTML string,
  // which draws nothing (the one-time _initVxIcons() pass that draws every
  // icon already ran at load) — same class of bug as the chat-unlock button
  // and the defense badge earlier. Detach the real icon node, swap only the
  // text, then reattach it exactly as it was regardless of outcome.
  const btnIcon = btn.querySelector('canvas.vx-icon');
  btn.innerHTML = '';
  if (btnIcon) btn.appendChild(btnIcon);
  btn.appendChild(document.createTextNode('Publishing…'));
  try {
    const docId = (userId || 'anon') + '_' + Date.now();
    await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'voxeria_mods', docId), {
      name: mbCurrentModData.name,
      author: mbCurrentModData.author || '',
      description: mbCurrentModData._description || '',
      world: mbCurrentModData.world,
      perks: mbCurrentModData.perks,
      startInventory: mbCurrentModData.startInventory,
      // The gallery keeps the readable fields for display, but `code` above is
      // what actually gets played — these are never read back as game state.
      visual: mbCurrentModData.visual,
      behavior: mbCurrentModData.behavior,
      dim: mbCurrentModData.dim,
      tags: Array.from(mbSelectedTags),
      icon: mbCurrentIcon,
      code: mbCurrentModCode,
      userId: userId || 'anon',
      ts: Date.now()
    });
    showNotification('🧩 Mod published! It now appears in the gallery.');
  } catch (e) {
    console.error('Publish error:', e);
    showNotification('❌ Publishing failed.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '';
    if (btnIcon) btn.appendChild(btnIcon);
    btn.appendChild(document.createTextNode('Publish mod'));
  }
}

// -- Mod tip toast: the "did you know Voxeria supports modding?" nudge -------
function dismissModTip() {
  var t = document.getElementById('mod-tip-toast');
  if (t) t.classList.remove('visible');
  try { localStorage.setItem('voxeria_mod_tip_shown', '1'); } catch(e) {}
}
window._modTipShown = false;
function _maybeShowModTip() {
  // Advertising the modding tools in a mode that cannot open them would be a
  // dead link, so the tip stays away rather than being shown and then refused.
  if (!vxCreatorAllowed()) return;
  if (window._modTipShown) return;
  try { if (localStorage.getItem('voxeria_mod_tip_shown') === '1') return; } catch(e) { return; }
  window._modTipShown = true;
  setTimeout(function() {
    var t = document.getElementById('mod-tip-toast');
    if (t) {
      t.classList.add('visible');
      setTimeout(dismissModTip, 11000);
    }
  }, 1800);
}

// ============================================================================
// DEBUG-ANSICHT — die abstrakten Regeln des Studios sichtbar machen
// ============================================================================
// Zonen und Countdowns leben bisher nur als Zahlen im Speicher. Ohne diese
// Ansicht muss man erraten, ob eine Regel ueberhaupt auslaeuft: F3 zeigt
// stattdessen jede Zone als Kasten genau dort, wo sie in der Welt liegt, und
// jede gespeicherte Zahl, Liste und jeden Countdown in einer Textbox am Rand.
//
// Bewusst KEINE feste Rot/Gruen-Bedeutung fuer Zonen: das System kennt keinen
// Unterschied zwischen einer "Todeszone" und einer "Zielzone", eine Zone ist
// nur ein benannter Kasten, den ein Mod gesetzt hat. Was sie bedeutet, weiss
// nur die Regel, die auf sie hoert. Jede Zone bekommt stattdessen eine EIGENE
// Farbe (per Reihenfolge, in der sie angelegt wurde), damit man mehrere
// gleichzeitig sichtbare Zonen auseinanderhalten kann, ohne dass die Farbe
// etwas behauptet, das das System nicht weiss.
let graphDebugView = false;
const GRAPH_ZONE_DEBUG_COLORS = ['#ff5566', '#55e08a', '#55c8ff', '#ffd166', '#c586ff', '#ff9955', '#66e0d0', '#ff6bc4'];
function graphZoneDebugColor(name) {
  const i = Object.keys(graphZones).indexOf(name);
  return GRAPH_ZONE_DEBUG_COLORS[(i < 0 ? 0 : i) % GRAPH_ZONE_DEBUG_COLORS.length];
}

// Weltraum-Kaesten, jeden Frame neu gezeichnet (nicht nur beim Umschalten):
// die Welt selbst wird jeden Frame komplett neu gemalt, ein einmalig
// gezeichneter Kasten waere also sofort wieder ueberdeckt.
function drawGraphDebugZones() {
  if (typeof ctx === 'undefined' || typeof TILE === 'undefined') return;
  for (const name in graphZones) {
    const z = graphZones[name];
    const sx = z.x0 * TILE - drawCamX, sy = z.y0 * TILE - drawCamY;
    const w = (z.x1 - z.x0 + 1) * TILE, h = (z.y1 - z.y0 + 1) * TILE;
    if (sx + w < -8 || sx > canvas.width + 8 || sy + h < -8 || sy > canvas.height + 8) continue; // ausserhalb des Bildschirms
    const col = graphZoneDebugColor(name);
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = col;
    ctx.fillRect(sx, sy, w, h);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.strokeRect(sx + 1, sy + 1, w - 2, h - 2);
    ctx.font = '10px monospace';
    ctx.fillStyle = col;
    ctx.fillText(name, sx + 3, sy + 11);
    ctx.restore();
  }
}

// Die Textbox am Rand. Ein eigenes DOM-Element wie graphBoardElement/
// graphDialogElement oben, aus demselben Grund: gestochen scharfer Text bei
// jeder Aufloesung, ohne selbst Schriftgroessen gegen die Canvas-Aufloesung
// rechnen zu muessen.
let graphDebugPanelEl = null;
function graphDebugPanelElement() {
  if (graphDebugPanelEl && graphDebugPanelEl.isConnected) return graphDebugPanelEl;
  graphDebugPanelEl = document.createElement('div');
  graphDebugPanelEl.id = 'vx-debug-panel';
  graphDebugPanelEl.style.cssText =
    'position:fixed;left:14px;top:96px;z-index:59;min-width:150px;max-width:260px;' +
    'padding:8px 10px;border:1px solid rgba(85,224,138,0.55);border-radius:4px;' +
    'background:rgba(10,14,10,0.82);color:#d8ffe6;' +
    'font-family:var(--font-mono,monospace);font-size:10.5px;line-height:1.55;' +
    'pointer-events:none;display:none;';
  document.body.appendChild(graphDebugPanelEl);
  return graphDebugPanelEl;
}

// Alle Speicher, in genau der Reihenfolge, in der ein Mod-Autor eine Regel
// typischerweise nachverfolgt: erst Zahlen, dann Texte, dann Listen, dann
// Countdowns (weil die von selbst weiterlaufen), dann Zonen (als Farblegende
// zu den Kaesten oben).
function graphDebugPanelHtml() {
  const rows = [];
  rows.push('<div style="color:#8fffb0;letter-spacing:0.08em;margin-bottom:4px">DEBUG (F3)</div>');

  const varNames = Object.keys(graphVars);
  if (varNames.length) {
    rows.push('<div style="opacity:0.7">Zahlen</div>');
    for (const n of varNames.slice(0, 10)) {
      rows.push('<div>' + escapeHtml(n) + ': <b>' + graphVars[n] + '</b></div>');
    }
  }
  const textNames = Object.keys(graphTexts);
  if (textNames.length) {
    rows.push('<div style="opacity:0.7;margin-top:4px">Texte</div>');
    for (const n of textNames.slice(0, 6)) {
      rows.push('<div>' + escapeHtml(n) + ': <b>„' + escapeHtml(graphTexts[n]) + '“</b></div>');
    }
  }
  const listNames = Object.keys(graphLists);
  if (listNames.length) {
    rows.push('<div style="opacity:0.7;margin-top:4px">Listen</div>');
    for (const n of listNames.slice(0, 6)) {
      rows.push('<div>' + escapeHtml(n) + ': [' + graphLists[n].join(', ') + ']</div>');
    }
  }
  const timerNames = Object.keys(graphCountdowns);
  if (timerNames.length) {
    rows.push('<div style="opacity:0.7;margin-top:4px">Countdowns</div>');
    for (const n of timerNames) {
      rows.push('<div>' + escapeHtml(n) + ': <b>' + graphCountdownLeft(n).toFixed(1) + 's</b></div>');
    }
  }
  const zoneNames = Object.keys(graphZones);
  if (zoneNames.length) {
    rows.push('<div style="opacity:0.7;margin-top:4px">Zonen</div>');
    for (const n of zoneNames) {
      const col = graphZoneDebugColor(n);
      rows.push('<div><span style="display:inline-block;width:8px;height:8px;background:' +
                col + ';margin-right:5px;vertical-align:middle"></span>' + escapeHtml(n) + '</div>');
    }
  }
  if (rows.length === 1) rows.push('<div style="opacity:0.6">(noch nichts gesetzt)</div>');
  return rows.join('');
}

let graphDebugPanelLastUpdate = 0;
function drawGraphDebugOverlay(now) {
  drawGraphDebugZones();
  // Die Textbox seltener aktualisieren als die Kaesten: ein DOM-Schreibvorgang
  // ist teurer als ein paar Rechtecke, und Text muss nicht mit 60fps zittern.
  if (now - graphDebugPanelLastUpdate < 150) return;
  graphDebugPanelLastUpdate = now;
  graphDebugPanelElement().innerHTML = graphDebugPanelHtml();
}

function graphToggleDebugView() {
  graphDebugView = !graphDebugView;
  graphDebugPanelElement().style.display = graphDebugView ? '' : 'none';
  if (typeof showNotification === 'function') {
    showNotification(graphDebugView ? '🩻 Debug view on (F3)' : '🩻 Debug view off');
  }
}

// Eigener, unabhaengiger Tastendruck-Beobachter statt eines Eingriffs in den
// bestehenden in voxeria-engine.js -- genau das Muster, das Ctrl+T fuers
// Terminal schon benutzt (siehe voxeria-terminal.js).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'F3') return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  e.preventDefault();
  graphToggleDebugView();
});

// Haengt die Kaesten und die Textbox ans Ende jedes Frames, ohne eine Zeile
// in voxeria-engine.js zu aendern: _gameLoopInner ist eine gewoehnliche
// Funktion und damit von aussen ersetzbar, genau wie updateGraphRuntime es
// schon ist. Laeuft NACH dem Original, zeichnet also ueber Welt, Spieler und
// HUD -- und damit auch ueber allem, was ein Mod selbst einblendet.
if (typeof _gameLoopInner === 'function') {
  const _origGameLoopInner = _gameLoopInner;
  window._gameLoopInner = function (now) {
    _origGameLoopInner(now);
    if (!graphDebugView) return;
    if (typeof vxMenuIsOpen === 'function' && vxMenuIsOpen()) return;
    try { drawGraphDebugOverlay(now); }
    catch (e) { console.warn('Voxeria: Debug-Ansicht fehlgeschlagen', e); }
  };
}


// =========================================================
// ANMELDUNG BEI DER ENGINE
// =========================================================
// Dasselbe Prinzip wie installGraphHooks() weiter oben, nur andersherum. Dort
// umhuellt diese Datei Engine-Funktionen, weil sie einen Ausgang aendern will,
// den die Engine sonst schon gefaellt haette. Hier geht es nur darum, im Frame
// aufgerufen zu werden, und dafuer ist Umhuellen zu viel Werkzeug: die Engine
// rief updateGraphRuntime() bisher direkt und musste dafuer wissen, dass es
// ein Mod-System gibt.
//
// 'update' und nicht 'updateLate': die Graph-Runtime lief schon immer vor
// Tageszeit, Wetter und Drops, damit ein Mod-Ereignis den Frame sieht, der
// gerade simuliert wird, und nicht den davor.
VxHooks.on('update', updateGraphRuntime);

// Zwoelf Stellen in der Engine riefen bis eben fireGraphEvent() direkt: beim
// Sprung, beim Tod, beim Abbauen, bei Tagesanbruch. Damit stand in einer
// Datei, die auch ohne Mod-System laufen soll, zwoelf Mal dessen Name.
//
// Jetzt meldet die Engine nur noch, DASS etwas passiert ist, an einen Punkt,
// der nichts ueber Mods weiss. Der Gewinn ist nicht nur die Richtung: Arena,
// Erfolge oder eine Statistik koennen sich an dieselbe Stelle haengen, ohne
// dass die Engine dafuer eine Zeile aendert.
VxHooks.on('gameEvent', function (type, ctx) { fireGraphEvent(type, ctx); });

// Mod-Codes und Loadout-Codes im Seed-Feld. Diese sechzig Zeilen standen bis
// eben in applySeedFromUI() in voxeria-engine.js, also mitten in dem Pfad, der
// ueber Weltidentitaet entscheidet. Sie sind hier unveraendert, nur mit einem
// return statt jeweils zwoelf Zeilen Weltneustart drumherum: den macht die
// Engine jetzt einmal fuer alle drei Faelle.
//
// Alles bis zum return laeuft garantiert VOR resetGameAndWorld(). Deshalb darf
// registerLoadoutPieces() hier stehen, und deshalb muss es das auch: der Reset
// leert jede Dimension, und die danach neu erzeugten Chunks lesen customOreTiers.
VxHooks.on('seedInput', function (claimed, inputVal) {
  if (claimed) return; // jemand anders war schneller

  // Ein Loadout ist ein Mod PLUS eine Liste eigener Teile. Zuerst geprueft,
  // weil ein VXL1- Code kein VXM3- Code ist und isModCode() ihn abweisen wuerde.
  if (isLoadoutCode(inputVal)) {
    const loadout = decodeLoadoutCode(inputVal);
    if (!loadout) return { error: "⚠️ Invalid loadout code" };
    if (!activeMod) realInventorySnapshot = JSON.parse(JSON.stringify(inventory));
    activeMod = loadout.mod;
    activeLoadoutPieceCodes = loadout.pieceCodes;
    window._activeModCode = inputVal;
    registerLoadoutPieces(loadout.pieceCodes);
    return {
      seed: String(loadout.mod.seed || inputVal).slice(0, 60) || String(Date.now() % 9999999),
      display: inputVal,
      done: function () {
        showModBanner(loadout.mod);
        if (loadout.skipped) showNotification('⚠️ ' + loadout.skipped + ' piece(s) in that loadout were unreadable and were skipped.');
      }
    };
  }

  if (isModCode(inputVal)) {
    const mod = decodeModCode(inputVal);
    if (!mod) return { error: "⚠️ Invalid mod code" };
    // Nur schnappschussen, wenn wir aus einem normalen Zustand kommen: direkt
    // von einem Mod in den naechsten zu wechseln darf das echte Inventar nicht
    // ueberschreiben, das vor dem ersten gesichert wurde.
    if (!activeMod) realInventorySnapshot = JSON.parse(JSON.stringify(inventory));
    activeMod = mod;
    // Ein reiner Mod-Code bringt keine Teile mit: zurueck auf die lokale
    // Bibliothek, damit die Teile eines vorherigen Loadouts nicht mitwandern.
    activeLoadoutPieceCodes = null;
    registerLoadoutPieces();
    window._activeModCode = inputVal; // wandert im geteilten ?mod= Link mit
    return {
      seed: String(mod.seed || inputVal).slice(0, 60) || String(Date.now() % 9999999),
      display: inputVal,
      done: function () { showModBanner(mod); }
    };
  }

  // Kein Code. Damit endet ein eventuell aktiver Mod genau hier, und weil das
  // vor dem Weltneustart passiert, startet die neue Welt sauber ohne ihn.
  activeMod = null;
  activeLoadoutPieceCodes = null;
  registerLoadoutPieces();
  window._activeModCode = null;
  hideModBanner();
});

// F6 Mod-Editor, F8 Konsole, F10 Zufallscode, F12 Hilfe. Vier Tastenkuerzel,
// die vorher im keydown-Handler der Engine standen und jetzt in der Datei
// stehen, der sie gehoeren. Wer nichts zurueckgibt, hat die Taste nicht
// angefasst und laesst sie fuer den naechsten liegen.
VxHooks.on('keyDown', function (handled, key) {
  if (handled) return;
  switch (key) {
    case 'F6':  toggleModEditor();       return true;
    case 'F8':  toggleCommandConsole();  return true;
    case 'F10': generateRandomModCode(); return true;
    case 'F12': toggleCommandHelp();     return true;
  }
});
