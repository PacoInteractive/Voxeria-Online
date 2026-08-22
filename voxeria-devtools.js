// ============================================================================
// VOXERIA -- HIDDEN DEV TOOL: UI LAYOUT & TEXT EDITOR (Ctrl+Shift+E)
// Build-time tool for the developer, not part of the shipped game experience.
// Self-contained on purpose -- do not fold this into the game scripts.
// ============================================================================

(function () {
  var STORAGE_KEY = 'voxeria_ui_editor_draft';
  var active = false;
  var panel = null;
  var moved = {};   // selector -> {dx, dy}
  var edited = {};  // selector -> text
  var hovered = null;
  var editingEl = null;
  var editingOriginalText = '';
  var drag = null;  // {el, selector, startX, startY, baseDx, baseDy, moved:boolean}
  var DRAG_THRESHOLD = 4;

  function isOwnUI(el) { return !!(el && el.closest && el.closest('.vxed-own')); }
  function isCanvas(el) { return el && el.id === 'canvas'; }

  // Elements not worth ever targeting: the <html>/<body>/top-level layout
  // shells. Everything else — however deeply nested — is fair game, since
  // "every UI element" means exactly that.
  function isTooRoot(el) {
    return !el || el === document.body || el === document.documentElement;
  }

  function getSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      var parent = node.parentElement;
      if (!parent) break;
      var idx = Array.prototype.indexOf.call(parent.children, node) + 1;
      parts.unshift(node.tagName.toLowerCase() + ':nth-child(' + idx + ')');
      node = parent;
    }
    return parts.join(' > ');
  }

  function parseTranslate(el) {
    var m = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/.exec(el.style.transform || '');
    return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : { x: 0, y: 0 };
  }

  function isDirectTextTarget(el) {
    if (!el || el.children.length > 0) return false;
    return el.textContent.trim().length > 0;
  }

  // ---- persistence: re-apply a saved draft so work-in-progress survives reloads ----
  function saveDraft() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ moved: moved, edited: edited })); } catch (e) {}
  }
  function loadDraftAndApply() {
    var raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) {}
    if (!raw) return;
    var data;
    try { data = JSON.parse(raw); } catch (e) { return; }
    moved = data.moved || {};
    edited = data.edited || {};
    applyAll();
  }
  function applyAll() {
    Object.keys(moved).forEach(function (sel) {
      try {
        var el = document.querySelector(sel);
        if (el) el.style.transform = 'translate(' + moved[sel].x + 'px,' + moved[sel].y + 'px)';
      } catch (e) {}
    });
    Object.keys(edited).forEach(function (sel) {
      try {
        var el = document.querySelector(sel);
        if (el) el.textContent = edited[sel];
      } catch (e) {}
    });
  }
  // Some panels render their contents lazily (only once opened, or once
  // Firebase data arrives), so a single pass on load can miss them. Retry a
  // few times over the first several seconds instead of polling forever.
  var _reapplyTries = 0;
  function scheduleReapply() {
    if (_reapplyTries++ > 20) return;
    setTimeout(function () { applyAll(); scheduleReapply(); }, 500);
  }

  // ---- panel ----
  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'vxed-panel';
    panel.className = 'vxed-own';
    panel.innerHTML =
      '<div class="vxed-title">🛠 UI Editor <span style="float:right;opacity:.6;font-weight:400;">Ctrl+Shift+E</span></div>' +
      '<div class="vxed-row"><span>Moved</span><span id="vxed-count-moved">0</span></div>' +
      '<div class="vxed-row"><span>Text changed</span><span id="vxed-count-edited">0</span></div>' +
      '<div class="vxed-row" style="opacity:.6;">Drag = move · Click = edit text</div>' +
      '<button id="vxed-export-btn">Export code</button>' +
      '<button id="vxed-reset-btn" class="vxed-secondary">Reset everything</button>' +
      '<button id="vxed-close-btn" class="vxed-secondary">Close editor</button>';
    document.body.appendChild(panel);
    document.getElementById('vxed-export-btn').addEventListener('mousedown', function (e) { e.stopPropagation(); });
    document.getElementById('vxed-export-btn').addEventListener('click', function (e) { e.stopPropagation(); if (editingEl) commitEdit(); openExportModal(); });
    document.getElementById('vxed-reset-btn').addEventListener('mousedown', function (e) { e.stopPropagation(); });
    document.getElementById('vxed-reset-btn').addEventListener('click', function (e) { e.stopPropagation(); if (editingEl) commitEdit(); resetAll(); });
    document.getElementById('vxed-close-btn').addEventListener('mousedown', function (e) { e.stopPropagation(); });
    document.getElementById('vxed-close-btn').addEventListener('click', function (e) { e.stopPropagation(); toggleEditor(); });
    makePanelDraggable();
    refreshPanelCounts();
  }
  function makePanelDraggable() {
    var title = panel.querySelector('.vxed-title');
    var pd = null;
    title.addEventListener('mousedown', function (e) {
      e.stopPropagation();
      var rect = panel.getBoundingClientRect();
      pd = { startX: e.clientX, startY: e.clientY, left: rect.left, top: rect.top };
      panel.style.right = 'auto';
    });
    document.addEventListener('mousemove', function (e) {
      if (!pd) return;
      panel.style.left = (pd.left + (e.clientX - pd.startX)) + 'px';
      panel.style.top = (pd.top + (e.clientY - pd.startY)) + 'px';
    });
    document.addEventListener('mouseup', function () { pd = null; });
  }
  function refreshPanelCounts() {
    if (!panel) return;
    document.getElementById('vxed-count-moved').textContent = Object.keys(moved).length;
    document.getElementById('vxed-count-edited').textContent = Object.keys(edited).length;
  }
  function resetAll() {
    if (!confirm('Really reset all moves and text changes? This only affects this editor draft, not code you already exported/pasted.')) return;
    Object.keys(moved).forEach(function (sel) { try { var el = document.querySelector(sel); if (el) el.style.transform = ''; } catch (e) {} });
    Object.keys(edited).forEach(function (sel) { try { var el = document.querySelector(sel); if (el) el.classList.remove('vxed-moved'); } catch (e) {} });
    moved = {}; edited = {};
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    refreshPanelCounts();
  }

  // ---- export ----
  function escapeJsString(s) { return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n'); }
  function buildExportText() {
    var cssLines = [];
    Object.keys(moved).forEach(function (sel) {
      var d = moved[sel];
      cssLines.push(sel + ' { transform: translate(' + Math.round(d.x) + 'px, ' + Math.round(d.y) + 'px); }');
    });
    var jsLines = [];
    Object.keys(edited).forEach(function (sel) {
      jsLines.push('  { var el = document.querySelector("' + sel.replace(/"/g, '\\"') + '"); if (el) el.textContent = "' + escapeJsString(edited[sel]) + '"; }');
    });
    var out = '';
    out += '/* ---- UI Editor Export ----\n';
    out += '   Positions: paste this <style> block anywhere before </head>.\n';
    out += '   Text: paste the <script> block anywhere before </body> (or into\n';
    out += '   the existing main script block).\n';
    out += '   Note: text changes on elements the game itself keeps re-rendering\n';
    out += '   (hearts, hotbar counts, X/Y readout, chat, notifications) get\n';
    out += '   overwritten by the next re-render -- those need to be changed in\n';
    out += '   the source code itself instead. */\n\n';
    if (cssLines.length) {
      out += '<style>\n' + cssLines.map(function (l) { return '  ' + l; }).join('\n') + '\n</style>\n\n';
    } else {
      out += '<!-- no position changes -->\n\n';
    }
    if (jsLines.length) {
      out += '<script>\ndocument.addEventListener("DOMContentLoaded", function () {\n' + jsLines.join('\n') + '\n});\n</' + 'script>\n';
    } else {
      out += '<!-- no text changes -->\n';
    }
    return out;
  }
  function openExportModal() {
    var modal = document.createElement('div');
    modal.id = 'vxed-export-modal';
    modal.className = 'vxed-own';
    var text = buildExportText();
    modal.innerHTML =
      '<div class="vxed-box">' +
        '<div style="font-weight:800;font-size:15px;">🛠 Code Export</div>' +
        '<textarea readonly></textarea>' +
        '<div class="vxed-actions">' +
          '<button class="vxed-secondary" id="vxed-dl">Download as file</button>' +
          '<button id="vxed-copy">Copy to clipboard</button>' +
          '<button class="vxed-secondary" id="vxed-close-modal">Close</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.querySelector('textarea').value = text;
    modal.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    modal.addEventListener('click', function (e) { e.stopPropagation(); });
    document.getElementById('vxed-copy').onclick = function () {
      navigator.clipboard.writeText(text).catch(function () {
        var ta = modal.querySelector('textarea'); ta.focus(); ta.select(); document.execCommand('copy');
      });
    };
    document.getElementById('vxed-dl').onclick = function () {
      var blob = new Blob([text], { type: 'text/plain' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'voxeria-ui-export.txt';
      a.click();
    };
    document.getElementById('vxed-close-modal').onclick = function () { modal.remove(); };
  }

  // ---- interaction (capture phase, so it always wins over game handlers while active) ----
  function onMouseOver(e) {
    if (isOwnUI(e.target) || isCanvas(e.target) || isTooRoot(e.target)) return;
    if (hovered && hovered !== e.target) clearHover();
    hovered = e.target;
    hovered.classList.add(isDirectTextTarget(hovered) ? 'vxed-text-outline' : 'vxed-hover-outline');
  }
  function clearHover() {
    if (hovered) { hovered.classList.remove('vxed-hover-outline', 'vxed-text-outline'); hovered = null; }
  }
  function onMouseDown(e) {
    if (isOwnUI(e.target)) return; // let the panel/modal's own handlers run
    e.preventDefault(); e.stopPropagation();
    if (isCanvas(e.target) || isTooRoot(e.target)) return;
    var el = e.target;
    var base = parseTranslate(el);
    drag = { el: el, selector: getSelector(el), startX: e.clientX, startY: e.clientY, baseDx: base.x, baseDy: base.y, moved: false };
  }
  function onMouseMove(e) {
    if (!drag) return;
    e.preventDefault(); e.stopPropagation();
    var dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
    if (!drag.moved && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) drag.moved = true;
    if (drag.moved) {
      var nx = drag.baseDx + dx, ny = drag.baseDy + dy;
      drag.el.style.transform = 'translate(' + nx + 'px,' + ny + 'px)';
    }
  }
  function onMouseUp(e) {
    if (!drag) return;
    e.preventDefault(); e.stopPropagation();
    if (drag.moved) {
      var t = parseTranslate(drag.el);
      moved[drag.selector] = t;
      drag.el.classList.add('vxed-moved');
      refreshPanelCounts();
      saveDraft();
    } else {
      // No real drag happened — treat it as a click: edit text if this
      // element directly carries its own text.
      if (isDirectTextTarget(drag.el)) startEdit(drag.el);
    }
    drag = null;
  }
  function startEdit(el) {
    clearHover();
    editingEl = el;
    editingOriginalText = el.textContent;
    el.contentEditable = 'true';
    el.classList.add('vxed-text-outline');
    // blur is the ONE reliable signal that editing ended, no matter how focus
    // left (Tab, clicking the panel, clicking a totally unrelated element,
    // the browser losing focus). Relying on "did mousedown hit a different
    // target" instead used to miss the case of clicking a panel button while
    // mid-edit — e.g. hitting "Code exportieren" straight after typing would
    // silently drop the edit because nothing ever committed it.
    el.addEventListener('blur', onEditBlur);
    el.focus();
    document.execCommand('selectAll', false, null);
  }
  function onEditBlur() { commitEdit(); }
  function commitEdit() {
    if (!editingEl) return;
    var el = editingEl;
    el.removeEventListener('blur', onEditBlur);
    el.contentEditable = 'false';
    el.classList.remove('vxed-text-outline');
    if (el.textContent !== editingOriginalText) {
      edited[getSelector(el)] = el.textContent;
      el.classList.add('vxed-moved');
      refreshPanelCounts();
      saveDraft();
    }
    editingEl = null;
  }
  function cancelEdit() {
    if (!editingEl) return;
    var el = editingEl;
    el.removeEventListener('blur', onEditBlur);
    el.textContent = editingOriginalText;
    el.contentEditable = 'false';
    el.classList.remove('vxed-text-outline');
    editingEl = null;
    el.blur();
  }
  function onKeyDown(e) {
    if (editingEl) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
      e.stopPropagation();
    }
  }
  function onClickCapture(e) {
    // Swallow every click while active EXCEPT clicks on the editor's own
    // panel/modal — otherwise a "click to edit text" would also fire the
    // real button underneath it (opening a modal, changing world, etc.).
    if (isOwnUI(e.target)) return;
    e.preventDefault(); e.stopPropagation();
  }

  function toggleEditor() {
    active = !active;
    if (active) {
      if (editingEl) commitEdit();
      buildPanel();
      document.addEventListener('mouseover', onMouseOver, true);
      document.addEventListener('mousedown', onMouseDown, true);
      document.addEventListener('mousemove', onMouseMove, true);
      document.addEventListener('mouseup', onMouseUp, true);
      document.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('click', onClickCapture, true);
    } else {
      if (editingEl) commitEdit();
      clearHover();
      document.removeEventListener('mouseover', onMouseOver, true);
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('mousemove', onMouseMove, true);
      document.removeEventListener('mouseup', onMouseUp, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('click', onClickCapture, true);
      if (panel) { panel.remove(); panel = null; }
      var modal = document.getElementById('vxed-export-modal');
      if (modal) modal.remove();
    }
  }

  window.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      toggleEditor();
    }
  });

  // Re-apply any saved draft on load, regardless of whether the editor is
  // currently toggled on — a customized layout should stick around.
  loadDraftAndApply();
  scheduleReapply();
})();

