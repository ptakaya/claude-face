/**
 * Phase 1 — the particles talk (Claude Face).
 *
 * The proven S2 particle renderer (D11 winning recipe: 20k dots, medium
 * mouth weighting, eyes + blinks, dot 1.05, hair chaos 2.00) now driven by
 * HeadTTS `bf_isabella` (D14) over REST. The server returns audio plus
 * native viseme timestamps; visemes are applied per-frame against the
 * Web Audio clock, so the mouth track ends exactly with the waveform —
 * the S2 lipsync tail-out cannot happen by construction.
 *
 * The head mesh: `vendor/avatar-audition.glb` (Avaturn export of the original's
 * chosen face, gitignored) when present, else the committed S2 stand-in.
 *
 * the original's free-tier export is a T1 head: photoreal geometry but NO facial
 * morphs. So when no viseme morphs are present we drive a PROCEDURAL mouth —
 * the lips are located by geometry, dots near them are displaced (open / wide
 * / pucker) per the active viseme, and the interior dims to a dark void. The
 * stand-in's real morph rig is used unchanged when it's present.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// ---------- config / variants ----------------------------------------------
const params = new URLSearchParams(location.search);
const state = {
  density: +(params.get("density") || 800000), // beauty re-tune 2026-06-30: 600k reads as a smooth surface while staying out of additive clipping (was 800k → washed out the lighting)
  mouthBoost: params.has("mouth") ? +params.get("mouth") : 0, // 0 off / 6 medium / 18 heavy (off reads best, 2026-06-13)
  eyes: params.get("eyes") !== "0",
  dotScale: +(params.get("dot") || 3.55), // brightness comes from dot size + opacity (the levers), NOT from cranking exposure into the rolloff (which froze the lighting sliders). 3.55 = the pick 2026-06-30
  hairDensity: +(params.get("hairDensity") || 250000), // hair's OWN dot budget — separate from the face, so hair never steals face dots (2026-06-14)
  hairDot: +(params.get("hairDot") || 0.5), // hair dot-size as a ratio of the face dot size — smaller hair dots stop the hair blowing out
  hairChaos: +(params.get("hair") || 2),
  pose: params.get("pose") || null, // frozen pose for screenshots
  yaw: +(params.get("yaw") || 0),
  zoom: +(params.get("zoom") || 1),
  say: params.get("say") || null, // autospeak on load (headless end-to-end test)
};

// ?dev=1 → developer mode: verbose console traces plus debug-only knobs (BLINK_HOLD, eyedebug) and the
// experimental swirl modes (orbit/ribbons). Off by default so the shipped page stays quiet and locked.
const DEV = params.has("dev");
const dlog = DEV ? console.log.bind(console) : () => {};

// Meshes are classified by inspection, not by name list, so the renderer
// speaks both dialects: the RPM stand-in (Wolf3D_Head/Teeth, EyeLeft/Right,
// Wolf3D_Hair/Body) and Avaturn T2 (avaturn_body carries head+torso+visemes
// in one mesh; avaturn_hair_0; avaturn_look_0 is clothing).
const TEETH_WEIGHT = 0.15;

function classifyMesh(mesh) {
  const n = mesh.name.toLowerCase();
  if (n.includes("glass") || n.includes("outfit") || n.includes("shoe")) return "skip";
  if (n.includes("teeth")) return "teeth";
  if (n.includes("hair")) return "hair";
  if (n.includes("eye")) return "eye";
  const dict = mesh.morphTargetDictionary || {};
  if (Object.keys(dict).some((k) => k.startsWith("viseme_"))) return "face";
  return "body";
}

const SPEECH_MORPHS = ["viseme_aa", "viseme_O", "viseme_U", "viseme_E", "viseme_I", "viseme_PP", "viseme_FF", "viseme_kk", "jawOpen"];

// ---------- scene ------------------------------------------------------------
const stageEl = document.getElementById("stage");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
stageEl.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 20);

// Size the canvas off the #stage container, not the window. While #stage is
// inset:0 this equals innerWidth/innerHeight (zero visible change); once a
// push-drawer narrows #stage, the canvas refits the narrower pane instead of
// stretching. One resize() reused for the initial size and the resize event. (2026-06-30)
function resize() {
  const w = stageEl.clientWidth, h = stageEl.clientHeight;
  if (!w || !h) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
resize();
addEventListener("resize", resize);

function dotTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.4, "rgba(255,255,255,.9)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const material = new THREE.PointsMaterial({
  size: 0.0035,
  map: dotTexture(),
  transparent: true,
  opacity: +(params.get("op") ?? 0.64), // per-dot strength = second brightness lever (with dot size). 0.64 = the pick 2026-06-30. Higher → brighter but eventually white-clips the additive sum, which re-flattens the lighting; the moody-mid zone is where the lighting sliders have the most range.
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  sizeAttenuation: true,
  vertexColors: true,
  // per-point size: hair dots can be smaller than face dots in the SAME render pass.
  onBeforeCompile: (shader) => {
    shader.vertexShader = "attribute float aSize;\n" + shader.vertexShader.replace("gl_PointSize = size;", "gl_PointSize = size * aSize;");
  },
});

let points = null;

// ---------- avatar load -------------------------------------------------------
const meshes = {};
let headBone = null, neckBone = null, headCenter = new THREE.Vector3();
// real CC0 eyeballs (the low-poly eyes asset): each {c: world centre, r: radius}. The iris/
// pupil is shaded on THESE actual spheres, not a guessed disc. Detected by eyeLook* gaze
// morphs (name-independent), centres computed from world-space verts after framing. (2026-06-24)
let eyeballMeshes = [], eyeballL = null, eyeballR = null, hasRealEyes = false;
let morphMeshes = [];

// the original's own head (Avaturn export, gitignored — free tier is non-commercial)
// wins when present; otherwise the committed stand-in keeps the app alive.
let gltf, headSource;
let BACK_CULL = +(params.get("back") ?? 0.30); // keep dots with z > headCenter.z − this (0.30 = whole head; female bust overrides tighter)
let occluderMat = null; // shared invisible depth-only occluder (head skin + hair); built below
const headParam = params.get("head");   // DEFAULT → headsculpt (primary face, locked 2026-06-16). ?head=female (young bust) · candidate5 · avatar · standin
const headFileParam = params.get("headfile"); // audition any rigged head in vendor/ as particles: ?headfile=david (RPM-format → morph path) (2026-06-24)
// A missing/unreadable head is fatal (there is nothing to render), so any load failure surfaces on the
// #boot banner rather than leaving the blank "sampling the face…" screen up forever. The ?head=… and
// ?headfile=… variants below audition heads whose GLBs are NOT shipped, so they land here too.
try {
  if (headFileParam) {
    gltf = await new GLTFLoader().loadAsync(`./vendor/${headFileParam}.glb`);
    headSource = "stand-in";
  } else if (headParam === "female") {
    gltf = await new GLTFLoader().loadAsync("./vendor/bust-female.glb"); // audition head — NOT shipped
    headSource = "female";
  } else if (headParam === "candidate5") {
    gltf = await new GLTFLoader().loadAsync("./vendor/candidate5-head-normalized.glb"); // audition head — NOT shipped
    headSource = "candidate5";
  } else if (headParam === "avatar") {
    try {
      gltf = await new GLTFLoader().loadAsync("./vendor/avatar-audition.glb"); // audition head — NOT shipped
      headSource = "avatar";
    } catch {
      gltf = await new GLTFLoader().loadAsync("./vendor/avatar.glb");
      headSource = "stand-in";
    }
  } else if (headParam === "standin") {
    gltf = await new GLTFLoader().loadAsync("./vendor/avatar.glb"); // audition RPM stand-in — NOT shipped
    headSource = "stand-in";
  } else {
    gltf = await new GLTFLoader().loadAsync("./vendor/head-default.glb"); // DEFAULT — the one CC0 head we ship (real eyeballs + native visemes); the locked look
    headSource = "cc0";
  }
} catch (err) {
  const bootEl = document.getElementById("boot"); // still on screen — only removed after a successful build
  if (bootEl) {
    bootEl.textContent = "Could not load the face — " + (err && err.message ? err.message : String(err));
    bootEl.style.color = "#ff6b6b";
  }
  throw err; // stop: nothing downstream can run without the head
}
const avatar = gltf.scene;
avatar.visible = false;
scene.add(avatar);

const meshKind = new Map();
avatar.traverse((o) => {
  if (o.isMesh) {  // isMesh covers both SkinnedMesh (Avaturn) and plain Mesh (FaceBuilder static head)
    meshes[o.name] = o;
    o.frustumCulled = false;
    meshKind.set(o, classifyMesh(o));
  }
  if (o.isBone && !headBone && /head$/i.test(o.name)) headBone = o;
  if (o.isBone && !neckBone && /neck/i.test(o.name)) neckBone = o;
});
morphMeshes = Object.values(meshes).filter((m) => m.morphTargetDictionary);
dlog("[avatar]", headSource, Object.values(meshes).map((m) => `${m.name}:${meshKind.get(m)}`).join(" "));

avatar.updateMatrixWorld(true);
if (headBone) {
  headBone.getWorldPosition(headCenter);
  headCenter.y += 0.04;
} else if (headSource === "female" || headSource === "headsculpt") {
  // stock bust: authored tiny + includes shoulders. Scale to a standard size, then put
  // headCenter up in the face (upper portion of the bust). Both tunable via params.
  const _b0 = new THREE.Box3();
  for (const m of Object.values(meshes)) _b0.expandByObject(m);
  const s = +(params.get("headH") ?? 1.0) / (_b0.getSize(new THREE.Vector3()).y || 1);
  avatar.scale.setScalar(s);
  avatar.position.set(0, 1.6, 0); // sit it at a head-height world position
  avatar.updateMatrixWorld(true);
  // anchor headCenter on the eyeball mesh centre (= the eye line, natural look-at point)
  let eyeBox = null;
  for (const m of Object.values(meshes)) if (/PM3D_Sphere/.test(m.name)) eyeBox = new THREE.Box3().setFromObject(m);
  if (eyeBox) {
    eyeBox.getCenter(headCenter);
    headCenter.y += +(params.get("headFrac") ?? -0.01); // small nudge from eye line toward face centre
  } else {
    const _b1 = new THREE.Box3();
    for (const m of Object.values(meshes)) _b1.expandByObject(m);
    const c = _b1.getCenter(new THREE.Vector3()), sz = _b1.getSize(new THREE.Vector3());
    headCenter.set(c.x, c.y + sz.y * 0.30, c.z + sz.z * 0.08);
  }
  for (const m of Object.values(meshes)) {
    if (/PM3D_Sphere|PM3D_Cylinder/.test(m.name)) meshKind.set(m, "skip"); // eyeball spheres + display-stand cylinder
  }
  if (headSource === "headsculpt") headCenter.set(0, 1.545, 0.15); // eyeball-less bust: anchor on the eye line (nose y≈1.493 + brow), face is x=0
  if (params.has("headCX")) headCenter.x = +params.get("headCX"); // manual camera-aim override (eyeball-less busts)
  if (params.has("headCY")) headCenter.y = +params.get("headCY");
  if (params.has("headCZ")) headCenter.z = +params.get("headCZ");
  BACK_CULL = params.has("back") ? +params.get("back") : (headSource === "headsculpt" ? 0.25 : 0.07); // bust has a neck: cull the back half so it doesn't show through the face
  dlog("[avatar] female bust · scale", s.toFixed(4), "· headCenter", headCenter.toArray().map((v) => +v.toFixed(3)).join(","));
} else if (headSource === "cc0") {
  // Shipped CC0 head — the SAME mesh as the ?headfile= audition it was dialed in on, so it must use the
  // IDENTICAL handling as that branch (below): scale to a standard head height, then anchor headCenter
  // on the real geometry. The feature/nose anchors are offsets from headCenter, so a mismatched centre
  // lands them off the face → soft nose + small framing. (The earlier "already sized, fixed 1.545"
  // path did exactly that — the default looked degraded next to the audition it was tuned on.)
  const _b0 = new THREE.Box3();
  for (const m of Object.values(meshes)) _b0.expandByObject(m);
  const s = +(params.get("headH") ?? 1.0) / (_b0.getSize(new THREE.Vector3()).y || 1);
  avatar.scale.setScalar(s);
  avatar.position.set(0, 1.6, 0);
  avatar.updateMatrixWorld(true);
  const _b1 = new THREE.Box3();
  for (const m of Object.values(meshes)) _b1.expandByObject(m);
  const c = _b1.getCenter(new THREE.Vector3()), sz = _b1.getSize(new THREE.Vector3());
  headCenter.set(c.x, c.y + sz.y * (+(params.get("headFrac") ?? 0.32)), c.z + sz.z * 0.08);
  if (params.has("headCX")) headCenter.x = +params.get("headCX");
  if (params.has("headCY")) headCenter.y = +params.get("headCY");
  if (params.has("headCZ")) headCenter.z = +params.get("headCZ");
  BACK_CULL = params.has("back") ? +params.get("back") : 0.22;
  dlog("[avatar] cc0 head (audition-matched) · scale", s.toFixed(4), "· headCenter", headCenter.toArray().map((v) => +v.toFixed(3)).join(","));
} else if (headFileParam && !headBone) {
  // MPFB/CC0 bust auditioned via ?headfile= (no skeleton): auto-scale by bbox height and
  // anchor headCenter up on the face — same idea as the female/headsculpt busts, so any
  // cropped rig-less head frames on the face instead of the chest. (2026-06-24)
  const _b0 = new THREE.Box3();
  for (const m of Object.values(meshes)) _b0.expandByObject(m);
  const s = +(params.get("headH") ?? 1.0) / (_b0.getSize(new THREE.Vector3()).y || 1);
  avatar.scale.setScalar(s);
  avatar.position.set(0, 1.6, 0);
  avatar.updateMatrixWorld(true);
  const _b1 = new THREE.Box3();
  for (const m of Object.values(meshes)) _b1.expandByObject(m);
  const c = _b1.getCenter(new THREE.Vector3()), sz = _b1.getSize(new THREE.Vector3());
  headCenter.set(c.x, c.y + sz.y * (+(params.get("headFrac") ?? 0.32)), c.z + sz.z * 0.08);
  if (params.has("headCX")) headCenter.x = +params.get("headCX");
  if (params.has("headCY")) headCenter.y = +params.get("headCY");
  if (params.has("headCZ")) headCenter.z = +params.get("headCZ");
  BACK_CULL = params.has("back") ? +params.get("back") : 0.22;
  dlog("[avatar] mpfb bust · scale", s.toFixed(4), "· headCenter", headCenter.toArray().map((v) => +v.toFixed(3)).join(","));
} else {
  // static head (no skeleton): the mesh was normalized to the Avaturn head frame,
  // so headCenter = mesh-bounds centre + the known Avatar (bboxCentre → headCentre) offset.
  const _box = new THREE.Box3();
  for (const m of Object.values(meshes)) _box.expandByObject(m);
  _box.getCenter(headCenter);
  headCenter.add(new THREE.Vector3(0, 0.075, -0.046));
  dlog("[avatar] no headBone — headCenter from mesh bounds:", headCenter.toArray().map((v) => +v.toFixed(3)).join(","));
}

// --- real eyeballs: find the eye mesh(es) by their eyeLook* gaze morphs, then measure each
// eyeball's world-space centre + radius (split left/right by x). Forward toward camera is +z, so
// the iris/pupil cap is the disc around each centre's +z pole. The eyeball's OWN gaze saccade is
// suppressed when real eyes are present (see updateIdle) so it stays geometrically static — that
// keeps this one-time measure valid and the iris holds a steady, well-defined forward gaze. (2026-06-24)
eyeballMeshes = Object.values(meshes).filter((m) => {
  const keys = Object.keys(m.morphTargetDictionary || {});
  const hasGaze = keys.some((k) => k.toLowerCase().startsWith("eyelook"));
  if (!hasGaze) return false;
  const hasViseme = keys.some((k) => k.startsWith("viseme_")); // the FACE carries ARKit eyeLook* too — but it has visemes; the eyeball doesn't
  // size guard: reject a viseme-less ARKit-only FACE mesh that would otherwise slip through. The eye
  // mesh holds BOTH eyeballs, so its governing dimension is the inter-ocular SPAN (~0.17 world on a
  // ~1-tall head), not a single sphere; a face spans ~1.27. The 0.55 cut sits with wide margin between
  // the two (tolerant of head-framing up to ~headH 3), so the real eyeballs always pass. (verified)
  const sz = new THREE.Box3().setFromObject(m).getSize(new THREE.Vector3());
  const small = Math.max(sz.x, sz.y, sz.z) < 0.55;
  return !hasViseme && small;
});
hasRealEyes = eyeballMeshes.length > 0;
if (hasRealEyes) {
  const _w = new THREE.Vector3();
  const side = (lo) => ({ sx: 0, sy: 0, sz: 0, n: 0, pts: [] }); // accumulator
  const L = side(), R = side();
  for (const m of eyeballMeshes) {
    m.updateMatrixWorld();
    const p = m.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      _w.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
      const s = _w.x < headCenter.x ? L : R;
      s.sx += _w.x; s.sy += _w.y; s.sz += _w.z; s.n++;
      s.pts.push(_w.x, _w.y, _w.z);
    }
  }
  const measure = (s) => {
    if (!s.n) return null;
    const c = new THREE.Vector3(s.sx / s.n, s.sy / s.n, s.sz / s.n);
    let rs = 0;
    for (let i = 0; i < s.pts.length; i += 3) {
      const dx = s.pts[i] - c.x, dy = s.pts[i + 1] - c.y, dz = s.pts[i + 2] - c.z;
      rs += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    return { c, r: rs / (s.pts.length / 3) }; // sphere surface → mean dist ≈ radius
  };
  eyeballL = measure(L); eyeballR = measure(R);
  const fmt = (e) => e ? `c=${e.c.toArray().map((v) => +v.toFixed(3)).join(",")} r=${e.r.toFixed(4)} n=${e === eyeballL ? L.n : R.n}` : "none";
  dlog("[eyeballs] L", fmt(eyeballL), " R", fmt(eyeballR));
}

// --- occlusion: render the head surface as an INVISIBLE depth-only occluder, so points
// behind it (back of skull, lit back-hair) are hidden and the skin reads as solid. The
// points already depth-test; this gives them a surface to test against. (?occlude=0 off)
if (params.get("occlude") !== "0") {
  const bias = +(params.get("occBias") ?? 2.0); // push occluder back so front-surface points aren't culled by their own skin
  occluderMat = new THREE.MeshBasicMaterial({
    colorWrite: false,            // invisible — writes depth only, no colour
    polygonOffset: true,
    polygonOffsetFactor: bias,
    polygonOffsetUnits: bias,
  });
  avatar.visible = true;
  for (const m of Object.values(meshes)) {
    const k = meshKind.get(m);
    if (k === "body" || k === "face") { m.material = occluderMat; m.visible = true; m.frustumCulled = false; }
    else m.visible = false; // eyeballs, base, hair — don't occlude
  }
}

// --- procedural mouth setup (engaged when the head carries no viseme morphs) --
const hasVisemeMorphs = morphMeshes.some((m) => "viseme_aa" in (m.morphTargetDictionary || {}));
const procedural = params.has("proc") ? params.get("proc") !== "0" : !hasVisemeMorphs;

// the face mesh = the skinned mesh with the most vertices clustered at the head
const _tmp = new THREE.Vector3();
let faceMesh = null, faceBest = -1;
for (const mesh of Object.values(meshes)) {
  const k = meshKind.get(mesh);
  if (k === "skip" || k === "hair") continue;
  const pos = mesh.geometry.attributes.position;
  let cnt = 0;
  for (let i = 0; i < pos.count; i += 7) {
    _tmp.fromBufferAttribute(pos, i);
    if (_tmp.distanceTo(headCenter) < 0.13) cnt++;
  }
  if (cnt > faceBest) { faceBest = cnt; faceMesh = mesh; }
}

// locate the lips: the frontmost point in the lower-face band, near centre x
const mouthAnchorBase = headCenter.clone();
if (faceMesh) {
  faceMesh.updateMatrixWorld();
  const mw = faceMesh.matrixWorld; // scan in WORLD space — the bust is scaled (0.0191) + lifted, so its LOCAL coords don't match the world-space headCenter. Without this the anchor lands ~17 units off the face and the mouth never moves (fix 2026-06-24)
  const pos = faceMesh.geometry.attributes.position;
  const yLo = headCenter.y - 0.13, yHi = headCenter.y - 0.05; // BELOW the nose — the old band's frontmost point was the nose underside, so the mouth animated on the nose (2026-06-24)
  const inBand = (p) => p.y >= yLo && p.y <= yHi && Math.abs(p.x - headCenter.x) < 0.05;
  let maxz = -Infinity;
  for (let i = 0; i < pos.count; i++) { _tmp.fromBufferAttribute(pos, i).applyMatrix4(mw); if (inBand(_tmp) && _tmp.z > maxz) maxz = _tmp.z; }
  let sy = 0, cnt = 0;
  for (let i = 0; i < pos.count; i++) { _tmp.fromBufferAttribute(pos, i).applyMatrix4(mw); if (inBand(_tmp) && _tmp.z >= maxz - 0.02) { sy += _tmp.y; cnt++; } }
  mouthAnchorBase.set(headCenter.x, cnt ? sy / cnt : (yLo + yHi) / 2, maxz);
}
// live mouth position — you drag it onto the lips; the rebuild re-tags which dots are "mouth" (2026-06-24)
let MOX = +(params.get("mox") || 0), MOY = +(params.get("moy") || 0), MOZ = +(params.get("moz") || 0);
const mouthAnchor = mouthAnchorBase.clone();
function applyMouthOffset() { mouthAnchor.set(mouthAnchorBase.x + MOX, mouthAnchorBase.y + MOY, mouthAnchorBase.z + MOZ); }
applyMouthOffset();
const MOUTH_SIGMA = +(params.get("mr") || 0.045); // gate radius (~3σ ≈ 0.135) must exceed the max aperture half-extent (~0.05) so a wide opening is never clipped (2026-06-24)
let JAW = +(params.get("jaw") || 0.06);           // opening amount — raised so the lips visibly part (was 0.016 ≈ sub-mm; 2026-06-24)
let MOUTH_CW = +(params.get("cw") || 0.045);      // mouth half-width: corners beyond this hold still — widened for a real mouth (2026-06-24)
let ULIP = +(params.get("ulip") ?? 0.0);          // OPTIONAL symmetric lip-part (0 = clean default, no displacement); no longer an asymmetric up/down split (2026-06-24)
let VOID = +(params.get("void") ?? 1.0);          // cavity blackness: 1 = inside dots fully extinguished → pure-black opening; lower = a veiled/dim opening (2026-06-24)
let CHEEK_FREEZE = +(params.get("cheekFreeze") ?? 0.75); // CHEEK-MOVEMENT FALLOFF (2026-06-30): hold the upper cheeks toward their no-mouth rest while she talks. 0 = off, 1 = fully still. The native viseme blendshapes deform the whole mid-face and ride the cheeks up toward the ears; this calms that while the lips/jaw keep full motion.
let CHEEK_RISE = +(params.get("cheekRise") ?? 0.05);     // how far ABOVE the mouth motion is allowed to climb before the freeze reaches full (world units). Smaller = cheeks settle sooner / more frozen; larger = more of the mid-face keeps moving. THE knob for how much cheek moves.
let EYE_SPARE = +(params.get("eyeSpare") ?? 0.09);       // eyelid-spare RADIUS (world units) around each eye centre: inside this, the cheek-freeze is fully OFF so the blink lid can travel. 0.025 (orig) and 0.045 both froze the OPEN upper-lid dots (which sit well above the eye centre) → they never swept down → the eye closed as a "black void" (the "curtain"). 0.09 measured to restore full closed-lid coverage — headless held-blink compare A/B/C, 2026-06-30. THE knob for the blink.
let EYE_SPARE_RAMP = +(params.get("eyeSpareRamp") ?? 0.035); // ramp width from fully-spared (at EYE_SPARE) to fully-frozen (at EYE_SPARE+this). Wider = a gentler handoff between the free lid and the calm cheek.
let E_SMILE = +(params.get("eSmile") ?? 0.5);            // strong-E / I smile (2026-06-30): how far the lip corners spread (mouthSmile L/R) on "easy / bees / knees". Eases in with the viseme's wide signal; only the strong spreads (E/I, wide > 0.4) trigger it. 0 = off.
const SMILE_DBG = params.has("smile") ? +params.get("smile") : null; // &smile=<0..1> force-applies mouthSmile for static inspection / tuning
let RIM_GLOW = +(params.get("rimGlow") ?? 0.2);   // lit-lip-rim highlight — frames the void so the lips stay defined when a wide 'aa' thins the ring (2026-06-24)
// BACK_CULL is declared earlier (above the head-loading block) so the female branch can override it
let HAIR_CULL = +(params.get("hairCull") ?? 0.020); // cull skull/scalp dots within this of hair, so hair hides the skull (0 = off)
let HAIR_BACK = +(params.get("hairBack") ?? 0.05);  // drop hair dots behind headCenter.z − this (less back-of-head fog over the face)
let HAIR_DROP = +(params.get("hairDrop") ?? 0.13);  // drop hair dots below headCenter.y − this (stops hair draping past the jaw)
let HAIR_BRIGHT = +(params.get("hairBright") ?? 0.7); // hair dot brightness multiplier — dims the hair so it stops blowing out ("on fire") independent of the face
let HAIRLINE = +(params.get("hairline") ?? 0.10); // lift hair off the central forehead up to this height above the brow — clean forehead instead of see-through strands / cull splotches (0 = full fringe)
// hair fit (live): scale + offsets, driven by sliders via refitHair(). Defaults from the 2026-06-14 dial.
let hairObj = null;
let HAIR_SCALE = +(params.get("hairScale") ?? 150); // nimxx (default hair) fits at ~150 (2026-06-14)
let HAIR_ROTY = +(params.get("hairRotY") ?? 0);
let HAIR_X = +(params.get("hairX") ?? 0);
let HAIR_Y = +(params.get("hairY") ?? 0);
let HAIR_Z = +(params.get("hairZ") ?? 0);
function refitHair() {
  if (!hairObj) return;
  hairObj.scale.setScalar(HAIR_SCALE);
  hairObj.rotation.y = HAIR_ROTY;
  hairObj.position.set(0, 0, 0);
  hairObj.updateMatrixWorld(true);
  const c = new THREE.Box3().setFromObject(hairObj).getCenter(new THREE.Vector3()); // scaled hair centre
  hairObj.position.set(headCenter.x - c.x + HAIR_X, headCenter.y - c.y + HAIR_Y, headCenter.z - c.z + HAIR_Z);
  hairObj.updateMatrixWorld(true);
}

// horizontal contour striation (scan-line banding) — per-frame, live sliders, strength 0 = untouched
let STRI = +(params.get("stri") || 0.08);               // master strength: 0 = scatter → 1 = full bands (the lock: strength 0.08, 2026-06-24)
let STRI_SPACE = +(params.get("striSpace") || 0.006);  // band spacing in world units (smaller = more lines)
let STRI_CRISP = +(params.get("striCrisp") ?? 0.78);   // 0 = soft bands → 1 = razor lines (carves the gaps)
let STRI_CONTOUR = +(params.get("striContour") || 0);  // 0 = horizontal lines → 1 = topographic contour rings (manual; ignored while auto on)
let STRI_AUTO = +(params.get("striAuto") || 3.0);      // smooth auto-drive of Contour 0↔1 (0 = manual, higher = faster roam)
let STRI_DRIFT = +(params.get("striDrift") || 0);      // slow breathe of band spacing (0 = off)
const STRI_Y0 = headCenter.y;                          // band anchor, fixed to the head
const STRI_FOCAL = new THREE.Vector3(headCenter.x, headCenter.y + 0.05, headCenter.z + 0.10); // contour-ring centre, on the face

// beauty rig — a directional KEY (sculpts shape) + a softer FILL from the other side
// (lifts the key's shadow side so the FRONT view doesn't read flat/backlit). Single front
// keys can't beauty-light a front view: every front surface faces the key equally → no gradient.
let LIGHT = +(params.get("light") || 0.25);        // SHADOW DARKNESS: 0 = no shadows (flat) → 1 = shadow side crushes to pure black. Ambient floor = 1 − LIGHT. Now LIVE/visible because EXPOSURE sits in headroom (beauty re-tune v3 2026-06-30).
let LIGHT_AZ = +(params.get("lightAz") ?? 0.3);   // key azimuth (rad): 0 = front; ~0.5 puts the softbox a little to the side for gentle cheek/brow modelling (beauty re-tune 2026-06-30)
let LIGHT_EL = +(params.get("lightEl") ?? 0.2); // key elevation (rad): low (≈eye level, slightly up) so the softbox lights the FACE rather than blooming the crown (beauty re-tune 2026-06-30)
let MODEL = +(params.get("model") ?? 2.0);        // MODELING: gamma on the key term, NOW LIVE in the softbox path too (was a dead hardcoded 2 — the slider did nothing while SOFT>0; fixed 2026-06-30). 1 = flat, 2 = the old soft default, 3–5 = strong shape. A face is forward-facing so raw N·L barely varies; this is what turns that gentle gradient into real sculpting.
let FILL = +(params.get("fill") ?? 0.6);          // fill intensity: soft second key lifting the shadow side. Opens the shadows so the nose/lower face come up to meet the forehead. NOTE: lifts only where dots EXIST — the EDGE-emptied cheeks won't respond (beauty re-tune v3 2026-06-30)
let FILL_AZ = +(params.get("fillAz") ?? -0.55);   // fill azimuth (rad): opposite the key, near the front
let FILL_EL = +(params.get("fillEl") ?? 0.10);    // fill elevation (rad): near eye level, soft
let SOFT = +(params.get("soft") ?? 0.6);          // SOFTBOX: 0 = hard concentrated key (MODEL^3 hotspot reads as a small bulb). >0 wraps the key broadly around the form → large soft source. ~0.6 = nice — now ON by default (beauty re-tune 2026-06-30; this is what softens the modelling, and it bypasses MODEL)
let EXPOSURE = +(params.get("exposure") ?? 0.7);  // KEEP LOW. This is the per-dot light multiplier; brightness comes from dot size + opacity instead. At low exposure the lit values sit in the LINEAR zone so fill/shadow/key/modelling actually modulate them. Crank exposure up and every dot saturates → lighting goes dead again (the trap we chased all of 2026-06-30).
let ROLL_KNEE = +(params.get("rollKnee") ?? 6.0); // highlight rolloff — now EFFECTIVELY OFF (knee/ceil=6, far above any normal g). It existed to tame a forehead blowout caused by Feature-Density dot pile-up; FEAT=0 cured that at the source, and the rolloff was secretly pinning every dot near the ceiling so the lighting sliders had no range. Disabling it gave the lights their bite back (root-cause fix 2026-06-30).
let ROLL_CEIL = +(params.get("rollCeil") ?? 6.0);  // see ROLL_KNEE — kept equal so the shoulder never engages in normal use; lower both toward 0.55/1.0 only if a future high-density setting re-introduces blowout.
// VERTICAL DENSITY COMPENSATION (beauty re-tune v3 2026-06-30): the crown packs far more
// overlapping dots than the jaw, so additively the top reads bright and the bottom dark NO
// MATTER where the lights are (it's geometry, not lighting). This per-dot factor flattens that:
// gently dim dots above head-centre (dense crown/forehead) and lift dots below (sparse jaw),
// so the additive sum comes out even top-to-bottom. 0 = off.
let VFLAT = +(params.get("vflat") ?? 0);            // vertical density compensation — OFF by default (2026-06-30): kept as a code lever but not in the panel, so the dashboard is the whole truth. Raise via &vflat= or re-add a slider if we want it.
let VFLAT_Y = +(params.get("vflatY") ?? 0.18);      // world half-height from head-centre to crown (the ramp's reach)

// procedural eyes (T1 has no eye geometry): build a defined eye — tight opening, dark
// pupil, bright iris ring — at a placeable centre, then optionally glow/blink. All live.
let EYE_SEP = +(params.get("eyeSep") ?? 0.10);    // half-distance between the two eyes (x) — widened for the headsculpt; candidate5's 0.042 was too narrow (2026-06-24)
let EYE_H = +(params.get("eyeH") ?? -0.003);      // eye height vs head centre (y; world-anchored, reliable) — 2026-06-14
let EYE_R = +(params.get("eyeR") ?? 0.006);       // eye opening radius (smaller = tighter, more defined) — 2026-06-14
let EYE_DENSITY = +(params.get("eyeDens") || 6);  // extra dots packed into the eye discs (build-time; rebuild on change)
let EYE_PUPIL = +(params.get("eyePupil") || 0.2); // pupil darkness — a dark core reads as an eye
let EYEGLOW = +(params.get("eyeGlow") || 0.35);   // iris-ring brightness (catch-light)
let BLINK_HOLD = (DEV && params.has("blinkHold")) ? +params.get("blinkHold") : null; // DEV-only DEBUG (2026-06-30): force the eyeBlink morph to this value (0..1) and hold it, so a blink can be captured/measured statically. Combine with &pose=sil to freeze idle. null = normal idle blinking.
let BLINK = +(params.get("blink") || 0);          // blink rate: 0 = OFF by default — a bare iris/pupil with no eyelid blinking reads wrong (2026-06-24). 1 ≈ a blink every ~4s
const EYE_DEBUG = DEV && params.get("eyedebug") === "1"; // DEV-only: ?dev=1&eyedebug=1 → paint in-disc dots red to place them

// REAL-eyeball iris/pupil (shaded on the actual sphere, anchored on its forward +z pole).
// Radii are fractions of the eyeball radius: 0 = the toward-camera pole, 1 = the equator.
// Black pupil core inside a mid-grey iris ring inside the bright white sclera = a defined eye.
// LOCKED 2026-06-24 — picked the "HardRim" variant ("the best by far"): definition over size.
// A pure-black pupil + dark iris body + a strong limbal ring read as a defined eye via CONTRAST,
// with a moderate iris size. (auditioned across a 6-variant tab-compare on the real eyeballs.)
let IRIS_PR = +(params.get("irisPR") ?? 0.28);     // pupil radius (frac of eyeball R)
let IRIS_IR = +(params.get("irisIR") ?? 0.58);     // iris outer radius (frac)
let IRIS_PUPIL = +(params.get("irisPupil") ?? 1.0); // pupil darkness (1 = pure black core)
let IRIS_DARK = +(params.get("irisDark") ?? 0.60); // iris-ring darkness vs the white sclera
let IRIS_LIMBAL = +(params.get("irisLimbal") ?? 0.65); // extra darkening at the iris OUTER rim (the limbal ring that makes eyes pop)
let IRIS_CATCH = +(params.get("irisCatch") ?? 0.0); // catch-light: a small bright spark upper-nasal on the iris (0 = off)
const GAZE_DART = params.get("gaze") === "1";      // real eyes hold a STEADY forward stare (the procedural iris is anchored to +z and would NOT track a saccade — the eye would just look broken). ?gaze=1 re-enables the random eye-darts anyway.

// procedural relief — paint structure the smooth mesh lacks (per-frame, live)
let SOCKET = +(params.get("socket") || 0.32);      // eye-socket shadow depth (seats the eyes) — eased to 0.3 so the eyes aren't over-recessed in the flatter even light (beauty re-tune v2 2026-06-30)
let NOSE_DEF = +(params.get("noseDef") || 0.04);  // nose: bright bridge + shadowed nostril wings — DROPPED from 0.5: the procedural nostril darkening was the "black nose"; 0.15 keeps a hint of nose without the dark blob (beauty re-tune v2 2026-06-30)
let NOSE_DOTS = +(params.get("noseDots") || 0.5);  // 0..1: eases the EDGE thinning ONLY on the down-facing nostril wings + alar flare at the nose base, so the dots EDGE stripped there come back and the dark crescents fill. Targets the stripped creases, not the already-dense bridge (no blob). (2026-06-30)
let NASION_EVEN = +(params.get("nasionEven") || 0.3);  // 0..1: gently thins the over-dense nasion (top of bridge, between the brows) so that natural hotspot reads more even (2026-06-30)

// ---------- feature density: weight dots toward eyes/nose/cheekbones ----------
// Morph-less head carries no feature data, so we locate the nose tip by geometry
// (frontmost central point) and place the other anchors as offsets from it. The
// offsets are tunable via URL params so a mislocated cluster is a quick nudge.
let FEAT = +(params.get("feat") || 0);  // master: 0 = even dust → up = features dense (the lock 2026-06-13)
let EDGE = +(params.get("edge") || 1.15);  // silhouette dissolve: 0 = none → up = face thins toward its outline. the discovery 2026-06-30: high EDGE is THE shape/modelling lever (w *= nz^(EDGE*4) in buildSamples — it STOPS placing dots on side-facing surfaces, so the cheeks read as empty, not shadowed). 1.3 = strong shape with the cheeks still holding some dots; push higher for more drama, lower for fuller cheeks. NOTE: fill light can't lift the cheeks because the dots aren't there — this is the dot knob, not a light knob.
const EYE_DX = +(params.get("eyeDx") ?? 0.035), EYE_DY = +(params.get("eyeDy") ?? 0.05), EYE_DZ = +(params.get("eyeDz") ?? -0.02);
const CHK_DX = +(params.get("chkDx") ?? 0.075), CHK_DY = +(params.get("chkDy") ?? -0.01), CHK_DZ = +(params.get("chkDz") ?? -0.045);
const EYE_S = +(params.get("eyeS") ?? 0.022), NOSE_S = +(params.get("noseS") ?? 0.03), CHK_S = +(params.get("chkS") ?? 0.05);
const noseTip = headCenter.clone();
if (faceMesh) {
  faceMesh.updateMatrixWorld();
  const mw = faceMesh.matrixWorld; // WORLD space, same reason as the mouth scan — local coords on the scaled bust give noseTip.z = -Infinity (fix 2026-06-24)
  const pos = faceMesh.geometry.attributes.position;
  const yLo = headCenter.y - 0.02, yHi = headCenter.y + 0.06;
  let maxz = -Infinity, nx = headCenter.x, ny = headCenter.y;
  for (let i = 0; i < pos.count; i++) { _tmp.fromBufferAttribute(pos, i).applyMatrix4(mw); if (_tmp.y >= yLo && _tmp.y <= yHi && Math.abs(_tmp.x - headCenter.x) < 0.03 && _tmp.z > maxz) { maxz = _tmp.z; nx = _tmp.x; ny = _tmp.y; } }
  noseTip.set(nx, ny, maxz);
}
const FEAT_ANCHORS = [
  { p: new THREE.Vector3(headCenter.x - EYE_DX, noseTip.y + EYE_DY, noseTip.z + EYE_DZ), s: EYE_S, w: 1.0 },  // eye L
  { p: new THREE.Vector3(headCenter.x + EYE_DX, noseTip.y + EYE_DY, noseTip.z + EYE_DZ), s: EYE_S, w: 1.0 },  // eye R
  { p: noseTip.clone(), s: NOSE_S, w: 0.7 },                                                                   // nose
  { p: new THREE.Vector3(headCenter.x - CHK_DX, noseTip.y + CHK_DY, noseTip.z + CHK_DZ), s: CHK_S, w: 0.6 },  // cheekbone L
  { p: new THREE.Vector3(headCenter.x + CHK_DX, noseTip.y + CHK_DY, noseTip.z + CHK_DZ), s: CHK_S, w: 0.6 },  // cheekbone R
];
dlog("[mouth]", procedural ? "procedural" : "morph-driven", "anchor", mouthAnchor.toArray().map((n) => n.toFixed(3)).join(","), "face", faceMesh && faceMesh.name);
dlog("[feature] noseTip", noseTip.toArray().map((n) => n.toFixed(3)).join(","));

// Resting framing. ?dist= sets her size (smaller = bigger in frame); ?lift= raises her by aiming a
// touch below head centre (portrait headroom, so she isn't peeking up from the bottom). Both are
// live-tunable so her look can be art-directed without code edits, matching the codebase's param style.
const FRAME_DIST = +(params.get("dist") ?? 0.90);
const FRAME_LIFT = +(params.get("lift") ?? 0.11);
const camDist = FRAME_DIST / state.zoom;
const yawRad = (state.yaw * Math.PI) / 180;
const aim = headCenter.clone().add(new THREE.Vector3(0, -FRAME_LIFT, 0)); // aim slightly below head centre
camera.position.copy(aim).add(new THREE.Vector3(Math.sin(yawRad) * camDist, 0.01, Math.cos(yawRad) * camDist));
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(aim);
controls.enableDamping = true;
// Gentle bounds (step 4): she can be nudged + zoomed, but never knocked off-kilter — pan off, distance
// and orbit angles clamped around the resting framing. The slide keeps distance constant, so no conflict.
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.minDistance = camDist * 0.6;
controls.maxDistance = camDist * 1.7;
controls.minPolarAngle = Math.PI / 2 - 0.5;
controls.maxPolarAngle = Math.PI / 2 + 0.4;
controls.minAzimuthAngle = -0.7;
controls.maxAzimuthAngle = 0.7;
controls.update();

// ---- drawer slide: her SIZE stays constant in both states; only her horizontal position changes.
// She's rendered centred in the #stage canvas, and the drawer narrows that canvas from the right, so
// she is automatically centred in whatever pane is visible — collapsing the drawer slides her from
// the left-pane centre to the full-window centre, at the SAME size (her pixel size depends on canvas
// HEIGHT, which never changes — only width does). All we do during the .35s CSS push is resize() each
// frame so the canvas tracks the animating width (smooth slide, no stretch). The camera distance is
// never touched, so her size is identical open vs collapsed. (2026-06-30, constant size, slide only)
const SLIDE_SECS = 0.35; // lockstep with the CSS drawer transition
let slideT = 1;          // 1 = settled; <1 = mid-transition, drives the per-frame resize()
function setDrawerMotion(animate) {
  slideT = animate ? 0 : 1;
  if (!animate) resize(); // snap-size for the no-animation default-open on first load
}

const baseHeadQuat = headBone ? headBone.quaternion.clone() : null;
const baseNeckQuat = neckBone ? neckBone.quaternion.clone() : null;

// ---------- surface sampling --------------------------------------------------
let samples = null;

function vertexSpeechiness(mesh) {
  const dict = mesh.morphTargetDictionary || {};
  const targets = mesh.geometry.morphAttributes.position || [];
  const n = mesh.geometry.attributes.position.count;
  const s = new Float32Array(n);
  let max = 0;
  for (const name of SPEECH_MORPHS) {
    const idx = dict[name];
    if (idx == null || !targets[idx]) continue;
    const a = targets[idx];
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(a.getX(i), a.getY(i), a.getZ(i));
      if (d > s[i]) s[i] = d;
      if (s[i] > max) max = s[i];
    }
  }
  if (max > 0) for (let i = 0; i < n; i++) s[i] /= max;
  return s;
}

function buildSamples() {
  applyMouthOffset(); // re-seat the mouth anchor from the live MOY/MOZ offsets before re-tagging mouth dots
  const eyeballSet = new Set(eyeballMeshes); // dots on these get real iris/pupil shading
  const tris = [];
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  let totalW = 0;

  // subsample hair vertices once, so we can cull skull/scalp dots that hair covers
  let hairPts = null;
  if (HAIR_CULL > 0) {
    hairPts = [];
    const _hp = new THREE.Vector3();
    for (const mesh of Object.values(meshes)) {
      if (meshKind.get(mesh) !== "hair") continue;
      const p = mesh.geometry.attributes.position;
      mesh.updateMatrixWorld();
      // world-space, so cull matches the FITTED hair (head verts are baked local≈world)
      for (let i = 0; i < p.count; i += 6) {
        _hp.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld);
        hairPts.push(_hp.x, _hp.y, _hp.z);
      }
    }
    if (!hairPts.length) hairPts = null;
  }

  // head-isolation cull extents (live-tunable). The headsculpt bust is larger than the
  // female/avatar heads, so its face needs a wider box or the sides + forehead get clipped.
  const bigHead = headSource === "headsculpt"; // large bust geometry needs a wider isolation box; the CC0 head is audition-scaled now, so it uses the standard box (same crop the tuned look was dialed on)
  const CULL_YDN = +(params.get("cullYDn") ?? (bigHead ? 0.34 : 0.30));
  const CULL_YUP = +(params.get("cullYUp") ?? (bigHead ? 0.44 : 0.26));
  const CULL_XHALF = +(params.get("cullX") ?? (bigHead ? 0.34 : 0.17));

  for (const mesh of Object.values(meshes)) {
    const cls = meshKind.get(mesh);
    if (cls === "skip") continue;
    if (cls === "eye" && !state.eyes) continue;
    const isEyeball = eyeballSet.has(mesh);
    const isTeeth = cls === "teeth";
    const kind = isTeeth ? "face" : cls;
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const index = geo.index;
    const speech = kind === "face" ? vertexSpeechiness(mesh) : null;
    const triCount = index.count / 3;
    for (let t = 0; t < triCount; t++) {
      const ia = index.getX(t * 3), ib = index.getX(t * 3 + 1), ic = index.getX(t * 3 + 2);
      v[0].fromBufferAttribute(pos, ia);
      v[1].fromBufferAttribute(pos, ib);
      v[2].fromBufferAttribute(pos, ic);
      // sample in WORLD space so culls/weights work for meshes carrying a live fit
      // transform (scaled bust, fitted hair). For the baked head this is identity.
      v[0].applyMatrix4(mesh.matrixWorld); v[1].applyMatrix4(mesh.matrixWorld); v[2].applyMatrix4(mesh.matrixWorld);
      if (kind === "body" || kind === "face") {
        // isolate the head column — Avaturn ships a full body in T-pose, so a
        // simple "below the shoulders" cut leaves the arms spread across frame.
        const cy = (v[0].y + v[1].y + v[2].y) / 3;
        const cx = (v[0].x + v[1].x + v[2].x) / 3;
        const cz = (v[0].z + v[1].z + v[2].z) / 3;
        if (cy < headCenter.y - CULL_YDN || cy > headCenter.y + CULL_YUP) continue; // neck..crown
        if (Math.abs(cx - headCenter.x) > CULL_XHALF) continue;             // kill the T-pose arms / over-wide box
        if (cz < headCenter.z - BACK_CULL) continue;                        // drop the back of the skull → read the face
        if (hairPts) {
          // where hair covers the head, don't render the skull beneath it — let hair show instead
          let covered = false;
          for (let h = 0; h < hairPts.length; h += 3) {
            // only cull when the hair is IN FRONT of this dot (covers it from the camera);
            // side/behind hair shouldn't delete front-face dots — that was the cheek splotches.
            if (hairPts[h + 2] < cz - 0.01) continue;
            const dx = cx - hairPts[h], dy = cy - hairPts[h + 1], dz = cz - hairPts[h + 2];
            if (dx * dx + dy * dy + dz * dz < HAIR_CULL * HAIR_CULL) { covered = true; break; }
          }
          if (covered) continue;
        }
      } else if (kind === "hair") {
        // particle render has no depth occlusion, so back-of-head hair projects onto
        // the face and fogs it. Drop hair behind the head, and hair that drapes past the jaw.
        const cx = (v[0].x + v[1].x + v[2].x) / 3;
        const cy = (v[0].y + v[1].y + v[2].y) / 3;
        const cz = (v[0].z + v[1].z + v[2].z) / 3;
        if (cz < headCenter.z - HAIR_BACK) continue;
        if (cy < headCenter.y - HAIR_DROP) continue;
        // hairline clear: remove hair raking across the central FOREHEAD (front-facing,
        // above the brow, near centre) so it reads as clean skin framed by the bob — kills
        // both the "five fingers" see-through strands and the hair-cull splotches.
        if (HAIRLINE > 0 && cz > headCenter.z - 0.03 &&
            cy > headCenter.y + 0.015 && cy < headCenter.y + HAIRLINE &&
            Math.abs(cx - headCenter.x) < 0.075) continue;
      }
      const _cross = v[1].clone().sub(v[0]).cross(v[2].clone().sub(v[0]));
      const area = _cross.length() / 2;
      if (area <= 0) continue;
      let w = area;
      if (speech) {
        const sp = (speech[ia] + speech[ib] + speech[ic]) / 3;
        w *= 1 + state.mouthBoost * sp;
      }
      if (isTeeth) w *= TEETH_WEIGHT;
      let mi = 0, mdy = 0;
      if (procedural && (kind === "face" || kind === "body")) {
        const cx = (v[0].x + v[1].x + v[2].x) / 3;
        const cyy = (v[0].y + v[1].y + v[2].y) / 3;
        const cz = (v[0].z + v[1].z + v[2].z) / 3;
        const dx = cx - mouthAnchor.x, dy = cyy - mouthAnchor.y, dz = cz - mouthAnchor.z;
        const dyA = dy * 1.5; // symmetric lip shell up AND down — the old *2.4/*1.0 skew fed a chin tongue (the 3rd cleft hole). mouthW is now only a >0.01 spatial GATE for the aperture, never a darkness magnitude (2026-06-24)
        mi = Math.exp(-(dx * dx + dyA * dyA + dz * dz) / (2 * MOUTH_SIGMA * MOUTH_SIGMA));
        mdy = dy;
        w *= 1 + state.mouthBoost * mi;   // densify the lips so the mouth reads
      }
      if ((kind === "face" || kind === "body") && (FEAT > 0 || EDGE > 0)) {
        const cx = (v[0].x + v[1].x + v[2].x) / 3;
        const cyy = (v[0].y + v[1].y + v[2].y) / 3;
        const cz = (v[0].z + v[1].z + v[2].z) / 3;
        if (FEAT > 0) {
          let boost = 0;
          for (const a of FEAT_ANCHORS) {
            const ddx = cx - a.p.x, ddy = cyy - a.p.y, ddz = cz - a.p.z;
            boost += a.w * Math.exp(-(ddx * ddx + ddy * ddy + ddz * ddz) / (2 * a.s * a.s));
          }
          w *= 1 + FEAT * boost;          // eyes/nose/cheekbones pull more dots in
        }
        if (EDGE > 0) {
          const nz = _cross.z / (2 * area); // normal toward +z (camera); silhouette nz→0 thins out
          let edgePow = EDGE * 4;
          if (NOSE_DOTS > 0) { // in the nose-base region, EASE the thinning so the down-facing nostril WINGS + alar flare keep their dots. Restores dots exactly where EDGE stripped them (the dark creases) — the front-facing bridge (nz≈1) is untouched, so no blob. Region widened + raised to cover the alar flare sides. (2026-06-30)
            const ndx = cx - headCenter.x, ndy = cyy - (noseTip.y - 0.063), ndz = cz - (noseTip.z - 0.02);
            const nreg = Math.exp(-(ndx * ndx / (2 * 0.060 * 0.060) + ndy * ndy / (2 * 0.030 * 0.030) + ndz * ndz / (2 * 0.055 * 0.055)));
            edgePow *= Math.max(0, 1 - NOSE_DOTS * nreg); // NOSE_DOTS in 0..1: at the crease centre the thinning drops toward 0, so the stripped wings fill back in
          }
          w *= Math.pow(Math.max(nz, 0), edgePow);
        }
        if (NASION_EVEN > 0) { // gently thin the over-dense nasion (top of the bridge, between the brows) so it stops reading as a hotspot — evens the bright spot we flagged
          const mx = cx - headCenter.x, my = cyy - (headCenter.y - 0.005), mz = cz - (noseTip.z - 0.02);
          const mreg = Math.exp(-(mx * mx / (2 * 0.032 * 0.032) + my * my / (2 * 0.032 * 0.032) + mz * mz / (2 * 0.055 * 0.055)));
          w *= 1 - NASION_EVEN * mreg;
        }
      }
      if (EYE_DENSITY > 0 && (kind === "face" || kind === "body")) {
        // pack dots into the eye discs where they've been placed (same centres as the per-frame eye)
        const cx = (v[0].x + v[1].x + v[2].x) / 3, cyy = (v[0].y + v[1].y + v[2].y) / 3;
        const ex = cx - (cx < headCenter.x ? headCenter.x - EYE_SEP : headCenter.x + EYE_SEP);
        const ey = cyy - (headCenter.y + EYE_H);
        const rr = Math.sqrt(ex * ex + ey * ey) / (EYE_R * 1.2);
        if (rr < 1) w *= 1 + EYE_DENSITY * (1 - rr);
      }
      tris.push({ mesh, ia, ib, ic, w, kind, mi, mdy, eyeball: isEyeball ? 1 : 0 });
      totalW += w;
    }
  }

  // split the triangle pool: face/body/eye/teeth draw from the FACE budget, hair from
  // its OWN budget — so hair density never steals dots from her face (2026-06-14).
  const faceTris = [], hairTris = [];
  for (const t of tris) (t.kind === "hair" ? hairTris : faceTris).push(t);
  let faceW = 0; for (const t of faceTris) faceW += t.w;
  let hairW = 0; for (const t of hairTris) hairW += t.w;
  const Nface = faceTris.length ? state.density : 0;
  const Nhair = (hairTris.length && hairW > 0) ? state.hairDensity : 0;
  const N = Nface + Nhair;

  const meshList = [...new Set(tris.map((t) => t.mesh))];
  const meshIdx = new Map(meshList.map((m, i) => [m, i]));
  const sm = {
    meshList,
    tri: new Uint32Array(N * 3),
    triMesh: new Uint8Array(N),
    bary: new Float32Array(N * 3),
    kind: new Uint8Array(N),
    phase: new Float32Array(N * 3),
    mouthW: new Float32Array(N),   // 0..1 proximity to the lips
    mdy: new Float32Array(N),      // signed height vs the lip line (upper/lower)
    size: new Float32Array(N),     // per-point size ratio (face = 1, hair = state.hairDot)
    eyeball: new Uint8Array(N),    // 1 = dot lives on a real eyeball mesh (gets iris/pupil)
  };
  const KIND = { face: 0, eye: 1, hair: 2, body: 3 };

  // sample `count` dots from one triangle list (its own CDF), writing into sm at [start..)
  const sampleInto = (start, count, list, listW, sizeRatio) => {
    if (!count || !list.length || listW <= 0) return;
    const cdf = new Float64Array(list.length);
    let acc = 0; for (let i = 0; i < list.length; i++) { acc += list[i].w; cdf[i] = acc; }
    for (let k = 0; k < count; k++) {
      const i = start + k;
      const r = Math.random() * listW;
      let lo = 0, hi = list.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; cdf[mid] < r ? (lo = mid + 1) : (hi = mid); }
      const t = list[lo];
      let a = Math.random(), b = Math.random();
      if (a + b > 1) { a = 1 - a; b = 1 - b; }
      sm.tri[i * 3] = t.ia; sm.tri[i * 3 + 1] = t.ib; sm.tri[i * 3 + 2] = t.ic;
      sm.triMesh[i] = meshIdx.get(t.mesh);
      sm.bary[i * 3] = a; sm.bary[i * 3 + 1] = b; sm.bary[i * 3 + 2] = 1 - a - b;
      sm.kind[i] = KIND[t.kind];
      sm.mouthW[i] = t.mi || 0;
      sm.mdy[i] = t.mdy || 0;
      sm.size[i] = sizeRatio;
      sm.eyeball[i] = t.eyeball || 0;
      sm.phase[i * 3] = Math.random() * Math.PI * 2;
      sm.phase[i * 3 + 1] = Math.random() * Math.PI * 2;
      sm.phase[i * 3 + 2] = Math.random() * Math.PI * 2;
    }
  };
  sampleInto(0, Nface, faceTris, faceW, 1.0);
  sampleInto(Nface, Nhair, hairTris, hairW, state.hairDot);

  sm.used = meshList.map((mesh, mi) => {
    const set = new Set();
    for (let i = 0; i < N; i++) if (sm.triMesh[i] === mi) {
      set.add(sm.tri[i * 3]); set.add(sm.tri[i * 3 + 1]); set.add(sm.tri[i * 3 + 2]);
    }
    const ids = Uint32Array.from(set);
    const remap = new Map();
    ids.forEach((vid, k) => remap.set(vid, k));
    return { mesh, ids, remap, world: new Float32Array(ids.length * 3), restWorld: new Float32Array(ids.length * 3) };
  });
  for (let i = 0; i < N; i++) {
    const u = sm.used[sm.triMesh[i]];
    sm.tri[i * 3] = u.remap.get(sm.tri[i * 3]);
    sm.tri[i * 3 + 1] = u.remap.get(sm.tri[i * 3 + 1]);
    sm.tri[i * 3 + 2] = u.remap.get(sm.tri[i * 3 + 2]);
  }

  if (points) { points.geometry.dispose(); scene.remove(points); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  const colors = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const c = sm.kind[i] === 2 ? (0.55 + Math.random() * 0.45) * HAIR_BRIGHT : 0.75 + Math.random() * 0.25;
    colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = c;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setAttribute("aSize", new THREE.BufferAttribute(sm.size, 1)); // per-point size: hair smaller than face
  sm.col0 = colors.slice(); // rest colours, restored as the mouth closes
  points = new THREE.Points(geo, material);
  points.frustumCulled = false;
  scene.add(points);

  samples = sm;
  captureRest(); // grab each used vertex's neutral world pos (mouth closed) for the cheek-freeze
  updateDotSize();
  stamp();
}

function updateDotSize() {
  // dots shrink as density rises so coverage stays ~constant (keeps the scan/particle read)
  const base = 0.0022 * Math.sqrt(50000 / state.density);
  material.size = base * state.dotScale;
}

// ---------- per-frame surface evaluation --------------------------------------
const _v = new THREE.Vector3();
// Capture each used vertex's NEUTRAL (all-morphs-zeroed) world position so the cheek-freeze
// can blend talking dots back toward rest. Re-run after every buildSamples (samples rebuilt).
function captureRest() {
  if (!samples) return;
  const saved = samples.used.map((u) => {
    const inf = u.mesh.morphTargetInfluences;
    const copy = inf ? inf.slice() : null; // morphTargetInfluences is a plain Array, not a TypedArray
    if (inf) inf.fill(0);
    return copy;
  });
  for (const u of samples.used) {
    u.mesh.updateMatrixWorld();
    for (let k = 0; k < u.ids.length; k++) {
      u.mesh.getVertexPosition(u.ids[k], _v);
      _v.applyMatrix4(u.mesh.matrixWorld);
      u.restWorld[k * 3] = _v.x; u.restWorld[k * 3 + 1] = _v.y; u.restWorld[k * 3 + 2] = _v.z;
    }
  }
  samples.used.forEach((u, j) => { const s = saved[j]; if (s) { const cur = u.mesh.morphTargetInfluences; for (let m = 0; m < s.length; m++) cur[m] = s[m]; } });
}
function updateParticles(time) {
  const sm = samples;
  if (!sm) return;
  for (const u of sm.used) {
    u.mesh.updateMatrixWorld();
    for (let k = 0; k < u.ids.length; k++) {
      u.mesh.getVertexPosition(u.ids[k], _v);
      _v.applyMatrix4(u.mesh.matrixWorld);
      u.world[k * 3] = _v.x; u.world[k * 3 + 1] = _v.y; u.world[k * 3 + 2] = _v.z;
    }
  }
  const pos = points.geometry.attributes.position.array;
  const col = points.geometry.attributes.color.array;
  const N = sm.kind.length;
  const hairAmp = 0.004 * state.hairChaos;
  const shimmer = 0.00035;
  const mouthActive = mouthOpen > 0.002;
  const doMouth = procedural && (mouthActive || mouthWasActive);
  // smooth auto-drives (depend only on time → computed once per frame, not per particle).
  // Contour: three incommensurate waves roam 0↔1 organically — always moving (no stop-start),
  // never quite repeating. STRI_AUTO scales the overall speed.
  let striContour = STRI_CONTOUR;
  if (STRI_AUTO > 0) {
    const t = time * STRI_AUTO;
    striContour = 0.5 + 0.5 * (0.55 * Math.sin(t * 0.25) + 0.30 * Math.sin(t * 0.45) + 0.15 * Math.sin(t * 0.65));
  }
  // Spacing: breathes up by the drift amount and back on a ~6s cycle.
  let striSpace = STRI_SPACE;
  if (STRI_DRIFT > 0) striSpace += STRI_DRIFT * (0.5 + 0.5 * Math.sin(time * 1.0));
  // beauty rig: key direction (shape) + fill direction (lifts the shadow side) + ambient floor.
  const Lx = Math.sin(LIGHT_AZ) * Math.cos(LIGHT_EL), Ly = Math.sin(LIGHT_EL), Lz = Math.cos(LIGHT_AZ) * Math.cos(LIGHT_EL);
  const Fx = Math.sin(FILL_AZ) * Math.cos(FILL_EL), Fy = Math.sin(FILL_EL), Fz = Math.cos(FILL_AZ) * Math.cos(FILL_EL);
  // ambient floor: LIGHT is now "shadow darkness". 0 = no shadows (flat), 1 = floor hits
  // pure BLACK so the shadow side crushes to nothing (real contrast, not muddy grey).
  const ambient = Math.max(0, 1 - LIGHT);
  // eye centres (live, placeable) and the blink pulse.
  const eyeLx = headCenter.x - EYE_SEP, eyeRx = headCenter.x + EYE_SEP, eyeY = headCenter.y + EYE_H;
  let blink = 0;
  if (BLINK > 0) {
    const cyc = time * BLINK / 4, f = cyc - Math.floor(cyc), dur = 0.09;
    if (f < dur) blink = Math.sin((f / dur) * Math.PI); // 0 → 1 (shut) → 0
  }
  for (let i = 0; i < N; i++) {
    const u = sm.used[sm.triMesh[i]];
    const ia = sm.tri[i * 3] * 3, ib = sm.tri[i * 3 + 1] * 3, ic = sm.tri[i * 3 + 2] * 3;
    const a = sm.bary[i * 3], b = sm.bary[i * 3 + 1], c = sm.bary[i * 3 + 2];
    let x = a * u.world[ia] + b * u.world[ib] + c * u.world[ic];
    let y = a * u.world[ia + 1] + b * u.world[ib + 1] + c * u.world[ic + 1];
    let z = a * u.world[ia + 2] + b * u.world[ib + 2] + c * u.world[ic + 2];
    const p0 = sm.phase[i * 3], p1 = sm.phase[i * 3 + 1], p2 = sm.phase[i * 3 + 2];
    if (sm.kind[i] === 2) {
      x += Math.sin(time * 1.9 + p0) * Math.sin(time * 0.7 + p1) * hairAmp;
      y += Math.sin(time * 1.3 + p1) * hairAmp * 0.8;
      z += Math.sin(time * 2.3 + p2) * Math.sin(time * 0.9 + p0) * hairAmp;
    } else {
      x += Math.sin(time * 3.1 + p0) * shimmer;
      y += Math.sin(time * 2.6 + p1) * shimmer;
      z += Math.sin(time * 3.7 + p2) * shimmer;
    }
    // cheek-movement falloff (2026-06-30): native viseme blendshapes ride the upper cheeks up
    // toward the ears. Hold those dots toward their no-mouth REST while lips/jaw (at/below the
    // mouth) keep full motion; spare the eyelids by proximity so blinks survive.
    if (CHEEK_FREEZE > 0 && sm.kind[i] !== 2 && !sm.eyeball[i]) {
      const rx = a * u.restWorld[ia] + b * u.restWorld[ib] + c * u.restWorld[ic];
      const ry = a * u.restWorld[ia + 1] + b * u.restWorld[ib + 1] + c * u.restWorld[ic + 1];
      const rz = a * u.restWorld[ia + 2] + b * u.restWorld[ib + 2] + c * u.restWorld[ic + 2];
      const above = (ry - mouthAnchor.y) / CHEEK_RISE;            // 0 at the mouth → 1 a CHEEK_RISE above; lips/jaw stay free
      const rise = above <= 0 ? 0 : above >= 1 ? 1 : above;
      const edl = (rx - eyeLx) * (rx - eyeLx) + (ry - eyeY) * (ry - eyeY);
      const edr = (rx - eyeRx) * (rx - eyeRx) + (ry - eyeY) * (ry - eyeY);
      const eyeDist = Math.sqrt(edl < edr ? edl : edr);          // distance to the nearer eye centre
      const ep = (eyeDist - EYE_SPARE) / EYE_SPARE_RAMP;         // spare the eyelids (blinks): 0 within EYE_SPARE → 1 beyond EYE_SPARE+EYE_SPARE_RAMP
      const eyeProtect = ep <= 0 ? 0 : ep >= 1 ? 1 : ep;
      const f = CHEEK_FREEZE * rise * eyeProtect;
      if (f > 0) { x += (rx - x) * f; y += (ry - y) * f; z += (rz - z) * f; }
    }
    let dark = 0; // mouth-interior darkening, applied with the lighting at the end
    if (doMouth && sm.mouthW[i] > 0.01) {
      // OPTIONAL symmetric lip-part (default ULIP=0 → no motion). Split by CURRENT y vs the
      // one shared anchor, NOT by static sm.mdy, so the cloud can never tear into two groups.
      if (ULIP > 0) {
        const dxm0 = x - mouthAnchor.x;
        const cornerP = Math.max(0, 1 - (dxm0 * dxm0) / (MOUTH_CW * MOUTH_CW));
        const op = mouthOpen * sm.mouthW[i] * cornerP;
        y += (y >= mouthAnchor.y ? ULIP : -1.0) * op * JAW * 0.4; // gentle, symmetric-ish ease
      }
      // pucker(−)/spread(+): horizontal lip motion only, gated by openness
      x += (x - mouthAnchor.x) * 0.5 * mouthWide * mouthOpen * sm.mouthW[i];
    }
    // striation: pull each dot toward the nearest band, along the band's gradient.
    // shape ≈ 0 next to a line (dot stays) → 1 mid-gap (dot snaps in), so the gaps
    // darken and the lines sharpen as crispness rises. The band coordinate morphs
    // from height (horizontal scan-lines) toward radial distance (topographic
    // contour rings) as Contour rises. Hair keeps its drift.
    if (STRI > 0 && sm.kind[i] !== 2 && sm.mouthW[i] < 0.5) { // keep scan-lines out of the lip ring / opening edge (2026-06-24)
      let band = y - STRI_Y0, gx = 0, gy = 1, gz = 0;       // horizontal: coord = height, gradient = +y
      if (striContour > 0) {
        const rx = x - STRI_FOCAL.x, ry = y - STRI_FOCAL.y, rz = z - STRI_FOCAL.z;
        const rad = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1e-6;
        band = band * (1 - striContour) + rad * striContour;
        gx = gx * (1 - striContour) + (rx / rad) * striContour;
        gy = gy * (1 - striContour) + (ry / rad) * striContour;
        gz = gz * (1 - striContour) + (rz / rad) * striContour;
      }
      const q = band / striSpace;
      const ri = Math.round(q);
      const frac = q - ri;                                  // signed dist to nearest band, [-0.5, 0.5]
      const shape = Math.pow(Math.abs(frac) * 2, 1 + STRI_CRISP * 5);
      const d = (ri - q) * striSpace * STRI * shape;        // move along the gradient, in world units
      x += gx * d; y += gy * d; z += gz * d;
    }
    let glow = 0, eyeHit = false; // hoisted above the mouth aperture: both the lip rim and the eye add to glow
    // ---- DRAWN-APERTURE MOUTH (2026-06-24): the dark opening is a REGION recomputed each
    //      frame from where the lips CURRENTLY are — never a value stamped on a dot. One
    //      ellipse → one contiguous hole, so it cannot tear into two bands or a cleft blob.
    if (doMouth && sm.mouthW[i] > 0.01) {
      const dxm = x - mouthAnchor.x;
      const dym = y - mouthAnchor.y;
      const apH = Math.max(1e-4, JAW * mouthOpen);                                 // half-height ← opening × viseme openness
      const apW = Math.max(1e-4, MOUTH_CW * (1 + 0.45 * Math.max(0, mouthWide))    // spreads widen (E/I)
                                          / (1 + 0.55 * Math.max(0, -mouthWide))); // puckers narrow (O/U)
      const rN = Math.sqrt((dxm * dxm) / (apW * apW) + (dym * dym) / (apH * apH));
      const openGate = mouthOpen * mouthOpen * (3 - 2 * mouthOpen);                // smoothstep(mouthOpen): closures (PP/sil/FF) → ~0, no phantom hole
      if (rN < 1) {                                  // INSIDE the opening → extinguish so the black background shows through
        const soft = Math.min(1, (1 - rN) / 0.30);  // 1–2 dot feather at the inner lip edge
        dark = Math.max(dark, Math.min(1, VOID) * soft * openGate);
      } else if (rN < 1.35 && RIM_GLOW > 0) {        // the lit LIP RIM just outside the opening
        glow += RIM_GLOW * (1 - (rN - 1) / 0.35) * openGate;
      }
    }
    // ---- EYES: iris + pupil --------------------------------------------------
    if (sm.kind[i] !== 2) {
      const onRight = x >= headCenter.x;
      if (hasRealEyes && sm.eyeball[i]) {
        // REAL eyeball: shade by radius from the sphere's forward (+z) pole — black pupil
        // core inside a mid-grey iris ring (darkening to a limbal rim) inside white sclera.
        // Anchored on the ACTUAL geometry. The eyeball holds a steady forward gaze (the gaze
        // saccade is suppressed when hasRealEyes), so the +z pole is the cornea. (2026-06-24)
        const e = onRight ? (eyeballR || eyeballL) : (eyeballL || eyeballR);
        if (e) {
          const dx = x - e.c.x, dy = y - e.c.y, dz = z - e.c.z;
          if (dz > -e.r * 0.25) {                            // FRONT cap only (toward camera)
            const rr = Math.sqrt(dx * dx + dy * dy) / e.r;   // 0 at the pole … 1 at the equator
            if (rr < IRIS_IR) {
              eyeHit = true;
              if (rr < IRIS_PR) {
                dark = Math.max(dark, IRIS_PUPIL);           // PUPIL — black core
              } else {
                const tt = (rr - IRIS_PR) / Math.max(1e-4, IRIS_IR - IRIS_PR); // 0 inner … 1 limbus
                dark = Math.max(dark, IRIS_DARK + IRIS_LIMBAL * tt * tt);       // iris, darkening to the rim
              }
            }
            if (IRIS_CATCH > 0) {                            // catch-light: a small upper-nasal spark
              const clx = dx - (onRight ? -1 : 1) * e.r * 0.20, cly = dy - e.r * 0.24;
              const cs = e.r * 0.16;
              glow += IRIS_CATCH * Math.exp(-(clx * clx + cly * cly) / (2 * cs * cs));
            }
          }
        }
      } else {
        // FACE/lid dots (real-eye heads) OR every dot (rig-less heads): one eye-centre delta
        // + sqrt, shared by the rig-less disc AND the orbital socket (restores the single-sqrt
        // the old code had). Eyeball dots never reach here, so the sclera is never socket-darkened.
        const ecx = x - (onRight ? eyeRx : eyeLx), ecy = y - eyeY;
        const er = Math.sqrt(ecx * ecx + ecy * ecy);
        if (!hasRealEyes && EYE_R > 0 && er < EYE_R) {
          // rig-less head with NO eye geometry: the placed disc IS the iris + pupil (dark core,
          // bright iris ring out to the rim). No eyelid here, so no blink. (preserved verbatim)
          eyeHit = true;
          const r = er / EYE_R;                              // 0 centre … 1 rim
          if (r < 0.45) { if (EYE_PUPIL > 0) dark = Math.max(dark, EYE_PUPIL); }
          else if (EYEGLOW > 0) glow = EYEGLOW * (r < 0.9 ? 1 : (1 - r) / 0.1);
        }
        // orbital socket: darken a ring of FACE/lid dots around the eye, deepest at the upper-
        // lid crease — seats the eye.
        if (SOCKET > 0) {
          const sr = er / (EYE_R * 2.6);
          if (sr > 0.35 && sr < 1) {
            const ring = Math.sin(((sr - 0.35) / 0.65) * Math.PI); // 0 at edges → 1 mid-ring
            dark = Math.max(dark, SOCKET * ring * (ecy > 0 ? 1 : 0.35)); // crease above is darkest
          }
        }
      }
    }
    // nose relief: bright central bridge, shadowed nostril wings below the tip
    if (NOSE_DEF > 0 && sm.kind[i] !== 2) {
      const nx2 = x - headCenter.x, ny2 = y - headCenter.y;
      if (ny2 > -0.05 && ny2 < 0.06) {
        glow += NOSE_DEF * Math.exp(-(nx2 * nx2) / (2 * 0.009 * 0.009)) * 0.6; // bridge highlight
        if (ny2 < -0.005) {
          const d = Math.abs(nx2) - 0.016;
          dark = Math.max(dark, NOSE_DEF * Math.exp(-(d * d) / (2 * 0.009 * 0.009)) * 0.2); // nostril shadow (softened from 0.5 so the wings stop reading black — beauty re-tune 2026-06-30)
        }
      }
    }
    // directional shading: brightness from the dot's outward surface normal vs the key AND fill.
    // Hair is lit too now, so the light bounces off hair rather than the skull beneath.
    let lit = 1;
    if (LIGHT > 0 || FILL > 0) {
      const e1x = u.world[ib] - u.world[ia], e1y = u.world[ib + 1] - u.world[ia + 1], e1z = u.world[ib + 2] - u.world[ia + 2];
      const e2x = u.world[ic] - u.world[ia], e2y = u.world[ic + 1] - u.world[ia + 1], e2z = u.world[ic + 2] - u.world[ia + 2];
      let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      if (nx * (x - headCenter.x) + ny * (y - headCenter.y) + nz * (z - headCenter.z) < 0) { nx = -nx; ny = -ny; nz = -nz; } // outward
      const ndlK = Math.max(0, nx * Lx + ny * Ly + nz * Lz);  // key  → shape gradient
      const ndlF = Math.max(0, nx * Fx + ny * Fy + nz * Fz);  // fill → lifts the shadow side
      const rawK = nx * Lx + ny * Ly + nz * Lz;               // raw key dot (unclamped) for the soft wrap
      const key = SOFT > 0
        ? Math.pow(Math.max(0, (rawK + SOFT) / (1 + SOFT)), MODEL) // SOFTBOX: wrap the key broadly around the form → large soft source. Exponent is MODEL now (was a dead hardcoded 2) so the Modeling slider actually drives soft-key contrast (2026-06-30)
        : (MODEL === 1 ? ndlK : Math.pow(ndlK, MODEL));        // hard key (current default): punchy concentrated sculpting
      lit = ambient + (1 - ambient) * key + FILL * ndlF;
    }
    let vcomp = 1;
    if (VFLAT > 0) { const dyc = (y - headCenter.y) / VFLAT_Y; vcomp = Math.min(1.8, Math.max(0.25, 1 - VFLAT * dyc)); } // dim the dense crown (dyc>0), lift the sparse jaw (dyc<0) so the additive sum is even top-to-bottom
    let g = lit * (1 - dark) * (1 + glow) * EXPOSURE * vcomp;
    if (g > ROLL_KNEE) g = ROLL_KNEE + (ROLL_CEIL - ROLL_KNEE) * (1 - Math.exp(-(g - ROLL_KNEE) / (ROLL_CEIL - ROLL_KNEE))); // highlight rolloff: soft shoulder so the forehead can't clip to a flat white blob
    col[i * 3] = sm.col0[i * 3] * g;
    col[i * 3 + 1] = sm.col0[i * 3 + 1] * g;
    col[i * 3 + 2] = sm.col0[i * 3 + 2] * g;
    if (EYE_DEBUG && eyeHit) { col[i * 3] = 1; col[i * 3 + 1] = 0.1; col[i * 3 + 2] = 0.1; } // placement aid
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
  }
  points.geometry.attributes.position.needsUpdate = true;
  points.geometry.attributes.color.needsUpdate = true;
  mouthWasActive = mouthActive;
}

// ---------- morph control: visemes, blinks, idle -------------------------------
const morphTargets = {};
function setMorph(name, v) { morphTargets[name] = v; }

function applyMorphs(dt) {
  for (const mesh of morphMeshes) {
    const dict = mesh.morphTargetDictionary;
    const inf = mesh.morphTargetInfluences;
    for (const [name, target] of Object.entries(morphTargets)) {
      const idx = dict[name];
      if (idx == null) continue;
      const cur = inf[idx];
      const rate = target > cur ? 22 : 14;
      inf[idx] = cur + (target - cur) * Math.min(1, rate * dt);
    }
  }
}

// procedural mouth state — drives the original's morph-less T1 head from the active
// viseme. [openness 0..1, width −1 pucker .. +1 spread] per viseme.
const MOUTH = {
  sil: [0, 0], PP: [0, 0], FF: [0.12, 0.05], DD: [0.25, 0.1], TH: [0.2, 0.1],
  kk: [0.3, 0.1], CH: [0.25, 0.2], SS: [0.15, 0.25], nn: [0.2, 0.05], RR: [0.3, -0.1],
  aa: [0.82, 0.25], E: [0.5, 0.6], I: [0.38, 0.75], O: [0.55, -0.55], U: [0.38, -0.75],
};
let mouthOpen = 0, mouthWide = 0, mouthWasActive = false, activeViseme = "sil";
function updateMouth(dt) {
  const m = MOUTH[activeViseme] || MOUTH.sil;
  mouthOpen += (m[0] - mouthOpen) * Math.min(1, (m[0] > mouthOpen ? 18 : 12) * dt);
  mouthWide += (m[1] - mouthWide) * Math.min(1, 14 * dt);
  // strong-E / I smile: spread the lip corners as she says "easy / bees / knees". Driven by the
  // wide signal (only the strong spreads, E/I, clear the 0.4 gate) so it eases in/out with the viseme.
  const smile = SMILE_DBG != null ? SMILE_DBG : E_SMILE * Math.max(0, Math.min(1, (mouthWide - 0.4) / 0.35));
  setMorph("mouthSmileLeft", smile); setMorph("mouthSmileRight", smile);
}

let nextBlink = 2, blinkT = -1;
function updateBlink(t, dt) {
  if (blinkT < 0 && t > nextBlink) { blinkT = 0; nextBlink = t + 2.5 + Math.random() * 3.5; }
  if (blinkT >= 0) {
    blinkT += dt;
    const k = blinkT / 0.16;
    const v = k < 0.5 ? k * 2 : Math.max(0, 2 - k * 2);
    setMorph("eyeBlinkLeft", v);
    setMorph("eyeBlinkRight", v);
    if (k >= 1) blinkT = -1;
  }
}

let nextSaccade = 3;
function updateIdle(t) {
  const rx = Math.sin(t * 0.31) * 0.025 + Math.sin(t * 0.83) * 0.012;
  const ry = Math.sin(t * 0.23) * 0.045 + Math.sin(t * 0.61) * 0.015;
  const rz = Math.sin(t * 0.17) * 0.015;
  if (headBone) headBone.quaternion.copy(baseHeadQuat).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)));
  if (neckBone) neckBone.quaternion.copy(baseNeckQuat).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(rx * 0.4, ry * 0.4, rz * 0.4)));
  if (t > nextSaccade && (!hasRealEyes || GAZE_DART)) {
    // gaze darts move the real eyeball geometry, but the procedural iris is anchored to the
    // fixed +z pole and would NOT follow — so with real eyes we hold a steady forward stare
    // (a crisp, centred iris, which is the intent). ?gaze=1 overrides. (2026-06-24)
    nextSaccade = t + 1.5 + Math.random() * 4;
    const h = (Math.random() - 0.5) * 0.7, vv = (Math.random() - 0.5) * 0.3;
    setMorph("eyeLookOutLeft", Math.max(0, -h)); setMorph("eyeLookInLeft", Math.max(0, h));
    setMorph("eyeLookOutRight", Math.max(0, h)); setMorph("eyeLookInRight", Math.max(0, -h));
    setMorph("eyesLookUp", Math.max(0, vv)); setMorph("eyesLookDown", Math.max(0, -vv));
  }
}

// ---------- speech: HeadTTS bf_isabella, native visemes on the audio clock ------
// Voice endpoint is configurable, like the bridge ports: ?ttsUrl=… overrides the whole URL, else
// ?ttsPort=… overrides just the local port (default 8882). If the server is absent the fetch in speak()
// is caught and shown as a status note — the face keeps rendering, nothing crashes.
const TTS_URL = params.get("ttsUrl") || `http://127.0.0.1:${params.get("ttsPort") || "8882"}/v1/synthesize`;
const VOICE = "bf_isabella";
const ALL_VISEMES = ["viseme_sil","viseme_PP","viseme_FF","viseme_TH","viseme_DD","viseme_kk","viseme_CH","viseme_SS","viseme_nn","viseme_RR","viseme_aa","viseme_E","viseme_I","viseme_O","viseme_U"];

const PARAGRAPH =
  "Hello there. This is the moment we have been building toward: my voice and my face, finally in the same room. " +
  "Every word you hear is shaping the cloud you are watching — twenty thousand points of light, dancing to millisecond timing. " +
  "No more guesswork, and no more lag at the end of a sentence. When I stop speaking, the dots stop moving. " +
  "Rather satisfying, isn't it? Now — shall we make me beautiful?";

let audioCtx = null;
let currentSource = null;
let track = null; // { v, t, d, startAt, cursor } — visemes scheduled on the audio clock
let mouthLoop = false;
let speakGen = 0; // bumped on every speak()/stopSpeaking() so a slower in-flight speak() self-cancels between its awaits (no overlapping audio)

// Master audio bus: a GainNode (mute) + an AnalyserNode (level tap for the voice meter), built lazily on
// first audio. Sources connect INTO the analyser (pre-gain), so the meter still dances while muted. (2026-06-30)
let masterGain = null, analyser = null, meterFreq = null, muted = false, volume = 1;
function ensureBus() {
  if (!audioCtx) return null;
  if (!masterGain) {
    masterGain = audioCtx.createGain();
    masterGain.gain.value = muted ? 0 : volume;
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;
    analyser.connect(masterGain);
    masterGain.connect(audioCtx.destination);
  }
  return analyser; // sources connect here (pre-gain), not straight to destination
}
function setMuted(on) {
  muted = !!on;
  if (masterGain) masterGain.gain.value = muted ? 0 : volume;
  const b = document.getElementById("muteBtn");
  if (b) { b.classList.toggle("muted", muted); b.setAttribute("aria-label", muted ? "Unmute" : "Mute"); }
}
function setConnected(on) { const p = document.getElementById("idpill"); if (p) p.classList.toggle("online", !!on); }

const statusEl = document.getElementById("status");
function setStatus(msg) {
  statusEl.textContent = msg;
  const sl = document.getElementById("statusLine"); // mirror into the drawer footer (app mode hides #status)
  if (sl) sl.textContent = msg;
}

// Persistent REPL-style status bar: model · context% · tokens burned. Its own element (#statusbar),
// so the transient #statusLine that setStatus() clobbers can't fight it.
const MODEL_LABELS = { "claude-sonnet-4-6": "Sonnet 4.6", "claude-opus-4-8": "Opus 4.8", mock: "mock" };
function modelLabel(id) {
  if (!id) return "?";
  if (MODEL_LABELS[id]) return MODEL_LABELS[id];
  return id.replace(/^claude-/, "").replace(/-\d{8}$/, ""); // unknown id: tidy it rather than dump the raw string
}
function setStatusBar(meta) {
  const el = document.getElementById("statusbar");
  if (!el || !meta) return;
  const b = meta.burned || 0;
  const k = b >= 1000 ? (b / 1000).toFixed(1) + "k" : String(b);
  el.textContent = `${modelLabel(meta.model)} · ${meta.ctxPct || 0}% context · ${k} burned`;
}

function clearVisemes() {
  ALL_VISEMES.forEach((v) => setMorph(v, 0));
}

async function speak(text, done) {
  stopSpeaking();
  const myGen = ++speakGen;          // any later speak()/stopSpeaking() invalidates this call between its awaits
  let finished = false;
  const fin = () => { if (finished) return; finished = true; if (done) done(); }; // fire the completion hook once
  setStatus("synthesizing…");
  const t0 = performance.now();
  let data;
  try {
    const res = await fetch(TTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: text, voice: VOICE, language: "en-us", speed: 1, audioEncoding: "wav" }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    if (myGen !== speakGen) return;  // a newer line already took over (barge-in owns continuation)
    setStatus(`voice server unreachable — start it: cd spikes/s3-voice-bakeoff/headtts && npm start (${err.message})`);
    fin();                            // genuine terminal — let any queued sentence proceed
    return;
  }
  if (myGen !== speakGen) return;    // superseded while synthesizing — drop this one
  const synthMs = Math.round(performance.now() - t0);

  try {
    audioCtx ||= new AudioContext();
    if (audioCtx.state === "suspended") await audioCtx.resume();
    if (myGen !== speakGen) return;  // superseded while unlocking audio
    const bytes = Uint8Array.from(atob(data.audio), (c) => c.charCodeAt(0));
    const buffer = await audioCtx.decodeAudioData(bytes.buffer);
    if (myGen !== speakGen) return;  // superseded while decoding — never start a stale source

    const startAt = audioCtx.currentTime + 0.06; // tiny scheduling cushion
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(ensureBus() || audioCtx.destination); // through master gain (mute) + analyser (voice meter)
    src.start(startAt);
    currentSource = src;
    track = { v: data.visemes, t: data.vtimes, d: data.vdurations, startAt, cursor: 0 };
    src.onended = () => {
      if (currentSource !== src) return;  // superseded/cancelled — barge-in owns the queue, don't advance
      currentSource = null;
      track = null;
      activeViseme = "sil";
      clearVisemes();
      setStatus("idle — lips stopped with the audio");
      fin();                            // natural end — let the next queued sentence speak
    };
    setStatus(`speaking — synth ${synthMs}ms · audio ${buffer.duration.toFixed(1)}s · ${data.visemes.length} visemes`);
  } catch (err) {
    if (myGen !== speakGen) return;
    setStatus(`speech failed: ${err.message}`);
    stopSpeaking();
    fin();                              // terminal failure — let the queue proceed
  }
}

// per-frame: derive the active viseme from elapsed AUDIO time, not wall time.
// The track ends with the waveform (vtimes come from the synth itself), so
// the mouth cannot outrun the voice — S2's tail-out is structurally gone.
function updateSpeech() {
  if (!track || !audioCtx) return;
  const ms = (audioCtx.currentTime - track.startAt) * 1000;
  if (ms < 0) return;
  let active = -1;
  for (let i = track.cursor; i < track.v.length; i++) {
    if (track.t[i] > ms) break;            // next viseme hasn't started: gap
    if (ms < track.t[i] + track.d[i]) { active = i; break; }
    track.cursor = i + 1;                  // this one is finished, move past it
  }
  clearVisemes();
  activeViseme = active >= 0 ? track.v[active] : "sil";
  if (active >= 0) {
    const strength = ["aa", "E", "I", "O", "U"].includes(activeViseme) ? 0.95 : 0.85;
    setMorph("viseme_" + activeViseme, strength);
  }
}

function stopSpeaking() {
  speakGen++; // cancel any in-flight speak() sitting between its awaits
  if (currentSource) { try { currentSource.stop(); } catch {} currentSource = null; }
  track = null;
  mouthLoop = false;
  activeViseme = "sil";
  clearVisemes();
}

// silent mouth loop — judge legibility without audio (carried from S2)
let loopIdx = 0;
function runMouthLoop() {
  if (!mouthLoop) return;
  const seq = ["viseme_aa", "viseme_E", "viseme_PP", "viseme_O", "viseme_SS", "viseme_U", "viseme_FF", "viseme_I"];
  clearVisemes();
  setMorph(seq[loopIdx % seq.length], 0.95);
  activeViseme = seq[loopIdx % seq.length].replace("viseme_", "");
  loopIdx++;
  setTimeout(runMouthLoop, 240);
}

// ---------- UI -----------------------------------------------------------------
function seg(id, fn) {
  const el = document.getElementById(id);
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    el.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    fn(+b.dataset.v);
  });
}
// particle density is a slider now (50k feels right; up to 150k for resolving fine features).
// Rebuilds the sample set, so it applies on release; readout tracks live.
{
  const el = document.getElementById("densityR"), out = document.getElementById("densityRV");
  const show = () => { out.textContent = `${(+el.value / 1000) | 0}k`; };
  el.value = state.density;
  el.addEventListener("input", show);
  el.addEventListener("change", () => { state.density = +el.value; buildSamples(); });
  show();
}
seg("mouthSeg", (v) => { state.mouthBoost = v; buildSamples(); });
seg("eyesSeg", (v) => { state.eyes = !!v; buildSamples(); });

document.getElementById("dotSize").addEventListener("input", (e) => { state.dotScale = +e.target.value; updateDotSize(); stamp(); });
{ const o = document.getElementById("dotOp"); if (o) { o.value = material.opacity; const ov = document.getElementById("dotOpV"); if (ov) ov.textContent = (+o.value).toFixed(2); o.addEventListener("input", (e) => { material.opacity = +e.target.value; if (ov) ov.textContent = (+e.target.value).toFixed(2); stamp(); }); } }
document.getElementById("hairChaos").addEventListener("input", (e) => { state.hairChaos = +e.target.value; stamp(); });

// live mouth-shape sliders (procedural mouth) — drag while she speaks / loops
function mouthSlider(id, init, set) {
  const el = document.getElementById(id), out = document.getElementById(id + "V");
  if (!el) return;
  el.value = init;
  const show = () => { if (out) out.textContent = (+el.value).toFixed(3); };
  el.addEventListener("input", () => { set(+el.value); show(); });
  show();
}
mouthSlider("ulipR", ULIP, (v) => (ULIP = v));
mouthSlider("jawR", JAW, (v) => (JAW = v));
mouthSlider("cwR", MOUTH_CW, (v) => (MOUTH_CW = v));
mouthSlider("voidR", VOID, (v) => (VOID = v));
mouthSlider("rimGlowR", RIM_GLOW, (v) => (RIM_GLOW = v));
mouthSlider("striR", STRI, (v) => (STRI = v));
mouthSlider("striSpaceR", STRI_SPACE, (v) => (STRI_SPACE = v));
mouthSlider("striCrispR", STRI_CRISP, (v) => (STRI_CRISP = v));
mouthSlider("striContourR", STRI_CONTOUR, (v) => (STRI_CONTOUR = v));
mouthSlider("striAutoR", STRI_AUTO, (v) => (STRI_AUTO = v));

// feature-density sliders rebuild the sample set, so they fire on release (change),
// not while dragging — the value readout still tracks live on input.
function buildSlider(id, init, set) {
  const el = document.getElementById(id), out = document.getElementById(id + "V");
  if (!el) return;
  el.value = init;
  const show = () => { if (out) out.textContent = (+el.value).toFixed(2); };
  el.addEventListener("input", show);
  el.addEventListener("change", () => { set(+el.value); buildSamples(); });
  show();
}
buildSlider("featR", FEAT, (v) => (FEAT = v));
buildSlider("edgeR", EDGE, (v) => (EDGE = v));
buildSlider("moyR", MOY, (v) => (MOY = v)); // mouth height — drag onto the lips, rebuilds on release
buildSlider("mozR", MOZ, (v) => (MOZ = v)); // mouth depth
buildSlider("hairCullR", HAIR_CULL, (v) => (HAIR_CULL = v));
mouthSlider("lightR", LIGHT, (v) => (LIGHT = v));
mouthSlider("exposureR", EXPOSURE, (v) => (EXPOSURE = v));

// hair-fit sliders: move the hair live while dragging (matrixWorld), re-sample on release
function hairSlider(id, init, set) {
  const el = document.getElementById(id), out = document.getElementById(id + "V");
  if (!el) return;
  el.value = init;
  const show = () => { if (out) out.textContent = (+el.value).toFixed(3); };
  el.addEventListener("input", () => { set(+el.value); show(); refitHair(); });
  el.addEventListener("change", () => { set(+el.value); refitHair(); buildSamples(); });
  show();
}
hairSlider("hairScaleR", HAIR_SCALE, (v) => (HAIR_SCALE = v));
hairSlider("hairYR", HAIR_Y, (v) => (HAIR_Y = v));
hairSlider("hairZR", HAIR_Z, (v) => (HAIR_Z = v));
buildSlider("hairBackR", HAIR_BACK, (v) => (HAIR_BACK = v));
buildSlider("hairDropR", HAIR_DROP, (v) => (HAIR_DROP = v));
buildSlider("hairDensityR", state.hairDensity, (v) => (state.hairDensity = v));
buildSlider("hairDotR", state.hairDot, (v) => (state.hairDot = v));
buildSlider("hairBrightR", HAIR_BRIGHT, (v) => (HAIR_BRIGHT = v));
buildSlider("hairlineR", HAIRLINE, (v) => (HAIRLINE = v));
buildSlider("backR", BACK_CULL, (v) => (BACK_CULL = v));
mouthSlider("lightAzR", LIGHT_AZ, (v) => (LIGHT_AZ = v));
mouthSlider("lightElR", LIGHT_EL, (v) => (LIGHT_EL = v));
mouthSlider("modelR", MODEL, (v) => (MODEL = v));
mouthSlider("fillR", FILL, (v) => (FILL = v));
mouthSlider("fillAzR", FILL_AZ, (v) => (FILL_AZ = v));
mouthSlider("fillElR", FILL_EL, (v) => (FILL_EL = v));
mouthSlider("eyeSepR", EYE_SEP, (v) => (EYE_SEP = v));
mouthSlider("eyeHR", EYE_H, (v) => (EYE_H = v));
mouthSlider("eyeRR", EYE_R, (v) => (EYE_R = v));
buildSlider("eyeDensR", EYE_DENSITY, (v) => (EYE_DENSITY = v));
mouthSlider("eyePupilR", EYE_PUPIL, (v) => (EYE_PUPIL = v));
mouthSlider("eyeGlowR", EYEGLOW, (v) => (EYEGLOW = v));
mouthSlider("blinkR", BLINK, (v) => (BLINK = v));
mouthSlider("socketR", SOCKET, (v) => (SOCKET = v));
mouthSlider("noseDefR", NOSE_DEF, (v) => (NOSE_DEF = v));

// reference-photo overlay — a placement aid (align to the head at front view, then
// drop the eye discs on her real eyes). Pure DOM; never blocks the orbit.
const faceOverlay = document.getElementById("faceOverlay");
function updateOverlay() {
  const op = +document.getElementById("ovOpacity").value;
  const sc = +document.getElementById("ovScale").value;
  const oy = +document.getElementById("ovY").value;
  const ox = +document.getElementById("ovX").value;
  // ref/ is gitignored (absent in a clean clone), so only request the overlay image once the dev
  // actually turns it on. A plain load never sets src, so it never fires a distracting 404.
  if (op > 0 && !faceOverlay.getAttribute("src") && faceOverlay.dataset.ref) faceOverlay.src = faceOverlay.dataset.ref;
  faceOverlay.style.display = op > 0 ? "block" : "none";
  faceOverlay.style.opacity = op;
  faceOverlay.style.height = sc + "vh";
  faceOverlay.style.transform = `translate(calc(-50% + ${ox}px), calc(-50% + ${oy}px))`;
  document.getElementById("ovOpacityV").textContent = op.toFixed(2);
  document.getElementById("ovScaleV").textContent = sc + "vh";
  document.getElementById("ovYV").textContent = oy + "px";
  document.getElementById("ovXV").textContent = ox + "px";
}
["ovOpacity", "ovScale", "ovY", "ovX"].forEach((id) => document.getElementById(id).addEventListener("input", updateOverlay));
updateOverlay();
mouthSlider("striDriftR", STRI_DRIFT, (v) => (STRI_DRIFT = v));
document.getElementById("speak").addEventListener("click", () => {
  const sel = document.getElementById("line");
  speak(sel.value === "paragraph" ? PARAGRAPH : sel.value);
});
document.getElementById("stop").addEventListener("click", () => { stopSpeaking(); setStatus("stopped"); });
document.getElementById("loop").addEventListener("click", () => {
  if (mouthLoop) { mouthLoop = false; clearVisemes(); return; }
  mouthLoop = true; runMouthLoop();
});

function stamp() {
  const mouthName = { 0: "off", 6: "medium", 18: "heavy" }[state.mouthBoost] || state.mouthBoost;
  document.getElementById("stamp").textContent =
    `${(state.density / 1000) | 0}k dots · mouth ${mouthName} · ${state.eyes ? "eyes" : "eyeless"} · isabella`;
  document.getElementById("dotV").textContent = `×${state.dotScale.toFixed(2)}`;
  document.getElementById("hairV").textContent = `×${state.hairChaos.toFixed(2)}`;
}

for (const [id, val] of [["mouthSeg", state.mouthBoost], ["eyesSeg", state.eyes ? 1 : 0]]) {
  document.querySelectorAll(`#${id} button`).forEach((b) => b.classList.toggle("on", +b.dataset.v === val));
}

// --- hair: an optional mesh fitted onto the head --------------------------------
// The renderer bakes each mesh's world matrix at sample time, so hair is fitted with
// a plain transform (scale + offset + yaw, all live URL params) — no Blender bake
// needed. It's tagged kind "hair" so it gets hair drift, hair lighting, and hides the
// skull beneath it. Hair is OFF by default — the bald head is the shipped look. Wig
// meshes are NOT included in this release; ?hairFile=<name> expects a GLB you add to
// vendor/ yourself. ?hair=0 stays a hard "no hair".
const wantHair = (params.has("hairFile") || headSource === "female") && params.get("hair") !== "0";
if (wantHair) {
  try {
    // [file, defaultScale] — per-mesh default scale fitted to nimxx@150 by horizontal footprint
    // (native bbox read from GLB accessors 2026-06-15). The live hairScale slider / ?hairScale override still win.
    const hairFiles = {
      layers:       ["hair-layers.glb", 150],
      bob:          ["hair-bob.glb", 150],
      aespa:        ["hair-aespa.glb", 150],
      nimxx:        ["hair-nimxx.glb", 150],
      "nimxx-long": ["hair-nimxx-long.glb", 144], // longer nimxx variant (continuous shell)
      "wavy-wet":   ["hair-wavy-wet.glb", 120],   // longest; wet/wavy look
      "wavy-bangs": ["hair-wavy-bangs.glb", 141], // wavy w/ bangs (fringe covers forehead)
    };
    const hairSel = hairFiles[params.get("hairFile")] || hairFiles.bob; // default bob (the #1, locked 2026-06-16); ?hairFile=nimxx|aespa|layers|nimxx-long|wavy-wet|wavy-bangs
    const hairFile = hairSel[0];
    if (!params.has("hairScale")) { // adopt the per-mesh default scale + sync the on-screen slider
      HAIR_SCALE = hairSel[1];
      const _hsEl = document.getElementById("hairScaleR"), _hsV = document.getElementById("hairScaleRV");
      if (_hsEl) { _hsEl.value = HAIR_SCALE; if (_hsV) _hsV.textContent = HAIR_SCALE.toFixed(3); }
    }
    const hairGltf = await new GLTFLoader().loadAsync(`./vendor/${hairFile}`);
    hairObj = hairGltf.scene;
    hairObj.visible = false; // we render points, not the mesh
    scene.add(hairObj); // attach to scene, NOT avatar — avatar may be scaled (female bust) and would double-scale the hair
    refitHair(); // scale + centre on the head + offsets
    let hi = 0;
    hairObj.traverse((o) => {
      if (o.isMesh) { meshes[`hair_${hi++}`] = o; o.frustumCulled = false; meshKind.set(o, "hair"); }
    });
    // hair occludes too — but with a LARGER depth bias than the head, so the hair's own
    // front dots survive (they sit further from their surface than skin dots do) while the
    // skull behind the hair is hidden. Real physics, replacing the "hair hides skull" hack.
    if (params.get("hairOcc") === "1") { // opt-in: over-occludes the face with thick hair meshes
      const hb = +(params.get("hairOccBias") ?? 7);
      const hairOccMat = new THREE.MeshBasicMaterial({ colorWrite: false, polygonOffset: true, polygonOffsetFactor: hb, polygonOffsetUnits: hb });
      hairObj.visible = true;
      hairObj.traverse((o) => { if (o.isMesh) o.material = hairOccMat; });
    }
    const _shb = new THREE.Box3().setFromObject(hairObj).getSize(new THREE.Vector3());
    dlog("[hair] loaded", hi, "mesh(es) · scale", HAIR_SCALE.toFixed(3), "· pos", hairObj.position.toArray().map((v) => +v.toFixed(3)).join(","),
      "· sizeScaled", _shb.toArray().map((v) => +v.toFixed(3)).join(","));
  } catch (e) {
    console.warn("[hair] load failed:", e.message);
  }
}

// ---------- main loop ------------------------------------------------------------
buildSamples();
document.getElementById("boot").remove();

if (state.pose) {
  setMorph(state.pose, 0.95);
  if (procedural) activeViseme = state.pose in MOUTH ? state.pose : "aa"; // pose=aa/sil/O… freezes that shape
}

const skeletons = [...new Set(Object.values(meshes).map((m) => m.skeleton))].filter(Boolean);

// ---------- ambient swirl: a faint additive particle layer that moves around her head ----------
// Pure Three.js Points ON TOP of the face — runs anywhere she runs (no TouchDesigner), its own object
// (can't touch the face / mouth work, rolls back on its own), every knob a URL param. (2026-06-30)
// ?swirl=motes|orbit|ribbons (0/off/none = none) · swirlCount · swirlR · swirlSpread · swirlSpeed ·
// swirlFlow · swirlSize · swirlOp · swirlTint=white|ice|cyan|blue · swirlRings (orbit only)
//   motes   — faint dust drifting + slowly orbiting (dust in a sunbeam)
//   orbit   — tilted rings of light circling her head, a bright arc sweeping each orbit
//   ribbons — particles advected through a curl-ish flow → sweeping aurora-like filaments
const SWIRL = (params.get("swirl") ?? "motes").toLowerCase();
const SWIRL_ON = SWIRL !== "0" && SWIRL !== "off" && SWIRL !== "none";
// Only the shipped "motes" swirl runs in production; the experimental orbit/ribbons modes are DEV-only.
const SW_MODE = (DEV && (SWIRL === "orbit" || SWIRL === "ribbons")) ? SWIRL : "motes";
const SW_COUNT  = Math.max(0, (+(params.get("swirlCount") ?? (SW_MODE === "orbit" ? 5000 : SW_MODE === "ribbons" ? 7000 : 12000))) | 0);
const SW_R      = +(params.get("swirlR") ?? 0.42);      // mean radius around headCenter
const SW_SPREAD = +(params.get("swirlSpread") ?? 0.18); // radial thickness (± from SW_R)
const SW_SPEED  = +(params.get("swirlSpeed") ?? 0.12);  // base motion speed (rad/s) — orbit pace
const SW_FLOW   = +(params.get("swirlFlow") ?? 1.0);    // eddy / flow strength
const SW_SIZE   = +(params.get("swirlSize") ?? 0.006);  // base sprite size (world units, size-attenuated)
const SW_OP     = +(params.get("swirlOp") ?? 0.55);     // overall opacity
const SW_RINGS  = Math.max(1, (+(params.get("swirlRings") ?? 9)) | 0); // orbit: number of tilted rings
const SW_TINT   = (params.get("swirlTint") ?? "white").toLowerCase();
const SW_TINTS  = { white: [1, 1, 1], ice: [0.78, 0.92, 1.0], cyan: [0.55, 0.95, 1.0], blue: [0.55, 0.7, 1.0] };
const swTint    = SW_TINTS[SW_TINT] || SW_TINTS.white;
// audio-reactive (her voice): read a smoothed level off the master analyser each frame (it already taps
// her TTS — it's what drives the voice meter) and let it brighten, bloom, and energise the dust.
// ?swirlReact=0 off · swirlAudioGain (sensitivity) · swirlAudioBright · swirlAudioBloom (+ push out /
// − coalesce in) · swirlAudioFlow (the "vibrate") · swirlAudioTest=0.9|osc drives a synthetic level so
// the reaction can be tuned headlessly without the bridge. (2026-06-30)
const SW_REACT    = (params.get("swirlReact") ?? "1") !== "0";
const SW_A_GAIN   = +(params.get("swirlAudioGain") ?? 9);       // sensitivity: speech RMS is small, so push hard
const SW_A_BRIGHT = +(params.get("swirlAudioBright") ?? 1.2);   // glow on peaks
const SW_A_BLOOM  = +(params.get("swirlAudioBloom") ?? -0.4);   // − = coalesce INWARD on her voice (+ = bloom out) (2026-06-30)
const SW_A_FLOW   = +(params.get("swirlAudioFlow") ?? 6);       // strong vibration / agitation on her voice (2026-06-30)
const SW_A_TEST   = params.has("swirlAudioTest") ? (params.get("swirlAudioTest") || "osc") : null;
let swAudio = 0, swCoal = 0, swAudioBuf = null;
let motes = null, motesData = null;
const hash01 = (n) => { const s = Math.sin(n) * 43758.5453; return ((s % 1) + 1) % 1; }; // deterministic 0..1 (stable layout across reloads → comparable screenshots)

function swMaterial() {
  return new THREE.PointsMaterial({
    size: SW_SIZE, map: dotTexture(), transparent: true, opacity: SW_OP,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true, vertexColors: true,
    onBeforeCompile: (shader) => {
      shader.vertexShader = "attribute float aSize;\n" + shader.vertexShader.replace("gl_PointSize = size;", "gl_PointSize = size * aSize;");
    },
  });
}

function buildMotes() {
  if (!SWIRL_ON || SW_COUNT <= 0) return;
  const pos = new Float32Array(SW_COUNT * 3);
  const col = new Float32Array(SW_COUNT * 3);
  const siz = new Float32Array(SW_COUNT);
  motesData = { mode: SW_MODE };

  if (SW_MODE === "orbit") {
    // a fan of tilted rings; particles flow along their ring + a bright arc sweeps each orbit
    const rings = [];
    for (let r = 0; r < SW_RINGS; r++) {
      const u01 = (r + 0.5) / SW_RINGS, ph = Math.acos(1 - 2 * u01), th = r * 2.399963229;
      const n = new THREE.Vector3(Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th)).normalize();
      const up = Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      const u = new THREE.Vector3().crossVectors(up, n).normalize();
      const v = new THREE.Vector3().crossVectors(n, u).normalize();
      rings.push({ u, v, n,
        rad: SW_R * (0.82 + 0.5 * (r / Math.max(1, SW_RINGS - 1))),       // nested radii
        speed: SW_SPEED * (3 + hash01(r + 1) * 4) * (r % 2 ? -1 : 1),     // varied pace, alternating spin
        wave: 2 + hash01(r + 2) * 3 });                                   // arcs that sweep the orbit
    }
    motesData.rings = rings;
    motesData.ring = new Int16Array(SW_COUNT);
    motesData.ang = new Float32Array(SW_COUNT);
    motesData.rad = new Float32Array(SW_COUNT);
    motesData.nOff = new Float32Array(SW_COUNT);
    for (let i = 0; i < SW_COUNT; i++) {
      const ri = i % SW_RINGS, ring = rings[ri], jr = hash01(i * 7.13 + 1.7);
      motesData.ring[i] = ri;
      motesData.ang[i] = (i / SW_COUNT) * Math.PI * 2 * SW_RINGS + jr * 6.283; // fill each ring
      motesData.rad[i] = ring.rad * (1 + (jr - 0.5) * 0.10);                   // slight radial body
      motesData.nOff[i] = (jr - 0.5) * 2 * SW_SPREAD * 0.18;                   // slight out-of-plane body
      const b = 0.5 + 0.5 * jr; col[i*3]=swTint[0]*b; col[i*3+1]=swTint[1]*b; col[i*3+2]=swTint[2]*b;
      siz[i] = 0.6 + jr * 0.9;
    }
  } else if (SW_MODE === "ribbons") {
    // seed a vertically-stretched shell; the flow field advects them into sweeping curtains
    motesData.life = new Float32Array(SW_COUNT);
    motesData.lsp = new Float32Array(SW_COUNT);
    for (let i = 0; i < SW_COUNT; i++) {
      const u = (i + 0.5) / SW_COUNT, ph = Math.acos(1 - 2 * u), th = i * 2.399963229, jr = hash01(i * 9.71 + 3.3);
      const rr = SW_R * (0.55 + 0.9 * jr);
      pos[i*3]   = headCenter.x + Math.sin(ph) * Math.cos(th) * rr;
      pos[i*3+1] = headCenter.y + Math.cos(ph) * rr * 1.15;                    // vertical stretch (curtains)
      pos[i*3+2] = headCenter.z + Math.sin(ph) * Math.sin(th) * rr;
      motesData.life[i] = jr;                                                  // staggered lives → no unison pulse
      motesData.lsp[i] = 0.06 + hash01(i * 2.1 + 5.0) * 0.10;
      const b = 0.5 + 0.5 * jr; col[i*3]=swTint[0]*b; col[i*3+1]=swTint[1]*b; col[i*3+2]=swTint[2]*b;
      siz[i] = 0.5 + jr;
    }
  } else { // motes (dust) — each anchored to a fixed HOME so it always returns when she stops
    motesData.dir = new Float32Array(SW_COUNT * 3); // unit home direction on the shell
    motesData.tr  = new Float32Array(SW_COUNT);     // home radius
    motesData.tph = new Float32Array(SW_COUNT);
    motesData.tsp = new Float32Array(SW_COUNT);
    motesData.fph = new Float32Array(SW_COUNT);
    motesData.orbit = 0;                            // slow global circulation angle
    for (let i = 0; i < SW_COUNT; i++) {
      const u = (i + 0.5) / SW_COUNT, phi = Math.acos(1 - 2 * u), theta = i * 2.399963229, jr = hash01(i * 12.9898 + 7.13);
      const r = SW_R + (jr - 0.5) * 2 * SW_SPREAD;
      const dx = Math.sin(phi) * Math.cos(theta), dy = Math.cos(phi), dz = Math.sin(phi) * Math.sin(theta);
      motesData.dir[i*3] = dx; motesData.dir[i*3+1] = dy; motesData.dir[i*3+2] = dz;
      pos[i*3] = headCenter.x + dx * r; pos[i*3+1] = headCenter.y + dy * r; pos[i*3+2] = headCenter.z + dz * r;
      const b = 0.45 + 0.55 * jr; col[i*3]=swTint[0]*b; col[i*3+1]=swTint[1]*b; col[i*3+2]=swTint[2]*b;
      siz[i] = 0.5 + jr;
      motesData.tr[i] = r; motesData.tph[i] = jr * 6.283; motesData.tsp[i] = 0.6 + jr * 1.4; motesData.fph[i] = theta;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setAttribute("aSize", new THREE.BufferAttribute(siz, 1));
  motes = new THREE.Points(geo, swMaterial());
  motes.frustumCulled = false;
  motesData.base = col.slice(); // base colours; brightness scales from these (no compounding)
  scene.add(motes);
}

function updateMotes(dt, t) {
  if (!motes) return;
  const p = motes.geometry.attributes.position.array;
  const c = motes.geometry.attributes.color.array;
  const base = motesData.base;

  // her-voice level → swAudio (smoothed envelope: fast attack, slow release). The master analyser only
  // sees sound while SHE is speaking (currentSource set), so the dust reacts to her, nothing else.
  let aTarget = 0;
  if (SW_A_TEST !== null) {
    aTarget = SW_A_TEST === "osc" ? 0.5 + 0.5 * Math.sin(t * 2.2) : Math.max(0, Math.min(1, +SW_A_TEST || 0));
  } else if (SW_REACT && analyser && audioCtx && audioCtx.state === "running" && currentSource) {
    if (!swAudioBuf) swAudioBuf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(swAudioBuf);
    let s = 0; const n = swAudioBuf.length;
    for (let k = 0; k < n; k++) { const v = (swAudioBuf[k] - 128) / 128; s += v * v; }
    aTarget = Math.min(1, Math.sqrt(s / n) * SW_A_GAIN);
  }
  swAudio += (aTarget - swAudio) * (aTarget > swAudio ? 0.35 : 0.14); // fast env → vibration + glow (quick release)
  swCoal  += (aTarget - swCoal)  * (aTarget > swCoal  ? 0.05 : 0.08); // slow env → coalesce depth (gathers over sustained voice, then lets go)

  if (motesData.mode === "orbit") {
    const rings = motesData.rings;
    for (let i = 0; i < SW_COUNT; i++) {
      const ring = rings[motesData.ring[i]];
      const a = motesData.ang[i] + ring.speed * dt; motesData.ang[i] = a;
      const ca = Math.cos(a), sa = Math.sin(a), rad = motesData.rad[i], no = motesData.nOff[i];
      p[i*3]   = headCenter.x + (ring.u.x * ca + ring.v.x * sa) * rad + ring.n.x * no;
      p[i*3+1] = headCenter.y + (ring.u.y * ca + ring.v.y * sa) * rad + ring.n.y * no;
      p[i*3+2] = headCenter.z + (ring.u.z * ca + ring.v.z * sa) * rad + ring.n.z * no;
      const tw = 0.30 + 0.70 * (0.5 + 0.5 * Math.sin(a * 3 - t * ring.wave)); // light sweeps the orbit
      c[i*3]=base[i*3]*tw; c[i*3+1]=base[i*3+1]*tw; c[i*3+2]=base[i*3+2]*tw;
    }
  } else if (motesData.mode === "ribbons") {
    const SP = SW_FLOW * 0.18, maxR = SW_R * 1.7, maxR2 = maxR * maxR;
    for (let i = 0; i < SW_COUNT; i++) {
      let x = p[i*3] - headCenter.x, y = p[i*3+1] - headCenter.y, z = p[i*3+2] - headCenter.z;
      // domain-warped sinusoidal curl-ish flow → neighbours move alike → coherent sweeping filaments
      const wx = Math.sin(y * 2.1 + t * 0.40), wy = Math.sin(z * 1.9 - t * 0.35), wz = Math.sin(x * 2.3 + t * 0.30);
      const vx = Math.sin((y + wy) * 2.6 + t * 0.50) - Math.cos((z + wz) * 2.2 - t * 0.30);
      const vy = Math.sin((z + wz) * 2.4 - t * 0.45) - Math.cos((x + wx) * 2.0 + t * 0.35) + 0.5; // gentle lift
      const vz = Math.sin((x + wx) * 2.7 + t * 0.40) - Math.cos((y + wy) * 2.5 - t * 0.30);
      x += vx * SP * dt; y += vy * SP * dt; z += vz * SP * dt;
      let life = motesData.life[i] + motesData.lsp[i] * dt;
      if (life >= 1 || x*x + y*y + z*z > maxR2) {            // re-seed so the flow keeps feeding
        const a1 = Math.random() * 6.283, a2 = Math.acos(1 - 2 * Math.random()), rr = SW_R * (0.55 + 0.9 * Math.random());
        x = Math.sin(a2) * Math.cos(a1) * rr; y = Math.cos(a2) * rr * 1.15; z = Math.sin(a2) * Math.sin(a1) * rr;
        life = 0;
      }
      motesData.life[i] = life;
      p[i*3]=headCenter.x+x; p[i*3+1]=headCenter.y+y; p[i*3+2]=headCenter.z+z;
      const fade = Math.sin(Math.PI * life);                 // fade in/out over life → no pops
      c[i*3]=base[i*3]*fade; c[i*3+1]=base[i*3+1]*fade; c[i*3+2]=base[i*3+2]*fade;
    }
  } else { // motes (dust) — position is a pure function of (home, time, voice): can't get stuck, always returns
    motesData.orbit += SW_SPEED * dt;                          // slow global circulation
    const cA = Math.cos(motesData.orbit), sA = Math.sin(motesData.orbit);
    const bloom = 1 + SW_A_BLOOM * swCoal;                     // slow env: gathers IN over sustained voice, releases after
    const amp = 0.018 * (1 + SW_A_FLOW * swAudio);             // fast env: wander amplitude grows with voice (the "vibrate")
    const jit = SW_A_FLOW * swAudio * 0.02;                    // fast buzz on top of the wander
    const aBright = 1 + SW_A_BRIGHT * swAudio;                 // glow on peaks
    const dir = motesData.dir;
    for (let i = 0; i < SW_COUNT; i++) {
      const dx = dir[i*3], dy = dir[i*3+1], dz = dir[i*3+2];
      const rx = dx * cA + dz * sA, rz = -dx * sA + dz * cA;   // rotate home direction around Y (the circulation)
      const hr = motesData.tr[i] * bloom, fp = motesData.fph[i];
      const ox = amp * Math.sin(t * 0.70 + fp)       + jit * Math.sin(t * 9.0 + fp * 5); // bounded organic offset + voice buzz
      const oy = amp * Math.sin(t * 0.90 + fp * 1.3) + jit * Math.sin(t * 8.3 + fp * 4);
      const oz = amp * Math.cos(t * 0.80 + fp * 0.7) + jit * Math.cos(t * 9.4 + fp * 6);
      p[i*3]   = headCenter.x + rx * hr + ox;
      p[i*3+1] = headCenter.y + dy * hr + oy;
      p[i*3+2] = headCenter.z + rz * hr + oz;
      const tw = (0.55 + 0.45 * Math.sin(t * motesData.tsp[i] + motesData.tph[i])) * aBright; // twinkle × voice glow
      c[i*3]=base[i*3]*tw; c[i*3+1]=base[i*3+1]*tw; c[i*3+2]=base[i*3+2]*tw;
    }
  }
  motes.geometry.attributes.position.needsUpdate = true;
  motes.geometry.attributes.color.needsUpdate = true;
}

buildMotes();
const clock = new THREE.Clock();
let frames = 0, fpsAt = performance.now(), fps = 0;

renderer.setAnimationLoop(() => {
  const dt = Math.min(0.05, clock.getDelta());
  const t = clock.elapsedTime;
  if (!state.pose) { updateIdle(t); updateBlink(t, dt); }
  if (BLINK_HOLD != null) { setMorph("eyeBlinkLeft", BLINK_HOLD); setMorph("eyeBlinkRight", BLINK_HOLD); } // DEBUG hold, overrides idle blink; works with pose=sil too
  updateSpeech();
  updateMouth(dt);
  applyMorphs(dt);
  avatar.updateMatrixWorld(true);
  skeletons.forEach((s) => s.update());
  updateParticles(t);
  updateMotes(dt, t);
  if (slideT < 1) {
    slideT = Math.min(1, slideT + dt / SLIDE_SECS);
    resize(); // canvas tracks the animating #stage width: she slides + stays the same size, no stretch
  }
  controls.update();
  updateMeter();
  renderer.render(scene, camera);
  frames++;
  const now = performance.now();
  if (now - fpsAt > 1000) {
    fps = Math.round((frames * 1000) / (now - fpsAt));
    frames = 0; fpsAt = now;
    document.getElementById("hud").textContent =
      `${fps} fps · ${state.density.toLocaleString()} particles · drag to orbit · ${headSource === "avatar" ? "audition head" : "stand-in"}${procedural ? " · procedural mouth" : " · morph rig"}`;
  }
});

// autospeak for headless end-to-end tests (?say=...)
if (state.say) {
  setTimeout(() => speak(state.say === "paragraph" ? PARAGRAPH : state.say), 800);
}

// ---------- M3 talk UI: the standalone-window chrome (text box + thinking dots) -----
// The clean app window is now the default page; the talk drawer itself appears only when a
// bridge is in play (see APP/BRIDGED below). This section adds the LOOK only; the submit
// hook (onTalkSubmit) is wired by the bridge block below in Stage 3. Without a hook, Enter
// just echoes locally so the box can be judged on its own (Stage 2).
const talkInput = document.getElementById("talkInput");
const thinkingEl = document.getElementById("thinking");
const drawer = document.getElementById("drawer");
const drawerToggle = document.getElementById("drawerToggle");
let onTalkSubmit = null; // bridge wiring sets this (Stage 3); a closure reads it at submit time

// While she composes, pulse the dots AND rotate a playful "what she's doing" word. Called by both the
// optimistic showThinking(true) and the {type:"thinking"} frame; the clearInterval at the top makes a
// repeat call safe (no leaked timer). The words are synthetic — there's no real reasoning stream. (2026-06-30)
const THINK_WORDS = ["crunching…", "sticky beaking…", "mulling…", "cogitating…", "pondering…", "noodling…"];
let thinkTimer = null;
function showThinking(on) {
  thinkingEl.classList.toggle("show", !!on);
  const w = document.getElementById("thinkword");
  clearInterval(thinkTimer); thinkTimer = null;
  if (on) {
    let i = 0;
    if (w) w.textContent = THINK_WORDS[0];
    thinkTimer = setInterval(() => { i = (i + 1) % THINK_WORDS.length; if (w) w.textContent = THINK_WORDS[i]; }, 1500);
  } else if (w) { w.textContent = ""; }
}
function flashHeard() {
  if (!talkInput) return;
  talkInput.classList.add("heard");
  setTimeout(() => talkInput.classList.remove("heard"), 600);
}

// Terminal transcript: append a line. who = "me" (you, highlighted), "her" (spoken, plain), "tool" (activity).
const transcriptEl = document.getElementById("transcript");
function addLine(text, who) {
  if (!transcriptEl) return;
  const d = document.createElement("div");
  d.className = "tline " + who;
  d.textContent = text;
  transcriptEl.appendChild(d);
  transcriptEl.scrollTop = transcriptEl.scrollHeight; // autoscroll to newest
}

// Voice meter: a classic waveform line drawn off the analyser's time-domain data each frame; a faint flat
// line at rest, an oscillating red signature while she speaks. Canvas sized to its CSS box × dpr. (2026-06-30)
const meterEl = document.getElementById("meter");
const mctx = meterEl && meterEl.getContext ? meterEl.getContext("2d") : null;
let meterWave = null, meterLive = false;
function sizeMeter() {
  if (!meterEl || !meterEl.clientWidth) return;
  const dpr = Math.min(devicePixelRatio, 2);
  meterEl.width = Math.round(meterEl.clientWidth * dpr);
  meterEl.height = Math.round(meterEl.clientHeight * dpr);
}
function updateMeter() {
  if (!mctx) return;
  const W = meterEl.width, H = meterEl.height, mid = H / 2;
  if (!W || !H) return;
  const dpr = Math.min(devicePixelRatio, 2);
  mctx.clearRect(0, 0, W, H);
  mctx.lineJoin = "round"; mctx.lineCap = "round";
  const live = analyser && audioCtx && audioCtx.state === "running" && currentSource;
  // colour-linked to the mute speaker: green when live, red when muted — so the icon and the line
  // always share one colour and toggle together off the mute button. (matches #muteBtn's #35d07f/#ff6b6b)
  const wave = muted ? "#ff6b6b" : "#35d07f";
  const glow = muted ? "rgba(255,107,107,.55)" : "rgba(53,208,127,.55)";
  const flat = muted ? "rgba(255,107,107,.6)" : "rgba(53,208,127,.6)";
  if (live) {
    if (!meterWave) meterWave = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(meterWave);
    mctx.lineWidth = 2 * dpr; mctx.strokeStyle = wave;
    mctx.shadowColor = glow; mctx.shadowBlur = 7 * dpr;
    mctx.beginPath();
    const n = meterWave.length, step = W / (n - 1);
    for (let i = 0; i < n; i++) {
      const y = mid + ((meterWave[i] - 128) / 128) * mid * 0.92;
      i ? mctx.lineTo(i * step, y) : mctx.moveTo(0, y);
    }
    mctx.stroke();
    if (!meterLive) { meterEl.classList.add("live"); meterLive = true; }
  } else {
    mctx.lineWidth = 1.8 * dpr; mctx.strokeStyle = flat; mctx.shadowBlur = 0;
    mctx.beginPath(); mctx.moveTo(0, mid); mctx.lineTo(W, mid); mctx.stroke();
    if (meterLive) { meterEl.classList.remove("live"); meterLive = false; }
  }
}

// ---- transcript drawer (push): toggling narrows/widens #stage; the canvas refits ----
// setDrawer flips one body class; the CSS animates #stage's right edge, and resize()
// (which sizes off #stage, not the window) re-fits the canvas as the push settles. (2026-06-30)
function setDrawer(open, animate = true) {
  document.body.classList.toggle("drawer-open", open);
  if (drawerToggle) drawerToggle.textContent = open ? "›" : "‹";
  setDrawerMotion(animate); // constant size; resize() each frame during the push so she slides smoothly
  if (open && talkInput) talkInput.focus(); // so Superwhisper / typing lands without a click into the drawer
}
if (stageEl) stageEl.addEventListener("transitionend", (e) => { if (e.propertyName === "right") resize(); });
if (drawerToggle) drawerToggle.addEventListener("click", () =>
  setDrawer(!document.body.classList.contains("drawer-open")));

// The clean app window is the DEFAULT — this is the public product view. ?panel=1 restores the
// full tuning dashboard (the old dev page: #panel + #hud + #stamp). ?app=1 still forces app
// chrome even alongside ?panel=1 (the relay-printed URLs carry it; also the tuning combo).
const APP = params.has("app") || !params.has("panel");
// The talk drawer + WebSocket exist only when a bridge is plausibly in play: the relay-printed
// URL (?token=…&bridgePort=…) or an explicit ?bridge=1. A bare page (hosted demo, Level 1
// `npm run serve`) gets the clean face — no dead talk box, no doomed reconnect loop.
const BRIDGED = params.has("bridge") || params.has("token") || params.has("bridgePort");
if (APP) document.body.classList.add("app");
if (params.has("panel")) { const dp = document.getElementById("panel"); if (dp) { dp.style.setProperty("display", "block", "important"); dp.style.setProperty("z-index", "9999", "important"); } } // &panel=1 reveals the full dev dashboard INSIDE the app window (shared-language tuning) — overrides the body.app hide AND lifts it above the transcript drawer

// Award-grade chrome (voice meter, identity pill, glassy controls: mute + gear look-panel) belongs
// to the app window itself — bridged or not, hosted or local.
if (APP) {
  ["meter", "idpill", "controls", "muteBtn"].forEach((id) => { const el = document.getElementById(id); if (el) el.classList.add("show"); });
  // configurable identity: ?name=Claude personalises the pill; ships generic so it's giveaway-safe
  const idname = document.getElementById("idname"); if (idname) idname.textContent = params.get("name") || "Assistant";
  sizeMeter(); addEventListener("resize", sizeMeter);
  const muteBtn = document.getElementById("muteBtn");
  if (muteBtn) muteBtn.addEventListener("click", () => { ensureBus(); setMuted(!muted); });
  // gear -> look panel; sliders drive her live (volume = real audio; glow/shimmer = her particle material)
  const gearBtn = document.getElementById("gearBtn"), lookpanel = document.getElementById("lookpanel");
  if (gearBtn && lookpanel) gearBtn.addEventListener("click", () => lookpanel.classList.toggle("open"));
  const slVol = document.getElementById("sl-vol");
  if (slVol) slVol.addEventListener("input", (e) => { volume = +e.target.value; ensureBus(); if (masterGain && !muted) masterGain.gain.value = volume; });
  const slGlow = document.getElementById("sl-glow");
  if (slGlow) { slGlow.value = EXPOSURE; slGlow.addEventListener("input", (e) => { EXPOSURE = +e.target.value; }); } // "Brightness" drives EXPOSURE, not opacity: the rolloff caps per-dot brightness, so raising it lifts the shadows / evens the face WITHOUT blowing the dense forehead (raising opacity WOULD blow it). Thumb starts at the live value so the first touch never jumps.
  const slSize = document.getElementById("sl-size");
  if (slSize) { slSize.value = state.dotScale; slSize.addEventListener("input", (e) => { state.dotScale = +e.target.value; updateDotSize(); }); } // source of truth, survives density changes; thumb starts at the live dot size
}

if (talkInput && BRIDGED) {
  talkInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const text = talkInput.value.trim();
    if (!text) return;
    flashHeard();
    addLine(text, "me"); // log the line (highlighted) whether bridged or look-only
    if (onTalkSubmit) { onTalkSubmit(text); talkInput.value = ""; } // brain wired: send + clear for the next line
    else { setStatus(`look-only — you said: ${text}`); talkInput.value = ""; } // Stage 2: not wired to a brain yet
  });

  // The transcript drawer is part of the standalone window: default-OPEN (workstation feel),
  // collapsible to the clean cinematic window. Suppress the transition for THIS first
  // application so the default-open state sizes the canvas correctly with no opening
  // animation (otherwise the canvas paints at full width behind a 340px drawer on load).
  if (drawer && drawerToggle) {
    drawer.classList.add("show");
    drawerToggle.classList.add("show");
    document.body.classList.add("sf-no-anim");
    setDrawer(true, false);
    resize();
    requestAnimationFrame(() => document.body.classList.remove("sf-no-anim"));
  }
}

// ---------- M1 talking bridge (one-way: this terminal session -> her mouth) -------
// Gated on BRIDGED (a token/bridgePort on the URL, or ?bridge=1), so the bare public page
// never opens a doomed WebSocket. A tiny local relay (bridge/relay.mjs) pushes
// {type:"say", text} frames over a 127.0.0.1 WebSocket; each line goes straight to
// speak() — the same seam the Speak button uses, so the audio-clock viseme sync is
// identical. Nothing is spoken unless someone deliberately fires `claude-say "…"`. (2026-06-24)
if (BRIDGED) {
  const token = params.get("token") || ""; // no published default — the relay prints the URL with the real per-install token
  const port = params.get("bridgePort") || "8765";

  // A reply streams as several {type:"say"} frames. speak() is a single-utterance, self-cancelling
  // seam (it stopSpeaking()s at its top), so without serialization each sentence would cut the
  // previous one off. This queue plays them one at a time, advancing on speak()'s completion hook.
  const sayQueue = [];
  let qSpeaking = false;
  const pumpSay = () => {
    if (qSpeaking) return;
    if (!audioCtx || audioCtx.state !== "running") return; // wait for the unlock gesture; armAudio re-pumps
    const next = sayQueue.shift();
    if (next == null) return;
    qSpeaking = true;
    speak(next, () => { qSpeaking = false; pumpSay(); });
  };
  const clearSayQueue = () => { sayQueue.length = 0; qSpeaking = false; };

  // Browser autoplay policy: audio can't start until a user gesture lands on the PAGE.
  // So the first click/keypress anywhere arms audio and drains anything queued before the click.
  const armAudio = async () => {
    audioCtx ||= new AudioContext();
    if (audioCtx.state === "suspended") { try { await audioCtx.resume(); } catch {} }
    if (audioCtx.state === "running") pumpSay();
  };
  addEventListener("pointerdown", armAudio);
  addEventListener("keydown", armAudio);

  let ws = null, backoff = 0;
  const connect = () => {
    ws = new WebSocket(`ws://127.0.0.1:${port}/face?token=${encodeURIComponent(token)}`);
    ws.onopen = () => { backoff = 0; setConnected(true); setStatus("bridge connected — click once to unlock audio, then I speak your lines"); };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "thinking") { showThinking(!!m.on); return; }
      if (m.type === "activity" && typeof m.text === "string") { addLine(m.text, "tool"); return; }
      if (m.type === "status") { setStatusBar(m); return; } // persistent model · context% · burned
      if (m.type !== "say" || typeof m.text !== "string") return;
      sayQueue.push(m.text);
      addLine(m.text, "her"); // log her spoken line (plain) to the terminal transcript
      if (!audioCtx || audioCtx.state !== "running") setStatus("bridge: click anywhere once to unlock audio (lines queued)");
      pumpSay();
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
    ws.onclose = () => { backoff = Math.min(backoff + 1, 6); setConnected(false); setStatus("bridge disconnected — retrying…"); setTimeout(connect, 400 * backoff); };
  };

  // Up-leg: the talk box -> Claude. Barge-in clears the queue AND cuts current audio the instant a
  // new line lands; dots show optimistically and are confirmed/cleared by the relay's frames.
  onTalkSubmit = (text) => {
    clearSayQueue();
    stopSpeaking();
    showThinking(true);
    try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "ask", text })); }
    catch {}
  };

  addEventListener("pagehide", () => { try { ws && ws.close(); } catch {} });
  connect();
}
