// Eye-image detector for a manually selected ROI. No face landmarks or trained model.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EyePupil = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = 'adaptive-contour-temporal-v2';
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function features(u, v) {
    const x = u - .5, y = v - .5;
    return [1, x, y, x * x, x * y, y * y];
  }
  function detect(gray, width, height, { threshold = 50, candidatesOnly = false } = {}) {
    const count = width * height;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 20 || height < 20 ||
        count > 320 * 320 || gray.length !== count || !Number.isFinite(threshold)) throw Error('Invalid pupil image');
    threshold = clamp(threshold, 5, candidatesOnly ? 240 : 180);
    const visited = new Uint8Array(count), queue = new Int32Array(count), candidates = [], rejected = {};
    const reject = reason => { rejected[reason] = (rejected[reason] || 0) + 1; };
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
      if (tail < Math.max(18, count * (candidatesOnly ? .0004 : .0015))) { reject('too_small'); continue; }
      if (tail > count * .25) { reject('too_large'); continue; }
      if (minX < 2 || minY < 2 || maxX >= width - 2 || maxY >= height - 2) { reject('roi_edge'); continue; }
      const cx = sx / tail, cy = sy / tail, a = sxx / tail - cx * cx, b = syy / tail - cy * cy, c = sxy / tail - cx * cy;
      const delta = Math.hypot(a - b, 2 * c), major = 4 * Math.sqrt(Math.max(0, (a + b + delta) / 2));
      const minor = 4 * Math.sqrt(Math.max(0, (a + b - delta) / 2)), angle = .5 * Math.atan2(2 * c, a - b);
      if (minor < 4 || major <= 0 || minor / major < (candidatesOnly ? .25 : .4) || 4 * Math.PI * tail / (perimeter * perimeter) < (candidatesOnly ? .1 : .2)) { reject('shape'); continue; }
      const cos = Math.cos(angle), sin = Math.sin(angle);
      let ring = 0, ringCount = 0, fittedBoundary = 0, boundaryCount = 0;
      const boundary = [];
      const radiusAt = (x, y) => Math.hypot(((x - cx) * cos + (y - cy) * sin) / (major / 2), (-(x - cx) * sin + (y - cy) * cos) / (minor / 2));
      for (let k = 0; k < tail; k++) {
        const i = queue[k], x = i % width, y = Math.floor(i / width);
        if (gray[i - 1] > threshold || gray[i + 1] > threshold || gray[i - width] > threshold || gray[i + width] > threshold) {
          boundaryCount++; const r = radiusAt(x, y); if (r >= .65 && r <= 1.35) fittedBoundary++;
          if (candidatesOnly) boundary.push({ x, y });
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
      if (fit < (candidatesOnly ? .45 : .7)) { reject('shape'); continue; }
      if (contrast < 12) { reject('low_contrast'); continue; }
      const quality = clamp(contrast / 60, 0, 1) * fit * Math.sqrt(minor / major);
      candidates.push({ cx, cy, major, minor, angle, quality, contrast, area: tail, ...(candidatesOnly ? { boundary, threshold } : {}) });
    }
    candidates.sort((a, b) => b.quality - a.quality);
    if (candidatesOnly) return { candidates, rejected };
    if (!candidates.length) return { valid: false, reason: 'pupil_not_found' };
    const best = candidates[0], second = candidates[1];
    if (second && second.quality >= best.quality * .85) return { valid: false, reason: 'pupil_ambiguous' };
    const u = best.cx / width, v = best.cy / height;
    return { valid: true, ...best, u, v, features: features(u, v) };
  }
  // Fit a conic in normalized coordinates; reject hyperbolas and implausible ellipses.
  function fitEllipse(points, origin) {
    const s = origin.major / 2, m = Array.from({ length: 5 }, () => Array(6).fill(0));
    for (const p of points) {
      const x = (p.x - origin.cx) / s, y = (p.y - origin.cy) / s, row = [x*x, x*y, y*y, x, y];
      for (let i=0;i<5;i++) { m[i][5] += row[i]; for(let j=0;j<5;j++) m[i][j] += row[i]*row[j]; }
    }
    for(let i=0;i<5;i++) {
      let pivot=i; for(let j=i+1;j<5;j++) if(Math.abs(m[j][i])>Math.abs(m[pivot][i])) pivot=j;
      [m[i],m[pivot]]=[m[pivot],m[i]]; const value=m[i][i]; if(Math.abs(value)<1e-8) return null;
      for(let j=i;j<6;j++) m[i][j]/=value;
      for(let k=0;k<5;k++) if(k!==i) {const f=m[k][i];for(let j=i;j<6;j++) m[k][j]-=f*m[i][j];}
    }
    const [a,b,c,d,e]=m.map(row=>row[5]), det=a*c-b*b/4;
    if(a<=0||c<=0||det<=1e-8) return null;
    const x=(-d*c/2+b*e/4)/det,y=(-e*a/2+b*d/4)/det,k=1+a*x*x+b*x*y+c*y*y;
    const delta=Math.hypot(a-c,b), lo=(a+c-delta)/2,hi=(a+c+delta)/2;
    if(k<=0||lo<=0) return null;
    const major=2*Math.sqrt(k/lo)*s,minor=2*Math.sqrt(k/hi)*s;
    if(!Number.isFinite(major)||major>origin.major*1.8||major<origin.major*.6||minor<4||minor/major<.25||Math.hypot(x,y)*s>origin.major*.4) return null;
    return {cx:origin.cx+x*s,cy:origin.cy+y*s,major,minor,angle:.5*Math.atan2(b,a-c)+Math.PI/2};
  }
  function radialError(p, ellipse) {
    const x=p.x-ellipse.cx,y=p.y-ellipse.cy,c=Math.cos(ellipse.angle),s=Math.sin(ellipse.angle);
    return Math.abs(Math.hypot((x*c+y*s)/(ellipse.major/2),(-x*s+y*c)/(ellipse.minor/2))-1);
  }
  function contourFit(candidate) {
    const all=candidate.boundary, step=Math.max(1,Math.ceil(all.length/160)), points=all.filter((_,i)=>i%step===0);
    if(points.length<12) return null;
    let seed=12345,best=null,bestCount=0;
    // Deterministic RANSAC: reflection boundaries and straight eyelid edges may be outliers.
    for(let n=0;n<40;n++) {
      const subset=[],used=new Set();
      while(subset.length<5) {seed=(Math.imul(seed,1664525)+1013904223)>>>0;const i=seed%points.length;if(!used.has(i)){used.add(i);subset.push(points[i]);}}
      const fit=fitEllipse(subset,candidate); if(!fit) continue;
      const inliers=points.filter(p=>radialError(p,fit)<.12);
      if(inliers.length>bestCount) {best=fit;bestCount=inliers.length;}
    }
    if(!best||bestCount<points.length*.55) return null;
    const inliers=points.filter(p=>radialError(p,best)<.12), refined=fitEllipse(inliers,candidate)||best;
    const sectors=new Set(),c=Math.cos(refined.angle),s=Math.sin(refined.angle);
    for(const p of inliers) {const x=p.x-refined.cx,y=p.y-refined.cy;sectors.add(Math.floor((Math.atan2((-x*s+y*c)/refined.minor,(x*c+y*s)/refined.major)+Math.PI)*12/(2*Math.PI))%12);}
    if(sectors.size<8) return null;
    return {...refined, contour_support:inliers.length/points.length, contour_coverage:sectors.size/12};
  }
  function detectAdaptive(gray,width,height,{ previous = null } = {}) {
    if(!Number.isInteger(width)||!Number.isInteger(height)||width<20||height<20||width*height>320*320||gray.length!==width*height) throw Error('Invalid pupil image');
    const hist=new Uint32Array(256);for(const v of gray) hist[v]++;
    const thresholds=new Set();let sum=0,q=0;const quantiles=[.001,.003,.007,.015,.03,.06,.12,.22];
    for(let v=0;v<255&&q<quantiles.length;v++) {sum+=hist[v];while(q<quantiles.length&&sum>=gray.length*quantiles[q]){thresholds.add(v);q++;}}
    const rejected={}, pooled=[];
    for(const threshold of thresholds) {
      const scan=detect(gray,width,height,{threshold:clamp(threshold,5,240),candidatesOnly:true});
      for(const [key,value] of Object.entries(scan.rejected)) rejected[key]=(rejected[key]||0)+value;
      for(const candidate of scan.candidates.slice(0,4)) {
        // Equivalent candidates across threshold levels need only one contour fit.
        if(pooled.some(p=>Math.hypot(p.cx-candidate.cx,p.cy-candidate.cy)<2&&Math.abs(p.major-candidate.major)<3)) continue;
        const fit=contourFit(candidate);if(!fit){rejected.insufficient_edges=(rejected.insufficient_edges||0)+1;continue;}
        if(fit.major>Math.max(width,height)*.55) {rejected.too_large=(rejected.too_large||0)+1;continue;}
        const p={...candidate,...fit};delete p.boundary;
        p.quality=.4*p.contour_support+.3*p.contour_coverage+.3*clamp(p.contrast/40,0,1);
        if(p.quality<.72) {rejected.insufficient_edges=(rejected.insufficient_edges||0)+1;continue;}
        pooled.push(p);
      }
    }
    for(const p of pooled) {
      // Nested dark structures: prefer a supported inner boundary over the outer iris.
      const inner=pooled.some(q=>q!==p&&q.major<p.major*.65&&q.minor<p.minor*.75&&Math.hypot(q.cx-p.cx,q.cy-p.cy)<p.minor*.4);
      p.score=p.quality-(inner?.4:0);
      if(previous) {const dist=Math.hypot(p.cx-previous.cx,p.cy-previous.cy),ratio=p.major/previous.major;
        if(dist<Math.max(width*.15,previous.major)&&ratio>.6&&ratio<1.7)p.score+=.12*(1-dist/Math.max(width*.15,previous.major));}
    }
    pooled.sort((a,b)=>b.score-a.score);
    const diagnostic=['insufficient_edges','low_contrast','shape','roi_edge','too_small','too_large'].find(key=>rejected[key])||'no_dark_region';
    if(!pooled.length)return {valid:false,reason:'pupil_not_found',diagnostic,rejected};
    const best=pooled[0],other=pooled.find(p=>Math.hypot(p.cx-best.cx,p.cy-best.cy)>Math.max(4,best.minor*.4));
    if(other&&other.score>=best.score-.06)return {valid:false,reason:'pupil_ambiguous',diagnostic:'multiple_candidates',rejected};
    const u=best.cx/width,v=best.cy/height;
    return {valid:true,...best,u,v,features:features(u,v),diagnostic:'ok',rejected};
  }
  function describe(result) {
    if(result.valid)return `瞳孔候補を検出（しきい値${result.threshold ?? '手動'}）。緑の楕円が瞳孔に合うことを確認してください。`;
    const messages={too_small:'候補が小さすぎます。片目を大きく撮影するか、範囲を絞ってください。',too_large:'暗い領域が広すぎます。虹彩・影とつながっていないか確認してください。',roi_edge:'候補が範囲の端にあります。視線を動かす余白を広げてください。',shape:'形が細長いか崩れています。撮影角度・まぶた・反射を確認してください。',low_contrast:'目の境界が不鮮明です。ピント・反射・照明を確認してください。',insufficient_edges:'瞳孔の輪郭が十分見えません。反射・まぶた・ピントを確認してください。',multiple_candidates:'候補が複数あります。片目だけを囲み、反射やまつ毛を避けてください。',no_dark_region:'暗い瞳孔候補がありません。ピント・明るさを確認してください。'};
    return messages[result.reason==='pupil_ambiguous'?'multiple_candidates':result.diagnostic]||'瞳孔を検出できません。範囲・明るさ・ピントを確認してください。';
  }
  return { VERSION, detect, detectAdaptive, describe, features };
});
