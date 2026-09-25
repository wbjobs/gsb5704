import {
  computeLayout,
  createFreePlacement,
  fitExportSize,
  getExportIssue,
  normalizePlacement
} from './layout.js';

const $ = (selector) => document.querySelector(selector);

const els = {
  app: $('#app'),
  dropzone: $('#dropzone'),
  fileInput: $('#fileInput'),
  replaceInput: $('#replaceInput'),
  layoutSwitch: $('#layoutSwitch'),
  stage: $('#stage'),
  stageWrap: $('#stageWrap'),
  workerState: $('#workerState'),
  dimensions: $('#dimensions'),
  warningBar: $('#warningBar'),
  exportButton: $('#exportButton'),
  fitSizeButton: $('#fitSizeButton'),
  thumbList: $('#thumbList'),
  dropOverlay: $('#dropOverlay'),
  gap: $('#gapInput'),
  gapValue: $('#gapValue'),
  radius: $('#radiusInput'),
  radiusValue: $('#radiusValue'),
  borderWidth: $('#borderWidthInput'),
  borderWidthValue: $('#borderWidthValue'),
  borderColor: $('#borderColorInput'),
  backgroundColor: $('#bgColorInput'),
  backgroundAlpha: $('#bgAlphaInput'),
  backgroundAlphaValue: $('#bgAlphaValue'),
  targetWidth: $('#targetWidthInput'),
  format: $('#formatInput'),
  quality: $('#qualityInput'),
  qualityValue: $('#qualityValue'),
  qualityField: $('#qualityField')
};

const state = {
  images: [],
  files: new Map(),
  thumbUrls: new Map(),
  layout: 'long',
  batchId: 0,
  exportRequestId: 0,
  replacingId: null,
  busy: false,
  previewScale: 1
};

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function readStyle() {
  return {
    gap: Number(els.gap.value),
    radius: Number(els.radius.value),
    borderWidth: Number(els.borderWidth.value),
    borderColor: els.borderColor.value,
    backgroundColor: els.backgroundColor.value,
    backgroundAlpha: Number(els.backgroundAlpha.value) / 100
  };
}

function hexToRgba(hex, alpha) {
  const normalized = /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#ffffff';
  const r = parseInt(normalized.slice(1, 3), 16);
  const g = parseInt(normalized.slice(3, 5), 16);
  const b = parseInt(normalized.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function readSettings() {
  return {
    targetWidth: normalizeTargetWidth(),
    mimeType: els.format.value,
    quality: Number(els.quality.value) / 100
  };
}

function setWorkerState(text, kind = '') {
  els.workerState.textContent = text;
  els.workerState.className = `worker-state${kind ? ` ${kind}` : ''}`;
}

function setWarning(message, level = 'soft') {
  els.warningBar.hidden = !message;
  els.warningBar.textContent = message || '';
  els.warningBar.classList.toggle('error', level === 'hard');
}

function findImage(id) {
  return state.images.find((image) => image.id === id);
}

function revokeThumb(id) {
  const url = state.thumbUrls.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    state.thumbUrls.delete(id);
  }
}

function removeImage(id) {
  state.images = state.images.filter((image) => image.id !== id);
  state.files.delete(id);
  revokeThumb(id);
  scheduleRender();
}

async function addFiles(fileList, replaceId = null) {
  const files = Array.from(fileList).filter((file) => file.type.startsWith('image/'));
  if (!files.length) {
    setWarning('请选择浏览器可识别的图片文件。', 'hard');
    return;
  }

  const entries = files.map((file) => ({ id: uid(), file }));
  const batchId = ++state.batchId;

  let insertAt = state.images.length;
  let replacedPlacement = null;
  if (replaceId) {
    const oldIndex = state.images.findIndex((image) => image.id === replaceId);
    if (oldIndex !== -1) {
      insertAt = oldIndex;
      replacedPlacement = state.images[oldIndex].placeholder;
      state.files.delete(replaceId);
      revokeThumb(replaceId);
      state.images.splice(oldIndex, 1);
    }
    state.replacingId = null;
  }

  entries.forEach((entry, index) => {
    state.files.set(entry.id, entry.file);
    state.images.splice(Math.min(insertAt + index, state.images.length), 0, {
      id: entry.id,
      name: entry.file.name,
      size: entry.file.size,
      type: entry.file.type,
      width: 0,
      height: 0,
      status: 'pending',
      error: '',
      placeholder: replacedPlacement
    });
  });

  scheduleRender();
  const payload = entries.map(({ id, file }) => ({ id, file }));
  worker.postMessage({ type: 'addFiles', batchId, files: payload });
}

worker.addEventListener('message', (event) => {
  const message = event.data;

  if (message.type === 'addProgress') {
    const image = findImage(message.id);
    if (image) {
      image.status = 'pending';
      image.error = `解码中 ${message.index + 1}/${message.total}`;
      renderThumbs();
    }
    setWorkerState(`正在处理图片 ${message.index + 1}/${message.total}`, 'busy');
  }

  if (message.type === 'addDone') {
    for (const result of message.results) {
      if (result.ok) {
        const url = URL.createObjectURL(result.thumbnail);
        state.thumbUrls.set(result.id, url);

        const image = findImage(result.id);
        const index = state.images.findIndex((entry) => entry.id === result.id);
        if (image) {
          Object.assign(image, {
            width: result.width,
            height: result.height,
            name: result.name,
            size: result.size,
            type: result.type,
            status: 'ready',
            error: '',
            placeholder: image.placeholder || createFreePlacement(index, state.images.length)
          });
        }
      } else {
        const image = findImage(result.id);
        if (image) {
          image.status = 'error';
          image.error = result.error;
        }
      }
    }
    const hasError = message.results.some((result) => !result.ok);
    setWorkerState(hasError ? '部分图片处理失败' : 'Worker 就绪', hasError ? 'error' : 'ready');
    scheduleRender();
  }

  if (message.type === 'addError') {
    setWorkerState('Worker 处理失败', 'error');
    setWarning(message.error, 'hard');
  }

  if (message.type === 'progress') {
    setWorkerState(message.phase === 'encode' ? '正在编码导出图片' : `正在绘制图片 ${message.index + 1}/${message.total}`, 'busy');
  }

  if (message.type === 'exportDone') {
    if (message.requestId !== state.exportRequestId) return;
    state.busy = false;
    setWorkerState('Worker 就绪', 'ready');
    const url = URL.createObjectURL(message.blob);
    const link = document.createElement('a');
    const extension = message.blob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
    link.href = url;
    link.download = `collage-${Date.now()}.${extension}`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    els.exportButton.disabled = false;
  }

  if (message.type === 'exportError') {
    if (message.requestId !== state.exportRequestId) return;
    state.busy = false;
    setWorkerState('导出失败', 'error');
    setWarning(message.error, 'hard');
    els.exportButton.disabled = false;
  }
});

setWorkerState('Worker 准备中');

function readyImages() {
  return state.images.filter((image) => image.status === 'ready' && image.width > 0 && image.height > 0);
}

function currentLayoutData() {
  const settings = readSettings();
  return computeLayout({
    images: readyImages(),
    layout: state.layout,
    targetWidth: settings.targetWidth,
    gap: readStyle().gap
  });
}

function normalizeTargetWidth() {
  const minWidth = 320;
  const maxWidth = Number(els.targetWidth.max) || 12000;
  const requested = Math.round(Number(els.targetWidth.value));
  if (!Number.isFinite(requested) || requested < minWidth) {
    els.targetWidth.value = minWidth;
    return minWidth;
  }
  if (requested > maxWidth) {
    els.targetWidth.value = maxWidth;
    return maxWidth;
  }
  return requested;
}

function updateBackgroundPreview(style, settings) {
  const checker = 'conic-gradient(#222b3b 0 25%, #151b27 0 50%, #222b3b 0 75%, #151b27 0)';
  els.stage.style.backgroundColor = style.backgroundAlpha === 1 ? style.backgroundColor : 'transparent';
  els.stage.style.setProperty('--bg-alpha', style.backgroundAlpha);
  els.stage.style.setProperty('--border-color', style.borderColor);
  if (style.backgroundAlpha === 1) {
    els.stage.style.backgroundImage = 'none';
    els.stage.style.backgroundSize = '';
  } else if (style.backgroundAlpha === 0) {
    els.stage.style.backgroundImage = checker;
    els.stage.style.backgroundSize = '24px 24px';
  } else {
    const fill = hexToRgba(style.backgroundColor, style.backgroundAlpha);
    els.stage.style.backgroundImage = `linear-gradient(${fill}, ${fill}), ${checker}`;
    els.stage.style.backgroundSize = 'auto, 24px 24px';
  }
  els.qualityField.hidden = settings.mimeType === 'image/png';
}

function renderThumbs() {
  els.thumbList.innerHTML = '';
  state.images.forEach((image, index) => {
    const card = document.createElement('article');
    card.className = `thumb-card${image.status === 'pending' ? ' pending' : ''}${image.status === 'error' ? ' error' : ''}`;
    card.dataset.id = image.id;

    const preview = document.createElement('div');
    preview.className = 'thumb-preview';
    const img = document.createElement('img');
    img.alt = image.name;
    const url = state.thumbUrls.get(image.id);
    if (url) img.src = url;
    preview.append(img);

    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'drag-handle';
    handle.textContent = '⠿';
    handle.title = '拖拽排序';
    handle.setAttribute('aria-label', `拖拽排序 ${image.name}`);
    handle.addEventListener('pointerdown', (event) => startSorting(event, image.id));

    const actions = document.createElement('div');
    actions.className = 'thumb-actions';
    const replaceButton = document.createElement('button');
    replaceButton.type = 'button';
    replaceButton.className = 'icon-button';
    replaceButton.textContent = '换';
    replaceButton.title = '替换图片';
    replaceButton.addEventListener('click', () => {
      state.replacingId = image.id;
      els.replaceInput.click();
    });
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'icon-button delete';
    deleteButton.textContent = '×';
    deleteButton.title = '删除图片';
    deleteButton.addEventListener('click', () => removeImage(image.id));
    actions.append(replaceButton, deleteButton);

    const meta = document.createElement('div');
    meta.className = 'thumb-meta';
    meta.textContent = `${index + 1}. ${image.name}`;

    card.append(handle, actions, preview, meta);

    if (image.status === 'pending' || image.status === 'error') {
      const status = document.createElement('div');
      status.className = 'thumb-status';
      status.textContent = image.status === 'pending' ? (image.error || '处理中…') : `失败：${image.error}`;
      card.append(status);
    }

    els.thumbList.append(card);
  });
}

function renderStage() {
  const targetWidth = readSettings().targetWidth;
  const data = currentLayoutData();
  const settings = readSettings();
  const style = readStyle();
  const ready = readyImages();
  els.stage.innerHTML = '';
  els.stage.className = `stage ${state.layout}`;
  els.stage.style.width = '100%';
  const renderScale = els.stageWrap.clientWidth > 0 ? els.stageWrap.clientWidth / targetWidth : 1;
  els.stage.style.height = data.width > 0 ? `${Math.max(1, data.height * renderScale)}px` : '';
  updateBackgroundPreview(style, settings);

  const scale = renderScale;
  els.stage.style.setProperty('--gap-px', `${Math.max(0, style.gap * scale)}px`);
  els.stage.style.setProperty('--border-px', `${Math.max(0, style.borderWidth * scale)}px`);
  els.stage.style.setProperty('--radius-px', `${Math.max(0, style.radius * scale)}px`);

  for (const item of data.items) {
    const image = findImage(item.id);
    if (!image) continue;
    const node = document.createElement('div');
    node.className = 'stage-item';
    node.dataset.id = image.id;
    Object.assign(node.style, {
      left: `${item.x * scale}px`,
      top: `${item.y * scale}px`,
      width: `${item.width * scale}px`,
      height: `${item.height * scale}px`,
      borderRadius: `${style.radius * scale}px`,
      boxShadow: style.borderWidth > 0
        ? `inset 0 0 0 ${style.borderWidth * scale}px ${style.borderColor}`
        : 'none'
    });

    const img = document.createElement('img');
    img.src = state.thumbUrls.get(image.id) || '';
    img.alt = image.name;
    img.draggable = false;
    node.append(img);

    if (state.layout === 'free') {
      node.addEventListener('pointerdown', (event) => startFreeDrag(event, image.id, 'move'));
      const resizeHandle = document.createElement('button');
      resizeHandle.type = 'button';
      resizeHandle.className = 'free-handle';
      resizeHandle.title = '缩放图片';
      resizeHandle.setAttribute('aria-label', `缩放 ${image.name}`);
      resizeHandle.addEventListener('pointerdown', (event) => startFreeDrag(event, image.id, 'resize'));
      node.append(resizeHandle);
    }

    els.stage.append(node);
  }

  const issue = data.items.length ? getExportIssue(data.width, data.height) : null;
  if (!ready.length) {
    els.dimensions.textContent = state.images.length ? '图片仍在处理中…' : '尚未添加图片';
    setWarning('');
  } else {
    els.dimensions.textContent = `${ready.length} 张 · 导出尺寸 ${data.width}×${data.height}px`;
    if (settings.mimeType === 'image/jpeg' && style.backgroundAlpha < 1) {
      setWarning('JPEG 不支持透明通道，导出时会使用当前背景色填充透明区域。PNG 或 WebP 可保留透明。', 'soft');
    } else if (issue) {
      setWarning(issue.message, issue.level);
    } else {
      setWarning('');
    }
  }

  els.fitSizeButton.hidden = !(issue?.level === 'hard');
  els.exportButton.disabled = !ready.length || state.busy;
  renderThumbs();
}

let renderFrame = 0;
function scheduleRender() {
  cancelAnimationFrame(renderFrame);
  renderFrame = requestAnimationFrame(() => {
    updatePreviewScale();
    renderStage();
  });
}

function getPointerPosition(event) {
  return { x: event.clientX, y: event.clientY };
}

function startSorting(event, id) {
  event.preventDefault();
  event.stopPropagation();
  const card = els.thumbList.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!card) return;

  const rect = card.getBoundingClientRect();
  const pointer = getPointerPosition(event);
  const offsetX = pointer.x - rect.left;
  const offsetY = pointer.y - rect.top;
  const placeholder = document.createElement('div');
  placeholder.className = 'sort-placeholder';
  placeholder.style.flex = '0 0 104px';
  placeholder.style.width = '104px';
  placeholder.style.height = `${rect.height}px`;
  card.before(placeholder);

  Object.assign(card.style, {
    position: 'fixed',
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: '0',
    pointerEvents: 'none',
    opacity: '0.92',
    transform: 'scale(1.04)'
  });
  card.classList.add('is-sorting');
  document.body.append(card);

  const originalOrder = state.images.map((image) => image.id);
  let currentId = id;

  function move(moveEvent) {
    moveEvent.preventDefault();
    const pos = getPointerPosition(moveEvent);
    card.style.left = `${pos.x - offsetX}px`;
    card.style.top = `${pos.y - offsetY}px`;

    const cards = Array.from(els.thumbList.querySelectorAll('.thumb-card:not(.is-sorting)'));
    const target = cards.find((candidate) => {
      const bounds = candidate.getBoundingClientRect();
      return pos.x < bounds.right && pos.y >= bounds.top && pos.y <= bounds.bottom;
    });
    if (target && target.dataset.id !== currentId) {
      const from = state.images.findIndex((image) => image.id === currentId);
      const to = state.images.findIndex((image) => image.id === target.dataset.id);
      if (from !== -1 && to !== -1) {
        const [moved] = state.images.splice(from, 1);
        state.images.splice(to, 0, moved);
        currentId = target.dataset.id;
      }
      const insertBefore = pos.x < target.getBoundingClientRect().left + target.getBoundingClientRect().width / 2
        ? target
        : target.nextSibling;
      els.thumbList.insertBefore(placeholder, insertBefore);
    }
  }

  function finish() {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', cancel);
    placeholder.remove();
    card.remove();
    renderStage();
  }

  function cancel() {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', cancel);
    state.images = originalOrder
      .map((imageId) => state.images.find((image) => image.id === imageId))
      .filter(Boolean);
    placeholder.remove();
    card.remove();
    scheduleRender();
  }

  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', cancel);
}

function startFreeDrag(event, id, mode) {
  event.preventDefault();
  event.stopPropagation();
  const image = findImage(id);
  const node = els.stage.querySelector(`.stage-item[data-id="${CSS.escape(id)}"]`);
  if (!image || !node) return;

  const start = getPointerPosition(event);
  const startPlacement = normalizePlacement(image.placeholder);
  const rect = els.stage.getBoundingClientRect();
  node.classList.add('is-dragging');

  function updatePlacement(placement) {
    image.placeholder = normalizePlacement(placement);
    const normalized = normalizePlacement(placement);
    Object.assign(node.style, {
      left: `${normalized.x * rect.width}px`,
      top: `${normalized.y * rect.width}px`,
      width: `${normalized.w * rect.width}px`,
      height: `${normalized.h * rect.width}px`
    });
  }

  function move(moveEvent) {
    moveEvent.preventDefault();
    const pos = getPointerPosition(moveEvent);
    const dx = (pos.x - start.x) / rect.width;
    const dy = (pos.y - start.y) / rect.width;

    if (mode === 'move') {
      updatePlacement({
        x: startPlacement.x + dx,
        y: startPlacement.y + dy,
        w: startPlacement.w,
        h: startPlacement.h
      });
    } else {
      updatePlacement({
        x: startPlacement.x,
        y: startPlacement.y,
        w: startPlacement.w + dx,
        h: startPlacement.h + dy
      });
    }
  }

  function finish() {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', cancel);
    node.classList.remove('is-dragging');
    scheduleRender();
  }

  function cancel() {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', cancel);
    image.placeholder = startPlacement;
    node.classList.remove('is-dragging');
    scheduleRender();
  }

  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', cancel);
}

function updateControlLabels() {
  els.gapValue.textContent = els.gap.value;
  els.radiusValue.textContent = els.radius.value;
  els.borderWidthValue.textContent = els.borderWidth.value;
  els.backgroundAlphaValue.textContent = `${els.backgroundAlpha.value}%`;
  els.qualityValue.textContent = `${els.quality.value}%`;
}

function updatePreviewScale() {
  const requestedWidth = readSettings().targetWidth;
  const stageWidth = els.stageWrap.clientWidth || requestedWidth;
  state.previewScale = stageWidth / requestedWidth;
}

async function exportImage() {
  const ready = readyImages();
  if (!ready.length || state.busy) return;

  const settings = readSettings();
  const style = readStyle();
  const data = computeLayout({
    images: ready,
    layout: state.layout,
    targetWidth: settings.targetWidth,
    gap: style.gap
  });
  const issue = getExportIssue(data.width, data.height);
  if (issue?.level === 'hard') {
    setWarning(issue.message, 'hard');
    return;
  }

  state.busy = true;
  state.exportRequestId += 1;
  els.exportButton.disabled = true;
  const files = data.items.map((rect) => {
    const image = ready.find((entry) => entry.id === rect.id);
    return { id: image.id, file: state.files.get(image.id), rect };
  }).filter((item) => item.file);

  try {
    worker.postMessage({
      type: 'export',
      requestId: state.exportRequestId,
      files,
      layout: data,
      style,
      mimeType: settings.mimeType,
      format: settings.mimeType,
      quality: settings.quality
    });
  } catch (error) {
    state.busy = false;
    els.exportButton.disabled = false;
    setWarning(`无法发送图片到 Worker：${error.message || error}。可尝试减少图片或缩小尺寸。`, 'hard');
    setWorkerState('导出失败', 'error');
  }
}

function fitToSafeSize() {
  const data = currentLayoutData();
  const fitted = fitExportSize(data.width, data.height);
  els.targetWidth.value = Math.max(320, Math.round(Number(els.targetWidth.value) * fitted.scale));
  scheduleRender();
}

function bindEvents() {
  els.fileInput.addEventListener('change', (event) => {
    addFiles(event.target.files);
    event.target.value = '';
  });

  els.replaceInput.addEventListener('change', (event) => {
    const replaceId = state.replacingId;
    if (replaceId) addFiles(event.target.files, replaceId);
    event.target.value = '';
  });

  els.dropzone.addEventListener('click', () => {
    state.replacingId = null;
  });
  els.dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') els.fileInput.click();
  });

  els.layoutSwitch.addEventListener('click', (event) => {
    const button = event.target.closest('[data-layout]');
    if (!button) return;
    state.layout = button.dataset.layout;
    els.layoutSwitch.querySelectorAll('button').forEach((candidate) => {
      candidate.classList.toggle('active', candidate === button);
    });
    scheduleRender();
  });

  [els.gap, els.radius, els.borderWidth, els.borderColor, els.backgroundColor, els.backgroundAlpha, els.targetWidth, els.format, els.quality]
    .forEach((input) => input.addEventListener('input', () => {
      updateControlLabels();
      scheduleRender();
    }));

  els.exportButton.addEventListener('click', exportImage);
  els.fitSizeButton.addEventListener('click', fitToSafeSize);

  let dragDepth = 0;
  window.addEventListener('dragenter', (event) => {
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    event.preventDefault();
    dragDepth += 1;
    els.dropOverlay.hidden = false;
    els.app.classList.add('is-dragging');
  });
  window.addEventListener('dragover', (event) => {
    if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault();
  });
  window.addEventListener('dragleave', (event) => {
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) {
      els.dropOverlay.hidden = true;
      els.app.classList.remove('is-dragging');
    }
  });
  window.addEventListener('drop', (event) => {
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    event.preventDefault();
    dragDepth = 0;
    els.dropOverlay.hidden = true;
    els.app.classList.remove('is-dragging');
    state.replacingId = null;
    addFiles(event.dataTransfer.files);
  });

  if ('ResizeObserver' in window) {
    new ResizeObserver(() => scheduleRender()).observe(els.stageWrap);
  }
}

worker.addEventListener('error', (event) => {
  setWorkerState('Worker 加载失败', 'error');
  setWarning(`Worker 加载失败：${event.message}。请通过本地 HTTP 服务打开本页面。`, 'hard');
});

bindEvents();
updateControlLabels();
updatePreviewScale();
renderStage();
