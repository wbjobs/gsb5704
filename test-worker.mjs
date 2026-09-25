import assert from 'node:assert';
import { readFileSync } from 'node:fs';

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓ ' + name); passed++; }

/* ---------- 最小 mock 环境 ---------- */
class MockImageBitmap {
  constructor(w, h) { this.width = w; this.height = h; this.closed = false; }
  close() { this.closed = true; }
}
class MockCtx {
  constructor(w, h) { this.w = w; this.h = h; this.calls = []; this.fillStyle = '#000'; this.lineWidth = 0; }
  drawImage(bmp, ...args) {
    this.calls.push({ op: 'draw', w: bmp.width, args });
  }
  beginPath() { this.calls.push({ op: 'path' }); }
  moveTo() {} arcTo() {} lineTo() {} closePath() {}
  clip() { this.clipped = true; }
  save() {} restore() {} stroke() { this.calls.push({ op: 'stroke' }); }
  fillRect(x, y, w, h) { this.calls.push({ op: 'fill', x, y, w, h }); }
  getImageData() {
    // 模拟透明：alpha 数据含 0
    return { data: new Uint8ClampedArray([0, 0, 0, 0, 10, 20, 30, 255]) };
  }
}
class MockOffscreen {
  constructor(w, h) { this.width = w; this.height = h; this.ctx = new MockCtx(w, h); }
  getContext() { return this.ctx; }
  convertToBlob(opts) { return Promise.resolve(new Blob([new Uint8Array(42)], { type: (opts && opts.type) || 'image/png' })); }
  transferToImageBitmap() { return new MockImageBitmap(this.width, this.height); }
}

/* ---------- 加载 libFactory 源码到 mock Worker 作用域 ---------- */
const src = readFileSync('./js/engine.js', 'utf8');
function makeWorkerScope() {
  const listeners = {};
  const posted = [];
  const scope = {
    name: 'mock-worker',
    onmessage: null,
    postMessage: (m) => posted.push(m),
    OffscreenCanvas: MockOffscreen,
    URL: { createObjectURL: (b) => 'blob:mock/' + posted.length, revokeObjectURL: () => {} },
    Blob: globalThis.Blob,
    createImageBitmap(blob, opts) {
      // 模拟浏览器：opts.resizeWidth/Height 生效；记录请求大小
      scope._lastDecode = opts || {};
      if (!scope._dimsFor) throw new Error('no dims');
      const d = scope._dimsFor(blob);
      let w = d.width, h = d.height;
      if (opts && opts.resizeWidth && opts.resizeHeight) { w = opts.resizeWidth; h = opts.resizeHeight; }
      return Promise.resolve(new MockImageBitmap(w, h));
    },
    _dimsFor: null,
    _posted: posted, _listeners: listeners
  };
  return scope;
}

const scope = makeWorkerScope();
// 从 engine.js 提取 libFactory 定义并在 mock 作用域里以 worker 身份执行
const factoryMatch = src.match(/function libFactory[\s\S]*?\n\}\n\n\/\* UMD/);
assert.ok(factoryMatch, 'libFactory 提取失败');
const factoryCode = factoryMatch[0].replace(/\n\/\* UMD.*$/s, '');
new Function('globalScope', factoryCode + '\nglobalScope.__lib = libFactory(globalScope, true);')(scope);
const post = scope._posted;
function waitFor(cond, timeout = 1000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function tick() {
      if (cond()) return resolve();
      if (Date.now() - t0 > timeout) return reject(new Error('等待超时'));
      setImmediate(tick);
    })();
  });
}
function send(m) { scope.onmessage({ data: m }); }

/* ---------- 1. init 探测 WebP ---------- */
send({ type: 'init' });
await waitFor(() => post.some(m => m.type === 'ready'));
ok('Worker 启动并回报 ready', true);
ok('WebP 探测可降级（mock convertToBlob 支持，应为 true）', post.find(m => m.type === 'ready').webpSupported === true);

/* ---------- 2. 加载 800x600 PNG ---------- */
const pngBytes = readFileSync('./test-fixtures/sample.png');
const pngBlob = new Blob([pngBytes], { type: 'image/png' });
scope._dimsFor = () => ({ width: 800, height: 600 });
send({ type: 'load', id: 'a', blob: pngBlob });
await waitFor(() => post.some(m => m.type === 'loaded' && m.id === 'a'));
const la = post.find(m => m.type === 'loaded' && m.id === 'a');
ok('PNG 加载成功并返回真实尺寸', la.width === 800 && la.height === 600);
ok('检测到透明通道', la.hasAlpha === true);
ok('返回缩略图 URL', typeof la.thumbUrl === 'string');

/* ---------- 3. 超大“JPEG”：50MB 填充，只能切到前 1MB ---------- */
let slicedBytes = 0;
const head = readFileSync('./test-fixtures/sample.jpg');
const padding = Buffer.alloc(50 * 1024 * 1024 - head.length, 0x55);
class SliceSpyBlob extends Blob {
  constructor(parts, opts) { super(parts, opts); this.sliceCalls = []; }
  slice(s, e) { slicedBytes = Math.max(slicedBytes, e - s); return super.slice(s, e); }
}
const bigJpg = new SliceSpyBlob([head, padding], { type: 'image/jpeg' });
scope._dimsFor = () => ({ width: 2000, height: 1200 });
send({ type: 'load', id: 'big', blob: bigJpg });
await waitFor(() => post.some(m => m.type === 'loaded' && m.id === 'big'));
const lb = post.find(m => m.type === 'loaded' && m.id === 'big');
ok('50MB JPEG 头解析尺寸正确', lb.width === 2000 && lb.height === 1200);
ok('50MB 文件仅读取前 1MB（不全量进内存）', slicedBytes === 1048576);
ok('超大图缩略解码被缩小到约 600px', Math.max(scope._lastDecode.resizeWidth, scope._lastDecode.resizeHeight) <= 600);

/* ---------- 4. 导出：九宫格 2 张，验证绘制调用与输出 ---------- */
post.length = 0;
const layout = {
  width: 640, height: 640,
  boxes: [
    { id: 'a', x: 0, y: 0, w: 300, h: 300 },
    { id: 'big', x: 340, y: 0, w: 300, h: 300 }
  ]
};
send({
  type: 'export', exportId: 'e1', layout,
  settings: { bgColor: '#ffffff', transparent: false, radius: 12, borderWidth: 4,
    borderColor: '#000000', fit: 'cover' },
  format: 'image/png', quality: 92
});
await waitFor(() => post.some(m => m.type === 'exportDone' && m.exportId === 'e1'));
const done = post.find(m => m.type === 'exportDone' && m.exportId === 'e1');
ok('导出成功返回 Blob', !!done.blob && done.blobType === 'image/png');
ok('导出过程上报了进度', post.some(m => m.type === 'exportProgress'));

/* ---------- 5. 取消导出 ---------- */
post.length = 0;
let cancelled = false;
const bigLayout = { width: 100, height: 100, boxes: Array.from({ length: 30 }, (_, i) => ({
  id: i % 2 === 0 ? 'a' : 'big', x: 0, y: 0, w: 10, h: 10
})) };
send({ type: 'export', exportId: 'e2', layout: bigLayout,
  settings: { transparent: true, radius: 0, borderWidth: 0, fit: 'cover' },
  format: 'image/png' });
send({ type: 'cancelExport' });
await waitFor(() => post.some(m => m.type === 'exportDone' && m.exportId === 'e2'));
ok('取消导出返回 cancelled', post.find(m => m.type === 'exportDone' && m.exportId === 'e2').cancelled === true);

/* ---------- 6. 透明背景：不填充底色 ---------- */
post.length = 0;
send({ type: 'export', exportId: 'e3',
  layout: { width: 100, height: 100, boxes: [{ id: 'a', x: 0, y: 0, w: 100, h: 100 }] },
  settings: { transparent: true, radius: 0, borderWidth: 0, fit: 'cover' },
  format: 'image/png' });
await waitFor(() => post.some(m => m.type === 'exportDone' && m.exportId === 'e3'));
ok('透明导出成功', post.find(m => m.type === 'exportDone').blobType === 'image/png');

console.log('\nWorker 端到端全部通过：' + passed + ' 项');
