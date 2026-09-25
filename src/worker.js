import { roundedRectPath } from './layout.js';

const SOURCE_LIMIT = 4096;
const THUMBNAIL_LIMIT = 512;

function ascii(bytes, start, length) {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

async function readImageSize(file) {
  const buffer = await file.slice(0, 1024 * 1024).arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  if (bytes.length >= 24 && ascii(bytes, 0, 8) === '\x89PNG\r\n\x1a\n') {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 10 && ascii(bytes, 0, 3) === 'GIF') {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (bytes.length >= 30 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const kind = ascii(bytes, 12, 4);
    if (kind === 'VP8 ') return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    if (kind === 'VP8L') {
      const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    }
    if (kind === 'VP8X') {
      return {
        width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
        height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16)
      };
    }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const length = view.getUint16(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return null;
}

function post(type, payload = {}) {
  self.postMessage({ type, ...payload });
}

function hexToRgb(hex) {
  const normalized = /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#ffffff';
  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16)
  };
}

function getScale(width, height, limit) {
  return Math.min(1, limit / width, limit / height);
}

async function decodeResized(file, limit = SOURCE_LIMIT) {
  if (!('createImageBitmap' in self)) throw new Error('当前浏览器不支持 createImageBitmap');
  const size = await readImageSize(file).catch(() => null);
  const sourceScale = size ? getScale(size.width, size.height, limit) : 1;

  if (size && sourceScale < 1) {
    const resizeOptions = size.width >= size.height
      ? { resizeWidth: limit, resizeQuality: 'high' }
      : { resizeHeight: limit, resizeQuality: 'high' };
    try {
      const resized = await createImageBitmap(file, resizeOptions);
      if (resized.width > 0 && resized.height > 0) return resized;
      resized.close();
    } catch (_) {
      // Fall through to full decode for browsers without resize options.
    }
  }

  const initial = await createImageBitmap(file);
  const scale = getScale(initial.width, initial.height, limit);

  if (scale >= 1) return initial;

  const targetWidth = Math.max(1, Math.round(initial.width * scale));
  const targetHeight = Math.max(1, Math.round(initial.height * scale));
  const canvas = new OffscreenCanvas(targetWidth, targetHeight);
  const ctx = canvas.getContext('2d', { alpha: true });
  ctx.drawImage(initial, 0, 0, targetWidth, targetHeight);
  initial.close();
  return canvas;
}

async function canvasToPngBlob(canvas) {
  return canvas.convertToBlob({ type: 'image/png' });
}

async function createThumbnail(file) {
  const source = await decodeResized(file, THUMBNAIL_LIMIT);
  const canvas = new OffscreenCanvas(source.width, source.height);
  const ctx = canvas.getContext('2d', { alpha: true });
  ctx.drawImage(source, 0, 0);
  if (source instanceof ImageBitmap) {
    source.close();
  } else {
    source.width = 0;
  }
  return canvasToPngBlob(canvas);
}

function releaseSource(source) {
  if (source instanceof ImageBitmap) {
    if (!source.closed) source.close();
  } else if (source) {
    source.width = 0;
  }
}

function drawContain(ctx, source, rect) {
  const sourceRatio = source.width / source.height;
  const rectRatio = rect.width / rect.height;
  let drawWidth;
  let drawHeight;
  if (sourceRatio > rectRatio) {
    drawWidth = rect.width;
    drawHeight = rect.width / sourceRatio;
  } else {
    drawHeight = rect.height;
    drawWidth = rect.height * sourceRatio;
  }
  const drawX = rect.x + (rect.width - drawWidth) / 2;
  const drawY = rect.y + (rect.height - drawHeight) / 2;
  ctx.drawImage(source, drawX, drawY, drawWidth, drawHeight);
}

function drawItem(ctx, source, item, style) {
  const borderWidth = Math.min(
    Math.max(0, style.borderWidth),
    item.width / 2,
    item.height / 2
  );
  const radius = Math.max(0, style.radius);
  const innerX = item.x + borderWidth;
  const innerY = item.y + borderWidth;
  const innerWidth = item.width - borderWidth * 2;
  const innerHeight = item.height - borderWidth * 2;
  const innerRadius = Math.max(0, radius - borderWidth);
  if (innerWidth <= 0 || innerHeight <= 0) return;

  ctx.save();
  roundedRectPath(ctx, innerX, innerY, innerWidth, innerHeight, innerRadius);
  ctx.clip();
  drawContain(ctx, source, {
    x: innerX,
    y: innerY,
    width: innerWidth,
    height: innerHeight
  });
  ctx.restore();

  if (borderWidth > 0) {
    ctx.save();
    ctx.lineWidth = borderWidth;
    ctx.strokeStyle = style.borderColor;
    roundedRectPath(
      ctx,
      item.x + borderWidth / 2,
      item.y + borderWidth / 2,
      item.width - borderWidth,
      item.height - borderWidth,
      Math.max(0, radius - borderWidth / 2)
    );
    ctx.stroke();
    ctx.restore();
  }
}

async function exportComposite(message) {
  const { files, layout, style, format, quality, mimeType } = message;
  const outputWidth = Math.round(layout.width);
  const outputHeight = Math.round(layout.height);
  if (outputWidth < 1 || outputHeight < 1) throw new Error('导出尺寸无效');
  if (!Number.isFinite(outputWidth * outputHeight)) throw new Error('导出尺寸无效');

  let canvas;
  try {
    canvas = new OffscreenCanvas(outputWidth, outputHeight);
  } catch (error) {
    throw new Error(`无法创建 ${outputWidth}×${outputHeight}px 画布，请缩小导出尺寸`);
  }

  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('无法创建 2D 绘图上下文');
  ctx.clearRect(0, 0, outputWidth, outputHeight);

  const preserveAlpha = mimeType !== 'image/jpeg';
  if (!preserveAlpha || style.backgroundAlpha > 0) {
    const rgb = hexToRgb(style.backgroundColor);
    ctx.fillStyle = preserveAlpha
      ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${style.backgroundAlpha})`
      : `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
    ctx.fillRect(0, 0, outputWidth, outputHeight);
  }

  for (let index = 0; index < files.length; index += 1) {
    const item = files[index];
    post('progress', { phase: 'decode', index, total: files.length });
    let source;
    try {
      source = await decodeResized(item.file, SOURCE_LIMIT);
      drawItem(ctx, source, item.rect, style);
    } finally {
      releaseSource(source);
    }
  }

  post('progress', { phase: 'encode', total: files.length });
  let blob;
  try {
    blob = await canvas.convertToBlob({
      type: mimeType,
      quality: mimeType === 'image/png' ? undefined : quality
    });
  } catch (error) {
    throw new Error(`图片编码失败：${error.message || error}`);
  }
  canvas.width = 0;
  return blob;
}

const messageQueue = [];
let queueRunning = false;

async function handleAddFiles(message) {
  const results = [];
  for (let index = 0; index < message.files.length; index += 1) {
    const entry = message.files[index];
    post('addProgress', { batchId: message.batchId, index, total: message.files.length, id: entry.id });
    try {
      const parsedSize = await readImageSize(entry.file).catch(() => null);
      let width = parsedSize?.width || 0;
      let height = parsedSize?.height || 0;
      if (!width || !height) {
        const bitmap = await createImageBitmap(entry.file);
        width = bitmap.width;
        height = bitmap.height;
        bitmap.close();
      }
      const thumbnail = await createThumbnail(entry.file);
      results.push({
        id: entry.id,
        ok: true,
        width,
        height,
        name: entry.file.name,
        size: entry.file.size,
        type: entry.file.type,
        thumbnail
      });
    } catch (error) {
      results.push({
        id: entry.id,
        ok: false,
        name: entry.file.name,
        size: entry.file.size,
        error: error.message || '无法解码该图片'
      });
    }
  }
  post('addDone', { batchId: message.batchId, results });
}

async function processQueue() {
  if (queueRunning) return;
  queueRunning = true;
  while (messageQueue.length) {
    const message = messageQueue.shift();
    try {
      if (message.type === 'addFiles') {
        await handleAddFiles(message);
      } else if (message.type === 'export') {
        const blob = await exportComposite(message);
        post('exportDone', { requestId: message.requestId, blob });
      }
    } catch (error) {
      if (message.type === 'addFiles') {
        post('addError', { batchId: message.batchId, error: error.message || String(error) });
      } else if (message.type === 'export') {
        post('exportError', { requestId: message.requestId, error: error.message || String(error) });
      }
    }
  }
  queueRunning = false;
}

self.onmessage = (event) => {
  messageQueue.push(event.data);
  processQueue();
};
