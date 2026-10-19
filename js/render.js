/* global d3 */
// Canvas and SVG rendering of layer specs, plus the sheet furniture (legend, scale bar, north arrow).
// SVG coordinates are the on-screen sheet pixels, so the export matches what you see.

export const FONT = 'Poppins, Helvetica, Arial, sans-serif';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const r2 = (v) => Math.round(v * 100) / 100;

// Ground metres per screen pixel at the map centre (MapLibre uses 512 px tiles).
export function metersPerPixel(map) {
  return (40075016.686 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
}

export function projector(map, ox = 0, oy = 0) {
  return d3.geoTransform({
    point(x, y) {
      const p = map.project([x, y]);
      this.stream.point(p.x + ox, p.y + oy);
    },
  });
}

export function featuresFor(spec, sources) {
  const feats = sources[spec.source]?.features || [];
  if (!spec.filter) return feats;
  const { prop, eq, in: list } = spec.filter;
  return feats.filter((f) => (list ? list.includes(f.properties[prop]) : f.properties[prop] === eq));
}

function groupByColor(spec, feats) {
  const groups = new Map();
  for (const f of feats) {
    const color = spec.colorBy ? spec.colorBy.map[f.properties[spec.colorBy.prop]] || spec.fill : spec.fill;
    if (!groups.has(color)) groups.set(color, []);
    groups.get(color).push(f);
  }
  return groups;
}

// --- 2.5D oblique extrusion (like QGIS's 2.5D renderer) ---------------------
export function obliqueFaces(features, map, { ox = 0, oy = 0, heightScale = 1, angle = 60, view = null } = {}) {
  const k = heightScale / metersPerPixel(map);
  const a = (angle * Math.PI) / 180;
  const ux = Math.cos(a) * k;
  const uy = -Math.sin(a) * k;
  const out = [];

  for (const f of features) {
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    const dx = ux * f.properties.h;
    const dy = uy * f.properties.h;
    for (const poly of polys) {
      const rings = poly.map((ring) => ring.map((c) => {
        const p = map.project(c);
        return [p.x + ox, p.y + oy];
      }));
      const base = rings[0];
      if (view) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [x, y] of base) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        if (x1 + Math.max(dx, 0) < view[0] || x0 > view[2] || y1 < view[1] || y0 + Math.min(dy, 0) > view[3]) continue;
      }
      const walls = [];
      for (const ring of rings) {
        for (let i = 0; i < ring.length - 1; i++) {
          const p = ring[i];
          const q = ring[i + 1];
          walls.push({
            pts: [p, q, [q[0] + dx, q[1] + dy], [p[0] + dx, p[1] + dy]],
            shade: Math.abs(q[0] - p[0]) >= Math.abs(q[1] - p[1]) ? 0 : 1,
            key: (p[1] + q[1]) / 2,
          });
        }
      }
      walls.sort((w1, w2) => w1.key - w2.key);
      let maxY = -Infinity;
      for (const p of base) if (p[1] > maxY) maxY = p[1];
      out.push({ key: maxY, walls, roof: rings.map((r) => r.map(([x, y]) => [x + dx, y + dy])) });
    }
  }
  out.sort((b1, b2) => b1.key - b2.key);
  return out;
}

const ringPath = (pts) => 'M' + pts.map(([x, y]) => `${r2(x)},${r2(y)}`).join('L') + 'Z';

// --- Canvas (on-screen 2.5D preset) ----------------------------------------
export function drawCanvas(canvas, map, specs, sources, { heightScale = 1 } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!specs?.length) return;

  const path = d3.geoPath(projector(map), ctx);
  for (const spec of specs) {
    const feats = featuresFor(spec, sources);
    if (spec.type === 'fill') {
      ctx.globalAlpha = spec.opacity ?? 1;
      for (const [color, group] of groupByColor(spec, feats)) {
        ctx.beginPath();
        group.forEach((f) => path(f));
        ctx.fillStyle = color;
        ctx.fill('evenodd');
      }
    } else if (spec.type === 'oblique') {
      ctx.globalAlpha = 1;
      ctx.lineWidth = 0.3;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = spec.stroke;
      for (const b of obliqueFaces(feats, map, { heightScale, view: [0, 0, w, h] })) {
        for (const wall of b.walls) {
          ctx.beginPath();
          tracePoly(ctx, wall.pts);
          ctx.fillStyle = wall.shade ? spec.wallB : spec.wallA;
          ctx.fill();
          ctx.stroke();
        }
        ctx.beginPath();
        b.roof.forEach((r) => tracePoly(ctx, r));
        ctx.fillStyle = spec.roof;
        ctx.fill('evenodd');
        ctx.stroke();
      }
    }
  }
  ctx.globalAlpha = 1;
}

function tracePoly(ctx, pts) {
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

// --- Satellite image for export (Esri World Imagery, colour-graded in pixels) ---
const SAT_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

export async function satelliteImage(map, sat, scale = 3) {
  const el = map.getContainer();
  const w = el.clientWidth;
  const h = el.clientHeight;
  const b = map.getBounds();
  let z = Math.min(19, Math.round(map.getZoom() + 1 + Math.log2(scale)));
  let range;
  for (; z > 0; z--) {
    range = tileRange(b, z);
    if ((range.x1 - range.x0 + 1) * (range.y1 - range.y0 + 1) <= 300) break;
  }

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  const n = 2 ** z;
  const lonOf = (x) => (x / n) * 360 - 180;
  const latOf = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;

  const jobs = [];
  for (let x = range.x0; x <= range.x1; x++) {
    for (let y = range.y0; y <= range.y1; y++) {
      jobs.push(loadImage(SAT_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y)).then((img) => {
        const p0 = map.project([lonOf(x), latOf(y)]);
        const p1 = map.project([lonOf(x + 1), latOf(y + 1)]);
        ctx.drawImage(img, p0.x * scale, p0.y * scale, (p1.x - p0.x) * scale + 0.5, (p1.y - p0.y) * scale + 0.5);
      }).catch(() => {}));
    }
  }
  await Promise.all(jobs);

  // Same grading as MapLibre's raster-saturation / raster-brightness-max.
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const s = 1 + (sat.saturation ?? 0);
  const br = sat.brightness ?? 1;
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    d[i] = (gray + (d[i] - gray) * s) * br;
    d[i + 1] = (gray + (d[i + 1] - gray) * s) * br;
    d[i + 2] = (gray + (d[i + 2] - gray) * s) * br;
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.85);
}

function tileRange(b, z) {
  const n = 2 ** z;
  const tx = (lon) => Math.floor(((lon + 180) / 360) * n);
  const ty = (lat) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  };
  return { x0: tx(b.getWest()), x1: tx(b.getEast()), y0: ty(b.getNorth()), y1: ty(b.getSouth()) };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// --- Sheet furniture -------------------------------------------------------
export function hatchDef(id, color, u = 1) {
  const s = 4.5 * u;
  return `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${r2(s)}" height="${r2(s)}" patternTransform="rotate(45)">`
    + `<rect width="${r2(s)}" height="${r2(s)}" fill="${color}" fill-opacity="0.22"/>`
    + `<line x1="0" y1="0" x2="0" y2="${r2(s)}" stroke="${color}" stroke-width="${r2(1.3 * u)}"/></pattern>`;
}

export function legendSVG(items, { title = 'LEGEND', subtitle = '', x, yBottom, u }) {
  if (!items.length) return { svg: '', w: 0, h: 0 };
  const fs = 5 * u;
  const row = 8 * u;
  const sw = 11 * u;
  const pad = 6 * u;
  const cols = items.length > 8 ? 3 : 1;
  const rows = Math.ceil(items.length / cols);
  const colW = sw + 4 * u + Math.max(...items.map((i) => i.label.length)) * fs * 0.53 + 6 * u;
  const headH = fs * 1.8 + (subtitle ? fs * 1.6 : 0);
  const w = pad * 2 + cols * colW;
  const h = pad * 2 + headH + rows * row;
  const y0 = yBottom - h;

  let s = `<g id="legend" font-family="${FONT}">`;
  s += `<defs>${hatchDef('lg-hatch', items.find((i) => i.kind === 'hatch')?.color || '#999', u)}</defs>`;
  s += `<rect x="${r2(x)}" y="${r2(y0)}" width="${r2(w)}" height="${r2(h)}" fill="#ffffff" fill-opacity="0.9"/>`;
  s += `<text x="${r2(x + pad)}" y="${r2(y0 + pad + fs)}" font-size="${r2(fs)}" font-weight="600" fill="#1a1a1a" letter-spacing="0.04em">${esc(title)}</text>`;
  if (subtitle) s += `<text x="${r2(x + pad)}" y="${r2(y0 + pad + fs * 2.9)}" font-size="${r2(fs * 0.95)}" font-weight="600" fill="#444">${esc(subtitle)}</text>`;

  items.forEach((it, i) => {
    const ix = x + pad + Math.floor(i / rows) * colW;
    const iy = y0 + pad + headH + (i % rows) * row;
    const mid = iy + row * 0.4;
    if (it.kind === 'line') {
      const dash = it.dash ? ` stroke-dasharray="${it.dash.map((d) => r2(d * Math.max(it.width, 1.5))).join(' ')}"` : '';
      s += `<line x1="${r2(ix)}" y1="${r2(mid)}" x2="${r2(ix + sw)}" y2="${r2(mid)}" stroke="${it.color}" stroke-width="${r2(Math.min(Math.max(it.width ?? 2, 1.5), 4) * u)}" stroke-opacity="${it.opacity ?? 1}"${dash}/>`;
    } else {
      const fillAttr = it.kind === 'hatch' ? 'url(#lg-hatch)' : it.color;
      const strokeAttr = it.kind === 'outline' ? ` fill-opacity="${it.fillOpacity ?? 0}" stroke="${it.color}" stroke-width="${r2(1.4 * u)}"` : '';
      s += `<rect x="${r2(ix)}" y="${r2(mid - row * 0.25)}" width="${r2(sw)}" height="${r2(row * 0.5)}" fill="${fillAttr}"${strokeAttr}/>`;
    }
    s += `<text x="${r2(ix + sw + 4 * u)}" y="${r2(mid + fs * 0.35)}" font-size="${r2(fs)}" fill="#333">${esc(it.label)}</text>`;
  });
  return { svg: s + '</g>', w, h };
}

export function scaleBarSVG({ xRight, y, u, mpp }) {
  const maxPx = 140 * u;
  const unit = [10, 25, 50, 100, 200, 250, 500, 1000, 2000].reverse().find((m) => (3 * m) / mpp <= maxPx) || 10;
  const L = unit / mpp;
  const x0 = xRight - 3 * L;
  const fs = 4.2 * u;
  let s = `<g id="scale-bar" font-family="${FONT}" font-size="${r2(fs)}" fill="#555" text-anchor="middle">`;
  for (let i = 0; i < 3; i++) {
    s += `<rect x="${r2(x0 + i * L)}" y="${r2(y)}" width="${r2(L)}" height="${r2(2 * u)}" fill="${i % 2 ? '#c9cbe0' : '#1f2f7c'}"/>`;
  }
  for (let i = 0; i <= 3; i++) {
    const label = i === 3 ? `${unit * 3} M` : String(unit * i);
    s += `<text x="${r2(x0 + i * L)}" y="${r2(y + 2 * u + fs * 1.4)}">${label}</text>`;
  }
  return s + '</g>';
}

export function northSVG({ cx, cy, u }) {
  const r = 6.5 * u;
  return `<g id="north-arrow" fill="none" stroke="#1a1a1a" stroke-width="${r2(0.9 * u)}" stroke-linecap="round">`
    + `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(r)}"/>`
    + `<line x1="${r2(cx)}" y1="${r2(cy - r - 2 * u)}" x2="${r2(cx)}" y2="${r2(cy)}"/></g>`;
}

// --- SVG export ------------------------------------------------------------
function svgSpec(spec, sources, ctx) {
  const feats = featuresFor(spec, sources).filter((f) => ctx.visible(f));
  if (!feats.length) return '';
  const id = esc(spec.name || spec.source);
  const op = spec.opacity ?? 1;

  if (spec.type === 'fill' || spec.type === 'hatch') {
    let s = `<g id="${id}" fill-rule="evenodd"${op < 1 ? ` fill-opacity="${op}"` : ''}>`;
    if (spec.type === 'hatch') {
      const pid = `hatch-${ctx.seq++}`;
      ctx.defs.push(hatchDef(pid, spec.color, ctx.u));
      return s + `<g fill="url(#${pid})">${paths(feats, ctx.path)}</g></g>`;
    }
    for (const [color, group] of groupByColor(spec, feats)) s += `<g fill="${color}">${paths(group, ctx.path)}</g>`;
    return s + '</g>';
  }

  if (spec.type === 'line') {
    const dash = spec.dash ? ` stroke-dasharray="${spec.dash.map((d) => r2(d * spec.width)).join(' ')}"` : '';
    return `<g id="${id}" fill="none" stroke="${spec.color}" stroke-width="${spec.width}"${op < 1 ? ` stroke-opacity="${op}"` : ''}`
      + ` stroke-linecap="${spec.dash ? 'butt' : 'round'}" stroke-linejoin="round"${dash}>${paths(feats, ctx.path)}</g>`;
  }

  if (spec.type === 'oblique') {
    const faces = obliqueFaces(feats, ctx.map, { ox: ctx.ox, oy: ctx.oy, heightScale: ctx.heightScale, view: ctx.view });
    let s = `<g id="${id}" stroke="${spec.stroke}" stroke-width="0.3" stroke-linejoin="round">`;
    for (const b of faces) {
      s += '<g>';
      for (const wall of b.walls) s += `<path fill="${wall.shade ? spec.wallB : spec.wallA}" d="${ringPath(wall.pts)}"/>`;
      s += `<path fill="${spec.roof}" fill-rule="evenodd" d="${b.roof.map(ringPath).join('')}"/></g>`;
    }
    return s + '</g>';
  }

  if (spec.type === 'label') return svgLabels(spec, feats, ctx);
  return '';
}

function paths(feats, path) {
  let s = '';
  for (const f of feats) {
    const d = path(f);
    if (d) s += `<path d="${d}"/>`;
  }
  return s;
}

function svgLabels(spec, feats, ctx) {
  const fs = spec.size * ctx.u;
  const halo = spec.halo ? ` paint-order="stroke" stroke="${spec.halo}" stroke-width="${r2(fs * 0.35)}" stroke-linejoin="round"` : '';
  let s = `<g id="${esc(spec.name)}" font-family="${FONT}" font-size="${r2(fs)}" fill="${spec.color}"${halo}>`;
  const project = (c) => {
    const p = ctx.map.project(c);
    return [p.x + ctx.ox, p.y + ctx.oy];
  };

  if (spec.placement === 'point') {
    for (const f of feats) {
      const text = f.properties[spec.prop];
      if (!text) continue;
      const [x, y] = project(f.geometry.coordinates);
      s += `<text x="${r2(x)}" y="${r2(y)}" text-anchor="middle" dominant-baseline="middle">${esc(text)}</text>`;
    }
    return s + '</g>';
  }

  // Line labels: one per street name, on its longest visible piece.
  const best = new Map();
  for (const f of feats) {
    const name = f.properties[spec.prop];
    if (!name) continue;
    const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const line of lines) {
      const pts = line.map(project);
      let len = 0;
      for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (len > (best.get(name)?.len ?? 0)) best.set(name, { pts, len });
    }
  }
  for (const [name, { pts, len }] of best) {
    if (len < name.length * fs * 0.6 + 10) continue;
    const ordered = pts[0][0] > pts[pts.length - 1][0] ? pts.slice().reverse() : pts;
    const pid = `lp-${ctx.seq++}`;
    ctx.defs.push(`<path id="${pid}" d="M${ordered.map(([x, y]) => `${r2(x)},${r2(y)}`).join('L')}"/>`);
    s += `<text dy="${r2(fs * 0.35)}"><textPath href="#${pid}" startOffset="50%" text-anchor="middle">${esc(name)}</textPath></text>`;
  }
  return s + '</g>';
}

export function buildSVG(o) {
  const { W, H, mapBox: mb, map, specs, sources, satURL, satClip, bg, u, fontCss } = o;
  const b = map.getBounds();
  const bboxes = new WeakMap();
  const ctx = {
    map, u, ox: mb.x, oy: mb.y, defs: [], seq: 0,
    heightScale: o.heightScale,
    view: [mb.x, mb.y, mb.x + mb.width, mb.y + mb.height],
    path: d3.geoPath(projector(map, mb.x, mb.y)).digits(2),
    visible(f) {
      if (!bboxes.has(f)) bboxes.set(f, d3.geoBounds(f));
      const [[w, s], [e, n]] = bboxes.get(f);
      return !(e < b.getWest() || w > b.getEast() || n < b.getSouth() || s > b.getNorth());
    },
  };

  let body = `<rect x="${mb.x}" y="${mb.y}" width="${mb.width}" height="${mb.height}" fill="${bg}"/>`;
  if (satURL) {
    let clip = '';
    if (satClip) {
      const clipFeats = sources[satClip]?.features || [];
      ctx.defs.push(`<clipPath id="satclip">${paths(clipFeats, ctx.path)}</clipPath>`);
      clip = ' clip-path="url(#satclip)"';
    }
    body += `<image id="aerial" href="${satURL}" x="${mb.x}" y="${mb.y}" width="${mb.width}" height="${mb.height}" preserveAspectRatio="none"${clip}/>`;
  }
  for (const spec of specs) body += svgSpec(spec, sources, ctx);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="297mm" height="420mm" viewBox="0 0 ${r2(W)} ${r2(H)}">
<defs>${fontCss ? `<style>${fontCss}</style>` : ''}<clipPath id="mapclip"><rect x="${mb.x}" y="${mb.y}" width="${mb.width}" height="${mb.height}"/></clipPath>${ctx.defs.join('')}</defs>
<rect width="${r2(W)}" height="${r2(H)}" fill="#ffffff"/>
<g id="map" clip-path="url(#mapclip)">${body}</g>
${o.chrome}
</svg>`;
}

export function titleSVG({ text, x, y, size, color }) {
  return `<text id="title" x="${r2(x)}" y="${r2(y)}" font-family="${FONT}" font-size="${r2(size)}" font-weight="600" letter-spacing="0.02em" fill="${color}">${esc(text.toUpperCase())}</text>`;
}

export function creditSVG({ text, x, y, u }) {
  return `<text id="credit" x="${r2(x)}" y="${r2(y)}" font-family="${FONT}" font-size="${r2(3.8 * u)}" fill="#999">${esc(text)}</text>`;
}

// Inline Poppins so a rasterised SVG (PNG export) keeps the font.
export async function poppinsFontCss() {
  try {
    const css = await (await fetch('https://fonts.googleapis.com/css2?family=Poppins:wght@400;600&display=swap')).text();
    const urls = [...new Set(css.match(/https:\/\/[^)]+\.woff2/g) || [])];
    let out = css;
    await Promise.all(urls.map(async (url) => {
      const buf = await (await fetch(url)).arrayBuffer();
      let bin = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      out = out.split(url).join(`data:font/woff2;base64,${btoa(bin)}`);
    }));
    return out;
  } catch {
    return '';
  }
}

export function svgToPng(svg, widthPx) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    img.onload = () => {
      const scale = widthPx / img.width;
      const c = document.createElement('canvas');
      c.width = widthPx;
      c.height = Math.round(img.height * scale);
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png');
    };
    img.onerror = () => reject(new Error('Could not rasterise SVG'));
    img.src = url;
  });
}
