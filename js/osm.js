/* global turf */
// Site data from OpenFreeMap vector tiles (OpenStreetMap, OpenMapTiles schema) at z14,
// decoded and stitched into clean, clipped GeoJSON layers for the diagrams.

const TILEJSON = 'https://tiles.openfreemap.org/planet';
const Z = 14; // highest zoom of the tileset — full detail

const ROAD_CLASS = {
  motorway: 'primary', trunk: 'primary', primary: 'primary', secondary: 'secondary', tertiary: 'tertiary',
  minor: 'residential', service: 'service', path: 'path', track: 'path',
};

// Rail/transit track subclasses → transport-map modes.
const TRANSIT_MODE = { tram: 'tram', subway: 'subway', rail: 'train', light_rail: 'train', narrow_gauge: 'train', monorail: 'train' };

// OpenMapTiles POI subclasses → building use (POIs inside a building classify it).
const USE_BY_POI = {
  place_of_worship: 'religion', monastery: 'religion',
  school: 'education', university: 'education', college: 'education', kindergarten: 'education',
  hospital: 'healthcare', clinic: 'healthcare', doctors: 'healthcare', dentist: 'healthcare', pharmacy: 'healthcare',
  library: 'culture', theatre: 'culture', cinema: 'culture', arts_centre: 'culture', museum: 'culture', gallery: 'culture', community_centre: 'culture',
  townhall: 'civic', courthouse: 'civic', police: 'civic', fire_station: 'civic', post_office: 'civic', embassy: 'civic',
  restaurant: 'hospitality', cafe: 'hospitality', bar: 'hospitality', pub: 'hospitality', fast_food: 'hospitality',
  hotel: 'hospitality', hostel: 'hospitality', guest_house: 'hospitality', motel: 'hospitality',
  bank: 'offices', office: 'offices', marketplace: 'retail',
  sports_centre: 'sport', fitness_centre: 'sport', stadium: 'sport', swimming_pool: 'sport', ice_rink: 'sport',
  parking: 'transport', bus_station: 'transport', station: 'transport',
};
const USE_BY_LANDUSE = {
  residential: 'residential', retail: 'retail', commercial: 'offices',
  school: 'education', university: 'education', college: 'education', kindergarten: 'education', education: 'education',
  hospital: 'healthcare', religious: 'religion', library: 'culture', military: 'civic',
  industrial: 'industrial', railway: 'transport', bus_station: 'transport', garages: 'transport',
  stadium: 'sport', pitch: 'sport',
};
const PARK_SUBCLASSES = new Set(['park', 'recreation_ground', 'village_green']);
const SHOP_CLASSES =new Set(['shop', 'grocery', 'clothing_store', 'alcohol_shop', 'bakery', 'butcher', 'car', 'furniture', 'hardware', 'jewelry', 'mobile_phone', 'shoe', 'stationery', 'supermarket']);

export function bboxAround(lon, lat, halfWidthM, halfHeightM) {
  const dLat = halfHeightM / 111320;
  const dLon = halfWidthM / (111320 * Math.cos((lat * Math.PI) / 180));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

// --- Geometry helpers ------------------------------------------------------
function cleanGeometry(g) {
  if (!g) return null;
  if (g.type === 'Polygon') {
    const rings = g.coordinates.filter((r) => r.length >= 4);
    return rings.length ? { type: 'Polygon', coordinates: rings } : null;
  }
  if (g.type === 'MultiPolygon') {
    const polys = g.coordinates.map((p) => p.filter((r) => r.length >= 4)).filter((p) => p.length);
    return polys.length ? { type: 'MultiPolygon', coordinates: polys } : null;
  }
  if (g.type === 'LineString') return g.coordinates.length >= 2 ? g : null;
  if (g.type === 'MultiLineString') {
    const lines = g.coordinates.filter((l) => l.length >= 2);
    return lines.length ? { type: 'MultiLineString', coordinates: lines } : null;
  }
  return null;
}

function pushClipped(list, geometry, properties, box) {
  let f = { type: 'Feature', properties, geometry };
  const [w, s, e, n] = turf.bbox(f);
  if (e < box[0] || w > box[2] || n < box[1] || s > box[3]) return null;
  if (w < box[0] || e > box[2] || s < box[1] || n > box[3]) {
    try {
      f = turf.bboxClip(f, box);
    } catch {
      return null;
    }
  }
  f.geometry = cleanGeometry(f.geometry);
  if (!f.geometry) return null;
  list.push(f);
  return f;
}

// --- Loading ---------------------------------------------------------------
let vtModules;

export async function loadArea(bbox, onStatus) {
  vtModules ??= Promise.all([
    import('https://cdn.jsdelivr.net/npm/@mapbox/vector-tile@2.0.3/+esm'),
    import('https://cdn.jsdelivr.net/npm/pbf@4.0.1/+esm'),
  ]);
  const [{ VectorTile }, { default: Pbf }] = await vtModules;
  const template = (await (await fetch(TILEJSON)).json()).tiles[0];

  const n = 2 ** Z;
  const tx = (lon) => Math.floor(((lon + 180) / 360) * n);
  const ty = (lat) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  };
  const lonOf = (x) => (x / n) * 360 - 180;
  const latOf = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  const [w, s, e, nth] = bbox;

  const L = { buildings: [], water: [], waterways: [], green: [], parks: [], parkLabels: [], roads: [], roadLabels: [], rail: [], transit: [] };
  const pois = [];
  const landuse = [];
  const tiles = [];
  for (let x = tx(w); x <= tx(e); x++) for (let y = ty(nth); y <= ty(s); y++) tiles.push([x, y]);
  let done = 0;
  onStatus(`Loading vector tiles 0 / ${tiles.length}…`);

  await Promise.all(tiles.map(async ([x, y]) => {
    const res = await fetch(template.replace('{z}', Z).replace('{x}', x).replace('{y}', y));
    if (!res.ok) throw new Error(`Tile ${Z}/${x}/${y}: ${res.status}`);
    const tile = new VectorTile(new Pbf(await res.arrayBuffer()));

    // Clip every feature to its own tile so pieces from neighbouring tiles abut instead of overlapping.
    const box = [Math.max(w, lonOf(x)), Math.max(s, latOf(y + 1)), Math.min(e, lonOf(x + 1)), Math.min(nth, latOf(y))];
    const inBox = ([lon, lat]) => lon >= box[0] && lon < box[2] && lat >= box[1] && lat < box[3];
    const each = (name, fn) => {
      const layer = tile.layers[name];
      if (!layer) return;
      for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i).toGeoJSON(x, y, Z);
        fn(f.properties, f.geometry);
      }
    };
    const isPoly = (g) => g.type === 'Polygon' || g.type === 'MultiPolygon';
    const isLine = (g) => g.type === 'LineString' || g.type === 'MultiLineString';

    each('building', (p, g) => {
      if (isPoly(g) && !p.hide_3d) pushClipped(L.buildings, g, { h: p.render_height || 0 }, box);
    });
    each('water', (p, g) => isPoly(g) && pushClipped(L.water, g, {}, box));
    each('waterway', (p, g) => {
      if (isLine(g) && ['river', 'canal', 'stream'].includes(p.class)) pushClipped(L.waterways, g, { kind: p.class }, box);
    });
    each('landcover', (p, g) => {
      if (!isPoly(g) || !['grass', 'wood'].includes(p.class)) return;
      const park = PARK_SUBCLASSES.has(p.subclass);
      const f = pushClipped(L.green, g, { kind: park ? 'park' : 'green' }, box);
      if (f && park) L.parks.push(f);
    });
    each('landuse', (p, g) => {
      if (isPoly(g) && USE_BY_LANDUSE[p.class]) pushClipped(landuse, g, { use: USE_BY_LANDUSE[p.class] }, box);
    });
    each('transportation', (p, g) => {
      if (!isLine(g)) return;
      if (p.class === 'rail' || p.class === 'transit') {
        pushClipped(L.rail, g, { kind: p.subclass || p.class }, box);
        const mode = TRANSIT_MODE[p.subclass];
        if (mode && !p.service) pushClipped(L.transit, g, { mode }, box);
      } else if (ROAD_CLASS[p.class]) {
        pushClipped(L.roads, g, { class: ROAD_CLASS[p.class] }, box);
      }
    });
    each('transportation_name', (p, g) => {
      if (isLine(g) && p.name && ROAD_CLASS[p.class]) pushClipped(L.roadLabels, g, { class: ROAD_CLASS[p.class], name: p.name }, box);
    });
    each('poi', (p, g) => {
      if (g.type !== 'Point' || !inBox(g.coordinates)) return;
      if (p.class === 'park' && p.name) L.parkLabels.push({ type: 'Feature', properties: { name: p.name }, geometry: g });
      const use = SHOP_CLASSES.has(p.class) ? 'retail' : USE_BY_POI[p.subclass] || USE_BY_POI[p.class];
      if (use) pois.push({ pt: g.coordinates, use });
    });
    onStatus(`Loading vector tiles ${++done} / ${tiles.length}…`);
  }));

  onStatus('Classifying buildings…');
  await new Promise((r) => setTimeout(r, 0)); // let the status paint
  classifyBuildings(L.buildings, pois, landuse);
  return L;
}

// --- Building use and height -----------------------------------------------
// A building takes the use of the first POI inside it, else of the land-use area its centre falls in.
function classifyBuildings(buildings, pois, landuse) {
  const landuseBoxes = landuse.map((f) => ({ f, bb: turf.bbox(f) }));
  const useFromLanduse = (pt) => {
    for (const { f, bb } of landuseBoxes) {
      if (pt[0] >= bb[0] && pt[0] <= bb[2] && pt[1] >= bb[1] && pt[1] <= bb[3] && turf.booleanPointInPolygon(pt, f)) return f.properties.use;
    }
    return null;
  };

  const cell = 0.0005;
  const grid = new Map();
  for (const p of pois) {
    const k = `${Math.floor(p.pt[0] / cell)},${Math.floor(p.pt[1] / cell)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(p);
  }

  for (const f of buildings) {
    let use = null;
    const [w, s, e, n] = turf.bbox(f);
    search: for (let x = Math.floor(w / cell); x <= Math.floor(e / cell); x++) {
      for (let y = Math.floor(s / cell); y <= Math.floor(n / cell); y++) {
        for (const p of grid.get(`${x},${y}`) || []) {
          if (turf.booleanPointInPolygon(p.pt, f)) {
            use = p.use;
            break search;
          }
        }
      }
    }
    use ||= useFromLanduse(turf.centroid(f).geometry.coordinates);
    f.properties = { use: use || 'other', h: f.properties.h > 0 ? f.properties.h : 10 };
  }
}

// --- Other services --------------------------------------------------------
export async function fetchIsochrones(lon, lat, minutes = [5, 10, 15]) {
  const q = { locations: [{ lat, lon }], costing: 'pedestrian', contours: minutes.map((time) => ({ time })), polygons: true };
  const res = await fetch('https://valhalla1.openstreetmap.de/isochrone?json=' + encodeURIComponent(JSON.stringify(q)));
  if (!res.ok) throw new Error(`Valhalla ${res.status}`);
  const fc = await res.json();
  fc.features.forEach((f) => (f.properties = { minutes: f.properties.contour }));
  return fc;
}

export async function searchPlaces(query) {
  const res = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=6`);
  if (!res.ok) throw new Error(`Search ${res.status}`);
  const json = await res.json();
  return json.features.map((f) => {
    const p = f.properties;
    const parts = [p.name, p.street && p.housenumber ? `${p.street} ${p.housenumber}` : p.street, p.city, p.state, p.country];
    return { label: [...new Set(parts.filter(Boolean))].join(', '), lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] };
  });
}

// Massing footprint rectangle, same convention as the 3D view (rotation clockwise from north).
export function siteFootprint({ lon, lat, w, d, rot }) {
  const a = (rot * Math.PI) / 180;
  const mLon = 111320 * Math.cos((lat * Math.PI) / 180);
  const ring = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([x, y]) => [
    lon + (x * Math.cos(a) + y * Math.sin(a)) / mLon,
    lat + (-x * Math.sin(a) + y * Math.cos(a)) / 111320,
  ]);
  ring.push(ring[0]);
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}
