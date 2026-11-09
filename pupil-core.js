// Eye-image detector for a manually selected ROI. No face landmarks or trained model.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EyePupil = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = 'dark-component-moments-v1';
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function features(u, v) {
    const x = u - .5, y = v - .5;
    return [1, x, y, x * x, x * y, y * y];
  }
  function detect(gray, width, height, { threshold = 50 } = {}) {
    const count = width * height;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 20 || height < 20 ||
        count > 320 * 320 || gray.length !== count || !Number.isFinite(threshold)) throw Error('Invalid pupil image');
    threshold = clamp(threshold, 5, 180);
    const visited = new Uint8Array(count), queue = new Int32Array(count), candidates = [];
    for (let seed = 0; seed < count; seed++) {
      if (visited[seed] || gray[seed] > threshold) continue;
      let head = 0, tail = 1, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, dark = 0, perimeter = 0;
      let minX = width, minY = height, maxX = 0, maxY = 0;
      queue[0] = seed; visited[seed] = 1;
      while (head < tail) {
        const i = queue[head++], x = i % width, y = Math.floor(i / width);
        sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; dark += gray[i];
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        const neighbors = [x > 0 ? i - 1 : -1, x + 1 < width ? i + 1 : -1, y > 0 ? i - width : -1, y + 1 < height ? i + width : -1];
        for (const j of neighbors) {
          if (j < 0 || gray[j] > threshold) { perimeter++; continue; }
          if (!visited[j]) { visited[j] = 1; queue[tail++] = j; }
        }
      }
      if (tail < Math.max(18, count * .0015) || tail > count * .25 || minX < 2 || minY < 2 || maxX >= width - 2 || maxY >= height - 2) continue;
      const cx = sx / tail, cy = sy / tail, a = sxx / tail - cx * cx, b = syy / tail - cy * cy, c = sxy / tail - cx * cy;
      const delta = Math.hypot(a - b, 2 * c), major = 4 * Math.sqrt(Math.max(0, (a + b + delta) / 2));
      const minor = 4 * Math.sqrt(Math.max(0, (a + b - delta) / 2)), angle = .5 * Math.atan2(2 * c, a - b);
      if (minor < 4 || major <= 0 || minor / major < .4 || 4 * Math.PI * tail / (perimeter * perimeter) < .2) continue;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      let ring = 0, ringCount = 0, fittedBoundary = 0, boundaryCount = 0;
      const radiusAt = (x, y) => Math.hypot(((x - cx) * cos + (y - cy) * sin) / (major / 2), (-(x - cx) * sin + (y - cy) * cos) / (minor / 2));
      for (let k = 0; k < tail; k++) {
        const i = queue[k], x = i % width, y = Math.floor(i / width);
        if (gray[i - 1] > threshold || gray[i + 1] > threshold || gray[i - width] > threshold || gray[i + width] > threshold) {
          boundaryCount++; const r = radiusAt(x, y); if (r >= .65 && r <= 1.35) fittedBoundary++;
        }
      }
      for (let y = Math.max(0, Math.floor(cy - major)); y <= Math.min(height - 1, Math.ceil(cy + major)); y++) {
        for (let x = Math.max(0, Math.floor(cx - major)); x <= Math.min(width - 1, Math.ceil(cx + major)); x++) {
          const r = radiusAt(x, y);
          if (r >= 1.2 && r <= 1.8) { ring += gray[y * width + x]; ringCount++; }
        }
      }
      const fit = boundaryCount ? fittedBoundary / boundaryCount : 0;
      const contrast = ringCount ? ring / ringCount - dark / tail : 0;
      if (fit < .7 || contrast < 12) continue;
      const quality = clamp(contrast / 60, 0, 1) * fit * Math.sqrt(minor / major);
      candidates.push({ cx, cy, major, minor, angle, quality, contrast, area: tail });
    }
    candidates.sort((a, b) => b.quality - a.quality);
    if (!candidates.length) return { valid: false, reason: 'pupil_not_found' };
    const best = candidates[0], second = candidates[1];
    if (second && second.quality >= best.quality * .85) return { valid: false, reason: 'pupil_ambiguous' };
    const u = best.cx / width, v = best.cy / height;
    return { valid: true, ...best, u, v, features: features(u, v) };
  }
  return { VERSION, detect, features };
});
