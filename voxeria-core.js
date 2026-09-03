// ============================================================================
// VOXERIA -- CORE
// ----------------------------------------------------------------------------
// Das Fundament, auf dem alles andere steht. Laedt als ERSTE Datei, vor
// voxeria-engine.js, und ruft selbst nichts auf: sie kennt weder Renderer noch
// Weltgenerator noch Mod-System.
//
// WARUM ES DIESE DATEI GIBT
//
// Zwischen voxeria-engine.js und voxeria-worldgen.js lag ein Ring, und er war
// von anderer Art als alle anderen, die aufgeloest wurden. Die anderen waren
// jeweils ein Aufruf, der in die falsche Richtung zeigte, und ein Hook drehte
// ihn um. Hier nicht: die Engine ruft den Weltgenerator 42 Mal, und das ist die
// RICHTIGE Richtung, denn ein Renderer braucht Terrain. Umgekehrt las der
// Generator dreizehn Namen aus der Engine, und die meisten gehoerten keinem von
// beiden. BLOCKS, CHUNK_W, seededRandom: das ist gemeinsame Sprache, kein
// Dienst, den einer dem anderen leistet.
//
// Ein Ring aus gemeinsamer Sprache laesst sich nicht mit Hooks aufloesen,
// sondern nur, indem die Sprache ein eigenes Zuhause bekommt. Das ist diese
// Datei.
//
// WAS HIERHER GEHOERT: Vokabular und Zustand, ueber den sich alle Dateien einig
// sein muessen, und nichts, was davon abhaengt, WIE gezeichnet, geladen oder
// simuliert wird. Faustregel: wenn es ein Canvas, ein DOM-Element oder Firebase
// braucht, gehoert es nicht hierher.
//
// WAS BEWUSST NICHT HIER STEHT: COLS und ROWS. Das ist die Groesse des
// Fensters, nicht die der Welt, und sie aendern sich beim Skalieren. Der
// Renderer besitzt sie und leitet sie aus TILE ab.
// ============================================================================

// ============================================================================
// VxHooks -- damit "laedt danach" auch "haengt davon ab" bleibt.
// ----------------------------------------------------------------------------
// Der Satz oben stimmt nur in eine Richtung. Gewachsen ist daraus das
// Gegenteil: die Engine ruft inzwischen ueberall nach oben in Dateien hinein,
// die erst nach ihr geladen werden. `node tools/check.js deps` zaehlt das aus,
// und es waren 33 Namen aus dimensions-progress und 22 aus modding. Damit gibt
// es keine unterste Schicht mehr, sondern einen Ring: jede Datei braucht jede.
//
// Das ist nicht nur haesslich, es kostet konkret. Nichts laesst sich einzeln
// oeffnen, testen oder ersetzen, weil kein Teil ohne den Rest laeuft, und der
// Spielablauf steht nirgends geschrieben, sondern nur in der Reihenfolge der
// <script>-Tags in index.html.
//
// Diese Registry dreht die Pfeile um. Statt dass die Engine
// updatePocketDimension() ruft und damit weiss, dass es Pocket-Dimensionen
// gibt, macht sie an derselben Stelle einen benannten Punkt auf, und
// dimensions-progress traegt sich dort ein. Das Verhalten ist Zeile fuer
// Zeile dasselbe, die Abhaengigkeit zeigt danach nur noch nach unten.
//
// Das Muster ist nicht neu, es ist das, was das Projekt ohnehin schon tut:
// `if (window.VxDesertPrototype) VxDesertPrototype.update(dt)` im Game Loop,
// installGraphHooks() in voxeria-modding.js, das VxArena-IIFE. Neu ist nur,
// dass es einen Namen hat und dass es nicht jedes Mal neu erfunden wird.
//
// ZWEI FORMEN, weil es zwei Fragen gibt:
//   run(name, ...)            "das ist gerade passiert"  -- Rueckgabe egal
//   filter(name, wert, ...)   "was soll daraus werden"   -- Wert wandert durch
//
// Jeder Listener laeuft in seinem eigenen try. Diese Punkte liegen im Game
// Loop, also 60 Mal pro Sekunde: ein Fehler in einem Feature darf das Bild
// nicht anhalten, sonst ist ein kleiner Mod-Bug ein schwarzer Bildschirm.
//
// DER DRITTE PARAMETER von on() ist wichtiger, als er aussieht. Ohne ihn waere
// die Aufrufreihenfolge innerhalb eines Punktes die Anmeldereihenfolge, und
// die ist die Reihenfolge der <script>-Tags in index.html. Damit haette diese
// Registry das Problem, gegen das sie gebaut ist, nur um eine Ebene
// verschoben: wer die Zeilen in index.html vertauscht, veraendert still den
// Spielablauf. Mit order steht es in der Datei, die es angeht.
// ============================================================================
const VxHooks = (function () {
  const slots = Object.create(null);
  // Ein Punkt, an dem noch nie jemand hing, hat keine Liste. Das spart im
  // Game Loop den Allocation-Druck, den ein leeres Array pro Slot machen
  // wuerde, und macht has() zur ehrlichen Antwort statt zu "Laenge 0".
  return {
    // order: kleiner laeuft frueher, Standard 0. Bei Gleichstand gewinnt, wer
    // sich zuerst angemeldet hat, damit zwei Zeilen untereinander in derselben
    // Datei auch in dieser Reihenfolge laufen.
    on(name, fn, order) {
      if (typeof fn !== 'function') return;
      const list = slots[name] || (slots[name] = []);
      const rank = (typeof order === 'number') ? order : 0;
      let i = list.length;
      while (i > 0 && list[i - 1].rank > rank) i--;
      list.splice(i, 0, { fn: fn, rank: rank });
    },
    run(name, a, b, c) {
      const list = slots[name];
      if (!list) return;
      for (let i = 0; i < list.length; i++) {
        try { list[i].fn(a, b, c); }
        catch (e) { console.error('VxHooks "' + name + '" fehlgeschlagen:', e); }
      }
    },
    // Wer undefined zurueckgibt, wollte den Wert nicht anfassen. Sonst muesste
    // jeder Listener, der nur mitliest, den Wert von Hand weiterreichen, und
    // ein vergessenes return wuerde den Wert still auf undefined setzen.
    filter(name, value, a, b) {
      const list = slots[name];
      if (!list) return value;
      for (let i = 0; i < list.length; i++) {
        try {
          const out = list[i].fn(value, a, b);
          if (out !== undefined) value = out;
        } catch (e) { console.error('VxHooks "' + name + '" fehlgeschlagen:', e); }
      }
      return value;
    },
    has(name) { return !!slots[name]; },
    // Nur fuer Diagnose: was haengt gerade wo? Ohne das ist ein Punkt, an dem
    // niemand haengt, von einem Punkt, den niemand ausloest, nicht zu
    // unterscheiden, und beides sieht im Spiel gleich aus, naemlich nach nichts.
    debug() {
      const out = {};
      for (const name of Object.keys(slots)) {
        out[name] = slots[name].map(e => (e.fn.name || '(anonym)') + '@' + e.rank);
      }
      return out;
    }
  };
})();
window.VxHooks = VxHooks;

// =========================================================
// GEOMETRIE DER WELT
// =========================================================
const TILE = 28;
const WORLD_H = 120;
const CHUNK_W = 32;

// =========================================================
// BLOCKS -- das Vokabular
// =========================================================
const BLOCKS = {
  AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, WOOD: 4,
  LEAVES: 5, SAND: 6, WATER: 7, COAL_ORE: 8,
  IRON_ORE: 9, GOLD_ORE: 10, BEDROCK: 11, LOG: 12,
  GLASS: 13, PLANKS: 14, TORCH: 15,
  DIAMOND_ORE: 16, FLOWER: 19, LIGHTER: 20, BG_PLANKS: 21,
  CACTUS: 23, ICE: 24, RAINBOW_ORE: 25, PORTAL: 26, YELLOW_LIMESTONE: 27,
  DIAMOND_DYNAMITE: 28, GOLD_BRICK: 29,
  // Ocean Depth dimension blocks
  OCEAN_STONE: 31, CORAL: 32, KELP: 33, DEEP_WATER: 34, SEA_LANTERN: 35,
  // Lava Core dimension blocks
  MAGMA: 36, LAVA: 37, OBSIDIAN: 38, EMBER_ORE: 39, FIRE_CRYSTAL: 40,
  // Blither dimension blocks
  VOID_STONE: 41, VOID_ORE: 42, STAR_DUST: 43, ETHER_CRYSTAL: 44, VOID_GLASS: 45,
  // Volcano Biome (Overworld)
  VOLCANIC_ROCK: 46, ASH_DIRT: 47, LAVA_POOL: 48, SULFUR_ORE: 49, CINDER_BLOCK: 50,
  // Mystic Biome (Overworld)
  MYSTIC_EARTH: 51, GLOWSHROOM: 52, CRYSTAL_FLOWER: 53, HAZELNUT_WOOD: 54, HAZELNUT_SHELL: 55,
  MYSTIC_ORE: 56,
  // The Erg dimension blocks
  ERG_SAND: 57, ERG_SANDSTONE: 58, ERG_CACTUS: 59
};

// =========================================================
// DIMENSIONEN
// =========================================================
// Chunk-Speicher pro Dimension. "MENU" hat bewusst eine eigene Map, damit das
// Panorama hinter dem Hauptmenue niemals Terrain in einen Chunk-Index cached,
// den der echte Spielstand noch gar nicht erzeugt hat.
const dimensions = { "OVERWORLD": new Map(), "GOLD": new Map(), "OCEAN": new Map(), "LAVA": new Map(), "VOID": new Map(), "ERG": new Map(), "MENU": new Map() };
let currentDim = "OVERWORLD";

// Dimension -> Nonce. Eine Dimension, die bei jedem Betreten ein frisches
// Layout bekommt, traegt hier ihre Nonce ein, damit sie in den Hash von
// seededRandom() wandert. Wer fehlt, bekommt den unveraenderten Schluessel,
// und genau deshalb verschiebt sich das Terrain der Overworld nie.
const DIM_SEED_SALT = Object.create(null);

// Dimensionen, deren Blockaenderungen niemals gespeichert werden. Ein Schreiben
// nach Firebase waere dort dauerhafter Muell, den nie jemand zurueckliest.
const EPHEMERAL_DIMS = new Set();

// =========================================================
// DER WOCHEN-SEED
// =========================================================
// Fester Wochenrhythmus, fuer jeden Spieler derselbe Moment (UTC-Epoche), nicht
// abhaengig davon, wann jemand beigetreten ist oder einen Block gesetzt hat.
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const WEEKLY_EPOCH = Date.UTC(2024, 0, 1); // fixed Monday 00:00 UTC anchor

function getWeekNumber(now = Date.now()) {
  return Math.floor((now - WEEKLY_EPOCH) / WEEK_MS);
}

function getWeeklySeedString(weekNum = getWeekNumber()) {
  return `WEEKLY-${weekNum}`;
}

function getNextWeeklyResetTime() {
  return WEEKLY_EPOCH + (getWeekNumber() + 1) * WEEK_MS;
}

function isWeeklyAutoSeed(seedRaw) {
  return /^WEEKLY-\d+$/.test(String(seedRaw));
}

// =========================================================
// SEED UND ZUFALL
// =========================================================
function hashCode(str) {
  let hash = 2166136261;
  str = String(str);
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seedToNumber(value) {
  const raw = String(value).trim();
  if (raw !== "" && isFinite(Number(raw))) return Number(raw);
  return hashCode(raw);
}

function seededRandom(...parts) {
  // Eine Dimension mit Nonce faltet sie in den Schluessel, damit jedes Betreten
  // ein frisches Layout ergibt. Ohne Nonce bleibt der Schluessel Byte fuer Byte
  // derselbe wie immer, weshalb das Terrain der Overworld nie wandert.
  const salt = DIM_SEED_SALT[currentDim];
  const key = salt !== undefined
    ? [rawSeedString, currentDim, salt, ...parts].join('|')
    : [rawSeedString, currentDim, ...parts].join('|');
  let h = hashCode(key);
  h += 0x6D2B79F5;
  h = Math.imul(h ^ (h >>> 15), h | 1);
  h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
  return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
}

function seededInt(min, max, ...parts) {
  return Math.floor(seededRandom(...parts) * (max - min + 1)) + min;
}

// Voreinstellung ist der Wochen-Seed: wer keinen eigenen waehlt und keinem Raum
// beitritt, landet in derselben Welt wie alle anderen dieser Woche.
let rawSeedString = getWeeklySeedString();
let SEED = seedToNumber(rawSeedString);

// =========================================================
// SITZUNGSZUSTAND
// =========================================================
// Worauf sich gerade alle einigen muessen. Beide werden ausserhalb dieser Datei
// gesetzt, hier stehen nur die Ausgangswerte.
let gameMode = 'normal';          // 'explore' | 'normal' | 'arena'
let activeMod = null;
