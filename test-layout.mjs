import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import Lib from './js/engine.js';

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓ ' + name); passed++; }

// 1. 长图：宽度统一，高度按比例
{
  const r = Lib.computeLayout({ mode: 'long', metas: [
    { width: 100, height: 200 }, { width: 400, height: 100 }, { width: 50, height: 50 }
  ], gap: 10, pad: 20, longWidth: 300 });
  ok('长图宽度 = longWidth + 2*pad', r.width === 340);
  ok('长图高度按比例', r.boxes[0].h === 600 && r.boxes[1].h === 75 && r.boxes[2].h === 300);
  ok('长图总高度正确', r.height === 20 + 600 + 10 + 75 + 10 + 300 + 20 && r.height === 1035);
  ok('长图 x 均为 pad', r.boxes.every(b => b.x === 20));
}

// 2. 九宫格：3 列
{
  const metas = Array.from({ length: 9 }, () => ({ width: 123, height: 456 }));
  const r = Lib.computeLayout({ mode: 'grid9', metas, gap: 10, pad: 10, cellSize: 300 });
  ok('九宫格宽 = 3*cell+2*gap+2*pad', r.width === 3 * 300 + 2 * 10 + 20);
  ok('九宫格高 = 3*cell+2*gap+2*pad', r.height === 3 * 300 + 2 * 10 + 20);
  ok('九宫格 9 个格子', r.boxes.length === 9);
  ok('九宫格行列坐标正确',
    r.boxes[4].x === 10 + 310 && r.boxes[4].y === 10 + 310);
}

// 3. 四宫格：2 列，不足 4 张
{
  const r = Lib.computeLayout({ mode: 'grid4', metas: [
    { width: 1, height: 1 }, { width: 2, height: 1 }, { width: 1, height: 2 }
  ], gap: 0, pad: 0, cellSize: 200 });
  ok('四宫格宽度 2 格', r.width === 400);
  ok('四宫格 2 行', r.height === 400);
  ok('四宫格 3 个格子', r.boxes.length === 3);
  ok('四宫格第三格在第二行', r.boxes[2].y === 200 && r.boxes[2].x === 0);
}

// 4. 自动格子尺寸（不一致的图片）
{
  const r = Lib.computeLayout({ mode: 'grid9', metas: [
    { width: 300, height: 800 }, { width: 5000, height: 5000 }, { width: 640, height: 480 }
  ], cellSize: null });
  ok('自动格子取中位数并钳制', r.boxes[0].w >= 240 && r.boxes[0].w <= 2000);
}

// 5. 自由布局：自动排版不越界
{
  const metas = Array.from({ length: 6 }, () => ({ width: 400, height: 300 }));
  const r = Lib.computeLayout({ mode: 'free', metas, gap: 10, pad: 0, freeW: 1000, freeH: 1000, positions: [] });
  ok('自由布局返回 positions', Array.isArray(r.positions) && r.positions.length === 6);
  const overflow = r.boxes.some(b => b.x + b.w > 1000 + 0.001 || b.y + b.h > 1000 + 0.001);
  ok('自由布局自动排版不越界', !overflow);
}

// 6. 自由布局：手工越界坐标会被钳制
{
  const r = Lib.computeLayout({ mode: 'free', metas: [{ width: 100, height: 100 }],
    pad: 0, freeW: 500, freeH: 500, positions: [{ x: 900, y: 900, w: 200 }] });
  ok('越界坐标被钳制且标记 clamped', r.clamped && r.boxes[0].x === 300 && r.boxes[0].y === 300);
}

// 7. 超大导出判定
{
  ok('普通尺寸 ok', Lib.checkExportSize(1080, 10000).level === 'ok');
  ok('40MP 以上警告', Lib.checkExportSize(8000, 6000).level === 'warn');
  ok('超 16384 硬限制', Lib.checkExportSize(20000, 1000).level === 'hard');
  ok('超 104MP 硬限制', Lib.checkExportSize(10000, 11000).level === 'hard');
}

// 8. fitRect：cover 填满、contain 完整
{
  const cover = Lib.fitRect(100, 100, 200, 50, 'cover');
  ok('cover 短边填满', Math.abs(cover.dh - 100) < 1e-6 && cover.dw >= 100);
  const contain = Lib.fitRect(100, 100, 200, 50, 'contain');
  ok('contain 长边缩回', Math.abs(contain.dw - 100) < 1e-6 && contain.dh <= 100);
}

// 9. 图片头解析：PNG 与 JPEG
{
  const png = new Blob([readFileSync(new URL('./test-fixtures/sample.png', import.meta.url))]);
  Lib; // ensure import
  const { parseImageHeader } = headerParser();
  const dPng = await parseImageHeader(png);
  ok('PNG 头解析尺寸', dPng && dPng.width === 800 && dPng.height === 600);
  const jpg = new Blob([readFileSync(new URL('./test-fixtures/sample.jpg', import.meta.url))]);
  const dJpg = await parseImageHeader(jpg);
  ok('JPEG 头解析尺寸', dJpg && dJpg.width === 2000 && dJpg.height === 1200);
}

console.log('\n全部通过：' + passed + ' 项');

function headerParser() {
  // engine.js 没有导出 parseImageHeader，通过 module 缓存外的方式取不到，
  // 这里用正则从源文件提取函数体在当前作用域 eval（仅测试用途）
  const src = readFileSync('./js/engine.js', 'utf8');
  const m = src.match(/function parseImageHeader[\s\S]*?\n\}/)[0];
  const j = src.match(/function parseJPEG[\s\S]*?\n\}/)[0];
  const mod = {};
  new Function('module', j + '\n' + m + '\nmodule.exports = { parseImageHeader };')(mod);
  return mod.exports;
}
