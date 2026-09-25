/* 图片拼接工坊 - 主线程 UI */
(function () {
'use strict';
var Lib = window.ImageCollageLib;
var $ = function (id) { return document.getElementById(id); };

/* ---------- 状态 ---------- */
var state = {
  mode: 'long',
  items: [],                 // {id, file, name, width, height, hasAlpha, thumbUrl, status}
  settings: {
    gap: 12, pad: 20, bgColor: '#ffffff', transparent: false,
    radius: 8, borderWidth: 0, borderColor: '#dddddd', fit: 'cover',
    longWidth: 1080, cellSize: null,
    freeW: 1200, freeH: 1200
  },
  selectedId: null,
  worker: null,
  webpSupported: false,
  exportSeq: 0,
  scale: 1
};
var seq = 0;
var nextId = function () { return 'img_' + (++seq) + '_' + Date.now().toString(36); };
var byId = function (id) {
  for (var i = 0; i < state.items.length; i++) if (state.items[i].id === id) return state.items[i];
  return null;
};

/* ---------- Worker ---------- */
function setupWorker() {
  if (!('Worker' in window) || typeof OffscreenCanvas === 'undefined' || !HTMLCanvasElement.prototype.transferControlToOffscreen) {
    // 没有 OffscreenCanvas 也允许使用（部分旧浏览器），但降级提示
  }
  try {
    state.worker = Lib.createWorker();
  } catch (e) {
    toast('当前浏览器不支持 Web Worker，无法处理图片', 'error');
    return;
  }
  state.worker.onmessage = function (e) { onWorkerMessage(e.data); };
  state.worker.onerror = function (e) {
    toast('Worker 错误：' + (e.message || '未知错误'), 'error');
  };
  state.worker.postMessage({ type: 'init' });
}

function onWorkerMessage(msg) {
  if (msg.type === 'ready') {
    state.webpSupported = !!msg.webpSupported;
    updateFormatOptions();
    return;
  }
  if (msg.type === 'loaded') {
    var item = byId(msg.id);
    if (!item) return;
    if (msg.error) {
      item.status = 'error';
      item.error = msg.error;
      renderFilmstrip();
      toast('「' + item.name + '」无法读取：不支持的格式或文件已损坏', 'error');
      return;
    }
    item.width = msg.width;
    item.height = msg.height;
    item.hasAlpha = msg.hasAlpha;
    item.thumbUrl = msg.thumbUrl;
    item.status = 'ready';
    renderFilmstrip();
    schedulePreview();
    updateExportInfo();
    return;
  }
  if (msg.type === 'exportProgress') {
    if (msg.exportId === currentExportId) updateProgress(msg.progress);
    return;
  }
  if (msg.type === 'exportDone') {
    if (msg.exportId !== currentExportId) return; // 已取消的旧任务
    finishExport(msg);
  }
}

/* ---------- 文件导入 ---------- */
function addFiles(fileList) {
  var files = Array.prototype.slice.call(fileList).filter(function (f) {
    return f.type.indexOf('image/') === 0;
  });
  if (!files.length) {
    if (fileList.length) toast('请选择图片文件', 'error');
    return;
  }
  var tooBig = files.filter(function (f) { return f.size > 100 * 1024 * 1024; });
  files.forEach(function (file) {
    var item = { id: nextId(), file: file, name: file.name, status: 'loading' };
    state.items.push(item);
    state.worker.postMessage({ type: 'load', id: item.id, blob: file });
  });
  $('clearBtn').disabled = false;
  $('exportBtn').disabled = false;
  renderFilmstrip();
  $('emptyState').style.display = 'none';
  if (tooBig.length) toast(tooBig.length + ' 张图片超过 100MB，将尽力处理，若卡顿属正常', '');
}

function removeItem(id) {
  var idx = state.items.findIndex(function (it) { return it.id === id; });
  if (idx < 0) return;
  state.worker.postMessage({ type: 'remove', id: id });
  state.items.splice(idx, 1);
  delete state.freePos[id];
  if (state.selectedId === id) state.selectedId = null;
  if (!state.items.length) {
    $('clearBtn').disabled = true;
    $('exportBtn').disabled = true;
    $('emptyState').style.display = '';
  }
  renderFilmstrip();
  renderPreview();
  updateExportInfo();
}

function replaceFile(id, file) {
  if (!file || file.type.indexOf('image/') !== 0) return;
  var item = byId(id);
  if (!item) return;
  state.worker.postMessage({ type: 'remove', id: id });
  item.file = file; item.name = file.name; item.status = 'loading';
  item.width = 0; item.height = 0; item.hasAlpha = false;
  state.worker.postMessage({ type: 'load', id: id, blob: file });
  renderFilmstrip();
}

function reorder(from, to) {
  if (from === to || from < 0 || to < 0 || from >= state.items.length || to >= state.items.length) return;
  var moved = state.items.splice(from, 1)[0];
  state.items.splice(to, 0, moved);
  renderFilmstrip();
  renderPreview();
}

/* ---------- 缩略图条 ---------- */
function renderFilmstrip() {
  var strip = $('filmstrip');
  strip.innerHTML = '';
  state.items.forEach(function (item, i) {
    var card = document.createElement('div');
    card.className = 'thumb';
    card.dataset.idx = String(i);
    card.dataset.id = item.id;
    if (item.status === 'loading') card.style.filter = 'brightness(0.6)';

    if (item.thumbUrl) {
      var img = document.createElement('img');
      img.src = item.thumbUrl;
      img.alt = item.name;
      img.title = item.name + (item.hasAlpha ? '（含透明通道）' : '');
      card.appendChild(img);
    }
    var idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = String(i + 1);
    card.appendChild(idx);

    if (item.status === 'error') {
      var err = document.createElement('div');
      err.className = 'loaderr';
      err.textContent = '读取失败';
      card.appendChild(err);
    }

    var actions = document.createElement('div');
    actions.className = 'actions';
    var repl = document.createElement('button');
    repl.className = 'repl';
    repl.title = '替换';
    repl.textContent = '⇄';
    var del = document.createElement('button');
    del.title = '删除';
    del.textContent = '✕';
    actions.appendChild(repl);
    actions.appendChild(del);
    card.appendChild(actions);

    repl.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    del.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    repl.addEventListener('click', function (e) {
      e.stopPropagation();
      pickFileForReplace(item.id);
    });
    del.addEventListener('click', function (e) {
      e.stopPropagation();
      removeItem(item.id);
    });

    bindThumbDrag(card);
    strip.appendChild(card);
  });
}

function pickFileForReplace(id) {
  var inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.onchange = function () {
    if (inp.files && inp.files[0]) replaceFile(id, inp.files[0]);
  };
  inp.click();
}

/* 缩略图拖拽排序（Pointer Events） */
function bindThumbDrag(card) {
  var ghost = null, startX = 0, startY = 0, dragging = false;
  var offsetX = 0, offsetY = 0, curIdx = -1;

  card.addEventListener('pointerdown', function (e) {
    if (e.button !== undefined && e.button !== 0) return;
    if (e.target.closest('.actions')) return;
    startX = e.clientX; startY = e.clientY;
    curIdx = parseInt(card.dataset.idx, 10);
    offsetX = e.clientX - card.getBoundingClientRect().left;
    offsetY = e.clientY - card.getBoundingClientRect().top;
    dragging = false;

    function move(ev) {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) < 6 && Math.abs(ev.clientY - startY) < 6) return;
        dragging = true;
        ghost = card.cloneNode(true);
        ghost.classList.add('dragging');
        ghost.style.position = 'fixed';
        ghost.style.zIndex = '300';
        ghost.style.pointerEvents = 'none';
        ghost.style.width = card.getBoundingClientRect().width + 'px';
        ghost.style.height = card.getBoundingClientRect().height + 'px';
        document.body.appendChild(ghost);
      }
      ghost.style.left = (ev.clientX - offsetX) + 'px';
      ghost.style.top = (ev.clientY - offsetY) + 'px';
      var target = document.elementFromPoint(ev.clientX, ev.clientY);
      var over = target ? target.closest('.thumb') : null;
      clearDropMarks();
      if (over && over !== card && over.parentNode === card.parentNode) {
        var rect = over.getBoundingClientRect();
        var before = ev.clientX < rect.left + rect.width / 2;
        over.classList.add(before ? 'drop-before' : 'drop-after');
      }
    }
    function up(ev) {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (ghost) { ghost.remove(); ghost = null; }
      clearDropMarks();
      if (dragging) {
        var target = document.elementFromPoint(ev.clientX, ev.clientY);
        var over = target ? target.closest('.thumb') : null;
        if (over && over !== card) {
          var toIdx = parseInt(over.dataset.idx, 10);
          var rect = over.getBoundingClientRect();
          var before = ev.clientX < rect.left + rect.width / 2;
          var insertAt = before ? toIdx : toIdx + 1;
          if (insertAt > curIdx) insertAt--;
          reorder(curIdx, insertAt);
        }
      }
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}

function clearDropMarks() {
  document.querySelectorAll('.thumb.drop-before,.thumb.drop-after').forEach(function (n) {
    n.classList.remove('drop-before', 'drop-after');
  });
}

/* ---------- 设置绑定 ---------- */
function bindRange(id, key, labelId) {
  var el = $(id), lab = labelId ? $(labelId) : null;
  el.addEventListener('input', function () {
    state.settings[key] = parseInt(el.value, 10);
    if (lab) lab.textContent = el.value;
    schedulePreview();
    updateExportInfo();
  });
}

function bindControls() {
  bindRange('gap', 'gap', 'gapVal');
  bindRange('pad', 'pad', 'padVal');
  bindRange('radius', 'radius', 'radiusVal');
  bindRange('borderWidth', 'borderWidth', 'borderVal');
  bindRange('longWidth', 'longWidth', 'longWidthVal');

  $('bgColor').addEventListener('input', function (e) {
    state.settings.bgColor = e.target.value;
    schedulePreview();
  });
  $('transparentBg').addEventListener('change', function (e) {
    state.settings.transparent = e.target.checked;
    $('bgColor').disabled = e.target.checked;
    updateFormatOptions();
    schedulePreview();
  });
  $('borderColor').addEventListener('input', function (e) {
    state.settings.borderColor = e.target.value;
    schedulePreview();
  });
  $('borderWidth'); // 边框颜色显隐
  $('borderWidth').addEventListener('input', function () {
    $('borderColorCtl').hidden = parseInt($('borderWidth').value, 10) === 0;
  });
  $('fitMode').addEventListener('change', function (e) {
    state.settings.fit = e.target.value;
    schedulePreview();
  });

  // 宫格尺寸滑块：0 = 自动
  var cellSlider = $('cellSize');
  cellSlider.addEventListener('input', function () {
    state.settings.cellSize = parseInt(cellSlider.value, 10);
    $('cellSizeVal').textContent = cellSlider.value;
    schedulePreview();
    updateExportInfo();
  });
  $('cellAutoBtn').addEventListener('click', function () {
    state.settings.cellSize = null;
    $('cellSizeVal').textContent = '自动';
    schedulePreview();
    updateExportInfo();
  });

  $('freeW').addEventListener('input', function (e) {
    state.settings.freeW = parseInt(e.target.value, 10);
    $('freeWVal').textContent = e.target.value;
    schedulePreview(); updateExportInfo();
  });
  $('freeH').addEventListener('input', function (e) {
    state.settings.freeH = parseInt(e.target.value, 10);
    $('freeHVal').textContent = e.target.value;
    schedulePreview(); updateExportInfo();
  });
  $('resetFreeBtn').addEventListener('click', function () {
    state.positions = [];
    renderPreview();
  });

  // 模式切换
  document.querySelectorAll('.mode-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.mode-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      state.mode = btn.dataset.mode;
      applyModeUI();
      renderPreview();
      updateExportInfo();
    });
  });

  $('exportFormat').addEventListener('change', function () { updateFormatOptions(); updateExportInfo(); });
  $('quality').addEventListener('input', updateExportInfo);
}

function applyModeUI() {
  var m = state.mode;
  document.querySelectorAll('.mode-opts').forEach(function (sec) {
    var modes = sec.dataset.modeOpts.split(',');
    var show = modes.indexOf(m) >= 0 || ((m === 'grid9' || m === 'grid4') && modes.indexOf('grid') >= 0);
    sec.hidden = !show;
  });
  $('previewCanvas').dataset.mode = m;
  if (state.settings.cellSize === null) {
    $('cellSizeVal').textContent = '自动';
  } else {
    $('cellSize').value = state.settings.cellSize;
    $('cellSizeVal').textContent = String(state.settings.cellSize);
  }
}

function updateFormatOptions() {
  var sel = $('exportFormat');
  Array.prototype.forEach.call(sel.options, function (opt) {
    if (opt.value === 'image/webp') opt.disabled = !state.webpSupported;
  });
  if (sel.value === 'image/webp' && !state.webpSupported) sel.value = 'image/png';
  if (state.settings.transparent && sel.value === 'image/jpeg') {
    // JPEG 不支持透明，提示但保留选择（导出时自动填充背景）
  }
  $('qualityCtl').hidden = sel.value === 'image/png';
}

/* ---------- 预览（DOM 渲染，实时流畅） ---------- */
var previewRaf = 0;
function schedulePreview() {
  if (previewRaf) return;
  previewRaf = requestAnimationFrame(function () { previewRaf = 0; renderPreview(); });
}

function readyItems() { return state.items.filter(function (it) { return it.status === 'ready'; }); }

function buildLayout(items) {
  var s = state.settings;
  var opts = {
    mode: state.mode,
    gap: s.gap, pad: s.pad,
    longWidth: s.longWidth,
    cellSize: s.cellSize,
    freeW: s.freeW, freeH: s.freeH,
    metas: items.map(function (it) { return { width: it.width, height: it.height }; }),
    positions: items.map(function (it) { return state.freePos[it.id]; })
  };
  var layout = Lib.computeLayout(opts);
  if (state.mode === 'free' && layout.positions) {
    layout.positions.forEach(function (pos, i) {
      if (pos && items[i]) state.freePos[items[i].id] = pos;
    });
  }
  return layout;
}

function renderPreview() {
  var canvasEl = $('previewCanvas');
  canvasEl.innerHTML = '';
  var items = readyItems();
  if (!items.length) {
    canvasEl.style.width = '0px';
    canvasEl.style.height = '0px';
    canvasEl.style.background = 'transparent';
    return;
  }
  var layout = buildLayout(items);
  var scroll = $('previewScroll');
  var availW = scroll.clientWidth - 64;
  var availH = scroll.clientHeight - 64;
  var scale = Lib.previewScale(layout.width, layout.height, Math.max(200, availW), Math.max(200, availH));
  state.scale = scale;
  var s = state.settings;

  canvasEl.style.width = (layout.width * scale) + 'px';
  canvasEl.style.height = (layout.height * scale) + 'px';
  canvasEl.style.background = s.transparent ? 'transparent' : s.bgColor;
  canvasEl.style.borderRadius = '2px';

  layout.boxes.forEach(function (box) {
    var item = items[box.index];
    var frame = document.createElement('div');
    frame.className = 'preview-frame';
    if (state.mode === 'free') frame.classList.add('free-item');
    if (item.id === state.selectedId) frame.classList.add('selected');
    frame.dataset.id = item.id;
    frame.style.boxSizing = 'border-box';
    frame.style.left = (box.x * scale) + 'px';
    frame.style.top = (box.y * scale) + 'px';
    frame.style.width = (box.w * scale) + 'px';
    frame.style.height = (box.h * scale) + 'px';
    frame.style.borderRadius = (s.radius * scale) + 'px';
    if (s.borderWidth > 0) {
      frame.style.border = (s.borderWidth * scale) + 'px solid ' + s.borderColor;
    }
    frame.style.background = (s.fit === 'contain' && !s.transparent) ? s.bgColor : 'transparent';

    var img = document.createElement('img');
    img.src = item.thumbUrl;
    img.alt = item.name;
    var fr = Lib.fitRect(box.w, box.h, item.width, item.height, s.fit);
    img.style.left = (fr.dx * scale) + 'px';
    img.style.top = (fr.dy * scale) + 'px';
    img.style.width = (fr.dw * scale) + 'px';
    img.style.height = (fr.dh * scale) + 'px';
    frame.appendChild(img);

    if (state.mode === 'free') {
      var handle = document.createElement('div');
      handle.className = 'resize-handle';
      frame.appendChild(handle);
      bindFreeInteractions(frame, handle, item);
    }
    canvasEl.appendChild(frame);
  });
}

/* ---------- 自由布局：拖拽移动 + 手柄缩放（Pointer Events） ---------- */
function bindFreeInteractions(frame, handle, item) {
  var s = state.settings;

  frame.addEventListener('pointerdown', function (e) {
    if (e.target === handle) return;
    if (e.button !== undefined && e.button !== 0) return;
    state.selectedId = item.id;
    document.querySelectorAll('.preview-frame.selected').forEach(function (n) { n.classList.remove('selected'); });
    frame.classList.add('selected');
    frame.setPointerCapture(e.pointerId);
    var startX = e.clientX, startY = e.clientY;
    var pos = state.freePos[item.id] || { x: 0, y: 0, w: s.freeW * 0.4 };
    var origX = pos.x, origY = pos.y;

    function move(ev) {
      var dx = (ev.clientX - startX) / state.scale;
      var dy = (ev.clientY - startY) / state.scale;
      pos.x = Lib.clamp(origX + dx, 0, Math.max(0, s.freeW - pos.w));
      pos.y = Lib.clamp(origY + dy, 0, Math.max(0, s.freeH - pos.w * item.height / item.width));
      state.freePos[item.id] = pos;
      frame.style.left = ((s.pad + pos.x) * state.scale) + 'px';
      frame.style.top = ((s.pad + pos.y) * state.scale) + 'px';
    }
    function up() {
      frame.removeEventListener('pointermove', move);
      frame.removeEventListener('pointerup', up);
      frame.removeEventListener('pointercancel', up);
      updateExportInfo();
    }
    frame.addEventListener('pointermove', move);
    frame.addEventListener('pointerup', up);
    frame.addEventListener('pointercancel', up);
  });

  handle.addEventListener('pointerdown', function (e) {
    e.stopPropagation();
    if (e.button !== undefined && e.button !== 0) return;
    handle.setPointerCapture(e.pointerId);
    var startX = e.clientX;
    var pos = state.freePos[item.id] || { x: 0, y: 0, w: s.freeW * 0.4 };
    var origW = pos.w;

    function move(ev) {
      var dw = (ev.clientX - startX) / state.scale;
      pos.w = Lib.clamp(origW + dw, 60, s.freeW);
      state.freePos[item.id] = pos;
      var h = pos.w * item.height / item.width;
      frame.style.width = (pos.w * state.scale) + 'px';
      frame.style.height = (h * state.scale) + 'px';
      var imgEl = frame.querySelector('img');
      var fr = Lib.fitRect(pos.w, h, item.width, item.height, state.settings.fit);
      imgEl.style.left = (fr.dx * state.scale) + 'px';
      imgEl.style.top = (fr.dy * state.scale) + 'px';
      imgEl.style.width = (fr.dw * state.scale) + 'px';
      imgEl.style.height = (fr.dh * state.scale) + 'px';
    }
    function up() {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      // 结束后完整重绘，应用越界钳制与边框/圆角
      renderPreview();
      updateExportInfo();
    }
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

/* ---------- 导出信息预估 ---------- */
function currentLayoutForExport() {
  var items = readyItems();
  if (!items.length) return null;
  var layout = buildLayout(items);
  var boxes = layout.boxes.map(function (b) {
    return { id: items[b.index].id, x: b.x, y: b.y, w: b.w, h: b.h };
  });
  return { width: layout.width, height: layout.height, boxes: boxes };
}

function updateExportInfo() {
  var layout = currentLayoutForExport();
  if (!layout) {
    $('exportSize').textContent = '预计导出：—';
    $('exportWarn').hidden = true;
    return;
  }
  $('exportSize').textContent = '预计导出：' + layout.width + ' × ' + layout.height + 'px';
  var check = Lib.checkExportSize(layout.width, layout.height);
  var warnEl = $('exportWarn');
  if (check.level === 'hard') {
    warnEl.hidden = false;
    warnEl.textContent = '⛔ ' + check.message;
  } else if (check.level === 'warn') {
    warnEl.hidden = false;
    warnEl.textContent = '⚠️ ' + check.message;
  } else {
    warnEl.hidden = true;
  }
}

/* ---------- 导出 ---------- */
var currentExportId = null;

function doExport(ignoreWarn) {
  if (state.items.some(function (it) { return it.status === 'loading'; })) {
    toast('还有图片正在加载，请稍候', 'error');
    return;
  }
  var layout = currentLayoutForExport();
  if (!layout) { toast('请先添加图片', 'error'); return; }
  var check = Lib.checkExportSize(layout.width, layout.height);
  if (check.level === 'hard') { toast(check.message, 'error'); return; }
  if (check.level === 'warn' && !ignoreWarn) {
    showConfirm('导出尺寸较大', check.message + '\n\n确定要继续导出吗？', function () { doExport(true); });
    return;
  }

  var format = $('exportFormat').value;
  var quality = parseInt($('quality').value, 10);
  var s = state.settings;
  var transparent = s.transparent;
  if (transparent && format === 'image/jpeg') {
    transparent = false;
    toast('JPEG 不支持透明通道，已使用背景色填充', '');
  }

  currentExportId = 'exp_' + (++state.exportSeq);
  showProgress();
  state.worker.postMessage({
    type: 'export',
    exportId: currentExportId,
    layout: layout,
    settings: {
      bgColor: s.bgColor, transparent: transparent,
      radius: s.radius, borderWidth: s.borderWidth,
      borderColor: s.borderColor, fit: s.fit
    },
    format: format, quality: quality
  });
}

function showProgress() {
  var bar = document.getElementById('progressBar');
  if (bar) bar.remove();
  bar = document.createElement('div');
  bar.className = 'progress-bar';
  bar.id = 'progressBar';
  bar.innerHTML = '<div class="pt"><span id="progressLabel">正在导出…</span><span id="progressPct">0%</span></div>' +
    '<div class="track"><div class="fill" id="progressFill"></div></div>';
  document.body.appendChild(bar);
  $('cancelExportBtn').hidden = false;
}
function updateProgress(p) {
  var fill = document.getElementById('progressFill');
  var pct = document.getElementById('progressPct');
  if (fill) fill.style.width = Math.round(p * 100) + '%';
  if (pct) pct.textContent = Math.round(p * 100) + '%';
}
function hideProgress() {
  var bar = document.getElementById('progressBar');
  if (bar) bar.remove();
  $('cancelExportBtn').hidden = true;
}

function finishExport(msg) {
  hideProgress();
  if (msg.cancelled) { toast('已取消导出', ''); return; }
  if (msg.error) { toast(msg.error, 'error'); return; }
  var ext = (msg.blobType || 'image/png').split('/')[1].replace('jpeg', 'jpg');
  var url = URL.createObjectURL(msg.blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'collage-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.' + ext;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  toast('导出成功（' + (msg.blob.size / 1024 / 1024).toFixed(1) + ' MB）', 'success');
}

/* ---------- 确认弹窗 ---------- */
function showConfirm(title, text, onOk) {
  $('confirmTitle').textContent = title;
  $('confirmText').textContent = text;
  $('confirmModal').hidden = false;
  var ok = $('confirmOk'), cancel = $('confirmCancel');
  function close() {
    $('confirmModal').hidden = true;
    ok.onclick = null; cancel.onclick = null;
  }
  ok.onclick = function () { close(); onOk(); };
  cancel.onclick = close;
}

/* ---------- Toast ---------- */
var toastTimer = 0;
function toast(text, kind) {
  var el = $('toast');
  el.textContent = text;
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.hidden = true; }, 3200);
}

/* ---------- 拖入导入 ---------- */
function bindDropZone() {
  var zone = $('previewScroll');
  var depth = 0;
  zone.addEventListener('dragenter', function (e) {
    if (!Array.prototype.some.call(e.dataTransfer.types, function (t) { return t === 'Files'; })) return;
    e.preventDefault();
    depth++;
    zone.classList.add('dragging');
  });
  zone.addEventListener('dragover', function (e) { e.preventDefault(); });
  zone.addEventListener('dragleave', function () {
    depth = Math.max(0, depth - 1);
    if (!depth) zone.classList.remove('dragging');
  });
  zone.addEventListener('drop', function (e) {
    e.preventDefault();
    depth = 0;
    zone.classList.remove('dragging');
    if (e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
}

/* ---------- 初始化 ---------- */
function init() {
  state.freePos = state.freePos || {};
  setupWorker();
  bindControls();
  bindDropZone();
  applyModeUI();

  $('addBtn').addEventListener('click', function () { $('fileInput').click(); });
  $('fileInput').addEventListener('change', function (e) {
    addFiles(e.target.files);
    e.target.value = '';
  });
  $('clearBtn').addEventListener('click', function () {
    if (!state.items.length) return;
    showConfirm('清空所有图片？', '将移除当前已添加的全部 ' + state.items.length + ' 张图片。', function () {
      state.items.forEach(function (it) { state.worker.postMessage({ type: 'remove', id: it.id }); });
      state.items = [];
      state.freePos = {};
      state.selectedId = null;
      $('clearBtn').disabled = true;
      $('exportBtn').disabled = true;
      $('emptyState').style.display = '';
      renderFilmstrip();
      renderPreview();
      updateExportInfo();
    });
  });
  $('exportBtn').addEventListener('click', function () { doExport(false); });
  $('cancelExportBtn').addEventListener('click', function () {
    if (currentExportId) state.worker.postMessage({ type: 'cancelExport' });
  });

  window.addEventListener('resize', schedulePreview);
  updateExportInfo();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
})();
