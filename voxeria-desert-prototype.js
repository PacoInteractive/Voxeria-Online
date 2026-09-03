// ============================================================================
// VOXERIA — DESERT PROTOTYPE
// One isolated prototype layer: the Erg settlement blueprint and its first NPC.
// It deliberately reuses the player frame cache, so the merchant has the exact
// same pixel animation language as the player without a second sprite pipeline.
// Remove this script tag to remove the settlement prototype as one unit.
// ============================================================================
(function () {
  'use strict';

  const BLUEPRINT = {
    id: 'erg_trader_shelter_v1',
    name: 'Wüstenhändler-Unterstand',
    // Anchor is the left-most floor block. The roof uses LOG, walls use WOOD,
    // and one TORCH makes the finished form obvious even at night.
    cells: [
      [0, 0, 'STONE'], [1, 0, 'STONE'], [2, 0, 'STONE'], [3, 0, 'STONE'], [4, 0, 'STONE'], [5, 0, 'STONE'], [6, 0, 'STONE'],
      [0,-1, 'WOOD'], [6,-1, 'WOOD'], [0,-2, 'WOOD'], [6,-2, 'WOOD'], [0,-3, 'WOOD'], [6,-3, 'WOOD'],
      [0,-4, 'LOG'],  [1,-4, 'LOG'],  [2,-4, 'LOG'],  [3,-4, 'LOG'],  [4,-4, 'LOG'],  [5,-4, 'LOG'],  [6,-4, 'LOG'],
      [3,-1, 'TORCH']
    ]
  };
  const BLOCK_BY_NAME = {
    STONE: BLOCKS.STONE, WOOD: BLOCKS.WOOD, LOG: BLOCKS.LOG, TORCH: BLOCKS.TORCH
  };
  const state = { completed: null, npc: null, lastHint: 0, checkTimer: null };

  function matchesAt(ax, ay) {
    return BLUEPRINT.cells.every(([dx, dy, name]) => getBlock(ax + dx, ay + dy) === BLOCK_BY_NAME[name]);
  }

  function checkNear(wx, wy) {
    if (currentDim !== 'OVERWORLD' || state.completed) return;
    // The changed cell can be any part of the 7×5 construction. Restricting
    // checks to those plausible anchors avoids an expensive world-wide scan.
    for (let ay = wy; ay <= wy + 4; ay++) {
      for (let ax = wx - 6; ax <= wx; ax++) {
        if (!matchesAt(ax, ay)) continue;
        state.completed = { x: ax, y: ay, arrivedAt: Date.now() + 4500 };
        showNotification('🏠 Bauplan erfüllt! Der Wüstenhändler zieht ein …');
        return;
      }
    }
  }

  function onBlockChanged(wx, wy) {
    if (currentDim !== 'OVERWORLD' || state.completed) return;
    // A short debounce means a quick building burst causes one validation,
    // not a separate scan for every placed block.
    if (state.checkTimer) clearTimeout(state.checkTimer);
    state.checkTimer = setTimeout(() => { state.checkTimer = null; checkNear(wx, wy); }, 90);
  }

  function update() {
    if (!state.completed || state.npc || Date.now() < state.completed.arrivedAt || currentDim !== 'OVERWORLD') return;
    const p = state.completed;
    state.npc = {
      x: (p.x + 3.5) * TILE - PLAYER_FRAME_W / 2,
      y: p.y * TILE,
      color: '#c9863a',
      facing: 1,
      greeted: false
    };
    showNotification('🧭 Der Wüstenhändler ist eingezogen.');
  }

  function draw() {
    const npc = state.npc;
    if (!npc || currentDim !== 'OVERWORLD') return;
    const sx = npc.x - drawCamX + PLAYER_FRAME_W / 2;
    const sy = npc.y - drawCamY;
    if (sx < -40 || sx > canvas.width + 40 || sy < -70 || sy > canvas.height + 40) return;
    const frame = (Math.sin(frameCount * 0.07) > 0) ? 'idleB' : 'idleA';
    const sprite = _getPlayerFrame(frame, npc.color);
    ctx.save();
    ctx.translate(Math.round(sx), Math.round(sy));
    const oldSmooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sprite, -PLAYER_FRAME_W / 2, -PLAYER_FRAME_H, PLAYER_FRAME_W, PLAYER_FRAME_H);
    // Merchant scarf: a tiny distinct accent over the shared player frame.
    ctx.fillStyle = '#315c68'; ctx.fillRect(-PLAYER_FRAME_W / 2 + 4, -PLAYER_FRAME_H + 19, PLAYER_FRAME_W - 8, 3);
    ctx.imageSmoothingEnabled = oldSmooth;
    ctx.font = fontUI('10px'); ctx.textAlign = 'center';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText('Wüstenhändler', 0, -PLAYER_FRAME_H - 8);
    ctx.fillStyle = '#fff1c4'; ctx.fillText('Wüstenhändler', 0, -PLAYER_FRAME_H - 8);
    ctx.restore();

    if (!npc.greeted && Math.hypot(player.x - npc.x, player.y - npc.y) < TILE * 3) {
      npc.greeted = true;
      showNotification('🧭 Händler: Bring mir gerettete Erg-Materialien — bald tausche ich sie gegen Sturmausrüstung.');
    }
  }

  // Both direct local edits and synced placements use their own existing entry
  // points. Wrapping both keeps the blueprint reactive without changing the
  // engine's mining, networking or modding semantics.
  const baseSetBlock = setBlock;
  setBlock = function (x, y, type) {
    baseSetBlock(x, y, type);
    onBlockChanged(x, y);
  };
  const baseSetBlockAndBroadcast = setBlockAndBroadcast;
  setBlockAndBroadcast = function (x, y, type, destDim) {
    baseSetBlockAndBroadcast(x, y, type, destDim);
    onBlockChanged(x, y);
  };

  window.VxDesertPrototype = { BLUEPRINT, update, draw, onBlockChanged };

  // Bis hierher stand im Game Loop von voxeria-engine.js zweimal
  // `if (window.VxDesertPrototype) ...`. Das war das gleiche Muster wie
  // VxHooks, nur von Hand und nur fuer diese eine Datei. Jetzt tragen wir uns
  // an denselben zwei Stellen ein: 'update' laeuft vor Tageszeit und Wetter,
  // 'drawAfterPlayer' zeichnet hinter dem Spieler und vor der Parallaxe,
  // exakt die alten Plaetze.
  //
  // order -10, damit der Prototyp wie bisher VOR der Graph-Runtime aus
  // voxeria-modding.js laeuft. Ohne die Zahl entschiede die Reihenfolge der
  // <script>-Tags, und dort steht modding vor dieser Datei, der Ablauf waere
  // also still vertauscht worden.
  VxHooks.on('update', update, -10);
  VxHooks.on('drawAfterPlayer', draw);
})();
