(function () {
'use strict';
/* ---------- constants & helpers ---------- */
const D = Math.PI / 180, PI = Math.PI, LIM = 17 /*deg*/, TMAX = 130 /*kN, illustrative*/, TAU = 1.4 /*s*/;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wrap = a => ((a + PI) % (2 * PI) + 2 * PI) % (2 * PI) - PI;
const $ = id => document.getElementById(id);
const fmt = (v, d = 1) => (v >= 0 ? '+' : '') + v.toFixed(d);
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const view = $('view');

/* ---------- renderer / scene ---------- */
let renderer;
try { renderer = new THREE.WebGLRenderer({ antialias: true }); }
catch (e) { view.innerHTML = '<p style="padding:20px">WebGL not available in this browser.</p>'; return; }
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
renderer.outputEncoding = THREE.sRGBEncoding;
view.insertBefore(renderer.domElement, view.firstChild);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07090c); scene.fog = new THREE.Fog(0x07090c, 16, 42);
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);

// procedural studio environment so the metals have something to reflect
const envS = new THREE.Scene(); envS.background = new THREE.Color(0x04060a);
function soft(w, h, d, x, y, z, c) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(7) }));
  m.position.set(x, y, z); envS.add(m);
}
soft(12, .3, 3, 0, 8, 0, 0xffffff); soft(.3, 5, 10, -9, 2, 0, 0xaaccff);
soft(.3, 4, 8, 9, 1, 3, 0xffddbb); soft(10, 3, .3, 0, 3, -9, 0x8899aa);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(envS, 0.03).texture;

const key = new THREE.DirectionalLight(0xfff1e0, 1.6); key.position.set(4, 8, 5); key.castShadow = true;
key.shadow.mapSize.set(2048, 2048); Object.assign(key.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 1, far: 25 });
key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02; scene.add(key);
const rim = new THREE.DirectionalLight(0x6fa8ff, 0.9); rim.position.set(-6, 3, -6); scene.add(rim);
scene.add(new THREE.HemisphereLight(0x8aa0b8, 0x101418, 0.35));
const glowLight = new THREE.PointLight(0xff8a40, 0, 5);

const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: 0x0f1318, metalness: .3, roughness: .75 }));
floor.rotation.x = -PI / 2; floor.position.y = -1.65; floor.receiveShadow = true; scene.add(floor);
const grid = new THREE.GridHelper(40, 40, 0x1b2a3a, 0x121a24); grid.position.y = -1.64; scene.add(grid);

/* ---------- materials & builders ---------- */
const M = (c, m, r, o) => new THREE.MeshStandardMaterial(Object.assign({ color: c, metalness: m, roughness: r, side: THREE.DoubleSide }, o));
const steel = M(0xa4adb6, .95, .36), steel2 = M(0x7c858e, .95, .42), tit = M(0x8c8780, .95, .3), dark = M(0x2b3036, .9, .5),
  stand = M(0x3a4a5c, .75, .5), chrome = M(0xe3e9f0, 1, .12), blue = M(0x2f5385, .6, .4),
  conv = M(0x9a8d7e, .9, .38, { emissive: 0x000000 }), divg = M(0x6d6256, .9, .42, { emissive: 0x000000 });
function add(p, m) { m.castShadow = m.receiveShadow = true; p.add(m); return m; }
function lathe(pts, mat, parent) { // pts = [x, r]; revolve about X axis
  const m = new THREE.Mesh(new THREE.LatheGeometry(pts.map(p => new THREE.Vector2(p[1], p[0])), 72), mat);
  m.rotation.z = -PI / 2; return add(parent, m);
}
function ring(x, r, t, mat, parent) {
  const m = new THREE.Mesh(new THREE.TorusGeometry(r, t, 12, 72), mat); m.rotation.y = PI / 2; m.position.x = x; return add(parent, m);
}
function bolts(x, r, n, parent) {
  const im = new THREE.InstancedMesh(new THREE.CylinderGeometry(.02, .02, .045, 6), dark, n), o = new THREE.Object3D();
  for (let i = 0; i < n; i++) { const a = i / n * 2 * PI; o.position.set(x, Math.cos(a) * r, Math.sin(a) * r); o.rotation.set(a, 0, 0); o.updateMatrix(); im.setMatrixAt(i, o.matrix); }
  im.castShadow = true; parent.add(im);
}
function box(w, h, d, x, y, z, mat, parent) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); return add(parent || scene, m); }
function slab(L, wb, wt, t) { // tapered plate along +X, width along Z, thickness along Y
  const P = [], q = [[0, wb], [1, wt]];
  for (const [e, w] of q) for (let yb = 0; yb < 2; yb++) for (let zb = 0; zb < 2; zb++) P.push(e * L, yb ? t / 2 : -t / 2, zb ? w / 2 : -w / 2);
  const F = [[0, 1, 2, 3], [4, 5, 6, 7], [2, 3, 6, 7], [0, 1, 4, 5], [1, 3, 5, 7], [0, 2, 4, 6]], I = [];
  F.forEach(f => I.push(f[0], f[1], f[2], f[1], f[3], f[2]));
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setIndex(I);
  const n = g.toNonIndexed(); n.computeVertexNormals(); return n;
}

/* ---------- fixed engine + test stand ---------- */
const PX = 0; // gimbal pivot (world x)
const engine = new THREE.Group(); scene.add(engine);
lathe([[-4.3, .52], [-4.22, .66], [-4.0, .68], [-2.75, .64], [-2.7, .62]], steel, engine);
lathe([[-2.7, .62], [-2.65, .64], [-2.55, .62], [-1.35, .58], [-1.3, .6]], tit, engine);
lathe([[-1.3, .6], [-1.25, .62], [-1.15, .62], [-.9, .61], [-.55, .6]], steel2, engine);
ring(-4.26, .6, .07, chrome, engine);
[[-2.7, .65], [-1.3, .62], [-.62, .62]].forEach(a => { ring(a[0], a[1], .028, steel, engine); bolts(a[0], a[1] + .01, 36, engine); });
[-3.6, -3.2, -2.25, -1.95, -1.65, -1.05].forEach(x => ring(x, x < -2.7 ? .665 : x < -1.3 ? .6 : .615, .008, dark, engine));
[40, 140, 250].forEach(a => { const p = add(engine, new THREE.Mesh(new THREE.CylinderGeometry(.022, .022, 3.2, 10), chrome));
  p.rotation.z = PI / 2; p.position.set(-2.6, .69 * Math.cos(a * D), .69 * Math.sin(a * D)); });
// fan face
add(engine, new THREE.Mesh(new THREE.CylinderGeometry(.5, .5, .04, 48), dark)).rotation.z = PI / 2; engine.children[engine.children.length - 1].position.x = -4.0;
const spin = add(engine, new THREE.Mesh(new THREE.ConeGeometry(.17, .5, 32), chrome)); spin.rotation.z = PI / 2; spin.position.x = -4.2;
for (let i = 0; i < 24; i++) { const p = new THREE.Object3D(); p.rotation.x = i / 24 * 2 * PI; p.position.x = -4.0; engine.add(p);
  const b = add(p, new THREE.Mesh(new THREE.BoxGeometry(.05, .34, .13), steel)); b.position.y = .33; b.rotation.y = .5; }
// turbine exit disc (hot glow behind the nozzle)
const exitDisc = new THREE.Mesh(new THREE.CircleGeometry(.6, 48), new THREE.MeshBasicMaterial({ color: 0x2a0e06 }));
exitDisc.rotation.y = PI / 2; exitDisc.position.x = -.55; engine.add(exitDisc);
// static spherical socket
const socket = new THREE.Mesh(new THREE.SphereGeometry(.86, 64, 16, 0, 2 * PI, 100 * D, 35 * D), tit);
socket.rotation.z = -PI / 2; socket.position.x = PX; add(engine, socket);

// test stand
const skid = box(7.4, .18, 1.9, -1.5, -1.55, 0, stand);
box(7.4, .1, .12, -1.5, -1.45, .8, dark); box(7.4, .1, .12, -1.5, -1.45, -.8, dark);
[-3.3, -1.2].forEach(x => {
  ring(x, x < -2 ? .67 : .62, .06, steel, scene).position.x = x;
  box(.2, .84, 1.5, x, -1.04, 0, stand); box(.3, .1, 1.7, x, -.62, 0, dark);
  [-1, 1].forEach(s => { const c = add(scene, new THREE.Mesh(new THREE.CylinderGeometry(.07, .07, .3, 16), chrome)); c.rotation.x = PI / 2; c.position.set(x, 0, s * .74); });
  [-1, 1].forEach(s => { const st = box(.1, 1.0, .1, x, -1.0, s * .55, dark); st.rotation.x = s * .35; });
});

/* ---------- moving nozzle group (pivots about the gimbal point) ---------- */
const noz = new THREE.Group(); noz.position.x = PX; scene.add(noz);
const grabMeshes = [];
const ball = new THREE.Mesh(new THREE.SphereGeometry(.78, 64, 16, 0, 2 * PI, 60 * D, 60 * D), tit); ball.rotation.z = -PI / 2; grabMeshes.push(add(noz, ball));
grabMeshes.push(lathe([[.3, .66], [.34, .72], [.86, .72], [.9, .66]], steel, noz));
grabMeshes.push(ring(.42, .72, .022, chrome, noz), ring(.78, .72, .022, chrome, noz));
bolts(.6, .725, 32, noz);
lathe([[0, .55], [.9, .55]], M(0x241a14, .8, .5), noz); // inner liner hides see-through
const hotDisc = new THREE.Mesh(new THREE.CircleGeometry(.5, 40), new THREE.MeshBasicMaterial({ color: 0xff7a30, transparent: true, opacity: .2, blending: THREE.AdditiveBlending, depthWrite: false }));
hotDisc.rotation.y = PI / 2; hotDisc.position.x = .12; noz.add(hotDisc);

// 16 individually hinged petals: convergent + divergent
const NP = 16, HX = .88, R0 = .64, LC = .75, LD = .55, A0 = 14 * D, B0 = 8 * D, petals = [];
for (let i = 0; i < NP; i++) {
  const piv = new THREE.Object3D(); piv.rotation.x = i / NP * 2 * PI; piv.position.x = HX; noz.add(piv);
  const hinge = new THREE.Object3D(); hinge.position.y = R0; piv.add(hinge);
  const r1 = R0 - LC * Math.sin(A0), w0 = 2 * PI * R0 / NP * .98, w1 = 2 * PI * r1 / NP * .98, w2 = 2 * PI * (r1 + LD * Math.sin(B0)) / NP * .98;
  grabMeshes.push(add(hinge, new THREE.Mesh(slab(LC, w0, w1, .03), conv)));
  const hinge2 = new THREE.Object3D(); hinge2.position.x = LC; hinge.add(hinge2);
  grabMeshes.push(add(hinge2, new THREE.Mesh(slab(LD, w1, w2, .03), divg)));
  petals.push({ hinge, hinge2 });
}

// plume
function cone(color, grp) {
  const g = new THREE.ConeGeometry(1, 1, 32, 1, true); g.translate(0, .5, 0);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  m.rotation.z = -PI / 2; grp.add(m); return m;
}
const plume = new THREE.Group(); plume.position.x = 2.1; noz.add(plume);
const pOut = cone(0xff7a2a, plume), pIn = cone(0xffe6b8, plume); pIn.scale.set(.6, 1, .6); noz.add(glowLight); glowLight.position.set(1.2, 0, 0);

/* ---------- hydraulic actuators (world-space, driven by true linkage geometry) ---------- */
const UP = V3(0, 1, 0), acts = [];
function place(m, p, q, r) { const d = q.clone().sub(p), l = d.length(); m.position.copy(p).addScaledVector(d, .5); m.quaternion.setFromUnitVectors(UP, d.normalize()); m.scale.set(r, l, r); }
const cylG = new THREE.CylinderGeometry(1, 1, 1, 16);
for (let i = 0; i < 3; i++) {
  const psi = i * 2 * PI / 3, c = Math.cos(psi), s = Math.sin(psi);
  const A = V3(-.32, .95 * c, .95 * s), B = V3(.62, .9 * c, .9 * s);
  const b1 = new THREE.Object3D(); b1.rotation.x = psi; engine.add(b1); box(.1, .42, .14, -.32, .76, 0, steel2, b1);
  const b2 = new THREE.Object3D(); b2.rotation.x = psi; noz.add(b2); box(.1, .22, .12, .62, .8, 0, steel2, b2);
  const body = add(scene, new THREE.Mesh(cylG, blue)), rod = add(scene, new THREE.Mesh(cylG, chrome));
  const e1 = add(scene, new THREE.Mesh(new THREE.SphereGeometry(.06, 16, 12), chrome)), e2 = e1.clone(); scene.add(e2);
  acts.push({ A, B, body, rod, e1, e2, rest: 0, ext: 0 });
}
noz.updateMatrixWorld(true);
acts.forEach(a => { a.rest = a.A.distanceTo(noz.localToWorld(a.B.clone())); });

// force-on-engine arrow
const arrow = new THREE.ArrowHelper(V3(-1, 0, 0), V3(PX, 0, 0), 1, 0x35d0ff, .25, .12);
[arrow.line.material, arrow.cone.material].forEach(m => { m.depthTest = false; m.transparent = true; }); arrow.renderOrder = 20; scene.add(arrow);

/* ---------- simulation state ---------- */
const cmd = { p: 0, y: 0 }, st = { p: 0, y: 0 }, vel = { p: 0, y: 0 };
let T = 0, thrCmd = .45, rate = 30, paused = false, simT = 0, rateLim = false;
function setCmd(p, y) { const m = Math.hypot(p, y); if (m > LIM) { p *= LIM / m; y *= LIM / m; } cmd.p = p; cmd.y = y; }
const H = 1 / 240;
function step(h) {
  simT += h;
  if ($('auto').checked) setCmd(LIM * .85 * Math.sin(simT * .7), LIM * .85 * Math.sin(simT * 1.1 + 1.2));
  T += (thrCmd - T) / TAU * h; // first-order spool
  rateLim = false;
  for (const k of ['p', 'y']) {
    const err = cmd[k] - st[k], vt = clamp(err * 8, -rate, rate);
    if (Math.abs(err * 8) > rate) rateLim = true;
    vel[k] += clamp(vt - vel[k], -rate * 10 * h, rate * 10 * h); // acceleration-limited => no snapping
    st[k] += vel[k] * h;
  }
}

/* ---------- camera ---------- */
const PRE = [{ n: 'SIDE', th: 0, ph: PI / 2, r: 6.4, t: [.2, 0, 0] }, { n: 'REAR 3/4', th: 55 * D, ph: 80 * D, r: 5.5, t: [1.3, 0, 0] }, { n: 'TOP-DOWN', th: 0, ph: .05, r: 7.5, t: [.3, 0, 0] }];
let pIdx = 0, orbited = false;
const cur = { th: 0, ph: PI / 2, r: 6.4, t: V3(.2, 0, 0) }, goal = { th: 0, ph: PI / 2, r: 6.4, t: V3(.2, 0, 0) };
function goPreset(i) { pIdx = i; orbited = false; const p = PRE[i]; goal.th = cur.th + wrap(p.th - cur.th); goal.ph = p.ph; goal.r = p.r; goal.t.set(...p.t); }
function camUpdate(dt) {
  const k = 1 - Math.exp(-dt * 6.5);
  cur.th += (goal.th - cur.th) * k; cur.ph += (goal.ph - cur.ph) * k; cur.r += (goal.r - cur.r) * k; cur.t.lerp(goal.t, k);
  camera.position.set(cur.t.x + cur.r * Math.sin(cur.ph) * Math.sin(cur.th), cur.t.y + cur.r * Math.cos(cur.ph), cur.t.z + cur.r * Math.sin(cur.ph) * Math.cos(cur.th));
  camera.lookAt(cur.t);
  $('camtag').textContent = `${PRE[pIdx].n}${orbited ? ' (ORBITED)' : ''} · AZ ${(wrap(cur.th) / D).toFixed(0)}° EL ${(90 - cur.ph / D).toFixed(0)}° · ${cur.r.toFixed(1)} m`;
}
function resize() { const w = view.clientWidth || 1, h = view.clientHeight || 1; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
window.addEventListener('resize', resize); if (window.ResizeObserver) new ResizeObserver(resize).observe(view); resize();

/* ---------- input ---------- */
const DEG_PX = .12, ray = new THREE.Raycaster(), ndc = new THREE.Vector2(); let drag = null;
view.addEventListener('pointerdown', e => {
  if (e.button !== 0) return; view.setPointerCapture(e.pointerId); let mode = 'orbit';
  if ($('grab').checked) {
    const r = view.getBoundingClientRect(); ndc.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
    ray.setFromCamera(ndc, camera); if (ray.intersectObjects(grabMeshes, false).length) { mode = 'noz'; $('auto').checked = false; }
  }
  drag = { mode, x: e.clientX, y: e.clientY };
});
view.addEventListener('pointermove', e => {
  if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
  if (drag.mode === 'noz') setCmd(cmd.p - dy * DEG_PX, cmd.y + dx * DEG_PX);
  else { goal.th -= dx * .006; goal.ph = clamp(goal.ph - dy * .006, .04, 1.75); orbited = true; }
});
const endDrag = () => { drag = null; }; view.addEventListener('pointerup', endDrag); view.addEventListener('pointercancel', endDrag);
view.addEventListener('wheel', e => { e.preventDefault(); goal.r = clamp(goal.r * (1 + Math.sign(e.deltaY) * .08), 3.2, 14); orbited = true; }, { passive: false });
window.addEventListener('keydown', e => { if (e.key === 'e' || e.key === 'E') { e.preventDefault(); goPreset((pIdx + 1) % PRE.length); } });

const pad = $('pad'), pctx = pad.getContext('2d'); let padDrag = null;
(function () { const r = window.devicePixelRatio || 1; pad.width = 180 * r; pad.height = 180 * r; pctx.scale(r, r); })();
pad.addEventListener('pointerdown', e => { e.stopPropagation(); pad.setPointerCapture(e.pointerId); padDrag = { x: e.clientX, y: e.clientY }; $('auto').checked = false; });
pad.addEventListener('pointermove', e => { if (!padDrag) return; e.stopPropagation(); setCmd(cmd.p - (e.clientY - padDrag.y) * DEG_PX, cmd.y + (e.clientX - padDrag.x) * DEG_PX); padDrag.x = e.clientX; padDrag.y = e.clientY; });
pad.addEventListener('pointerup', () => { padDrag = null; }); pad.addEventListener('pointercancel', () => { padDrag = null; });
function drawPad() {
  const c = 90, R = 78; pctx.clearRect(0, 0, 180, 180); pctx.lineWidth = 1; pctx.strokeStyle = '#1e3248';
  [1, 2 / 3, 1 / 3].forEach(f => { pctx.beginPath(); pctx.arc(c, c, R * f, 0, 2 * PI); pctx.stroke(); });
  pctx.beginPath(); pctx.moveTo(c - R, c); pctx.lineTo(c + R, c); pctx.moveTo(c, c - R); pctx.lineTo(c, c + R); pctx.stroke();
  pctx.fillStyle = '#4b6a88'; pctx.font = '9px monospace'; pctx.fillText('UP', c - 6, 11); pctx.fillText('R', 168, c - 3); pctx.fillText('L', 5, c - 3);
  const ax = c + st.y / LIM * R, ay = c - st.p / LIM * R, cx = c + cmd.y / LIM * R, cy = c - cmd.p / LIM * R;
  pctx.strokeStyle = '#ffb347'; pctx.lineWidth = 2; pctx.beginPath(); pctx.moveTo(c, c); pctx.lineTo(ax, ay); pctx.stroke();
  pctx.strokeStyle = '#35d0ff'; pctx.lineWidth = 1.5; pctx.beginPath(); pctx.arc(cx, cy, 8, 0, 2 * PI); pctx.moveTo(cx - 12, cy); pctx.lineTo(cx + 12, cy); pctx.moveTo(cx, cy - 12); pctx.lineTo(cx, cy + 12); pctx.stroke();
  pctx.fillStyle = '#ffb347'; pctx.beginPath(); pctx.arc(ax, ay, 4, 0, 2 * PI); pctx.fill();
}

const thr = $('thr'), pit = $('pit'), yaw = $('yaw'), rt = $('rate');
thr.oninput = () => { thrCmd = thr.value / 100; };
pit.oninput = () => { $('auto').checked = false; setCmd(+pit.value, cmd.y); };
yaw.oninput = () => { $('auto').checked = false; setCmd(cmd.p, +yaw.value); };
rt.oninput = () => { rate = +rt.value; };
$('bCentre').onclick = () => { $('auto').checked = false; setCmd(0, 0); };
$('bPause').onclick = () => { paused = !paused; $('bPause').textContent = paused ? 'Resume' : 'Pause'; };
$('bReset').onclick = () => { $('auto').checked = false; $('grab').checked = false; setCmd(0, 0); thr.value = 45; thrCmd = .45; rt.value = 30; rate = 30; goPreset(0); };

/* ---------- telemetry & labels ---------- */
const rows = [['thc', 'Throttle cmd'], ['thr', 'Engine thrust'], ['pit', 'Pitch act / cmd'], ['yaw', 'Yaw act / cmd'], ['def', 'Total deflection'],
  ['fwd', 'Forward (+fwd)'], ['ver', 'Vertical (+up)'], ['lat', 'Lateral (+right)'], ['sts', 'Actuators'], ['a0', 'Actuator 1 ext'], ['a1', 'Actuator 2 ext'], ['a2', 'Actuator 3 ext']];
$('tele').innerHTML = rows.map(r => `<tr><td>${r[1]}</td><td id="t_${r[0]}"></td></tr>`).join('');
const tv = {}; rows.forEach(r => tv[r[0]] = $('t_' + r[0]));
const labs = [['F110-CLASS TURBOFAN (FIXED)', () => V3(-3, .72, 0)], ['GIMBAL / SPHERICAL BEARING', () => V3(0, .88, 0)],
  ['HYDRAULIC ACTUATORS ×3', () => acts[0].body.position.clone().add(V3(0, .05, 0))], ['AVEN PETALS ×16 (×2 ROWS)', () => noz.localToWorld(V3(1.5, .5, 0))]]
  .map(l => { const el = document.createElement('div'); el.className = 'lab'; el.textContent = l[0]; $('labels').appendChild(el); return { el, fn: l[1] }; });
const tmp = V3(0, 0, 0), qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), AXZ = V3(0, 0, 1), AXY = V3(0, 1, 0), dvec = V3(1, 0, 0);
let lastTele = 0;

function pose(now) {
  qa.setFromAxisAngle(AXY, -st.y * D); qb.setFromAxisAngle(AXZ, -st.p * D); noz.quaternion.copy(qa).multiply(qb); noz.updateMatrixWorld(true);
  const al = A0 - 4 * D * T, be = B0 + 3 * D * T; // nozzle area opens with power
  petals.forEach(p => { p.hinge.rotation.z = -al; p.hinge2.rotation.z = al + be; });
  conv.emissive.setRGB(.5 * T, .12 * T, .02 * T); divg.emissive.setRGB(.7 * T, .16 * T, .03 * T);
  // actuators
  acts.forEach(a => {
    const Bw = noz.localToWorld(a.B.clone()), d = Bw.clone().sub(a.A), len = d.length(), u = d.clone().normalize(), Lb = .45;
    place(a.body, a.A, a.A.clone().addScaledVector(u, Lb), .045); place(a.rod, a.A.clone().addScaledVector(u, Lb - .06), Bw, .024);
    a.e1.position.copy(a.A); a.e2.position.copy(Bw); a.ext = len - a.rest;
  });
  // exhaust + force
  dvec.set(1, 0, 0).applyQuaternion(noz.quaternion);
  const vis = T > .015; plume.visible = vis; hotDisc.material.opacity = .12 + .8 * T; glowLight.intensity = 3 * T;
  const fl = 1 + .02 * Math.sin(now * .011) + .015 * Math.sin(now * .023);
  plume.scale.set((.3 + 2.1 * T) * fl, .52, .52); pOut.material.opacity = .32 * T; pIn.material.opacity = .55 * T; pIn.scale.set(.65, 1, .65);
  arrow.setDirection(dvec.clone().negate()); arrow.setLength(.5 + 1.6 * T, .25, .12); arrow.visible = T > .01;
  // labels
  const w = view.clientWidth, h = view.clientHeight;
  labs.forEach(l => { tmp.copy(l.fn()).project(camera); const on = tmp.z < 1; l.el.style.display = on ? 'block' : 'none'; l.el.style.left = ((tmp.x * .5 + .5) * w) + 'px'; l.el.style.top = ((-tmp.y * .5 + .5) * h) + 'px'; });
  // telemetry
  if (now - lastTele > 60) {
    lastTele = now; const F = T * TMAX, mvg = Math.hypot(vel.p, vel.y);
    tv.thc.textContent = (thrCmd * 100).toFixed(0) + ' %'; tv.thr.textContent = F.toFixed(1) + ' kN (' + (T * 100).toFixed(0) + ' %)';
    tv.pit.textContent = fmt(st.p) + '° / ' + fmt(cmd.p) + '°'; tv.yaw.textContent = fmt(st.y) + '° / ' + fmt(cmd.y) + '°';
    tv.def.textContent = Math.hypot(st.p, st.y).toFixed(1) + '° of ' + LIM + '°';
    tv.fwd.textContent = (F * dvec.x).toFixed(1) + ' kN'; tv.ver.textContent = (-F * dvec.y).toFixed(1) + ' kN'; tv.lat.textContent = (F * dvec.z).toFixed(1) + ' kN';
    tv.sts.textContent = paused ? 'PAUSED' : rateLim ? 'RATE LIMITED' : mvg > .05 ? 'MOVING' : 'HOLDING';
    acts.forEach((a, i) => tv['a' + i].textContent = fmt(a.ext * 1000, 0) + ' mm');
    $('thrV').textContent = (thrCmd * 100).toFixed(0) + ' %'; $('pitV').textContent = fmt(cmd.p) + '°'; $('yawV').textContent = fmt(cmd.y) + '°'; $('rateV').textContent = rate + ' °/s';
    if (document.activeElement !== pit) pit.value = cmd.p.toFixed(1); if (document.activeElement !== yaw) yaw.value = cmd.y.toFixed(1);
  }
}

/* ---------- main loop: fixed 240 Hz physics step, frame-rate independent ---------- */
let last = performance.now(), acc = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, .1); last = now;
  if (!paused) { acc += dt; while (acc >= H) { step(H); acc -= H; } }
  camUpdate(dt); pose(now); drawPad(); renderer.render(scene, camera);
}
requestAnimationFrame(frame);
})();
