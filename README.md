# Site Analysis

Browser-based site analysis tools for architecture and urban design students.
No install, no account: open the page, search a place, and start working.

**Live:** https://siteanalysis.github.io

## Tools

- **3D view** (`index.html`) — Cesium globe with terrain and OSM buildings. Place a massing
  volume on the site, set a date and time, and read sun altitude, azimuth, sunrise and sunset
  for shadow studies.
- **Diagrams** (`diagrams.html`) — A3 diagram sheets from OpenStreetMap data: Schwarzplan,
  2.5D buildings, building classification, road network, transport network, parks and
  pedestrian accessibility. Draw SWOT annotations (barriers, noise, green links, opportunities)
  on top, then export as SVG or 300 dpi PNG.

## Stack

Plain HTML, CSS and ES modules, no build step.
[CesiumJS](https://cesium.com/platform/cesiumjs/), [MapLibre GL](https://maplibre.org/),
[Turf.js](https://turfjs.org/), [D3](https://d3js.org/), [Terra Draw](https://terradraw.io/),
[SunCalc](https://github.com/mourner/suncalc). Map data from
[OpenFreeMap](https://openfreemap.org/) vector tiles (OpenStreetMap contributors) and Esri World Imagery.

## Run locally

Serve the folder with any static server, for example:

```sh
python3 -m http.server 8000
```

then open http://localhost:8000. The committed `config.js` holds a Cesium ion token restricted
to the live site. For local work, replace it with your own token from
https://ion.cesium.com/tokens (see `config.example.js`).

## Author

Built by [Constantine Malynin](https://github.com/ConstantineMalynin).
