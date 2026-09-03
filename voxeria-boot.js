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
// Zuweisungen, keine Deklarationen: diese Werte gehoeren dem Renderer und
// stehen in voxeria-engine.js. Gesetzt werden sie hier, weil ihre Startwerte
// den Weltgenerator brauchen und der erst nach der Engine geladen ist.
initialSpawnX = findSafeSpawnX();
spawnY = getSurfaceYAt(initialSpawnX, "OVERWORLD");

// Der Spieler selbst steht in voxeria-engine.js. Hier bekommt er nur seine
// Startposition, denn die braucht den Weltgenerator.
player.x = initialSpawnX * TILE;
player.y = (spawnY - 2) * TILE;

camX = player.x - (COLS >> 1) * TILE;
camY = player.y - (ROWS >> 1) * TILE;

// -- Exports for the inline onclick="" handlers in index.html ---------------
window.togglePortalBook = togglePortalBook;
window.toggleBlockInventory = toggleBlockInventory;

window.applySeedFromUI=applySeedFromUI;

// -- Start the game ---------------------------------------------------------
initFirebase(); drawHealth(); drawHotbar(); updateDefenseBadge(); VibrantVox.syncSelect(); requestAnimationFrame(gameLoop);

