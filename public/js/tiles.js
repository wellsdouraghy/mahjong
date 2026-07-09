// tiles.js — canvas-generated face textures per tile kind (cached) + mesh factory.
import * as THREE from "three";

// Tile geometry constants (units).
export const TILE_W = 0.9;
export const TILE_H = 1.2;
export const TILE_D = 0.62;

const TEX_W = 128;
const TEX_H = 160;

const IVORY = "#faf4e4";       // slightly warmer, creamier ivory
const IVORY_EDGE = "#ece0c2";
const BACK_GREEN = "#2bb277";      // cheerful bright jade back
const BACK_GREEN_DARK = "#1c8a5a";

// Traditional-ish coloring for dots by rank.
const DOT_COLORS = {
  1: "#c0392b", 2: "#1f6fb2", 3: "#1f6fb2", 4: "#1f6fb2", 5: "#1f8f4e",
  6: "#1f8f4e", 7: "#c0392b", 8: "#1f6fb2", 9: "#c0392b",
};
const CHAR_NUMERALS = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
const WIND_CHARS = { wE: "東", wS: "南", wW: "西", wN: "北" };

// Flower / season bonus tiles. f* = flowers (red numeral), g* = seasons (blue numeral).
const FLOWER_GLYPHS = {
  f1: "梅", f2: "蘭", f3: "菊", f4: "竹",
  g1: "春", g2: "夏", g3: "秋", g4: "冬",
};
const FLOWER_NAMES = {
  f1: "Plum", f2: "Orchid", f3: "Mum", f4: "Bamboo",
  g1: "Spring", g2: "Summer", g3: "Autumn", g4: "Winter",
};

const _texCache = new Map();     // kind -> THREE.CanvasTexture (face)
let _backTex = null;             // shared back texture
let _sideTex = null;             // shared plain ivory side

// ---------- Face drawing ----------
function newFaceCanvas() {
  const c = document.createElement("canvas");
  c.width = TEX_W; c.height = TEX_H;
  const ctx = c.getContext("2d");
  // Ivory background with subtle inner bevel.
  ctx.fillStyle = IVORY;
  ctx.fillRect(0, 0, TEX_W, TEX_H);
  const grad = ctx.createLinearGradient(0, 0, 0, TEX_H);
  grad.addColorStop(0, "rgba(255,255,255,0.6)");
  grad.addColorStop(0.5, "rgba(255,255,255,0)");
  grad.addColorStop(1, "rgba(120,100,60,0.12)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, TEX_W, TEX_H);
  // Rounded border frame.
  ctx.strokeStyle = "rgba(90,70,40,0.25)";
  ctx.lineWidth = 4;
  roundRect(ctx, 5, 5, TEX_W - 10, TEX_H - 10, 12);
  ctx.stroke();
  return { c, ctx };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawDot(ctx, cx, cy, r, color) {
  // Concentric-ring dot with highlight, like a real pin.
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.62, 0, Math.PI * 2);
  ctx.fillStyle = IVORY;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.34, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  // highlight
  ctx.beginPath();
  ctx.arc(cx - r * 0.28, cy - r * 0.28, r * 0.16, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.fill();
}

function drawDots(ctx, n) {
  const color = DOT_COLORS[n] || "#1f6fb2";
  const cx = TEX_W / 2, cy = TEX_H / 2;
  const R = 15; // dot radius
  const layouts = {
    1: [[cx, cy, 26]],
    2: [[cx, cy - 34], [cx, cy + 34]],
    3: [[cx - 34, cy - 40], [cx, cy], [cx + 34, cy + 40]],
    4: [[cx - 28, cy - 34], [cx + 28, cy - 34], [cx - 28, cy + 34], [cx + 28, cy + 34]],
    5: [[cx - 30, cy - 36], [cx + 30, cy - 36], [cx, cy], [cx - 30, cy + 36], [cx + 30, cy + 36]],
    6: [[cx - 28, cy - 40], [cx + 28, cy - 40], [cx - 28, cy], [cx + 28, cy], [cx - 28, cy + 40], [cx + 28, cy + 40]],
    7: [[cx - 30, cy - 46], [cx, cy - 34], [cx + 30, cy - 22], [cx - 28, cy + 14], [cx + 28, cy + 14], [cx - 28, cy + 48], [cx + 28, cy + 48]],
    8: [[cx - 28, cy - 48], [cx + 28, cy - 48], [cx - 28, cy - 16], [cx + 28, cy - 16], [cx - 28, cy + 16], [cx + 28, cy + 16], [cx - 28, cy + 48], [cx + 28, cy + 48]],
    9: [[cx - 32, cy - 44], [cx, cy - 44], [cx + 32, cy - 44], [cx - 32, cy], [cx, cy], [cx + 32, cy], [cx - 32, cy + 44], [cx, cy + 44], [cx + 32, cy + 44]],
  };
  const pts = layouts[n] || layouts[1];
  for (const p of pts) {
    drawDot(ctx, p[0], p[1], p[2] || R, color);
  }
}

function drawBambooStick(ctx, cx, cy, len, color) {
  const w = 9;
  ctx.fillStyle = color;
  roundRect(ctx, cx - w / 2, cy - len / 2, w, len, 4);
  ctx.fill();
  // node lines
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - w / 2, cy - len / 6); ctx.lineTo(cx + w / 2, cy - len / 6);
  ctx.moveTo(cx - w / 2, cy + len / 6); ctx.lineTo(cx + w / 2, cy + len / 6);
  ctx.stroke();
  // end caps
  ctx.fillStyle = "#0f5c33";
  ctx.beginPath(); ctx.arc(cx, cy - len / 2, w / 2, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx, cy + len / 2, w / 2, 0, Math.PI * 2); ctx.fill();
}

function drawBamboo(ctx, n) {
  const green = "#1f8f4e";
  const cx = TEX_W / 2, cy = TEX_H / 2;
  if (n === 1) {
    // Stylized bird for s1.
    drawBird(ctx, cx, cy);
    return;
  }
  const L = 34;
  const positions = {
    2: [[cx, cy - 30], [cx, cy + 30]],
    3: [[cx, cy - 42], [cx, cy], [cx, cy + 42]],
    4: [[cx - 26, cy - 30], [cx + 26, cy - 30], [cx - 26, cy + 30], [cx + 26, cy + 30]],
    5: [[cx - 30, cy - 34], [cx + 30, cy - 34], [cx, cy], [cx - 30, cy + 34], [cx + 30, cy + 34]],
    6: [[cx - 28, cy - 40], [cx + 28, cy - 40], [cx - 28, cy], [cx + 28, cy], [cx - 28, cy + 40], [cx + 28, cy + 40]],
    7: [[cx, cy - 48], [cx - 26, cy - 8], [cx, cy - 8], [cx + 26, cy - 8], [cx - 26, cy + 44], [cx, cy + 44], [cx + 26, cy + 44]],
    8: [[cx - 26, cy - 44], [cx + 26, cy - 44], [cx - 26, cy - 8], [cx + 26, cy - 8], [cx - 26, cy + 28], [cx + 26, cy + 28], [cx - 12, cy + 56], [cx + 12, cy + 56]],
    9: [[cx - 30, cy - 44], [cx, cy - 44], [cx + 30, cy - 44], [cx - 30, cy], [cx, cy], [cx + 30, cy], [cx - 30, cy + 44], [cx, cy + 44], [cx + 30, cy + 44]],
  };
  const pts = positions[n] || positions[2];
  for (const p of pts) drawBambooStick(ctx, p[0], p[1], L, green);
}

function drawBird(ctx, cx, cy) {
  // A simple stylized green/red bird.
  ctx.save();
  ctx.translate(cx, cy - 6);
  // body
  ctx.fillStyle = "#1f8f4e";
  ctx.beginPath();
  ctx.ellipse(0, 6, 20, 26, 0, 0, Math.PI * 2);
  ctx.fill();
  // wing
  ctx.fillStyle = "#146b39";
  ctx.beginPath();
  ctx.ellipse(6, 8, 10, 20, -0.5, 0, Math.PI * 2);
  ctx.fill();
  // head
  ctx.fillStyle = "#1f8f4e";
  ctx.beginPath();
  ctx.arc(-4, -20, 12, 0, Math.PI * 2);
  ctx.fill();
  // beak
  ctx.fillStyle = "#c0392b";
  ctx.beginPath();
  ctx.moveTo(-14, -22); ctx.lineTo(-26, -18); ctx.lineTo(-14, -14); ctx.closePath();
  ctx.fill();
  // eye
  ctx.fillStyle = "#1a1a1a";
  ctx.beginPath();
  ctx.arc(-6, -22, 2.5, 0, Math.PI * 2);
  ctx.fill();
  // tail
  ctx.strokeStyle = "#c0392b";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(14, 26); ctx.lineTo(30, 44);
  ctx.moveTo(10, 30); ctx.lineTo(20, 50);
  ctx.stroke();
  // feet
  ctx.strokeStyle = "#c9a24a";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-4, 30); ctx.lineTo(-4, 44);
  ctx.moveTo(-8, 44); ctx.lineTo(0, 44);
  ctx.stroke();
  ctx.restore();
}

// Small western index numeral in the UPPER-LEFT corner (like a playing card).
// Legible but unobtrusive: subtle gray, small, tucked into the border margin.
function drawCornerNumeral(ctx, n, color) {
  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = "bold 26px 'Segoe UI', Arial, sans-serif";
  // faint halo so it stays legible over dots/sticks
  ctx.fillStyle = "rgba(247,241,223,0.85)";
  ctx.fillText(String(n), 12, 12);
  ctx.fillStyle = color || "rgba(60,50,35,0.72)";
  ctx.fillText(String(n), 11, 11);
  ctx.restore();
}

function drawFlower(ctx, kind) {
  const isSeason = kind[0] === "g";
  const numeral = parseInt(kind.slice(1), 10);
  const glyph = FLOWER_GLYPHS[kind] || "花";
  const accent = isSeason ? "#1f6fb2" : "#b0392b";
  // Decorative rounded inner frame in the accent color.
  ctx.save();
  ctx.strokeStyle = isSeason ? "rgba(31,111,178,0.55)" : "rgba(176,57,43,0.5)";
  ctx.lineWidth = 4;
  roundRect(ctx, 16, 40, TEX_W - 32, TEX_H - 62, 12);
  ctx.stroke();
  ctx.restore();
  // Central glyph.
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = isSeason ? "#1f7a8f" : "#2f6b3e";
  ctx.font = "bold 70px 'Songti SC','SimSun',serif";
  ctx.fillText(glyph, TEX_W / 2, TEX_H * 0.56);
  // Corner numeral 1-4, colored red (flower) / blue (season).
  drawCornerNumeral(ctx, numeral, accent);
}

function drawChars(ctx, n) {
  // Top: red Chinese numeral. Bottom: 萬 in dark blue/black.
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#c0392b";
  ctx.font = "bold 62px 'Songti SC','SimSun',serif";
  ctx.fillText(CHAR_NUMERALS[n] || "?", TEX_W / 2, TEX_H * 0.32);
  ctx.fillStyle = "#1a2a4a";
  ctx.font = "bold 58px 'Songti SC','SimSun',serif";
  ctx.fillText("萬", TEX_W / 2, TEX_H * 0.68);
}

function drawWind(ctx, kind) {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#1a1a1a";
  ctx.font = "bold 82px 'Songti SC','SimSun',serif";
  ctx.fillText(WIND_CHARS[kind] || "?", TEX_W / 2, TEX_H / 2 + 4);
}

function drawDragon(ctx, kind) {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (kind === "dR") {
    ctx.fillStyle = "#c0392b";
    ctx.font = "bold 84px 'Songti SC','SimSun',serif";
    ctx.fillText("中", TEX_W / 2, TEX_H / 2 + 4);
  } else if (kind === "dG") {
    ctx.fillStyle = "#1f8f4e";
    ctx.font = "bold 78px 'Songti SC','SimSun',serif";
    ctx.fillText("發", TEX_W / 2, TEX_H / 2 + 4);
  } else if (kind === "dW") {
    // White dragon: blue rounded border, blank center.
    ctx.strokeStyle = "#1f6fb2";
    ctx.lineWidth = 7;
    roundRect(ctx, 22, 30, TEX_W - 44, TEX_H - 60, 14);
    ctx.stroke();
    // subtle diagonal
    ctx.beginPath();
    ctx.moveTo(28, 36); ctx.lineTo(TEX_W - 28, TEX_H - 36);
    ctx.stroke();
  }
}

function drawFace(kind) {
  const { c, ctx } = newFaceCanvas();
  const suit = kind[0];
  const rank = parseInt(kind.slice(1), 10);
  if (suit === "m") { drawChars(ctx, rank); drawCornerNumeral(ctx, rank); }
  else if (suit === "p") { drawDots(ctx, rank); drawCornerNumeral(ctx, rank); }
  else if (suit === "s") { drawBamboo(ctx, rank); drawCornerNumeral(ctx, rank); }
  else if (suit === "w") drawWind(ctx, kind);
  else if (suit === "d") drawDragon(ctx, kind);
  else if (suit === "f" || suit === "g") drawFlower(ctx, kind);
  return c;
}

// ---------- Texture accessors ----------
export function getFaceTexture(kind) {
  if (_texCache.has(kind)) return _texCache.get(kind);
  const canvas = drawFace(kind);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  _texCache.set(kind, tex);
  return tex;
}

function getBackTexture() {
  if (_backTex) return _backTex;
  const c = document.createElement("canvas");
  c.width = TEX_W; c.height = TEX_H;
  const ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 0, TEX_H);
  g.addColorStop(0, BACK_GREEN);
  g.addColorStop(1, BACK_GREEN_DARK);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, TEX_W, TEX_H);
  // Cheerful nested-diamond motif with a warm accent center.
  ctx.save();
  ctx.translate(TEX_W / 2, TEX_H / 2);
  ctx.rotate(Math.PI / 4);
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 5;
  ctx.strokeRect(-38, -38, 76, 76);
  ctx.strokeStyle = "rgba(255,255,255,0.14)";
  ctx.lineWidth = 3;
  ctx.strokeRect(-24, -24, 48, 48);
  ctx.restore();
  // Little warm blossom dot in the middle.
  ctx.fillStyle = "rgba(255,214,90,0.85)";
  ctx.beginPath();
  ctx.arc(TEX_W / 2, TEX_H / 2, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.beginPath();
  ctx.arc(TEX_W / 2 - 2.5, TEX_H / 2 - 2.5, 3, 0, Math.PI * 2);
  ctx.fill();
  _backTex = new THREE.CanvasTexture(c);
  _backTex.colorSpace = THREE.SRGBColorSpace;
  return _backTex;
}

function getSideTexture() {
  if (_sideTex) return _sideTex;
  const c = document.createElement("canvas");
  c.width = 16; c.height = 16;
  const ctx = c.getContext("2d");
  ctx.fillStyle = IVORY_EDGE;
  ctx.fillRect(0, 0, 16, 16);
  _sideTex = new THREE.CanvasTexture(c);
  _sideTex.colorSpace = THREE.SRGBColorSpace;
  return _sideTex;
}

// ---------- Rounded tile geometry (shared, cached) ----------
// A single beveled rounded-box geometry reused by all ~144 tiles. Built by
// extruding a rounded-rect outline with a small bevel, then re-grouping its
// triangles into material buckets: near-flat +Z front (idx 4), near-flat -Z
// back (idx 5) and everything else — bevels + walls — as ivory sides (idx 0).
// The flat front/back caps get clean, planar 0..1 UVs so face textures map
// crisply (the rounded rim stays ivory, so nothing bleeds onto the bevel).
let _tileGeo = null;

function roundedRectShapeXY(w, h, r) {
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

export function getTileGeometry() {
  if (_tileGeo) return _tileGeo;
  const bevel = 0.06, r = 0.16;
  const shape = roundedRectShapeXY(TILE_W, TILE_H, r);
  let geo = new THREE.ExtrudeGeometry(shape, {
    depth: TILE_D - 2 * bevel,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 5,
    steps: 1,
  });
  geo.center();
  geo = geo.toNonIndexed();

  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const uv = geo.attributes.uv;
  const triCount = pos.count / 3;
  const fw = TILE_W - 2 * bevel;   // flat cap extent (texture maps to this)
  const fh = TILE_H - 2 * bevel;

  geo.clearGroups();
  const triMat = new Array(triCount);
  for (let t = 0; t < triCount; t++) {
    let nz = 0;
    for (let k = 0; k < 3; k++) nz += nor.getZ(t * 3 + k);
    nz /= 3;
    let m;
    if (nz > 0.85) m = 4;        // flat front face
    else if (nz < -0.85) m = 5;  // flat back face
    else m = 0;                  // bevels + walls → ivory sides
    triMat[t] = m;
    if (m === 4 || m === 5) {
      for (let k = 0; k < 3; k++) {
        const i = t * 3 + k;
        const x = pos.getX(i), y = pos.getY(i);
        let u = (x + fw / 2) / fw;
        const v = (y + fh / 2) / fh;
        if (m === 5) u = 1 - u;  // un-mirror the back face
        uv.setXY(i, u, v);
      }
    }
  }
  uv.needsUpdate = true;

  // Coalesce contiguous same-material runs into geometry groups.
  let start = 0;
  for (let t = 1; t <= triCount; t++) {
    if (t === triCount || triMat[t] !== triMat[t - 1]) {
      geo.addGroup(start * 3, (t - start) * 3, triMat[t - 1]);
      start = t;
    }
  }
  _tileGeo = geo;
  return geo;
}

// ---------- Mesh factory ----------
// Material index order matches the geometry groups above:
// [0..3] ivory sides/bevels, [4] +Z front face, [5] -Z back.
// (mats[4] stays the face material so callers can tint its emissive.)
export function makeTileMesh(kind, { faceDown = false } = {}) {
  const geo = getTileGeometry();  // shared — never dispose per-mesh
  const side = new THREE.MeshStandardMaterial({ map: getSideTexture(), color: 0xf3ecd7, roughness: 0.55, metalness: 0.02 });
  const back = new THREE.MeshStandardMaterial({ map: getBackTexture(), roughness: 0.45, metalness: 0.03 });
  const faceMat = kind
    ? new THREE.MeshStandardMaterial({ map: getFaceTexture(kind), roughness: 0.4, metalness: 0.02 })
    : side.clone();

  const materials = [
    side.clone(), // 0
    side.clone(), // 1
    side.clone(), // 2
    side.clone(), // 3
    faceMat,      // 4 front (face)
    back,         // 5 back
  ];
  const mesh = new THREE.Mesh(geo, materials);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.kind = kind || null;
  mesh.userData.faceDown = faceDown;
  mesh.userData.sharedGeo = true;
  return mesh;
}

// For 2D chip color class (used by HUD). Returns {char, cls}.
export function chipInfo(kind) {
  if (!kind) return { char: "", cls: "c-black" };
  const suit = kind[0];
  const rank = parseInt(kind.slice(1), 10);
  if (suit === "m") return { char: CHAR_NUMERALS[rank] || "?", sub: "萬", cls: "c-red" };
  if (suit === "p") return { char: "●".repeat(Math.min(rank, 3)) || "●", sub: `${rank}筒`, cls: DOT_COLORS[rank] === "#c0392b" ? "c-red" : (DOT_COLORS[rank] === "#1f8f4e" ? "c-green" : "c-blue") };
  if (suit === "s") return { char: rank === 1 ? "🐦" : "‖", sub: `${rank}索`, cls: "c-green" };
  if (suit === "w") return { char: WIND_CHARS[kind] || "?", cls: "c-black" };
  if (kind === "dR") return { char: "中", cls: "c-red" };
  if (kind === "dG") return { char: "發", cls: "c-green" };
  if (kind === "dW") return { char: "▢", cls: "c-blue" };
  if (suit === "f") return { char: FLOWER_GLYPHS[kind] || "花", sub: FLOWER_NAMES[kind] || "", cls: "c-red" };
  if (suit === "g") return { char: FLOWER_GLYPHS[kind] || "花", sub: FLOWER_NAMES[kind] || "", cls: "c-blue" };
  return { char: "?", cls: "c-black" };
}
