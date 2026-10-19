// Diagram presets. Each layer spec is rendered three ways from the same definition:
// MapLibre (on screen), canvas (2.5D preset) and SVG (export).

export const USES = [
  { id: 'residential', label: 'residential', color: '#c4ae92' },
  { id: 'religion', label: 'religion', color: '#9a9a9a' },
  { id: 'education', label: 'education', color: '#7ea1e6' },
  { id: 'healthcare', label: 'healthcare', color: '#2f8f5b' },
  { id: 'culture', label: 'culture', color: '#e2509f' },
  { id: 'civic', label: 'administration & civic services', color: '#24387f' },
  { id: 'retail', label: 'commercial – retail & daily services', color: '#ec5b4f' },
  { id: 'offices', label: 'commercial – offices & business', color: '#f19a8e' },
  { id: 'hospitality', label: 'commercial – hospitality', color: '#b8172b' },
  { id: 'sport', label: 'sport & leisure', color: '#a9cf2b' },
  { id: 'industrial', label: 'industrial', color: '#9f93d4' },
  { id: 'transport', label: 'transport / auxiliary', color: '#777777' },
  { id: 'other', label: 'other buildings / no data', color: '#dcdcdc' },
];

export const ROAD_CLASSES = [
  { id: 'path', label: 'paths', color: '#eadcea', width: 0.4 },
  { id: 'service', label: 'service', color: '#e3cbe0', width: 0.5 },
  { id: 'living_street', label: 'living street', color: '#dab3d3', width: 0.8 },
  { id: 'residential', label: 'residential', color: '#c99ac2', width: 0.9 },
  { id: 'tertiary', label: 'tertiary', color: '#c46fae', width: 1.4 },
  { id: 'secondary', label: 'secondary', color: '#c2408f', width: 2.1 },
  { id: 'primary', label: 'primary', color: '#c0185c', width: 3.2 },
];

// Track-based modes from the vector tiles (bus routes aren't in the tiles).
export const TRANSIT = [
  { id: 'train', label: 'train', color: '#2e9e5b', width: 3 },
  { id: 'subway', label: 'subway', color: '#4c6ef5', width: 3 },
  { id: 'tram', label: 'tram', color: '#e91e4f', width: 2.6 },
];

// SWOT drawing categories. `geom` picks the terra-draw mode.
export const SWOT = {
  barrier: { label: 'barrier', geom: 'line', color: '#e8344e', width: 2.5, dash: [1.5, 1.2] },
  positive: { label: 'positive', geom: 'area', color: '#b6d334', width: 3.5, fillOpacity: 0 },
  weakness: { label: 'weakness', geom: 'area', color: '#e8344e', width: 1.5, fillOpacity: 0.18 },
  noise: { label: 'noise', geom: 'line', color: '#f0a51f', width: 4, dash: [0.8, 0.8] },
  green: { label: 'green connections', geom: 'line', color: '#3aa76d', width: 12, opacity: 0.55 },
  opportunity: { label: 'opportunity', geom: 'arrow', color: '#2fa58f', width: 8, opacity: 0.8 },
};

const WATER = '#dfe6fa';
const NAVY = '#1f2f7c';

const fill = (source, color, extra = {}) => ({ type: 'fill', source, fill: color, ...extra });
const line = (source, color, width, extra = {}) => ({ type: 'line', source, color, width, ...extra });

export const PRESETS = [
  {
    id: 'schwarzplan',
    title: 'Schwarzplan',
    layers: [
      fill('water', WATER, { name: 'water' }),
      line('waterways', WATER, 3, { name: 'waterways' }),
      fill('buildings', NAVY, { name: 'buildings' }),
    ],
    legend: [{ kind: 'fill', color: NAVY, label: 'buildings' }, { kind: 'fill', color: WATER, label: 'water' }],
  },
  {
    id: 'buildings',
    title: 'Buildings',
    canvas: true, // 2.5D extrusion is drawn on a canvas under the map
    layers: [
      fill('water', '#e4e6f7', { name: 'water' }),
      { type: 'oblique', source: 'buildings', name: 'buildings', roof: '#c3bdee', wallA: '#7d75c4', wallB: '#5f57a8', stroke: '#4c4594' },
    ],
    legend: [{ kind: 'fill', color: '#a49ee0', label: 'buildings' }],
  },
  {
    id: 'classification',
    title: 'Building classification',
    layers: [
      fill('water', '#e6eaf8', { name: 'water' }),
      fill('buildings', '#dcdcdc', {
        name: 'buildings',
        colorBy: { prop: 'use', map: Object.fromEntries(USES.map((u) => [u.id, u.color])) },
      }),
    ],
    legend: USES.map((u) => ({ kind: 'fill', color: u.color, label: u.label })),
  },
  {
    id: 'roads',
    title: 'Road network',
    layers: [
      fill('water', '#e3e8fa', { name: 'water' }),
      fill('buildings', '#f1f0f4', { name: 'buildings' }),
      ...ROAD_CLASSES.map((c) => line('roads', c.color, c.width, { name: `roads-${c.id}`, filter: { prop: 'class', eq: c.id } })),
      {
        type: 'label', source: 'roadLabels', name: 'street-names', prop: 'name', placement: 'line',
        filter: { prop: 'class', in: ['primary', 'secondary', 'tertiary', 'residential'] },
        size: 5.5, color: '#7d4f78', halo: '#ffffff',
      },
    ],
    legend: [...ROAD_CLASSES].reverse().map((c) => ({ kind: 'line', color: c.color, width: c.width, label: c.label })),
  },
  {
    id: 'transport',
    title: 'Transport network',
    sat: { saturation: -1, brightness: 0.5 },
    layers: [
      line('roads', '#d4e157', 0.7, {
        name: 'streets', opacity: 0.5,
        filter: { prop: 'class', in: ['primary', 'secondary', 'tertiary', 'residential', 'living_street'] },
      }),
      ...TRANSIT.map((t) => line('transit', t.color, t.width, { name: `transit-${t.id}`, filter: { prop: 'mode', eq: t.id } })),
    ],
    legend: [
      ...TRANSIT.map((t) => ({ kind: 'line', color: t.color, width: t.width, label: t.label })),
      { kind: 'line', color: '#d4e157', width: 1, label: 'streets' },
    ],
    legendTitle: 'rail & transit lines',
  },
  {
    id: 'parks-sat',
    title: 'Parks',
    sat: { saturation: -1, brightness: 0.9 },
    layers: [
      fill('parks', '#8cc63f', { name: 'parks', opacity: 0.72 }),
      { type: 'label', source: 'parkLabels', name: 'park-names', prop: 'name', placement: 'point', size: 6.5, color: '#1c1c1c', halo: '#ffffff' },
    ],
    legend: [{ kind: 'fill', color: '#8cc63f', label: 'parks' }],
  },
  {
    id: 'parks-cutout',
    title: 'Parks',
    sat: { saturation: -0.35, brightness: 0.8, clip: 'parks' },
    layers: [
      fill('water', '#e3e8fa', { name: 'water' }),
      fill('buildings', '#f0f0f2', { name: 'buildings' }),
    ],
    legend: [{ kind: 'fill', color: '#46603f', label: 'parks (aerial)' }],
  },
  {
    id: 'parks-access',
    title: 'Parks pedestrian accessibility',
    bg: '#fbfbf7',
    layers: [
      { type: 'hatch', source: 'buffer', name: 'park-buffer', color: '#b5d46a' },
      fill('water', '#e3e8fa', { name: 'water' }),
      fill('buildings', '#d6d6d6', { name: 'buildings' }),
      fill('parks', '#8cc63f', { name: 'parks' }),
    ],
    legend: [
      { kind: 'fill', color: '#8cc63f', label: 'parks' },
      { kind: 'hatch', color: '#b5d46a', label: 'buffer' }, // label filled in with the distance
      { kind: 'fill', color: '#d6d6d6', label: 'buildings' },
    ],
  },
];

// Layers drawn on top of every preset.
export function overlaySpecs({ showSite, showIso, showSwot }) {
  const specs = [];
  if (showIso) {
    specs.push(line('iso', '#333333', 1, { name: 'walk-isochrones', dash: [3, 2] }));
    specs.push({ type: 'label', source: 'isoLabels', name: 'isochrone-labels', prop: 'label', placement: 'point', size: 5.5, color: '#333333', halo: '#ffffff' });
  }
  if (showSwot) {
    for (const [cat, s] of Object.entries(SWOT)) {
      const filter = { prop: 'cat', eq: cat };
      if (s.geom === 'area') {
        if (s.fillOpacity) specs.push(fill('swot', s.color, { name: `swot-${cat}-fill`, opacity: s.fillOpacity, filter }));
        specs.push(line('swot', s.color, s.width, { name: `swot-${cat}`, filter }));
      } else {
        specs.push(line('swot', s.color, s.width, { name: `swot-${cat}`, dash: s.dash, opacity: s.opacity, filter }));
        if (s.geom === 'arrow') specs.push(fill('swotHeads', s.color, { name: `swot-${cat}-heads`, opacity: s.opacity, filter }));
      }
    }
  }
  if (showSite) {
    specs.push(fill('site', '#ff6a3d', { name: 'site', opacity: 0.9 }));
    specs.push(line('site', '#5a1d0a', 0.8, { name: 'site-outline' }));
  }
  return specs;
}
