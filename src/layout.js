export const LAYOUTS = ['long', 'grid4', 'grid9', 'free'];

export const EXPORT_LIMITS = Object.freeze({
  maxEdge: 16384,
  maxArea: 100_000_000,
  softEdge: 8000,
  softArea: 64_000_000
});

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function roundedRectPath(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  if (r <= 0) {
    ctx.rect(x, y, width, height);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

export function createFreePlacement(index, total) {
  if (total <= 1) return { x: 0, y: 0, w: 1, h: 1 };
  const columns = Math.ceil(Math.sqrt(total));
  const rows = Math.ceil(total / columns);
  const cell = 1 / Math.max(columns, rows);
  const column = index % columns;
  const row = Math.floor(index / columns);
  return {
    x: column * cell,
    y: row * cell,
    w: cell,
    h: cell
  };
}

export function normalizePlacement(placement, margin = 0.04) {
  const w = clamp(Number(placement?.w) || 0.2, 0.08, 1);
  const h = clamp(Number(placement?.h) || 0.2, 0.08, 1);
  return {
    x: clamp(Number(placement?.x) || margin, 0, 1 - w),
    y: clamp(Number(placement?.y) || margin, 0, 1 - h),
    w,
    h
  };
}

export function computeLayout({ images = [], layout = 'long', targetWidth = 1080, gap = 0 }) {
  const count = images.length;
  const width = Math.max(1, Math.round(targetWidth));
  if (!count) return { width, height: 0, items: [] };

  const g = Math.max(0, gap);

  if (layout === 'long') {
    let height = 0;
    const items = images.map((image, index) => {
      const itemWidth = width;
      const itemHeight = itemWidth * image.height / image.width;
      const rect = { x: 0, y: height, width: itemWidth, height: itemHeight };
      height += itemHeight + (index === count - 1 ? 0 : g);
      return { id: image.id, ...rect };
    });
    return { width, height: Math.round(height), items };
  }

  if (layout === 'grid4' || layout === 'grid9') {
    const columns = layout === 'grid4' ? 2 : 3;
    const rows = Math.ceil(count / columns);
    const cellWidth = (width - g * (columns - 1)) / columns;
    const height = cellWidth * rows + g * Math.max(0, rows - 1);
    const items = images.map((image, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      return {
        id: image.id,
        x: column * (cellWidth + g),
        y: row * (cellWidth + g),
        width: cellWidth,
        height: cellWidth
      };
    });
    return { width, height: Math.round(height), items };
  }

  const items = images.map((image) => {
    const placement = normalizePlacement(image.placement);
    return {
      id: image.id,
      x: placement.x * width,
      y: placement.y * width,
      width: placement.w * width,
      height: placement.h * width
    };
  });
  return { width, height: width, items };
}

export function getExportIssue(width, height) {
  if (width > EXPORT_LIMITS.maxEdge || height > EXPORT_LIMITS.maxEdge) {
    return { level: 'hard', message: `导出边长不能超过 ${EXPORT_LIMITS.maxEdge}px，请缩小导出宽度。` };
  }
  const area = width * height;
  if (area > EXPORT_LIMITS.maxArea) {
    return { level: 'hard', message: `导出总面积不能超过 ${EXPORT_LIMITS.maxArea.toLocaleString()}px²，请缩小导出宽度。` };
  }
  if (width > EXPORT_LIMITS.softEdge || height > EXPORT_LIMITS.softEdge || area > EXPORT_LIMITS.softArea) {
    return { level: 'soft', message: `导出尺寸为 ${width}×${height}px，设备可能拒绝分配画布；仍可尝试导出。` };
  }
  return null;
}

export function fitExportSize(width, height) {
  const edgeScale = Math.min(1, EXPORT_LIMITS.maxEdge / width, EXPORT_LIMITS.maxEdge / height);
  const areaScale = Math.min(1, Math.sqrt(EXPORT_LIMITS.maxArea / (width * height)));
  const scale = Math.min(edgeScale, areaScale);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale
  };
}
