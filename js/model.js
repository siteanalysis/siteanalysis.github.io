// Design model import for the 3D view. Reads SketchUp/Rhino/etc. exports with three.js
// loaders, normalises units and up axis, rebases the model so its footprint centre sits at
// the origin, and hands Cesium a binary glTF. Loaded on demand so the page stays light.

import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

const RHINO3DM = 'https://cdn.jsdelivr.net/npm/rhino3dm@8.32.1/';

export const UNITS = { mm: 0.001, cm: 0.01, m: 1, in: 0.0254, ft: 0.3048 };

// Rhino UnitSystem enum → our unit keys.
const RHINO_UNITS = { 1: 'mm', 2: 'mm', 3: 'cm', 4: 'm', 8: 'in', 9: 'ft' };

// Which loader handles each extension, and the up axis the raw loader output uses.
// Loaders that normalise to Y-up themselves (glTF, Collada, FBX) are marked 'y'.
const FORMATS = {
  glb: { up: 'y', load: loadGltf },
  gltf: { up: 'y', load: loadGltf },
  dae: { up: 'y', load: loadCollada },
  fbx: { up: 'y', load: loadFbx },
  obj: { up: 'y', load: loadObj },
  '3dm': { up: 'z', load: load3dm },
  stl: { up: 'z', load: loadStl },
  '3ds': { up: 'z', load: load3ds },
  ply: { up: 'z', load: loadPly },
};

const ext = (name) => name.split('.').pop().toLowerCase();

/**
 * Read the dropped/selected files. Companion files (.bin, textures, .mtl) are resolved by
 * name. Returns the raw three.js object plus best-guess units and up axis.
 */
export async function readModel(files) {
  files = [...files];
  const main = files.find((f) => FORMATS[ext(f.name)]);
  if (!main) {
    if (files.some((f) => ext(f.name) === 'skp')) {
      throw new Error('SketchUp .skp files can\'t be read in the browser. In SketchUp use File → Export → 3D Model and pick COLLADA (.dae), glTF, OBJ or FBX.');
    }
    throw new Error('Unsupported file. Use .glb, .gltf, .dae, .fbx, .obj, .3dm, .stl, .3ds or .ply.');
  }

  const urls = new Map(files.map((f) => [f.name.toLowerCase(), URL.createObjectURL(f)]));
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('http')) return url;
    const name = decodeURIComponent(url.split(/[\\/]/).pop()).toLowerCase();
    return urls.get(name) || url;
  });

  const kind = ext(main.name);
  try {
    const { object, units } = await FORMATS[kind].load(main, { manager, urls, files });
    stripNonMeshes(object);
    let meshes = 0;
    object.traverse((o) => { if (o.isMesh) meshes++; });
    if (!meshes) {
      throw new Error(kind === '3dm'
        ? 'No meshes found. Save the file from Rhino in a shaded view so render meshes are stored, or export as OBJ or glTF.'
        : 'No mesh geometry found in this file.');
    }
    return { object, name: main.name, up: FORMATS[kind].up, units: units || guessUnits(object) };
  } finally {
    // Textures are already decoded by now.
    setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 1000);
  }
}

/**
 * Bake units and up axis, rebase so the base centre of the bounding box is the origin,
 * and export as binary glTF. Returns the GLB bytes and the model size in metres.
 */
export async function buildGlb(object, { units, up }) {
  const root = new THREE.Group();
  const inner = new THREE.Group();
  inner.add(object);
  inner.scale.setScalar(UNITS[units]);
  if (up === 'z') inner.rotation.x = -Math.PI / 2; // Z-up source → glTF Y-up
  root.add(inner);
  root.updateMatrixWorld(true);
  // CAD exports often have reversed faces (SketchUp back faces); don't let Cesium cull them.
  object.traverse((o) => {
    if (o.isMesh) [].concat(o.material).forEach((m) => { m.side = THREE.DoubleSide; });
  });

  const box = new THREE.Box3().setFromObject(inner);
  const size = box.getSize(new THREE.Vector3());
  inner.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  root.updateMatrixWorld(true);

  const glb = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: true });
  inner.remove(object); // keep the source object reusable for the next rebuild
  // glTF Y-up: x → east, y → up, z → south once Cesium places it.
  return { glb, size: { w: size.x, d: size.z, h: size.y } };
}

// --- Loaders -----------------------------------------------------------------
async function loadGltf(file, { manager }) {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const gltf = await new GLTFLoader(manager).parseAsync(await file.arrayBuffer(), '');
  return { object: gltf.scene, units: 'm' };
}

async function loadCollada(file, { manager }) {
  const { ColladaLoader } = await import('three/addons/loaders/ColladaLoader.js');
  const dae = new ColladaLoader(manager).parse(await file.text(), '');
  return { object: dae.scene, units: 'm' }; // loader applies <unit> and <up_axis>
}

async function loadFbx(file, { manager }) {
  const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
  const object = new FBXLoader(manager).parse(await file.arrayBuffer(), '');
  const cmPerUnit = object.userData.unitScaleFactor;
  const units = { 0.1: 'mm', 1: 'cm', 100: 'm', 2.54: 'in', 30.48: 'ft' }[cmPerUnit];
  return { object, units };
}

async function loadObj(file, { manager, urls }) {
  const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
  const text = await file.text();
  const loader = new OBJLoader(manager);
  const mtlName = text.match(/^mtllib\s+(.+)$/m)?.[1].trim().split(/[\\/]/).pop().toLowerCase();
  if (mtlName && urls.has(mtlName)) {
    const { MTLLoader } = await import('three/addons/loaders/MTLLoader.js');
    const materials = await new MTLLoader(manager).loadAsync(urls.get(mtlName));
    materials.preload();
    loader.setMaterials(materials);
  }
  return { object: loader.parse(text) };
}

async function load3dm(file) {
  const { Rhino3dmLoader } = await import('three/addons/loaders/3DMLoader.js');
  const loader = new Rhino3dmLoader();
  loader.setLibraryPath(RHINO3DM);
  const object = await loader.parseAsync(await file.arrayBuffer());
  loader.dispose();
  const unit = object.userData.settings?.modelUnitSystem;
  return { object, units: RHINO_UNITS[unit?.value ?? unit] };
}

async function loadStl(file) {
  const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
  const geometry = new STLLoader().parse(await file.arrayBuffer());
  return { object: new THREE.Mesh(geometry, defaultMaterial()) };
}

async function load3ds(file, { manager }) {
  const { TDSLoader } = await import('three/addons/loaders/TDSLoader.js');
  return { object: new TDSLoader(manager).parse(await file.arrayBuffer(), '') };
}

async function loadPly(file) {
  const { PLYLoader } = await import('three/addons/loaders/PLYLoader.js');
  const geometry = new PLYLoader().parse(await file.arrayBuffer());
  geometry.computeVertexNormals();
  return { object: new THREE.Mesh(geometry, defaultMaterial()) };
}

// --- Helpers -----------------------------------------------------------------
const defaultMaterial = () => new THREE.MeshStandardMaterial({ color: 0xe9e5dd, roughness: 0.9 });

// Curves, points and lights clutter the massing and some don't survive glTF export.
function stripNonMeshes(object) {
  const drop = [];
  object.traverse((o) => { if (o.isLine || o.isPoints || o.isLight || o.isCamera || o.isSprite) drop.push(o); });
  drop.forEach((o) => o.parent?.remove(o));
}

// Files without unit metadata: a building over 2 km in any direction was probably modelled in mm.
function guessUnits(object) {
  const size = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
  const max = Math.max(size.x, size.y, size.z);
  if (max > 20000) return 'mm';
  if (max > 2000) return 'cm';
  return 'm';
}
