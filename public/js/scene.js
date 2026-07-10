// scene.js — three.js world: classroom, seat-rotated tile layout, avatars,
// visible draw wall, flowers, look-around camera, raycast, lerp animation.
import * as THREE from "three";
import { makeTileMesh, TILE_H } from "./tiles.js";
import * as main from "./main.js";

// ---- Layout constants (in a seat's LOCAL frame; +Z points outward toward that player) ----
// Clean concentric radial bands from the table centre outward so no group
// intersects another, even with the pinwheel wall tilt:
//   [centre pad] → discard grid → draw-wall square → melds/flowers → hands.
const HAND_Z = 11.2;             // your face-up hand row (at the near edge)
const OPP_HAND_Z = 11.0;         // opponents' face-down hand rows
const HAND_STEP = 0.96;
const DRAW_GAP = 0.7;
const STAND_Y = TILE_H / 2;      // standing tile center height
const FLAT_Y = 0.33;             // flat tile center height
const DISCARD_Z0 = 3.4;          // outermost discard row (nearest the wall); grid grows inward
const DISCARD_ROW = 1.26;        // row pitch ≥ flat-tile depth (TILE_H) so rows never overlap
const DISCARD_STEP = 0.92;       // column pitch ≥ flat-tile width so columns never overlap
const DISCARD_COLS = 6;          // tiles per discard row before wrapping to the next row
const WALL_Z = 6.4;              // face-down draw-wall band (row centre distance)
const WALL_STEP = 0.9;           // spacing between wall stacks
const WALL_LIFT = 0.66;          // vertical gap between the two stacked tiles
const WALL_PINWHEEL = (18 * Math.PI) / 180;  // each side's wall tilted → pinwheel (~20°)
// Exposed flowers lie FLAT on the felt in a small face-up row just INBOARD of
// each seat's hand (a short row "above" the hand, toward the table centre), so
// they sit beside that player's own tiles — clear of the wall, discards, melds
// and hands. Centred (never marching into a neighbour's wall) and wrapping into
// extra rows toward the centre if a seat collects many (handles 0..8).
// z 9.7 keeps the row's far edge (9.7 + TILE_H/2 = 10.3) below the flat melds
// (which reach ~10.5) and well above the draw wall (6.4).
const FLOWER_Z0 = 9.7;           // first flower row, just inboard of the hand
const FLOWER_ROW = 0.82;         // pitch between wrapped flower rows (grows toward the centre)
const FLOWER_STEP = 0.8;         // column pitch inside a flower row
const FLOWER_COLS = 5;           // flowers per row before wrapping to a new row
const MELD_STEP = 0.9;           // pitch between tiles inside a meld
const MELD_GAP = 0.34;           // gap between adjacent melds in the seat's row
const MELD_HAND_GAP = 0.5;       // gap between the exposed meld group and the concealed hand
const ROW_MAX_W = 14.4;          // max width of a seat's meld+hand row before it compresses
const DEAD_WALL_DEFAULT = 4;     // constant back-of-deck stack size (2-high stacks)
const SEAT_Z = 16.2;             // chair anchor, just beyond the table rim (felt half = 14)
const SEAT_PAN_Y = -2.8;         // chair seat-pan top height (table felt is y = 0)

const LERP = 0.18;

// Distinct, cheerful shirt colors per seat (brighter, more varied).
const SEAT_SHIRTS = [0xff7a4d, 0x3fa9f5, 0x5fd08a, 0xffca3a];
// Matching hair tints so the four avatars read as different, friendly people.
const SEAT_HAIR = [0x3a2418, 0x2a2a3a, 0x4a2f1c, 0x38221a];

let renderer, scene, camera, container;
let raycaster, pointer;
let tableGroup;
let running = false;
let visible = false;
let startT = 0;

let currentState = null;
let hovered = null;       // mesh currently hovered (your hand)
let interactable = false; // true only on your discard turn

// Managed tile meshes keyed by string.
const meshes = new Map();  // key -> mesh
const seen = new Set();    // keys present this reconcile pass

// Opponent avatar rigs, indexed by display position (1,2,3). dp 0 = you = none.
const avatars = [null, null, null, null];
let turnLight = null;      // single roaming spotlight for the active opponent
let claimRing = null;      // pulsing ring under the claimable discard
let claimLight = null;     // warm up-light on the claimable discard
// World position of the claimable discard tile this reconcile pass (null = none).
const claimPos = new THREE.Vector3();
let claimActive = false;

// Precomputed local orientations.
const Q_STAND_YOU = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 6, 0, 0));
const Q_STAND_OPP = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0));
const Q_FLAT = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));      // face up
const Q_FLAT_DOWN = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));  // face down (wall)
// Wall tiles: face-down flat, yawed by the pinwheel angle so each side tilts.
const Q_WALL = new THREE.Quaternion()
  .setFromAxisAngle(new THREE.Vector3(0, 1, 0), WALL_PINWHEEL)
  .multiply(Q_FLAT_DOWN);

// ================= mouse-follow camera state =================
// The camera is planted at your chair; the view gently eases toward the mouse
// position over the canvas (no drag-orbit). Cursor toward an edge leans the
// view that way; leaving the canvas eases back to center.
const CAM_TARGET = new THREE.Vector3(0, 0, 3.4);
let camBase = { dist: 20, yaw: 0, pitch: 0.7 };
let camZoom = 1;                              // clamped wheel zoom
const LOOK_YAW = (10 * Math.PI) / 180;        // max yaw lean (±) — subtle
const LOOK_PITCH = (5 * Math.PI) / 180;       // max pitch lean (±) — subtle
const LOOK_DEAD = 0.28;   // centre deadzone: cursor near middle => no movement
// Cursor in the bottom band (hand row + claim buttons) must NOT drive the
// camera, so reaching for a tile never pushes it off-screen. NDC y below this
// (roughly the lower ~30% of the canvas) freezes the head-turn.
const BOTTOM_BAND = -0.4;
let claimFreeze = false;  // true whenever the local player has claim options open
const PITCH_MIN = 0.12;   // ~7° above horizon (clamp)
const PITCH_MAX = 1.46;   // ~84° (near top-down)
const LOOK_EASE = 0.03;   // slow, heavy smoothing — lazy drift, not a head-swivel

let lookTargetYaw = 0, lookTargetPitch = 0;   // driven by pointer position
let lookYaw = 0, lookPitch = 0;               // eased current offsets

// Map a normalized cursor axis (-1..1) through a centre deadzone to a lean
// amount (-1..1): flat near the middle, ramping smoothly toward the edges.
function deadzone(v) {
  const a = Math.abs(v);
  if (a <= LOOK_DEAD) return 0;
  return Math.sign(v) * (a - LOOK_DEAD) / (1 - LOOK_DEAD);
}

// ================= init =================
export function init(mountEl) {
  container = mountEl;
  startT = performance.now();

  scene = new THREE.Scene();
  // Bright, warm classroom air (soft cream-periwinkle), fog pushed back so the
  // whole cheerful room stays visible.
  scene.background = new THREE.Color(0x3b4a63);
  scene.fog = new THREE.Fog(0x3b4a63, 55, 105);

  camera = new THREE.PerspectiveCamera(45, aspect(), 0.1, 200);
  applyCameraFraming();

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  if ("outputColorSpace" in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  buildEnvironment();
  buildClassroom();
  buildAvatars();

  raycaster = new THREE.Raycaster();
  pointer = new THREE.Vector2();

  const el = renderer.domElement;
  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointerup", onPointerUp);
  el.addEventListener("pointerleave", onPointerLeave);
  el.addEventListener("dblclick", resetCamera);
  el.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", onResize);

  running = true;
  el.style.display = "none";
  animate();
}

function aspect() {
  const w = (container && container.clientWidth) || window.innerWidth;
  const h = (container && container.clientHeight) || window.innerHeight;
  return w / h;
}

// Choose a base framing (position + fov) for the current viewport, then derive
// the orbit spherical coords the look-around camera rotates from.
function applyCameraFraming() {
  const a = aspect();
  let bx, by, bz;
  // Lowered + slightly closer POV so your own hand is easy to read, while the
  // far players' tiles/discards stay in frame.
  if (a < 0.85) { camera.fov = 61; bx = 0; by = 16.0; bz = 20.5; }
  else if (a < 1.25) { camera.fov = 53; bx = 0; by = 14.8; bz = 19.4; }
  else { camera.fov = 47; bx = 0; by = 13.6; bz = 18.2; }
  camera.updateProjectionMatrix();

  const off = new THREE.Vector3(bx, by, bz).sub(CAM_TARGET);
  camBase.dist = off.length();
  camBase.pitch = Math.asin(off.y / camBase.dist);
  camBase.yaw = Math.atan2(off.x, off.z);
  updateCameraPose();
}

function updateCameraPose() {
  const yaw = camBase.yaw + lookYaw;
  const pitch = THREE.MathUtils.clamp(camBase.pitch + lookPitch, PITCH_MIN, PITCH_MAX);
  const dist = camBase.dist * camZoom;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  camera.position.set(
    CAM_TARGET.x + dist * cp * Math.sin(yaw),
    CAM_TARGET.y + dist * sp,
    CAM_TARGET.z + dist * cp * Math.cos(yaw)
  );
  camera.lookAt(CAM_TARGET);
}

// Ease the current look offsets toward the pointer-driven target every frame.
function updateCameraFollow() {
  // While a claim window is open, hold the view dead-center so the claimable
  // tile and the HUD buttons never drift out from under the cursor.
  if (claimFreeze) { lookTargetYaw = 0; lookTargetPitch = 0; }
  lookYaw += (lookTargetYaw - lookYaw) * LOOK_EASE;
  lookPitch += (lookTargetPitch - lookPitch) * LOOK_EASE;
  updateCameraPose();
}

function resetCamera() {
  lookTargetYaw = 0; lookTargetPitch = 0; camZoom = 1;
  updateCameraPose();
}

// ================= environment: table + lights =================
function buildEnvironment() {
  tableGroup = new THREE.Group();
  scene.add(tableGroup);

  // Felt table top (round-cornered square).
  const feltShape = roundedRectShape(28, 28, 3.4);
  const feltGeo = new THREE.ShapeGeometry(feltShape);
  const feltMat = new THREE.MeshStandardMaterial({ color: 0x1f7a4e, roughness: 0.95, metalness: 0.0 });
  const felt = new THREE.Mesh(feltGeo, feltMat);
  felt.rotation.x = -Math.PI / 2;
  felt.position.y = 0.02;
  felt.receiveShadow = true;
  tableGroup.add(felt);

  // Wood rim (a slightly larger rounded slab beneath the felt).
  const rimShape = roundedRectShape(31.5, 31.5, 3.8);
  const rimGeo = new THREE.ExtrudeGeometry(rimShape, { depth: 1.4, bevelEnabled: true, bevelThickness: 0.28, bevelSize: 0.28, bevelSegments: 2 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.6, metalness: 0.05 });
  const rim = new THREE.Mesh(rimGeo, rimMat);
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = -1.4;
  rim.receiveShadow = true;
  rim.castShadow = true;
  tableGroup.add(rim);

  // Table legs.
  const legMat = new THREE.MeshStandardMaterial({ color: 0x3f2a18, roughness: 0.7 });
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(1.1, 8, 1.1), legMat);
    leg.position.set(sx * 12, -5.4, sz * 12);
    leg.castShadow = true;
    tableGroup.add(leg);
  }

  // Center pad accent.
  const padGeo = new THREE.CircleGeometry(3.0, 48);
  const padMat = new THREE.MeshStandardMaterial({ color: 0x186640, roughness: 0.9 });
  const pad = new THREE.Mesh(padGeo, padMat);
  pad.rotation.x = -Math.PI / 2;
  pad.position.y = 0.03;
  pad.receiveShadow = true;
  tableGroup.add(pad);

  // Lighting: brighter, warmer daylight for a happy classroom. Lifted ambient +
  // warm hemisphere + strong warm key (shadows over the table only) + soft fill.
  const ambient = new THREE.AmbientLight(0xfff1dc, 0.92);
  scene.add(ambient);
  const hemi = new THREE.HemisphereLight(0xfff6e2, 0x6a6250, 0.72);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xffe9c4, 1.12);
  key.position.set(6, 22, 10);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 70;
  key.shadow.camera.left = -20;
  key.shadow.camera.right = 20;
  key.shadow.camera.top = 20;
  key.shadow.camera.bottom = -20;
  key.shadow.bias = -0.0004;
  key.shadow.radius = 3;   // softer, friendlier shadow edges
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xcfe4ff, 0.45);
  fill.position.set(-12, 10, -8);
  scene.add(fill);

  // Roaming spotlight that highlights the opponent whose turn it is.
  turnLight = new THREE.PointLight(0x9effc9, 0.0, 14, 2);
  turnLight.position.set(0, 6, 0);
  scene.add(turnLight);

  // Claim marker: a bright pulsing ring that sits under the just-discarded tile
  // the local player can pon/chi/ron. Positioned + pulsed each frame in animate.
  claimRing = new THREE.Mesh(
    new THREE.RingGeometry(0.62, 0.92, 40),
    new THREE.MeshBasicMaterial({ color: 0xffd23a, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false })
  );
  claimRing.rotation.x = -Math.PI / 2;
  claimRing.position.y = 0.06;
  claimRing.renderOrder = 5;
  claimRing.visible = false;
  scene.add(claimRing);
  // A soft warm up-light that makes the claimable tile pop off the felt.
  claimLight = new THREE.PointLight(0xffd23a, 0.0, 9, 2);
  claimLight.visible = false;
  scene.add(claimLight);
}

function roundedRectShape(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

// ================= environment: classroom =================
const ROOM = 46;          // room half-extent (x,z from center)
const ROOM_H = 20;        // wall height
const FLOOR_Y = -9.4;     // floor sits under the table legs

function buildClassroom() {
  const room = new THREE.Group();
  scene.add(room);

  // Floor — warm honey linoleum, cheap plane.
  const floorMat = new THREE.MeshStandardMaterial({ color: 0xbb9160, roughness: 0.9 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM * 2, ROOM * 2), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = FLOOR_Y;
  floor.receiveShadow = true;
  room.add(floor);

  // Faint floor grid (tile seams) via a second, emissive-free line-ish overlay.
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(40, 40),
    new THREE.MeshStandardMaterial({ color: 0x3f5a49, roughness: 0.95 }));
  rug.rotation.x = -Math.PI / 2;
  rug.position.y = FLOOR_Y + 0.02;
  rug.receiveShadow = true;
  room.add(rug);

  // Walls — cheerful warm butter-cream upper, wood wainscot lower.
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xfbe7bd, roughness: 1.0, side: THREE.FrontSide });
  const wainMat = new THREE.MeshStandardMaterial({ color: 0x7a5636, roughness: 0.8 });
  const ceilY = FLOOR_Y + ROOM_H;
  // Each wall: front-facing plane toward the room center.
  const wallDefs = [
    { pos: [0, 0, -ROOM], rot: 0 },            // north (far)
    { pos: [0, 0, ROOM], rot: Math.PI },       // south (behind you)
    { pos: [-ROOM, 0, 0], rot: Math.PI / 2 },  // west
    { pos: [ROOM, 0, 0], rot: -Math.PI / 2 },  // east
  ];
  for (const d of wallDefs) {
    const g = new THREE.Group();
    g.position.set(d.pos[0], 0, d.pos[2]);
    g.rotation.y = d.rot;
    const upper = new THREE.Mesh(new THREE.PlaneGeometry(ROOM * 2, ROOM_H), wallMat);
    upper.position.y = FLOOR_Y + ROOM_H / 2;
    upper.receiveShadow = true;
    g.add(upper);
    const wain = new THREE.Mesh(new THREE.PlaneGeometry(ROOM * 2, 3.2), wainMat);
    wain.position.y = FLOOR_Y + 1.6;
    wain.position.z = 0.06;   // pull off the wall plane to avoid z-fighting
    g.add(wain);
    room.add(g);
  }

  // Ceiling.
  const ceilMat = new THREE.MeshStandardMaterial({ color: 0xf0f2ee, roughness: 1.0, side: THREE.BackSide });
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(ROOM * 2, ROOM * 2), ceilMat);
  ceil.rotation.x = -Math.PI / 2;
  ceil.position.y = ceilY;
  room.add(ceil);

  // Fluorescent fixtures — emissive boxes (no real lights, keeps it cheap).
  const tubeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfdfbe6, emissiveIntensity: 0.9 });
  const housingMat = new THREE.MeshStandardMaterial({ color: 0xbfc4c8, roughness: 0.6 });
  for (const fx of [-14, 14]) {
    for (const fz of [-14, 14]) {
      const housing = new THREE.Mesh(new THREE.BoxGeometry(9, 0.5, 3), housingMat);
      housing.position.set(fx, ceilY - 0.4, fz);
      room.add(housing);
      const tube = new THREE.Mesh(new THREE.BoxGeometry(8.4, 0.24, 2.2), tubeMat);
      tube.position.set(fx, ceilY - 0.62, fz);
      room.add(tube);
    }
  }

  // Chalkboard on the far (north) wall with canvas scribbles.
  const board = new THREE.Mesh(new THREE.BoxGeometry(26, 9, 0.4),
    new THREE.MeshStandardMaterial({ map: makeChalkboardTexture(), roughness: 0.95 }));
  board.position.set(0, FLOOR_Y + 8.5, -ROOM + 0.3);
  room.add(board);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(27, 10, 0.3),
    new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 0.7 }));
  frame.position.set(0, FLOOR_Y + 8.5, -ROOM + 0.2);
  room.add(frame);

  // Colorful posters on the west wall.
  addPoster(room, makePosterTexture("HANDS", "PONG · CHOW · KONG", 0x2f7fd6), [-ROOM + 0.35, FLOOR_Y + 9, -10], Math.PI / 2, 6, 8);
  addPoster(room, makePosterTexture("四風", "東 南 西 北", 0xe0574d), [-ROOM + 0.35, FLOOR_Y + 8, 8], Math.PI / 2, 6, 7.4);
  // A cheerful rainbow poster on the east wall between the windows.
  addPoster(room, makeRainbowPosterTexture(), [ROOM - 0.35, FLOOR_Y + 8, 9], -Math.PI / 2, 6, 7.6);

  // Rainbow bunting strung across the far (north) wall above the chalkboard.
  addBunting(room, 0, FLOOR_Y + 14.2, -ROOM + 0.5, 30, 12);

  // Windows on the east wall with a soft daylight glow behind.
  for (const wz of [-12, 2, 16]) {
    addWindow(room, [ROOM - 0.3, FLOOR_Y + 10.5, wz], -Math.PI / 2);
  }

  // Door on the south wall.
  const doorGroup = new THREE.Group();
  doorGroup.position.set(20, FLOOR_Y, ROOM - 0.4);
  const door = new THREE.Mesh(new THREE.BoxGeometry(5, 11, 0.4),
    new THREE.MeshStandardMaterial({ color: 0x8a5a34, roughness: 0.7 }));
  door.position.y = 5.5;
  doorGroup.add(door);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.25, 12, 12),
    new THREE.MeshStandardMaterial({ color: 0xd8c46a, metalness: 0.6, roughness: 0.3 }));
  knob.position.set(1.8, 5, 0.3);
  doorGroup.add(knob);
  room.add(doorGroup);

  // A few school desks + chairs pushed toward the walls.
  const deskSpots = [
    [-30, -28, 0.2], [-30, -14, 0.2], [-30, 0, 0.2],
    [30, -28, -0.2], [30, -14, -0.2],
    [-18, -38, 0], [0, -38, 0], [18, -38, 0],
  ];
  for (const [dx, dz, ry] of deskSpots) addDeskChair(room, dx, dz, ry * Math.PI);
}

function addPoster(room, tex, pos, rotY, w, h) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
  m.position.set(pos[0], pos[1], pos[2]);
  m.rotation.y = rotY;
  room.add(m);
}

// A cheerful string of colored triangle flags (bunting) hung across a wall.
const BUNTING_COLORS = [0xff5d5d, 0xffa63a, 0xffd23a, 0x5fd08a, 0x3fa9f5, 0x9b7bff];
function addBunting(room, cx, cy, cz, width, count) {
  const g = new THREE.Group();
  g.position.set(cx, cy, cz);
  // String.
  const cord = new THREE.Mesh(new THREE.BoxGeometry(width, 0.08, 0.08),
    new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 0.8 }));
  g.add(cord);
  const step = width / (count - 1);
  const triShape = new THREE.Shape();
  triShape.moveTo(-0.85, 0); triShape.lineTo(0.85, 0); triShape.lineTo(0, -1.5); triShape.closePath();
  const triGeo = new THREE.ShapeGeometry(triShape);
  for (let i = 0; i < count; i++) {
    const flag = new THREE.Mesh(triGeo, new THREE.MeshStandardMaterial({
      color: BUNTING_COLORS[i % BUNTING_COLORS.length], roughness: 0.85, side: THREE.DoubleSide,
      emissive: BUNTING_COLORS[i % BUNTING_COLORS.length], emissiveIntensity: 0.12,
    }));
    // slight sag toward the middle for a friendly droop
    const x = -width / 2 + i * step;
    const sag = Math.cos((x / (width / 2)) * (Math.PI / 2)) * 0.6;
    flag.position.set(x, -0.1 - sag, 0.05);
    g.add(flag);
  }
  room.add(g);
}

function makeRainbowPosterTexture() {
  const c = document.createElement("canvas");
  c.width = 384; c.height = 512;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fffaf0";
  ctx.fillRect(0, 0, c.width, c.height);
  // rainbow arc
  const bands = ["#ff5d5d", "#ffa63a", "#ffd23a", "#5fd08a", "#3fa9f5", "#9b7bff"];
  ctx.lineWidth = 26;
  bands.forEach((col, i) => {
    ctx.strokeStyle = col;
    ctx.beginPath();
    ctx.arc(c.width / 2, 300, 150 - i * 27, Math.PI, 0);
    ctx.stroke();
  });
  // sun
  ctx.fillStyle = "#ffd23a";
  ctx.beginPath(); ctx.arc(300, 120, 34, 0, Math.PI * 2); ctx.fill();
  // cheer text
  ctx.fillStyle = "#3a2f28";
  ctx.textAlign = "center";
  ctx.font = "bold 46px 'Segoe UI', sans-serif";
  ctx.fillText("GOOD", c.width / 2, 400);
  ctx.fillText("LUCK!", c.width / 2, 452);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function addWindow(room, pos, rotY) {
  const g = new THREE.Group();
  g.position.set(pos[0], pos[1], pos[2]);
  g.rotation.y = rotY;
  // Glowing sky panel (emissive) — reads as daylight.
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(7, 9),
    new THREE.MeshStandardMaterial({ color: 0xcfe8ff, emissive: 0xbfe0ff, emissiveIntensity: 0.75 }));
  g.add(sky);
  // Frame + muntins.
  const fMat = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.7 });
  const top = new THREE.Mesh(new THREE.BoxGeometry(7.6, 0.5, 0.3), fMat); top.position.y = 4.6; g.add(top);
  const bot = top.clone(); bot.position.y = -4.6; g.add(bot);
  const lft = new THREE.Mesh(new THREE.BoxGeometry(0.5, 9.6, 0.3), fMat); lft.position.x = -3.6; g.add(lft);
  const rgt = lft.clone(); rgt.position.x = 3.6; g.add(rgt);
  const midV = new THREE.Mesh(new THREE.BoxGeometry(0.3, 9, 0.25), fMat); g.add(midV);
  const midH = new THREE.Mesh(new THREE.BoxGeometry(7, 0.3, 0.25), fMat); g.add(midH);
  room.add(g);
}

function addDeskChair(room, x, z, ry) {
  const g = new THREE.Group();
  g.position.set(x, FLOOR_Y, z);
  g.rotation.y = ry;
  const woodMat = new THREE.MeshStandardMaterial({ color: 0xb98a52, roughness: 0.8 });
  const metalMat = new THREE.MeshStandardMaterial({ color: 0x555b60, metalness: 0.5, roughness: 0.5 });
  // Desk top + legs.
  const top = new THREE.Mesh(new THREE.BoxGeometry(4, 0.3, 2.6), woodMat);
  top.position.y = 3.4; top.castShadow = true; g.add(top);
  for (const [lx, lz] of [[1.7, 1], [1.7, -1], [-1.7, 1], [-1.7, -1]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.22, 3.4, 0.22), metalMat);
    leg.position.set(lx, 1.7, lz); g.add(leg);
  }
  // Chair.
  const seat = new THREE.Mesh(new THREE.BoxGeometry(2, 0.25, 2), woodMat);
  seat.position.set(0, 2.1, 2.4); seat.castShadow = true; g.add(seat);
  const back = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 0.22), woodMat);
  back.position.set(0, 3.1, 3.3); g.add(back);
  for (const [lx, lz] of [[0.8, 1.6], [0.8, 3.2], [-0.8, 1.6], [-0.8, 3.2]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.18, 2.1, 0.18), metalMat);
    leg.position.set(lx, 1.05, lz); g.add(leg);
  }
  room.add(g);
}

// ---- canvas textures for classroom surfaces ----
function makeChalkboardTexture() {
  const c = document.createElement("canvas");
  c.width = 1024; c.height = 384;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#22402f";
  ctx.fillRect(0, 0, c.width, c.height);
  // subtle chalk smear
  ctx.fillStyle = "rgba(255,255,255,0.04)";
  for (let i = 0; i < 40; i++) {
    ctx.beginPath();
    ctx.ellipse(Math.random() * c.width, Math.random() * c.height, 60 + Math.random() * 120, 20 + Math.random() * 40, Math.random(), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = "rgba(240,245,235,0.9)";
  ctx.fillStyle = "rgba(240,245,235,0.92)";
  ctx.lineWidth = 3;
  ctx.font = "36px 'Comic Sans MS','Segoe Print',cursive";
  ctx.fillText("今日: 麻雀 Scoring Notes", 40, 60);
  ctx.font = "28px 'Comic Sans MS','Segoe Print',cursive";
  const lines = [
    "All Chows ....... 8 fan",
    "All Pungs ....... 6 fan",
    "Pure Straight ... 16 fan",
    "Seven Pairs ..... 24 fan",
    "Flower Tiles .... +1 each",
    "First to Mahjong wins!",
  ];
  lines.forEach((ln, i) => ctx.fillText(ln, 50, 120 + i * 42));
  // little chalk diagram of 3 tiles
  ctx.strokeRect(620, 150, 60, 90);
  ctx.strokeRect(700, 150, 60, 90);
  ctx.strokeRect(780, 150, 60, 90);
  ctx.font = "40px serif";
  ctx.fillText("三", 636, 210); ctx.fillText("四", 716, 210); ctx.fillText("五", 796, 210);

  // Playful colored-chalk doodles.
  // Big smiley face.
  ctx.strokeStyle = "#ffe14d"; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(920, 100, 44, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = "#ffe14d";
  ctx.beginPath(); ctx.arc(905, 88, 5, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(936, 88, 5, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(920, 104, 22, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  // Little stars.
  const star = (sx, sy, col) => {
    ctx.strokeStyle = col; ctx.lineWidth = 3;
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 4;
      ctx.beginPath();
      ctx.moveTo(sx - 10 * Math.cos(a), sy - 10 * Math.sin(a));
      ctx.lineTo(sx + 10 * Math.cos(a), sy + 10 * Math.sin(a));
      ctx.stroke();
    }
  };
  star(900, 250, "#8fd0ff"); star(970, 210, "#ff9ecb"); star(60, 320, "#a6f0c6");
  // Heart by the "First to Mahjong wins!" line.
  ctx.fillStyle = "#ff8fa3";
  ctx.beginPath();
  ctx.moveTo(360, 358);
  ctx.bezierCurveTo(360, 350, 348, 348, 348, 360);
  ctx.bezierCurveTo(348, 370, 360, 376, 360, 382);
  ctx.bezierCurveTo(360, 376, 372, 370, 372, 360);
  ctx.bezierCurveTo(372, 348, 360, 350, 360, 358);
  ctx.fill();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makePosterTexture(title, sub, accent) {
  const c = document.createElement("canvas");
  c.width = 384; c.height = 512;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#f4efe2";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = "#" + accent.toString(16).padStart(6, "0");
  ctx.fillRect(0, 0, c.width, 120);
  ctx.fillStyle = "#f9f6ee";
  ctx.textAlign = "center";
  ctx.font = "bold 70px 'Songti SC',serif";
  ctx.fillText(title, c.width / 2, 90);
  ctx.fillStyle = "#2a2a2a";
  ctx.font = "bold 34px 'Segoe UI',sans-serif";
  ctx.fillText(sub, c.width / 2, 200);
  // simple tile row art
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = "#efe8d2";
    ctx.strokeStyle = "#8a7a54";
    ctx.lineWidth = 4;
    const x = 70 + i * 90;
    ctx.fillRect(x, 300, 70, 100);
    ctx.strokeRect(x, 300, 70, 100);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ================= chairs + avatars =================
// Every seat gets a chair (including your own, dp 0). The three opponents
// (dp 1,2,3) also get a seated avatar body. All parts are built in the seat's
// LOCAL frame anchored at the chair (z = 0 seat centre, -z toward the table).
function buildAvatars() {
  // Chairs for all four seats.
  for (let dp = 0; dp <= 3; dp++) {
    const chair = makeChair();
    chair.position.copy(rotateLocal(dp, 0, 0, SEAT_Z));
    chair.quaternion.copy(seatQuat(dp));
    tableGroup.add(chair);
  }
  // Seated avatars for the three opponents only.
  for (let dp = 1; dp <= 3; dp++) {
    const rig = makeAvatarRig();
    rig.group.position.copy(rotateLocal(dp, 0, 0, SEAT_Z));
    rig.group.quaternion.copy(seatQuat(dp));
    rig.baseY = rig.group.position.y;
    rig.phase = dp * 1.7;
    rig.group.visible = false;
    tableGroup.add(rig.group);
    avatars[dp] = rig;
  }
}

// A simple classroom-style chair: wooden seat pan + back + four metal legs,
// facing the table (back rest on the +z / outward side).
function makeChair() {
  const g = new THREE.Group();
  const woodMat = new THREE.MeshStandardMaterial({ color: 0xb98a52, roughness: 0.8 });
  const metalMat = new THREE.MeshStandardMaterial({ color: 0x555b60, metalness: 0.5, roughness: 0.5 });

  const pan = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.3, 2.5), woodMat);
  pan.position.set(0, SEAT_PAN_Y, 0);
  pan.castShadow = true; pan.receiveShadow = true;
  g.add(pan);

  const back = new THREE.Mesh(new THREE.BoxGeometry(2.7, 3.0, 0.3), woodMat);
  back.position.set(0, SEAT_PAN_Y + 1.6, 1.2);
  back.castShadow = true;
  g.add(back);
  const backRail = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.4, 0.3), woodMat);
  backRail.position.set(0, SEAT_PAN_Y + 0.9, 1.2);
  g.add(backRail);

  const panBottom = SEAT_PAN_Y - 0.15;
  const legH = panBottom - FLOOR_Y;
  const legCY = (panBottom + FLOOR_Y) / 2;
  for (const [lx, lz] of [[1.15, 1.05], [1.15, -1.05], [-1.15, 1.05], [-1.15, -1.05]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.28, legH, 0.28), metalMat);
    leg.position.set(lx, legCY, lz);
    leg.castShadow = true;
    g.add(leg);
  }
  return g;
}

// A stylized low-poly humanoid genuinely SEATED on the chair: hips on the pan,
// lap/thighs forward, torso leaning toward the table with head well above the
// tabletop, arms reaching in toward the table edge. Nothing crosses y = 0 over
// the felt (the body sits outside the felt footprint at z ≈ SEAT_Z).
function makeAvatarRig() {
  const group = new THREE.Group();
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xe6b58c, roughness: 0.7 });
  const shirtMat = new THREE.MeshStandardMaterial({ color: 0x4a7fd0, roughness: 0.75, emissive: 0x000000, emissiveIntensity: 0 });
  const hairMat = new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.9 });

  const hipY = SEAT_PAN_Y + 0.55;   // hips resting on the pan

  // Lap / thighs — flat, extending forward from the hips toward the table.
  const lap = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.6, 2.1), shirtMat);
  lap.position.set(0, hipY, -1.05);
  lap.castShadow = true;
  group.add(lap);

  // Torso — tapered, tall enough that shoulders rise clearly above the table
  // top (y = 0); leans slightly forward toward the table.
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.25, 3.3, 12), shirtMat);
  torso.position.set(0, hipY + 1.7, -0.4);
  torso.rotation.x = -0.2;          // lean forward (top tips toward -z)
  torso.castShadow = true;
  group.add(torso);

  const shoulderY = hipY + 3.1;     // ≈ 0.85 (clearly above the tabletop y = 0)
  const shoulderZ = -0.95;

  // Neck + head above the shoulders.
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.36, 0.5, 10), skinMat);
  neck.position.set(0, shoulderY + 0.3, shoulderZ - 0.1);
  group.add(neck);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.72, 20, 16), skinMat);
  head.position.set(0, shoulderY + 1.0, shoulderZ - 0.15);
  head.castShadow = true;
  group.add(head);
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.78, 20, 16, 0, Math.PI * 2, 0, Math.PI * 0.62), hairMat);
  hair.position.set(0, shoulderY + 1.07, shoulderZ - 0.15);
  group.add(hair);

  // Friendly face: two dot eyes + a smile, on the front (-z, table-facing) side.
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.5 });
  const eyeGeo = new THREE.SphereGeometry(0.1, 10, 8);
  for (const ex of [-0.24, 0.24]) {
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.position.set(ex, 0.12, -0.66);
    head.add(eye);
  }
  // Rosy cheeks for a happy look.
  const cheekMat = new THREE.MeshStandardMaterial({ color: 0xff9a8a, roughness: 0.8, transparent: true, opacity: 0.6 });
  const cheekGeo = new THREE.SphereGeometry(0.11, 10, 8);
  for (const cx of [-0.36, 0.36]) {
    const cheek = new THREE.Mesh(cheekGeo, cheekMat);
    cheek.position.set(cx, -0.06, -0.6);
    cheek.scale.set(1, 0.7, 0.4);
    head.add(cheek);
  }
  // Smile: a half-torus arc curving upward at the ends.
  const smile = new THREE.Mesh(
    new THREE.TorusGeometry(0.24, 0.045, 8, 20, Math.PI),
    new THREE.MeshStandardMaterial({ color: 0x8a3b2e, roughness: 0.6 })
  );
  smile.rotation.z = Math.PI;        // flip so the arc opens upward (a smile)
  smile.position.set(0, -0.16, -0.64);
  head.add(smile);

  // Arms reaching forward and down toward the table edge; hands resting near
  // the felt surface (y ≈ 0.2) just inside the near edge.
  const armGeo = new THREE.CapsuleGeometry(0.27, 1.7, 4, 8);
  for (const sx of [-1, 1]) {
    const arm = new THREE.Mesh(armGeo, shirtMat);
    arm.position.set(sx * 0.95, shoulderY - 0.35, shoulderZ - 1.0);
    arm.rotation.x = Math.PI / 2.15;   // point forward-down toward the table
    arm.castShadow = true;
    group.add(arm);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.27, 10, 8), skinMat);
    hand.position.set(sx * 0.85, 0.2, shoulderZ - 1.95);
    group.add(hand);
  }

  // Name sprite floats above the head.
  const spriteHolder = new THREE.Object3D();
  spriteHolder.position.set(0, shoulderY + 2.4, shoulderZ - 0.15);
  group.add(spriteHolder);

  // Subtle turn-glow ring around the chair base (emissive, toggled on turn).
  const glow = new THREE.Mesh(new THREE.RingGeometry(1.5, 2.1, 24),
    new THREE.MeshBasicMaterial({ color: 0x9effc9, transparent: true, opacity: 0, side: THREE.DoubleSide }));
  glow.rotation.x = -Math.PI / 2;
  glow.position.set(0, SEAT_PAN_Y - 0.1, -0.2);
  group.add(glow);

  return { group, shirtMat, hairMat, spriteHolder, glow, sprite: null, spriteKey: "", isTurn: false, seat: -1 };
}

function updateAvatar(dp, player, state) {
  const rig = avatars[dp];
  if (!rig) return;
  rig.group.visible = true;
  rig.seat = player.seat;
  rig.isTurn = state.turn === player.seat && state.phase === "playing";

  // Shirt + hair color per seat (bright, varied, friendly).
  const col = SEAT_SHIRTS[player.seat % 4];
  if (rig.shirtMat.color.getHex() !== col) rig.shirtMat.color.setHex(col);
  const hc = SEAT_HAIR[player.seat % 4];
  if (rig.hairMat && rig.hairMat.color.getHex() !== hc) rig.hairMat.color.setHex(hc);

  // Name sprite (rebuild only when text/turn/connection changes).
  const label = (player.name || "—") + (player.isDealer ? " (E)" : "");
  const key = `${label}|${rig.isTurn}|${player.connected}`;
  if (rig.spriteKey !== key) {
    if (rig.sprite) {
      rig.spriteHolder.remove(rig.sprite);
      if (rig.sprite.material.map) rig.sprite.material.map.dispose();
      rig.sprite.material.dispose();
    }
    rig.sprite = makeNameSprite(label, rig.isTurn, player.connected !== false);
    rig.spriteHolder.add(rig.sprite);
    rig.spriteKey = key;
  }
}

// ================= visibility =================
export function setVisible(v) {
  visible = v;
  if (renderer) renderer.domElement.style.display = v ? "block" : "none";
  if (v) onResize();
}

// ================= seat helpers =================
function displayPos(seat, yourSeat) {
  return ((seat - yourSeat) + 4) % 4; // 0 bottom(you),1 right,2 top,3 left
}
function seatQuat(p) {
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p * Math.PI / 2);
}
function rotateLocal(p, lx, ly, lz) {
  const th = p * Math.PI / 2;
  const c = Math.cos(th), s = Math.sin(th);
  return new THREE.Vector3(lx * c + lz * s, ly, -lx * s + lz * c);
}

// ================= reconcile =================
export function update(state) {
  currentState = state;
  if (!state) return;

  const you = state.yourSeat;
  seen.clear();

  interactable = state.phase === "playing" && state.turn === you &&
    (state.turnPhase === "discard" || state.turnPhase === "draw");

  // Claim affordance: freeze the head-turn whenever YOU have any claim options,
  // and flag the specific just-discarded tile you can claim (pon/chi/ron) so the
  // 3D scene glows/lifts/rings it in agreement with the HUD buttons.
  const opts = state.claimOptions || [];
  claimFreeze = state.phase === "playing" && opts.length > 0;
  const canClaimDiscard = !!state.lastDiscard && !!state.lastDiscard.tile &&
    opts.some((o) => o === "pon" || o === "chi" || o === "ron" || o === "kong");
  const claimTileId = canClaimDiscard ? state.lastDiscard.tile.id : null;
  claimActive = false;

  // ---- Draw wall (pinwheel square of 2-high stacks + constant dead wall) ----
  placeWall(state.wallCount || 0, state.wallBackTaken || 0,
    state.deadWallCount ?? DEAD_WALL_DEFAULT);

  // ---- All players: hidden hands, discards, melds, flowers, avatars ----
  for (const p of state.players) {
    const dp = displayPos(p.seat, you);
    const isYou = p.seat === you;

    // Exposed melds + concealed hand form ONE left-anchored row at this seat's
    // near edge (melds on the left, hand to their right; single row, no wrap).
    placeSeatRow(dp, isYou, p.seat, p.melds || [],
      isYou ? (state.yourHand || []) : null, p.handCount || 0,
      isYou ? state.drawnTile : null);
    if (!isYou) updateAvatar(dp, p, state);

    // Discards: a wrapping grid (DISCARD_COLS per row) of face-up flat tiles in
    // this seat's central band. Rows grow inward (toward center) from the row
    // nearest the wall; row pitch ≥ tile depth so they never stack/overlap, and
    // the block stays clear of the tilted wall and the opposite seat's pile.
    const discards = p.discards || [];
    discards.forEach((t, i) => {
      const col = i % DISCARD_COLS;
      const row = Math.floor(i / DISCARD_COLS);
      const lx = (col - (DISCARD_COLS - 1) / 2) * DISCARD_STEP;
      const lz = DISCARD_Z0 - row * DISCARD_ROW;
      const isLast = state.lastDiscard && state.lastDiscard.seat === p.seat &&
        state.lastDiscard.tile && state.lastDiscard.tile.id === t.id;
      const isClaimable = isLast && claimTileId != null && t.id === claimTileId;
      if (isClaimable) {
        claimActive = true;
        claimPos.copy(rotateLocal(dp, lx, FLAT_Y, lz));
      }
      placeTile(`id:${t.id}`, t.kind, false, dp, lx, FLAT_Y, lz, Q_FLAT, { highlight: isLast, claimable: isClaimable });
    });

    // Flowers — face-up flat row laid on the felt just outboard of this seat's
    // hand, wrapping toward the table edge (absent on old servers → [] ).
    const flowers = p.flowers || [];
    flowers.forEach((t, i) => {
      const col = i % FLOWER_COLS;
      const row = Math.floor(i / FLOWER_COLS);
      // Tiles remaining in this (possibly short last) row, so it stays centered.
      const inThisRow = Math.min(FLOWER_COLS, flowers.length - row * FLOWER_COLS);
      const lx = (col - (inThisRow - 1) / 2) * FLOWER_STEP;
      const lz = FLOWER_Z0 - row * FLOWER_ROW;
      placeTile(`id:${t.id}`, t.kind, false, dp, lx, FLAT_Y, lz, Q_FLAT, { flower: true });
    });
  }

  // ---- Remove meshes no longer present ----
  for (const [key, mesh] of meshes) {
    if (!seen.has(key)) {
      tableGroup.remove(mesh);
      disposeMesh(mesh);
      meshes.delete(key);
    }
  }
}

// Lay a seat's exposed melds and concealed hand as ONE left-anchored single row
// at that seat's near edge: melds first (flat, face-up, growing left→right), then
// the concealed hand (standing) to their right, then the drawn tile (your seat).
// Because the hand shrinks by 3–4 tiles per exposed meld, total width stays
// roughly constant; if an extreme case (e.g. four kongs) would overrun, the whole
// row compresses instead of wrapping. A concealed kong shows its two ends face-up
// and its two middle tiles face-down; melded kongs and pon/chi show all faces up.
function placeSeatRow(dp, isYou, seat, melds, handTiles, handCount, drawn) {
  let meldTileCount = 0;
  for (const m of melds) meldTileCount += (m.tiles || []).length;
  const nMeld = melds.length;
  const nHand = isYou ? handTiles.length : handCount;

  const meldsW = meldTileCount * MELD_STEP + (nMeld > 1 ? (nMeld - 1) * MELD_GAP : 0);
  const handW = nHand * HAND_STEP;
  const midGap = (meldTileCount > 0 && (nHand > 0 || (isYou && drawn))) ? MELD_HAND_GAP : 0;
  const drawnW = (isYou && drawn) ? (DRAW_GAP + HAND_STEP) : 0;
  const totalW = meldsW + midGap + handW + drawnW;
  const sc = totalW > ROW_MAX_W ? ROW_MAX_W / totalW : 1;   // compress, never wrap

  const zRow = isYou ? HAND_Z : OPP_HAND_Z;
  const qStand = isYou ? Q_STAND_YOU : Q_STAND_OPP;
  const mStep = MELD_STEP * sc, hStep = HAND_STEP * sc;
  const mGap = MELD_GAP * sc, midG = midGap * sc, dGap = DRAW_GAP * sc;

  let x = -(totalW * sc) / 2;   // centered envelope; melds occupy the left of it

  // Melds — flat, face-up, left → right.
  for (const meld of melds) {
    const tiles = meld.tiles || [];
    if (!tiles.length) continue;
    const concealed = meld.type === "kong" && meld.concealed;
    tiles.forEach((t, ti) => {
      const lx = x + ti * mStep + mStep / 2;
      const down = concealed && (ti === 1 || ti === 2);
      placeTile(`id:${t.id}`, t.kind, down, dp, lx, FLAT_Y, zRow,
        down ? Q_FLAT_DOWN : Q_FLAT, { meld: true });
    });
    x += tiles.length * mStep + mGap;
  }
  if (nMeld > 0) x += midG - mGap;   // trade the trailing meld gap for the meld→hand gap

  // Concealed hand — standing; yours face-up & clickable, opponents' face-down.
  if (isYou) {
    for (const t of handTiles) {
      placeTile(`id:${t.id}`, t.kind, false, dp, x + hStep / 2, STAND_Y, zRow, qStand,
        { hand: true, tileId: t.id });
      x += hStep;
    }
    if (drawn) {
      placeTile(`id:${drawn.id}`, drawn.kind, false, dp, x + dGap + hStep / 2, STAND_Y, zRow,
        qStand, { hand: true, tileId: drawn.id, drawn: true });
    }
  } else {
    for (let i = 0; i < handCount; i++) {
      placeTile(`hand:${seat}:${i}`, null, true, dp, x + hStep / 2, STAND_Y, zRow, qStand, {});
      x += hStep;
    }
  }
}

// Render the wall as a pinwheel square of 2-high stacks with a TALLER dead-wall
// pile that marks the back of the deck. Behaviour:
//   • The live wall is a row of 2-high stacks (columns). Normal turn draws
//     deplete the FRONT (low column indices) — the wall shrinks from the front
//     corner as `count` drops.
//   • The dead wall is a single pile stacked `dead`-high (e.g. 4-high — clearly
//     taller than the 2-high wall) sitting FLUSH against the back end of the
//     live wall. Its height is how you read "this is the back of the deck".
//   • Replacement draws (`backTaken`) peel tiles off the TOP of that pile; once
//     a pair is consumed the pile walks one stack toward the FRONT (left along
//     the row) and the vacated back stack empties — so the tall back-marker
//     always stays flush against the remaining wall and never floats detached.
//
// The full physical wall (`wallCap`) is the running max of tiles ever present
// (live + dead + already-taken replacements) — established at the deal, then it
// only shrinks. Columns are dealt out equally across the four sides so no side
// is ever left short; empty front/back columns are simply not rendered.
let wallCap = 0;

function placeWall(count, backTaken, deadCount) {
  const live = Math.max(0, count | 0);
  const dead = Math.max(0, deadCount | 0);
  const taken = Math.max(0, backTaken | 0);
  // Running max of everything ever on the wall fixes the full physical length.
  const total = live + dead + taken;
  if (total > wallCap) wallCap = total;
  const cap = wallCap;
  if (cap <= 0) return;

  // Four equal sides of `stacksPerSide` columns (2 tiles per column at capacity,
  // 8 tiles per side). Columns are indexed 0..cols-1 around the square: low = the
  // FRONT corner (empties on normal draws), high = the BACK (dead-wall end).
  const stacksPerSide = Math.max(1, Math.ceil(cap / 8));
  const cols = stacksPerSide * 4;

  // The dead-wall pile: `dead`-high, walking one column toward the front for
  // every pair of replacement draws; a lone odd replacement peels one tile off
  // the current pile's top before the walk completes.
  const walk = Math.floor(taken / 2);        // columns the pile has advanced
  const peel = taken - walk * 2;             // 0 or 1 tile peeled off the top now
  const markerCol = Math.max(0, cols - 1 - walk);
  const markerH = Math.max(0, dead - peel);

  // Live wall: 2-high stacks packed against the FRONT side of the pile, so the
  // front-most stack goes partial/empty first as `count` falls.
  const liveCols = Math.ceil(live / 2);
  const liveFront = Math.max(0, markerCol - liveCols);   // first standing live column

  const spanX = (stacksPerSide - 1) * WALL_STEP;
  const cosP = Math.cos(WALL_PINWHEEL), sinP = Math.sin(WALL_PINWHEEL);

  // Place one vertical pile of `h` tiles at column `c` (keyed by column+height so
  // it reconciles idempotently each state).
  const placeStack = (c, h) => {
    if (h <= 0 || c < 0 || c >= cols) return;
    const side = Math.floor(c / stacksPerSide);          // 0..3 exactly
    const stack = c - side * stacksPerSide;
    const baseX = -spanX / 2 + stack * WALL_STEP;
    // Pinwheel tilt: rotate each side's row about its centre.
    const lx = baseX * cosP;
    const lz = WALL_Z - baseX * sinP;
    for (let i = 0; i < h; i++) {
      const ly = FLAT_Y + i * WALL_LIFT;
      placeTile(`wall:${c}:${i}`, null, true, side, lx, ly, lz, Q_WALL, { wall: true });
    }
  };

  // Live 2-high stacks; the front-most one is 1-high when `live` is odd (its top
  // has been drawn), matching front-first depletion.
  for (let c = liveFront; c < markerCol; c++) {
    const h = (c === liveFront && (live % 2) === 1) ? 1 : 2;
    placeStack(c, h);
  }
  // The tall dead-wall marker, flush against the back of the live wall.
  placeStack(markerCol, markerH);
}

// Create-or-update a tile mesh at a local (seat) position; targets lerped in animate().
function placeTile(key, kind, faceDown, dp, lx, ly, lz, qLocal, extra) {
  seen.add(key);
  let mesh = meshes.get(key);

  const wantKind = kind || null;
  if (mesh && mesh.userData.kind !== wantKind) {
    tableGroup.remove(mesh);
    disposeMesh(mesh);
    meshes.delete(key);
    mesh = null;
  }
  if (!mesh) {
    mesh = makeTileMesh(kind, { faceDown });
    const wp0 = rotateLocal(dp, lx, ly, lz);
    mesh.position.copy(wp0);
    mesh.quaternion.copy(seatQuat(dp).multiply(qLocal));
    tableGroup.add(mesh);
    meshes.set(key, mesh);
  }

  const wp = rotateLocal(dp, lx, ly, lz);
  const wq = seatQuat(dp).multiply(qLocal);
  mesh.userData.targetPos = wp;
  mesh.userData.targetQuat = wq;
  mesh.userData.baseY = wp.y;
  mesh.userData.tileId = extra && extra.tileId != null ? extra.tileId : (mesh.userData.tileId ?? null);
  mesh.userData.isHand = !!(extra && extra.hand);
  mesh.userData.kind = kind || null;
  mesh.userData.claimable = !!(extra && extra.claimable);

  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const faceMat = mats[4];
  if (faceMat && faceMat.emissive) {
    if (mesh.userData.claimable) {
      // Emissive/lift are pulsed each frame in animate(); set a warm gold base.
      faceMat.emissive.setHex(0xffb020);
      faceMat.emissiveIntensity = 0.7;
    } else if (extra && extra.highlight) {
      faceMat.emissive.setHex(0x2a5a3a);
      faceMat.emissiveIntensity = 0.6;
    } else {
      faceMat.emissive.setHex(0x000000);
    }
  }
}

function makeNameSprite(text, isTurn, connected) {
  const canvas = document.createElement("canvas");
  canvas.width = 256; canvas.height = 72;
  const ctx = canvas.getContext("2d");
  const r = 16;
  ctx.beginPath();
  ctx.moveTo(r, 4); ctx.lineTo(256 - r, 4);
  ctx.quadraticCurveTo(256, 4, 256, 4 + r);
  ctx.lineTo(256, 68 - r); ctx.quadraticCurveTo(256, 68, 256 - r, 68);
  ctx.lineTo(r, 68); ctx.quadraticCurveTo(0, 68, 0, 68 - r);
  ctx.lineTo(0, 4 + r); ctx.quadraticCurveTo(0, 4, r, 4);
  ctx.closePath();
  ctx.fillStyle = isTurn ? "rgba(31,191,117,0.94)" : "rgba(16,26,22,0.86)";
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = isTurn ? "#a8ffcf" : "rgba(120,200,160,0.4)";
  ctx.stroke();

  ctx.font = "bold 30px 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = isTurn ? "#04160d" : (connected ? "#eaf3ee" : "#8aa093");
  ctx.fillText(text, 128, 40);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(3.4, 0.96, 1);
  return sprite;
}

// ================= interaction =================
function localXY(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top, rect };
}

function onPointerMove(e) {
  if (!visible) return;
  const { x, y, rect } = localXY(e);
  // Normalized device coords for raycast hover.
  pointer.x = (x / rect.width) * 2 - 1;
  pointer.y = -(y / rect.height) * 2 + 1;
  // Mouse-follow camera: map cursor position (through a centre deadzone) to a
  // subtle look target. Cursor toward an edge lazily leans the view that way.
  // BUT freeze the head-turn while a claim window is open, or when the cursor is
  // in the bottom band (your hand row + claim buttons) — reaching down/right for
  // a tile must never push it off-screen. Only the upper playfield drifts.
  if (claimFreeze || pointer.y < BOTTOM_BAND) {
    lookTargetYaw = 0;
    lookTargetPitch = 0;
  } else {
    lookTargetYaw = -deadzone(pointer.x) * LOOK_YAW;
    lookTargetPitch = -deadzone(pointer.y) * LOOK_PITCH;
  }
}

function onPointerLeave() {
  // Ease the view back to the default framing when the pointer leaves the canvas.
  lookTargetYaw = 0;
  lookTargetPitch = 0;
  if (hovered) {
    hovered = null;
    if (renderer) renderer.domElement.style.cursor = "default";
  }
}

function onPointerDown(e) {
  if (!visible) return;
  // Keep the look target current for the frame of the click.
  const { x, y, rect } = localXY(e);
  pointer.x = (x / rect.width) * 2 - 1;
  pointer.y = -(y / rect.height) * 2 + 1;
}

function onPointerUp(e) {
  if (!visible) return;
  // Plain click (no drag mode anymore) = discard the hovered hand tile.
  if (interactable && hovered) {
    const tileId = hovered.userData.tileId;
    if (tileId != null) {
      main.discard(tileId);
      interactable = false; // debounce until next state
    }
  }
}

function onWheel(e) {
  if (!visible) return;
  e.preventDefault();
  camZoom = THREE.MathUtils.clamp(camZoom + (e.deltaY > 0 ? 0.08 : -0.08), 0.6, 1.5);
  updateCameraPose();
}

function onKeyDown(e) {
  if (e.key === "Escape" && visible) resetCamera();
}

function updateHover() {
  if (!visible) return;
  let newHover = null;
  if (interactable) {
    raycaster.setFromCamera(pointer, camera);
    const handMeshes = [];
    for (const m of meshes.values()) if (m.userData.isHand) handMeshes.push(m);
    const hits = raycaster.intersectObjects(handMeshes, false);
    if (hits.length) newHover = hits[0].object;
  }
  if (newHover !== hovered) {
    hovered = newHover;
    renderer.domElement.style.cursor = hovered ? "pointer" : "default";
  }
}

// ================= animation loop =================
function animate() {
  if (!running) return;
  requestAnimationFrame(animate);
  if (!visible) { renderer.render(scene, camera); return; }

  const t = (performance.now() - startT) / 1000;
  updateCameraFollow();
  updateHover();

  // Tiles: lerp toward targets (+ hover lift, + claimable lift/pulse).
  const claimPulse = 0.5 + 0.5 * Math.sin(t * 6);   // 0..1 shared claim pulse
  for (const mesh of meshes.values()) {
    const u = mesh.userData;
    if (u.targetPos) {
      let lift = mesh === hovered ? 0.5 : 0;
      if (u.claimable) {
        lift += 0.5 + 0.12 * claimPulse;              // rise off the felt + bob
        const fm = (Array.isArray(mesh.material) ? mesh.material : [mesh.material])[4];
        if (fm && fm.emissive) fm.emissiveIntensity = 0.55 + 0.55 * claimPulse;
      }
      const targetY = u.targetPos.y + lift;
      mesh.position.x += (u.targetPos.x - mesh.position.x) * LERP;
      mesh.position.y += (targetY - mesh.position.y) * LERP;
      mesh.position.z += (u.targetPos.z - mesh.position.z) * LERP;
    }
    if (u.targetQuat) mesh.quaternion.slerp(u.targetQuat, LERP);
  }

  // Claim marker: pulsing gold ring + warm up-light under the claimable discard.
  if (claimRing && claimLight) {
    if (claimActive) {
      claimRing.visible = true;
      claimLight.visible = true;
      claimRing.position.set(claimPos.x, 0.06, claimPos.z);
      const s = 1 + 0.18 * claimPulse;
      claimRing.scale.set(s, s, s);
      claimRing.material.opacity = 0.55 + 0.4 * claimPulse;
      claimLight.position.set(claimPos.x, 1.6, claimPos.z);
      claimLight.intensity = 1.1 + 0.7 * claimPulse;
    } else {
      claimRing.visible = false;
      claimLight.visible = false;
    }
  }

  // Avatars: idle breathing bob + turn glow. Roaming spotlight follows the active one.
  let litAvatar = null;
  for (let dp = 1; dp <= 3; dp++) {
    const rig = avatars[dp];
    if (!rig || !rig.group.visible) continue;
    const bob = Math.sin(t * 1.6 + rig.phase) * 0.06;
    rig.group.position.y = rig.baseY + bob;
    const pulse = rig.isTurn ? 0.28 + 0.18 * (0.5 + 0.5 * Math.sin(t * 4)) : 0;
    rig.shirtMat.emissive.setHex(rig.isTurn ? 0x1f8f4e : 0x000000);
    rig.shirtMat.emissiveIntensity = pulse;
    rig.glow.material.opacity = rig.isTurn ? 0.35 + 0.2 * Math.sin(t * 4) : 0;
    if (rig.isTurn) litAvatar = rig;
  }
  if (turnLight) {
    if (litAvatar) {
      turnLight.position.set(litAvatar.group.position.x, 7, litAvatar.group.position.z);
      turnLight.intensity = 0.9 + 0.3 * Math.sin(t * 4);
    } else {
      turnLight.intensity = 0;
    }
  }

  renderer.render(scene, camera);
}

// ================= misc =================
function onResize() {
  if (!renderer || !camera) return;
  const w = container.clientWidth || window.innerWidth;
  const h = container.clientHeight || window.innerHeight;
  camera.aspect = w / h;
  applyCameraFraming();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
}

export function clearScene() {
  for (const [key, mesh] of meshes) {
    tableGroup.remove(mesh);
    disposeMesh(mesh);
  }
  meshes.clear();
  seen.clear();
  for (let dp = 1; dp <= 3; dp++) {
    const rig = avatars[dp];
    if (rig) {
      rig.group.visible = false;
      rig.isTurn = false;
      rig.spriteKey = "";
      if (rig.sprite) {
        rig.spriteHolder.remove(rig.sprite);
        if (rig.sprite.material.map) rig.sprite.material.map.dispose();
        rig.sprite.material.dispose();
        rig.sprite = null;
      }
    }
  }
  if (turnLight) turnLight.intensity = 0;
  claimActive = false;
  claimFreeze = false;
  if (claimRing) claimRing.visible = false;
  if (claimLight) claimLight.visible = false;
  wallCap = 0;
  hovered = null;
  currentState = null;
  resetCamera();
}

function disposeMesh(mesh) {
  // Tile geometry is shared/cached across all tiles — never dispose it here.
  if (mesh.geometry && !mesh.userData.sharedGeo) mesh.geometry.dispose();
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of mats) m.dispose();
}
