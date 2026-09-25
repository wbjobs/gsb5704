/*
 * 图片拼接工坊 - 纯逻辑引擎 + Web Worker 入口
 *
 * 设计要点：libFactory 完全自包含（所有辅助函数均为其内部声明），
 * 因此 Blob Worker 只需内联 libFactory.toString() 即可运行，
 * 在 file:// 协议下直接双击打开 index.html 也能正常使用 Worker。
 * 本文件不依赖 DOM，可在 Node 中直接单测。
 */
(function (global) {
'use strict';

function libFactory(globalScope, asWorker) {

var WorkerGlobals = {
    OffscreenCanvas: globalScope.OffscreenCanvas,
    createImageBitmap: globalScope.createImageBitmap,
    URL: globalScope.URL,
    Blob: globalScope.Blob,
    Worker: globalScope.Worker
  };
  var OffscreenCanvas = WorkerGlobals.OffscreenCanvas;
  var createImageBitmap = WorkerGlobals.createImageBitmap;

var MAX_DIM = 16384;        // Canvas 单边硬上限（主流浏览器约 16384）
var WARN_MP = 40;           // 超过 4000 万像素给出大尺寸警告
var HARD_MP = 104;          // 约 1 亿像素硬保护（与内存相关）

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function roundedRectPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/* contain：完整显示；cover：填满裁剪。返回相对 box 的目标矩形 */
function fitRect(boxW, boxH, imgW, imgH, fit) {
  var scale = fit === 'cover'
    ? Math.max(boxW / imgW, boxH / imgH)
    : Math.min(boxW / imgW, boxH / imgH);
  var dw = imgW * scale;
  var dh = imgH * scale;
  return { dx: (boxW - dw) / 2, dy: (boxH - dh) / 2, dw: dw, dh: dh, scale: scale };
}

function autoCellSize(metas) {
  var widths = metas.map(function (m) { return m.width; }).sort(function (a, b) { return a - b; });
  if (!widths.length) return 900;
  var med = widths[Math.floor(widths.length / 2)];
  return clamp(Math.round(med), 240, 2000);
}

/*
 * opts: mode 'long'|'grid9'|'grid4'|'free'
 *   gap, pad, longWidth, cellSize(px|null=auto), freeW, freeH
 *   metas: [{width,height}], positions(free): [{x,y,w}|null]
 * 返回 { width,height, boxes:[{index,x,y,w,h}], clamped, positions? }
 */
function computeLayout(opts) {
  var metas = opts.metas || [];
  var n = metas.length;
  var gap = Math.max(0, opts.gap || 0);
  var pad = Math.max(0, opts.pad || 0);
  var boxes = [];
  var width = 0, height = 0;
  var clamped = false;

  if (opts.mode === 'long') {
    var W = clamp(Math.round(opts.longWidth || 1080), 160, MAX_DIM);
    var y = pad;
    for (var i = 0; i < n; i++) {
      var h = Math.max(1, Math.round(W * metas[i].height / metas[i].width));
      boxes.push({ index: i, x: pad, y: y, w: W, h: h });
      y += h;
      if (i < n - 1) y += gap;
    }
    width = W + pad * 2;
    height = (n ? y : 0) + pad;
  } else if (opts.mode === 'grid9' || opts.mode === 'grid4') {
    var cols = opts.mode === 'grid9' ? 3 : 2;
    var cell = opts.cellSize
      ? clamp(Math.round(opts.cellSize), 80, 4000)
      : autoCellSize(metas);
    var rows = Math.ceil(n / cols);
    width = pad * 2 + cols * cell + gap * (cols - 1);
    height = pad * 2 + (rows ? rows * cell + gap * (rows - 1) : 0);
    for (var k = 0; k < n; k++) {
      var c = k % cols;
      var r = Math.floor(k / cols);
      boxes.push({
        index: k,
        x: pad + c * (cell + gap),
        y: pad + r * (cell + gap),
        w: cell, h: cell
      });
    }
  } else if (opts.mode === 'free') {
    var cw = clamp(Math.round(opts.freeW || 1200), 160, MAX_DIM);
    var ch = clamp(Math.round(opts.freeH || 1200), 160, MAX_DIM);
    var positions = (opts.positions || []).slice();
    var cursorX = 0, cursorY = 0, rowH = 0;
    for (var p = 0; p < n; p++) {
      var meta = metas[p];
      var pos = positions[p];
      var bw, bh, bx, by;
      if (pos && typeof pos.x === 'number') {
        bw = pos.w; bh = pos.w * meta.height / meta.width;
        bx = pos.x; by = pos.y;
      } else {
        bw = clamp(Math.round(cw * 0.4), 80, cw);
        bh = bw * meta.height / meta.width;
        if (cursorX + bw > cw) { cursorX = 0; cursorY += rowH + gap; rowH = 0; }
        bx = cursorX; by = cursorY;
        cursorX += bw + gap;
        rowH = Math.max(rowH, bh);
        pos = { x: bx, y: by, w: bw };
        positions[p] = pos;
      }
      var nx = clamp(bx, 0, Math.max(0, cw - bw));
      var ny = clamp(by, 0, Math.max(0, ch - bh));
      if (nx !== bx || ny !== by) { clamped = true; bx = nx; by = ny; pos.x = bx; pos.y = by; }
      if (bw > cw) { clamped = true; bw = cw; bh = bw * meta.height / meta.width; pos.w = bw; }
      boxes.push({ index: p, x: pad + bx, y: pad + by, w: bw, h: bh });
    }
    width = cw + pad * 2;
    height = ch + pad * 2;
    return { width: width, height: height, boxes: boxes, clamped: clamped, positions: positions };
  }

  return { width: width, height: height, boxes: boxes, clamped: clamped };
}

/* 导出尺寸安全检查 */
function checkExportSize(width, height) {
  var mp = width * height / 1e6;
  if (width > MAX_DIM || height > MAX_DIM) {
    return { level: 'hard', mp: mp, message: '单边尺寸超过 ' + MAX_DIM + 'px，超出浏览器 Canvas 限制，请调小后再导出。' };
  }
  if (mp > HARD_MP) {
    return { level: 'hard', mp: mp, message: '导出像素约 ' + mp.toFixed(0) + 'MP，超出安全上限（约 ' + HARD_MP + 'MP），可能导致浏览器崩溃，请调小尺寸。' };
  }
  if (mp > WARN_MP) {
    return { level: 'warn', mp: mp, message: '导出尺寸约 ' + width + '×' + height + '（' + mp.toFixed(0) + 'MP），体积和内存占用较大，可能需要等待较久。' };
  }
  return { level: 'ok', mp: mp };
}

/* 预览等比缩放 */
function previewScale(width, height, maxW, maxH) {
  if (!width || !height) return 1;
  return Math.min(1, maxW / width, maxH / height);
}

/* ---- 图片头解析（只读前 1MB，不解码，超大图也不占内存） ---- */
function parseJPEG(view) {
  if (view.byteLength < 4 || view.getUint16(0) !== 0xFFD8) return null;
  var off = 2;
  while (off < view.byteLength - 3) {
    if (view.getUint8(off) !== 0xFF) { off++; continue; }
    var marker = view.getUint8(off + 1);
    if (marker === 0xFF) { off++; continue; }
    off += 2;
    if (marker >= 0xC0 && marker <= 0xCF &&
        marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      return { height: view.getUint16(off + 3), width: view.getUint16(off + 5) };
    }
    if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) continue;
    var segLen = view.getUint16(off);
    if (!segLen || segLen < 2) break;
    off += segLen;
  }
  return null;
}

function parseImageHeader(blob) {
  var headSize = Math.min(blob.size, 1048576);
  return blob.slice(0, headSize).arrayBuffer().then(function (buf) {
    var view = new DataView(buf);
    var bytes = new Uint8Array(buf);
    function str(o, n) {
      var s = '';
      for (var i = 0; i < n; i++) s += String.fromCharCode(bytes[o + i]);
      return s;
    }
    try {
      if (bytes[0] === 0xFF && bytes[1] === 0xD8) return parseJPEG(view);
      if (str(1, 3) === 'PNG' && view.byteLength >= 24) {
        return { width: view.getUint32(16), height: view.getUint32(20) };
      }
      if (str(0, 6) === 'GIF87a' || str(0, 6) === 'GIF89a') {
        return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
      }
      if (str(0, 4) === 'RIFF' && str(8, 4) === 'WEBP' && view.byteLength >= 30) {
        var kind = str(12, 4);
        if (kind === 'VP8 ') {
          return { width: view.getUint16(26) & 0x3FFF, height: view.getUint16(28) & 0x3FFF };
        }
        if (kind === 'VP8L' && view.byteLength >= 25) {
          var b0 = bytes[21], b1 = bytes[22], b2 = bytes[23], b3 = bytes[24];
          var w = 1 + (((b1 & 0x3F) << 8) | b0);
          var h = 1 + (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6));
          return { width: w, height: h };
        }
        if (kind === 'VP8X') {
          return {
            width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
            height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))
          };
        }
      }
    } catch (e) { /* 落到解码兜底 */ }
    return null;
  });
}

function decodeBitmap(blob, targetW, targetH) {
  var wantW = targetW ? Math.max(1, Math.round(targetW)) : 0;
  var wantH = targetH ? Math.max(1, Math.round(targetH)) : 0;
  var opts = { imageOrientation: 'from-image' };
  if (wantW && wantH) {
    opts.resizeWidth = wantW;
    opts.resizeHeight = wantH;
    opts.resizeQuality = 'high';
  }
  function finalize(bmp) {
    // 某些旧内核忽略 resize 选项，这里用 OffscreenCanvas 兜底缩放
    if (wantW && wantH && (bmp.width > wantW * 1.5 || bmp.height > wantH * 1.5)) {
      var c = new OffscreenCanvas(wantW, wantH);
      c.getContext('2d').drawImage(bmp, 0, 0, wantW, wantH);
      if (bmp.close) bmp.close();
      return Promise.resolve(c.transferToImageBitmap());
    }
    return Promise.resolve(bmp);
  }
  return new Promise(function (resolve, reject) {
    createImageBitmap(blob, opts).then(function (b) { finalize(b).then(resolve, reject); }, function () {
      createImageBitmap(blob, {}).then(function (b) { finalize(b).then(resolve, reject); }, reject);
    });
  });
}

/* 检测缩略图是否含透明像素 */
function detectAlpha(bmp) {
  try {
    var c = new OffscreenCanvas(bmp.width, bmp.height);
    var ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    var data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    for (var i = 3; i < data.length; i += 28) {
      if (data[i] < 250) return true;
    }
    return false;
  } catch (e) { return false; }
}

/* 为导出的单个格子准备合适分辨率的位图与裁剪参数 */
function decodeForBox(blob, meta, box, fit) {
  var DECODE_LIMIT = 8192;
  var dw, dh, crop;
  if (fit === 'contain') {
    var s = Math.min(box.w / meta.width, box.h / meta.height);
    dw = meta.width * s; dh = meta.height * s;
    crop = null;
  } else {
    var cw = Math.min(meta.width, meta.height * (box.w / box.h));
    var ch = cw * box.h / box.w;
    var cs = box.w / cw;
    dw = meta.width * cs; dh = meta.height * cs;
    crop = { sx: (meta.width - cw) / 2, sy: (meta.height - ch) / 2, sw: cw, sh: ch };
  }
  var decScale = Math.min(1, DECODE_LIMIT / Math.max(dw, dh));
  var decodeW = Math.max(1, Math.round(dw * decScale));
  var decodeH = Math.max(1, Math.round(dh * decScale));
  return decodeBitmap(blob, decodeW, decodeH).then(function (bmp) {
    return { bmp: bmp, crop: crop, decScale: decScale };
  });
}

function probeWebp() {
  try {
    var c = new OffscreenCanvas(1, 1);
    return c.convertToBlob({ type: 'image/webp' }).then(function (b) {
      return b.type === 'image/webp';
    }, function () { return false; });
  } catch (e) { return Promise.resolve(false); }
}

/* ---- Worker 主逻辑 ---- */
function workerMain() {
  var self = globalScope;
  var store = new Map(); // id -> { blob, width, height, thumbUrl }
  var exportGen = 0;

  function loadFile(id, blob) {
    parseImageHeader(blob).then(function (dims) {
      var useDims = dims;
      var decodeChain;
      if (useDims) {
        var ts = Math.min(1, 600 / Math.max(useDims.width, useDims.height));
        decodeChain = decodeBitmap(blob,
          Math.max(1, Math.round(useDims.width * ts)),
          Math.max(1, Math.round(useDims.height * ts)));
      } else {
        decodeChain = decodeBitmap(blob).then(function (bmp) {
          useDims = { width: bmp.width, height: bmp.height };
          return bmp;
        });
      }
      return decodeChain.then(function (thumb) {
        if (!useDims) useDims = { width: thumb.width, height: thumb.height };
        var hasAlpha = detectAlpha(thumb);
        // 用小尺寸 OffscreenCanvas 生成 PNG 缩略图（ImageBitmap 无 convertToBlob）
        var tc = new OffscreenCanvas(thumb.width, thumb.height);
        var tctx = tc.getContext('2d');
        tctx.drawImage(thumb, 0, 0);
        return tc.convertToBlob({ type: 'image/png' }).then(function (thumbBlob) {
          var thumbUrl = URL.createObjectURL(thumbBlob);
          store.set(id, { blob: blob, width: useDims.width, height: useDims.height, thumbUrl: thumbUrl });
          self.postMessage({ type: 'loaded', id: id, width: useDims.width, height: useDims.height,
            hasAlpha: hasAlpha, thumbUrl: thumbUrl });
          if (thumb.close) thumb.close();
        });
      });
    }).catch(function (err) {
      self.postMessage({ type: 'loaded', id: id, error: String((err && err.message) || err) });
    });
  }

  self.onmessage = function (e) {
    var msg = e.data;
    if (msg.type === 'init') {
      probeWebp().then(function (ok) {
        self.postMessage({ type: 'ready', webpSupported: ok });
      });
      return;
    }
    if (msg.type === 'load') { loadFile(msg.id, msg.blob); return; }
    if (msg.type === 'remove') {
      var rec = store.get(msg.id);
      if (rec) { if (rec.thumbUrl) URL.revokeObjectURL(rec.thumbUrl); store.delete(msg.id); }
      return;
    }
    if (msg.type === 'cancelExport') { exportGen++; return; }
    if (msg.type === 'export') {
      var gen = ++exportGen;
      runExport(msg, function () { return gen !== exportGen; });
    }
  };

  function runExport(job, isCancelled) {
    var id = job.exportId;
    function done(payload) {
      self.postMessage(Object.assign({ type: 'exportDone', exportId: id }, payload));
    }
    function progress(p) {
      self.postMessage({ type: 'exportProgress', exportId: id, progress: p });
    }

    var layout = job.layout;
    var canvas;
    try {
      canvas = new OffscreenCanvas(layout.width, layout.height);
      var ctx0 = canvas.getContext('2d');
      ctx0.fillStyle = job.settings.bgColor || '#fff'; // 预热 & 捕获分配失败
    } catch (err) {
      return done({ error: '无法创建画布，尺寸过大：' + (err.message || err) });
    }
    var ctx = canvas.getContext('2d');
    if (!job.settings.transparent) {
      ctx.fillStyle = job.settings.bgColor || '#ffffff';
      ctx.fillRect(0, 0, layout.width, layout.height);
    }

    var i = 0;
    function next() {
      if (isCancelled()) return done({ cancelled: true });
      if (i >= layout.boxes.length) return encode();
      var box = layout.boxes[i++];
      var rec = store.get(box.id);
      if (!rec) { progress(i / layout.boxes.length); return Promise.resolve().then(next); }
      return decodeForBox(rec.blob, { width: rec.width, height: rec.height }, box, job.settings.fit)
        .then(function (res) {
          ctx.save();
          roundedRectPath(ctx, box.x, box.y, box.w, box.h,
            clamp(job.settings.radius || 0, 0, Math.min(box.w, box.h) / 2));
          ctx.clip();
          if (res.crop) {
            var c = res.crop, k = res.decScale;
            ctx.drawImage(res.bmp,
              c.sx * k, c.sy * k, c.sw * k, c.sh * k,
              box.x, box.y, box.w, box.h);
          } else {
            var fr = fitRect(box.w, box.h, res.bmp.width, res.bmp.height, 'contain');
            ctx.drawImage(res.bmp, box.x + fr.dx, box.y + fr.dy, fr.dw, fr.dh);
          }
          ctx.restore();
          var bw = job.settings.borderWidth || 0;
          if (bw > 0) {
            ctx.save();
            ctx.lineWidth = bw;
            ctx.strokeStyle = job.settings.borderColor || '#000';
            roundedRectPath(ctx,
              box.x + bw / 2, box.y + bw / 2, box.w - bw, box.h - bw,
              Math.max(0, (job.settings.radius || 0) - bw / 2));
            ctx.stroke();
            ctx.restore();
          }
          if (res.bmp.close) res.bmp.close();
          progress(i / layout.boxes.length);
        }).then(next, function (err) {
          done({ error: '图片解码失败：' + ((err && err.message) || err) });
        });
    }

    function encode() {
      if (isCancelled()) return done({ cancelled: true });
      canvas.convertToBlob({ type: job.format, quality: (job.quality || 92) / 100 })
        .then(function (blob) {
          done({ blob: blob, blobType: blob.type || job.format });
        }, function (err) {
          done({ error: '编码失败（可能是内存不足）：' + ((err && err.message) || err) });
        });
    }

    Promise.resolve().then(next);
  }
}

/* ---- 对外 API ---- */
var api = {
  MAX_DIM: MAX_DIM,
  clamp: clamp,
  fitRect: fitRect,
  roundedRectPath: roundedRectPath,
  computeLayout: computeLayout,
  checkExportSize: checkExportSize,
  previewScale: previewScale,
  parseImageHeader: parseImageHeader,
  createWorker: function () {
    var src = '"use strict";\n(' + libFactory.toString() + ')(self, true);';
    var url = WorkerGlobals.URL.createObjectURL(
      new WorkerGlobals.Blob([src], { type: 'application/javascript' }));
    var w = new WorkerGlobals.Worker(url);
    setTimeout(function () { WorkerGlobals.URL.revokeObjectURL(url); }, 0);
    return w;
  }
};

if (asWorker) {
  workerMain();
}

return api;
}

/* UMD：window（主线程）/ self（Worker）/ module.exports（Node 单测） */
if (typeof window !== 'undefined') {
  window.ImageCollageLib = libFactory(window, false);
} else if (typeof module !== 'undefined' && module.exports) {
  module.exports = libFactory(typeof global !== 'undefined' ? global : globalThis, false);
}
}).call(typeof globalThis !== 'undefined' ? globalThis : this);
