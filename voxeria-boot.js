// ============================================================================
// VOXERIA -- BOOT
// ----------------------------------------------------------------------------
// Everything here used to sit in the middle of the single-file script. It is
// its own file now for one reason: it must run AFTER every other game script
// has been parsed. Spawning the player asks the world generator for terrain,
// and that generator lives in voxeria-dimensions-progress.js -- so doing it
// any earlier would reach for a dimension layer that does not exist yet.
//
// Keep this file LAST in index.html.
// ============================================================================

// -- Spawn point + the player themselves ------------------------------------
let initialSpawnX = findSafeSpawnX();
let spawnY = getSurfaceYAt(initialSpawnX, "OVERWORLD");

const player = {
  x: initialSpawnX * TILE, y: (spawnY - 2) * TILE,
  vx: 0, vy: 0, w: 24, h: TILE * 2, onGround: false, health: maxHealth, // exactly matches PLAYER_FRAME_W/H -- see voxeria-engine.js
  scaleX: 1.0, scaleY: 1.0, tilt: 0,
  facing: 1,            // 1 = right, -1 = left; latched in drawPlayer, see there
  wetTimer: 0, frozenTimer: 0, goldFrozenTimer: 0,
  placeAnimTimer: 0, // frames left to show the "place" pose — see executePlace/drawPlayer
  mineAnimTimer: 0, // frames left to show the mining swing after a single discrete hit — see registerMiningHit/drawPlayer. The continuous desktop hold-to-mine path uses the miningActive flag directly instead, see drawPlayer.
  color: `hsl(${Math.floor(Math.random() * 360)}, 100%, 70%)`
};

let fallStartY = null;
const MIN_THUMP_FALL_BLOCKS = 3;

let camX = player.x - (COLS >> 1) * TILE;
let camY = player.y - (ROWS >> 1) * TILE;

// -- Exports for the inline onclick="" handlers in index.html ---------------
window.togglePortalBook = togglePortalBook;
window.toggleBlockInventory = toggleBlockInventory;

window.applySeedFromUI=applySeedFromUI;

// -- Start the game ---------------------------------------------------------
initFirebase(); drawHealth(); drawHotbar(); checkChatUnlockStatus(); updateDefenseBadge(); VibrantVox.syncSelect(); requestAnimationFrame(gameLoop);

