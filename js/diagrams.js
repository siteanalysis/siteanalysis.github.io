/* global maplibregl, turf, terraDraw, terraDrawMaplibreGlAdapter */
import { PRESETS, SWOT, overlaySpecs } from './presets.js';
import { bboxAround, loadArea, fetchIsochrones, searchPlaces, siteFootprint } from './osm.js';
import {
  drawCanvas, buildSVG, legendSVG, scaleBarSVG, northSVG, titleSVG, creditSVG,
  satelliteImage, poppinsFontCss, svgToPng, metersPerPixel,
} from './render.js';

const $ = (id) => document.getElementById(id);
const fc = (features = []) => ({ type: 'FeatureCollection', features });
const fmt = (n) => Math.round(n).toLocaleString();
const DATA_SOURCES = ['buildings', 'water', 'waterways', 'green', 'parks', 'roads', 'roadLabels', 'rail', 'transit', 'mask', 'buffer', 'parkLabels'];
const SOURCES = ['buildings', 'water', 'waterways', 'green', 'parks', 'roads', 'roadLabels', 'rail', 'transit', 'mask', 'buffer', 'parkLabels', 'iso', 'isoLabels', 'site', 'swot', 'swotHeads'];
const PREVIEW_LAYERS = ['pv-water', 'pv-park', 'pv-road', 'pv-building'];
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

const params = new URLSearchParams(location.search);
const num = (k, d) => {
  const v = parseFloat(params.get(k));
  return Number.isFinite(v) ? v : d;
};

const state = {
  site: { lon: num('lon', -73.9855), lat: num('lat', 40.758), w: num('w', 30), d: num('d', 20), h: num('h', 36), rot: num('rot', 0) },
  radius: 1000,
  presetId: 'schwarzplan',
  titles: {},
  loaded: false,
  bbox: null,
  parkUnion: null,
  showSite: true,
  showIso: false,
  showSwot: true,
  bufferM: 400,
  heightScale: 1,
  tool: null,
  swot: [],
  sources: Object.fromEntries(SOURCES.map((n) => [n, fc()])),
};

let map;
let draw;
let sheet;
let layerIds = [];
let swotLayerIds = [];
let loadSeq = 0;

const preset = () => PRESETS.find((p) => p.id === state.presetId);

// --- Setup -----------------------------------------------------------------
async function init() {
  buildPanel();
  map = new maplibregl.Map({
    container: 'map',
    style: baseStyle(),
    center: [state.site.lon, state.site.lat],
    zoom: 15,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  await new Promise((resolve) => map.on('load', resolve));
  map.addImage('hatch', hatchImage('#b5d46a'));

  layout();
  window.addEventListener('resize', () => {
    layout();
    applyPreset();
  });
  map.on('move', scheduleRedraw);
  map.on('click', onMapClick);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.tool) setTool(state.tool);
  });

  setupDraw();
  setSource('site', fc([siteFootprint(state.site)]));
  loadSwot();
  applyPreset();
  loadData();
}

function baseStyle() {
  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
      sat: { type: 'raster', tiles: [ESRI], tileSize: 256, maxzoom: 19 },
      ...Object.fromEntries(SOURCES.map((n) => [n, { type: 'geojson', data: fc(), tolerance: 0.2 }])),
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#ffffff' } },
      { id: 'sat', type: 'raster', source: 'sat', layout: { visibility: 'none' } },
      { id: 'pv-water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': '#e3e8fa' } },
      { id: 'pv-park', type: 'fill', source: 'omt', 'source-layer': 'park', paint: { 'fill-color': '#e6efd9' } },
      { id: 'pv-road', type: 'line', source: 'omt', 'source-layer': 'transportation', paint: { 'line-color': '#e2e2e2', 'line-width': 0.6 } },
      { id: 'pv-building', type: 'fill', source: 'omt', 'source-layer': 'building', paint: { 'fill-color': '#d3d5e6' } },
    ],
  };
}

function hatchImage(color) {
  const s = 8;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  g.fillStyle = color + '38';
  g.fillRect(0, 0, s, s);
  g.strokeStyle = color;
  g.lineWidth = 1.3;
  g.beginPath();
  for (const o of [-s, 0, s]) {
    g.moveTo(o, s);
    g.lineTo(o + s, 0);
  }
  g.stroke();
  return g.getImageData(0, 0, s, s);
}

// A3 portrait sheet sized to the workspace. Everything (map, legend, export) is laid out in sheet pixels.
function layout() {
  const ws = $('workspace');
  const m = 24;
  let H = ws.clientHeight - 2 * m;
  let W = (H * 297) / 420;
  if (W > ws.clientWidth - 2 * m) {
    W = ws.clientWidth - 2 * m;
    H = (W * 420) / 297;
  }
  const pad = W * 0.055;
  const titleH = W * 0.075;
  const footH = W * 0.045;
  const mapBox = { x: pad, y: pad + titleH, width: W - 2 * pad, height: H - 2 * pad - titleH - footH };
  sheet = { W, H, u: W / 600, pad, titleH, mapBox };

  Object.assign($('sheet').style, { width: `${W}px`, height: `${H}px` });
  Object.assign($('mapWrap').style, {
    left: `${mapBox.x}px`, top: `${mapBox.y}px`, width: `${mapBox.width}px`, height: `${mapBox.height}px`,
  });
  const chrome = $('chrome');
  chrome.setAttribute('viewBox', `0 0 ${W} ${H}`);
  chrome.setAttribute('width', W);
  chrome.setAttribute('height', H);
  map.resize();
  redrawCanvas();
  drawChrome();
}

// --- Presets → MapLibre layers --------------------------------------------
function mlFilter({ prop, eq, in: list }) {
  return list ? ['in', ['get', prop], ['literal', list]] : ['==', ['get', prop], eq];
}

function mlLayers(spec, id) {
  const base = { id, source: spec.source };
  if (spec.filter) base.filter = mlFilter(spec.filter);
  switch (spec.type) {
    case 'fill': {
      const color = spec.colorBy
        ? ['match', ['get', spec.colorBy.prop], ...Object.entries(spec.colorBy.map).flat(), spec.fill]
        : spec.fill;
      return [{ ...base, type: 'fill', paint: { 'fill-color': color, 'fill-opacity': spec.opacity ?? 1 } }];
    }
    case 'hatch':
      return [{ ...base, type: 'fill', paint: { 'fill-pattern': 'hatch' } }];
    case 'line':
      return [{
        ...base,
        type: 'line',
        layout: { 'line-cap': spec.dash ? 'butt' : 'round', 'line-join': 'round' },
        paint: {
          'line-color': spec.color,
          'line-width': spec.width,
          'line-opacity': spec.opacity ?? 1,
          ...(spec.dash ? { 'line-dasharray': spec.dash } : {}),
        },
      }];
    case 'label':
      return [{
        ...base,
        type: 'symbol',
        layout: {
          'text-field': ['get', spec.prop],
          'text-font': ['Noto Sans Regular'],
          'text-size': spec.size * sheet.u,
          'symbol-placement': spec.placement === 'line' ? 'line' : 'point',
          'text-max-angle': 35,
          'symbol-spacing': 400,
          'text-padding': 4,
        },
        paint: { 'text-color': spec.color, 'text-halo-color': spec.halo || '#ffffff', 'text-halo-width': spec.halo ? 1 : 0 },
      }];
    default:
      return [];
  }
}

function currentSpecs() {
  const P = preset();
  return [...P.layers, ...overlaySpecs(state)];
}

function applyPreset() {
  const P = preset();
  for (const id of layerIds) if (map.getLayer(id)) map.removeLayer(id);
  layerIds = [];
  swotLayerIds = [];

  map.setPaintProperty('bg', 'background-color', P.bg || '#ffffff');
  map.setPaintProperty('bg', 'background-opacity', P.canvas ? 0 : 1);
  map.setLayoutProperty('sat', 'visibility', P.sat ? 'visible' : 'none');
  if (P.sat) {
    map.setPaintProperty('sat', 'raster-saturation', P.sat.saturation);
    map.setPaintProperty('sat', 'raster-brightness-max', P.sat.brightness);
  }
  for (const id of PREVIEW_LAYERS) map.setLayoutProperty(id, 'visibility', state.loaded ? 'none' : 'visible');
  $('mapWrap').style.background = P.bg || '#ffffff';

  const specs = [];
  if (P.sat?.clip) specs.push({ type: 'fill', source: 'mask', fill: P.bg || '#ffffff' });
  if (!P.canvas) specs.push(...P.layers);
  specs.push(...overlaySpecs(state));

  // Keep terra-draw's in-progress drawing on top.
  const before = map.getStyle().layers.find((l) => l.id.startsWith('td-'))?.id;
  specs.forEach((spec, i) => {
    for (const layer of mlLayers(spec, `d${i}`)) {
      map.addLayer(layer, before);
      layerIds.push(layer.id);
      if (spec.source === 'swot' || spec.source === 'swotHeads') swotLayerIds.push(layer.id);
    }
  });

  redrawCanvas();
  drawChrome();
  syncPanel();
}

// --- Canvas + sheet furniture ---------------------------------------------
let frame = 0;
function scheduleRedraw() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    redrawCanvas();
    drawChrome();
  });
}

function redrawCanvas() {
  const P = preset();
  drawCanvas($('canvas'), map, P.canvas ? P.layers : null, state.sources, { heightScale: state.heightScale });
}

function currentTitle() {
  return state.titles[state.presetId] ?? preset().title;
}

function credit() {
  return `© OpenStreetMap contributors${preset().sat ? ' · Imagery © Esri, Maxar, Earthstar Geographics' : ''}`;
}

function legendItems() {
  const P = preset();
  const items = P.legend.map((it) => (it.kind === 'hatch' ? { ...it, label: `${state.bufferM} m buffer from the park` } : it));
  if (state.showIso) items.push({ kind: 'line', color: '#333333', width: 1, dash: [3, 2], label: '5 / 10 / 15 min walk' });
  if (state.showSite) items.push({ kind: 'fill', color: '#ff6a3d', label: 'site' });
  if (state.showSwot) {
    const used = new Set(state.swot.map((f) => f.properties.cat));
    for (const [cat, s] of Object.entries(SWOT)) {
      if (!used.has(cat)) continue;
      items.push(s.geom === 'area'
        ? { kind: 'outline', color: s.color, fillOpacity: s.fillOpacity, label: s.label }
        : { kind: 'line', color: s.color, width: s.width, dash: s.dash, opacity: s.opacity, label: s.label });
    }
  }
  return items;
}

function chromeSVG() {
  const { W, u, pad, titleH, mapBox: mb } = sheet;
  const legend = legendSVG(legendItems(), { subtitle: preset().legendTitle || '', x: mb.x + 6 * u, yBottom: mb.y + mb.height - 6 * u, u });
  return titleSVG({ text: currentTitle(), x: pad, y: pad + titleH * 0.55, size: 15 * u, color: '#1a1a1a' })
    + northSVG({ cx: W - pad - 8 * u, cy: pad + titleH * 0.4, u })
    + legend.svg
    + scaleBarSVG({ xRight: W - pad, y: mb.y + mb.height + 7 * u, u, mpp: metersPerPixel(map) })
    + creditSVG({ text: credit(), x: pad, y: mb.y + mb.height + 11 * u, u });
}

function drawChrome() {
  $('chrome').innerHTML = chromeSVG();
}

// --- Data ------------------------------------------------------------------
function setSource(name, data) {
  state.sources[name] = data;
  map.getSource(name)?.setData(data);
}

async function loadData() {
  const seq = ++loadSeq;
  const { lon, lat } = state.site;
  const { mapBox: mb } = sheet;
  const halfW = state.radius;
  const halfH = (state.radius * mb.height) / mb.width;
  const view = bboxAround(lon, lat, halfW, halfH);
  state.bbox = bboxAround(lon, lat, halfW * 1.08, halfH * 1.08);
  map.fitBounds([[view[0], view[1]], [view[2], view[3]]], { padding: 0, animate: false });

  state.loaded = false;
  for (const n of DATA_SOURCES) setSource(n, fc());
  applyPreset();
  $('reloadBtn').disabled = true;

  try {
    const L = await loadArea(state.bbox, (text) => seq === loadSeq && setStatus(text));
    if (seq !== loadSeq) return;
    for (const [k, list] of Object.entries(L)) setSource(k, fc(list));
    computeParks();
    state.loaded = true;
    applyPreset();
    setStatus(`${fmt(L.buildings.length)} buildings · ${fmt(L.parks.length)} park pieces · ${fmt(L.transit.length)} transit segments`);
  } catch (err) {
    console.error(err);
    if (seq === loadSeq) setStatus(`Loading failed: ${err.message}. Try again.`, true);
  } finally {
    if (seq === loadSeq) $('reloadBtn').disabled = false;
  }
}

function computeParks() {
  const parks = state.sources.parks.features;
  let union = null;
  if (parks.length) {
    try {
      union = parks.length === 1 ? parks[0] : turf.union(fc(parks));
    } catch (err) {
      console.warn('Park union failed, using individual parks', err);
    }
  }
  state.parkUnion = union;

  const [w, s, e, n] = state.bbox;
  const outer = turf.bboxPolygon([w - 0.05, s - 0.05, e + 0.05, n + 0.05]);
  let mask = outer;
  if (union) {
    try {
      mask = turf.difference(fc([outer, union])) || outer;
    } catch {
      mask = holesMask(outer, parks);
    }
  } else if (parks.length) {
    mask = holesMask(outer, parks);
  }
  setSource('mask', fc([mask]));
  computeBuffer();
}

function holesMask(outer, parks) {
  const holes = parks.flatMap((p) => (p.geometry.type === 'Polygon' ? [p.geometry.coordinates[0]] : p.geometry.coordinates.map((pp) => pp[0])));
  return turf.polygon([outer.geometry.coordinates[0], ...holes]);
}

function computeBuffer() {
  const opts = { units: 'meters' };
  let features = [];
  try {
    if (state.parkUnion) features = [turf.buffer(state.parkUnion, state.bufferM, opts)];
    else if (state.sources.parks.features.length) features = turf.buffer(state.sources.parks, state.bufferM, opts).features;
  } catch (err) {
    console.warn('Buffer failed', err);
  }
  setSource('buffer', fc(features.filter(Boolean)));
}

async function loadIsochrones() {
  setStatus('Fetching walking isochrones from Valhalla…');
  try {
    const iso = await fetchIsochrones(state.site.lon, state.site.lat);
    setSource('iso', iso);
    setSource('isoLabels', fc(iso.features.map(isoLabel)));
    setStatus('Walking isochrones: 5 / 10 / 15 min from the site.');
  } catch (err) {
    setStatus(`Isochrones failed: ${err.message}. The public server may be busy — try again.`, true);
    state.showIso = false;
    $('isoOn').checked = false;
  }
}

function isoLabel(f) {
  const rings = f.geometry.type === 'Polygon' ? [f.geometry.coordinates[0]] : f.geometry.coordinates.map((p) => p[0]);
  let top = rings[0][0];
  for (const r of rings) for (const c of r) if (c[1] > top[1]) top = c;
  return turf.point(top, { label: `${f.properties.minutes} min` });
}

async function setSite(lon, lat) {
  Object.assign(state.site, { lon, lat });
  const p = new URLSearchParams(Object.entries(state.site).map(([k, v]) => [k, String(Math.round(v * 1e6) / 1e6)]));
  history.replaceState(null, '', `?${p}`);
  $('link3d').href = `index.html?${p}`;
  $('coords').value = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
  setSource('site', fc([siteFootprint(state.site)]));
  setSource('iso', fc());
  setSource('isoLabels', fc());
  loadSwot();
  if (state.showIso) loadIsochrones().then(applyPreset);
  loadData();
}

// --- SWOT drawing ----------------------------------------------------------
function setupDraw() {
  const color = () => SWOT[state.tool]?.color || '#333333';
  draw = new terraDraw.TerraDraw({
    adapter: new terraDrawMaplibreGlAdapter.TerraDrawMapLibreGLAdapter({ map }),
    modes: [
      new terraDraw.TerraDrawLineStringMode({
        styles: { lineStringColor: color, lineStringWidth: 3, closingPointColor: color, closingPointWidth: 4, closingPointOutlineColor: '#ffffff', closingPointOutlineWidth: 1 },
      }),
      new terraDraw.TerraDrawFreehandMode({
        styles: { fillColor: color, fillOpacity: 0.15, outlineColor: color, outlineWidth: 2.5, closingPointColor: color, closingPointWidth: 4, closingPointOutlineColor: '#ffffff', closingPointOutlineWidth: 1 },
      }),
    ],
  });
  draw.start();
  draw.on('finish', (id, ctx) => {
    if (ctx?.action && ctx.action !== 'draw') return;
    const f = draw.getSnapshot().find((x) => x.id === id);
    setTimeout(() => draw.removeFeatures([id]), 0);
    if (!f || !SWOT[state.tool]) return;
    const props = { cat: state.tool, sid: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
    if (SWOT[state.tool].geom === 'arrow') props.head = 16 * sheet.u * metersPerPixel(map);
    state.swot.push({ type: 'Feature', properties: props, geometry: f.geometry });
    saveSwot();
    refreshSwot();
  });
}

function setTool(tool) {
  state.tool = state.tool === tool ? null : tool;
  const geom = SWOT[state.tool]?.geom;
  draw.setMode(geom === 'area' ? 'freehand' : geom ? 'linestring' : 'static');
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === state.tool));
  const hints = {
    line: 'Click to add points · click the last point again to finish · Esc to stop',
    arrow: 'Draw the arrow shaft: click points, click the last point again to finish',
    area: 'Click to start, move to draw the outline, click again to close',
  };
  $('swotHint').textContent = state.tool === 'erase' ? 'Click a SWOT drawing to delete it' : hints[geom] || 'Pick a category, then draw on the map.';
  $('mapWrap').style.cursor = state.tool === 'erase' ? 'crosshair' : '';
}

function onMapClick(e) {
  if (state.tool !== 'erase' || !swotLayerIds.length) return;
  const { x, y } = e.point;
  const hit = map.queryRenderedFeatures([[x - 5, y - 5], [x + 5, y + 5]], { layers: swotLayerIds })[0];
  if (!hit) return;
  state.swot = state.swot.filter((f) => f.properties.sid !== hit.properties.sid);
  saveSwot();
  refreshSwot();
}

function arrowHead(f) {
  const c = f.geometry.coordinates;
  if (c.length < 2) return null;
  const tipBase = c[c.length - 1];
  const bearing = turf.bearing(c[c.length - 2], tipBase);
  const L = f.properties.head;
  const o = { units: 'meters' };
  const tip = turf.destination(tipBase, L * 0.9, bearing, o).geometry.coordinates;
  const left = turf.destination(tipBase, L * 0.6, bearing - 90, o).geometry.coordinates;
  const right = turf.destination(tipBase, L * 0.6, bearing + 90, o).geometry.coordinates;
  return turf.polygon([[left, tip, right, left]], { cat: f.properties.cat, sid: f.properties.sid });
}

function refreshSwot() {
  setSource('swot', fc(state.swot));
  setSource('swotHeads', fc(state.swot.filter((f) => SWOT[f.properties.cat]?.geom === 'arrow').map(arrowHead).filter(Boolean)));
  drawChrome();
}

const swotKey = () => `swot:${state.site.lat.toFixed(5)},${state.site.lon.toFixed(5)}`;
function saveSwot() {
  try {
    localStorage.setItem(swotKey(), JSON.stringify(state.swot));
  } catch {
    // storage unavailable — drawings live for this session only
  }
}
function loadSwot() {
  try {
    state.swot = JSON.parse(localStorage.getItem(swotKey()) || '[]');
  } catch {
    state.swot = [];
  }
  refreshSwot();
}

// --- Export ----------------------------------------------------------------
async function buildExport(forPng) {
  const P = preset();
  const satURL = P.sat ? await satelliteImage(map, P.sat, 3) : null;
  return buildSVG({
    W: sheet.W, H: sheet.H, mapBox: sheet.mapBox, u: sheet.u, map,
    specs: currentSpecs(),
    sources: state.sources,
    satURL,
    satClip: P.sat?.clip,
    bg: P.bg || '#ffffff',
    heightScale: state.heightScale,
    chrome: chromeSVG(),
    fontCss: forPng ? await poppinsFontCss() : '',
  });
}

function fileName(ext) {
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${slug(currentTitle()) || 'diagram'}-${state.presetId}.${ext}`;
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function exportFile(kind) {
  const btns = document.querySelectorAll('[data-export]');
  btns.forEach((b) => (b.disabled = true));
  setStatus(kind === 'png' ? 'Rendering A3 PNG at 300 dpi…' : 'Building SVG…');
  try {
    const svg = await buildExport(kind === 'png');
    if (kind === 'svg') {
      download(new Blob([svg], { type: 'image/svg+xml' }), fileName('svg'));
      setStatus(`SVG exported (${(svg.length / 1e6).toFixed(1)} MB). Opens in Illustrator, Figma or Inkscape.`);
    } else {
      download(await svgToPng(svg, 3508), fileName('png'));
      setStatus(`PNG exported (A3 at 300 dpi, 3508 × ${Math.round((3508 * sheet.H) / sheet.W)} px).`);
    }
  } catch (err) {
    console.error(err);
    setStatus(`Export failed: ${err.message}`, true);
  } finally {
    btns.forEach((b) => (b.disabled = false));
  }
}

// --- Panel -----------------------------------------------------------------
function setStatus(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}

function buildPanel() {
  $('presets').innerHTML = PRESETS.map((p) => `<button data-preset="${p.id}">${presetLabel(p)}</button>`).join('');
  $('presets').addEventListener('click', (e) => {
    const id = e.target.closest('[data-preset]')?.dataset.preset;
    if (!id) return;
    state.presetId = id;
    applyPreset();
  });

  $('swotTools').innerHTML = Object.entries(SWOT)
    .map(([cat, s]) => `<button data-tool="${cat}"><i style="background:${s.color}"></i>${s.label}</button>`)
    .join('') + '<button data-tool="erase">Erase</button>';
  $('swotTools').addEventListener('click', (e) => {
    const tool = e.target.closest('[data-tool]')?.dataset.tool;
    if (tool) setTool(tool);
  });
  $('undoBtn').addEventListener('click', () => {
    state.swot.pop();
    saveSwot();
    refreshSwot();
  });
  let clearArmed = false;
  $('clearBtn').addEventListener('click', () => {
    if (!clearArmed) {
      clearArmed = true;
      $('clearBtn').textContent = 'Click again to clear';
      setTimeout(() => {
        clearArmed = false;
        $('clearBtn').textContent = 'Clear all';
      }, 3000);
      return;
    }
    state.swot = [];
    saveSwot();
    refreshSwot();
  });

  $('radius').value = state.radius;
  $('radiusVal').textContent = `${state.radius} m`;
  $('radius').addEventListener('input', () => {
    state.radius = Number($('radius').value);
    $('radiusVal').textContent = `${state.radius} m`;
  });
  $('reloadBtn').addEventListener('click', loadData);

  $('titleInput').addEventListener('input', () => {
    const v = $('titleInput').value.trim();
    if (v) state.titles[state.presetId] = v;
    else delete state.titles[state.presetId];
    drawChrome();
  });

  $('siteOn').addEventListener('change', (e) => {
    state.showSite = e.target.checked;
    applyPreset();
  });
  $('swotOn').addEventListener('change', (e) => {
    state.showSwot = e.target.checked;
    applyPreset();
  });
  $('isoOn').addEventListener('change', async (e) => {
    state.showIso = e.target.checked;
    if (state.showIso && !state.sources.iso.features.length) await loadIsochrones();
    applyPreset();
  });
  $('buffer').addEventListener('input', () => {
    state.bufferM = Number($('buffer').value);
    $('bufferVal').textContent = `${state.bufferM} m`;
    drawChrome();
  });
  $('buffer').addEventListener('change', computeBuffer);
  $('heightScale').addEventListener('input', () => {
    state.heightScale = Number($('heightScale').value);
    $('heightVal').textContent = `${state.heightScale.toFixed(1)}×`;
    redrawCanvas();
  });

  document.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () => exportFile(b.dataset.export)));

  bindSearch();
  $('coords').value = `${state.site.lat.toFixed(6)}, ${state.site.lon.toFixed(6)}`;
  $('coordsGo').addEventListener('click', goToCoords);
  $('coords').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') goToCoords();
  });
  const p = new URLSearchParams(Object.entries(state.site).map(([k, v]) => [k, String(v)]));
  $('link3d').href = `index.html?${p}`;
}

function presetLabel(p) {
  return { 'parks-sat': 'Parks · aerial', 'parks-cutout': 'Parks · cut-out', 'parks-access': 'Park access' }[p.id] || p.title;
}

function syncPanel() {
  document.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('active', b.dataset.preset === state.presetId));
  $('titleInput').placeholder = preset().title;
  $('titleInput').value = state.titles[state.presetId] ?? '';
  $('bufferRow').style.display = state.presetId === 'parks-access' ? '' : 'none';
  $('heightRow').style.display = state.presetId === 'buildings' ? '' : 'none';
}

function goToCoords() {
  const [lat, lon] = $('coords').value.split(/[,\s]+/).map(Number);
  if (Number.isFinite(lat) && Number.isFinite(lon)) setSite(lon, lat);
}

function bindSearch() {
  const input = $('search');
  const list = $('results');
  let timer;
  let seq = 0;
  let results = [];
  let active = -1;

  const render = () => {
    list.innerHTML = results.length
      ? results.map((r, i) => `<li data-i="${i}" class="${i === active ? 'active' : ''}"></li>`).join('')
      : '<li class="empty">No results</li>';
    list.querySelectorAll('li[data-i]').forEach((li) => (li.textContent = results[li.dataset.i].label));
    list.style.display = 'block';
  };
  const choose = (r) => {
    input.value = r.label;
    list.style.display = 'none';
    setSite(r.lon, r.lat);
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) {
      list.style.display = 'none';
      return;
    }
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const found = await searchPlaces(q);
        if (mine !== seq) return;
        results = found;
        active = -1;
        render();
      } catch (err) {
        console.warn(err);
      }
    }, 300);
  });
  input.addEventListener('keydown', (e) => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && results.length) {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      render();
    } else if (e.key === 'Enter' && results.length) {
      choose(results[Math.max(active, 0)]);
    } else if (e.key === 'Escape') {
      list.style.display = 'none';
    }
  });
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-i]');
    if (!li) return;
    e.preventDefault();
    choose(results[li.dataset.i]);
  });
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.search')) list.style.display = 'none';
  });
}

init().catch((err) => {
  console.error(err);
  setStatus(`Failed to start: ${err.message}`, true);
});
