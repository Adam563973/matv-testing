(() => {
  'use strict';

  // Surface startup/runtime JavaScript errors in the viewport rather than leaving
  // a blank canvas with no clue what failed.
  window.addEventListener('error', (event) => {
    const viewEl = document.getElementById('view');
    if (!viewEl) return;
    let panel = document.getElementById('matv-js-error');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'matv-js-error';
      panel.style.cssText = 'position:absolute;z-index:10000;left:12px;right:12px;bottom:12px;max-height:32%;overflow:auto;padding:12px;background:rgba(88,18,24,.96);border:1px solid #ff8181;border-radius:6px;color:#fff;font:12px/1.45 monospace;white-space:pre-wrap;pointer-events:auto;';
      viewEl.appendChild(panel);
    }
    panel.textContent = 'MATV JavaScript error: ' + (event.message || 'Unknown error') +
      (event.filename ? '\n' + event.filename.split('/').pop() + ':' + event.lineno : '') +
      '\nOpen browser developer tools (F12) for the full stack trace.';
    console.error('MATV simulator runtime error:', event.message, event.filename, event.lineno, event.error);
  });

  // F-16 MATV / AVEN nozzle bench — procedural visualisation.
  // Uses Three.js r128 WebGL rendering, PBR materials, environment reflections,
  // soft shadow maps and raycasting for pointer interaction. This is not a
  // hardware ray-traced renderer or an engineering-accurate engine model.

  const $ = (id) => document.getElementById(id);
  const required = ['view','thr','pit','yaw','rate','pad','camtag','labels','tele','auto','grab','bCentre','bPause','bReset','sceneMode','nozzleMode','aircraftProfile','diff','flightSpeed','flightAlt','elev','ail','rud','flightTele','bCobra','bLevel','haptics','gamepadToggle','gamepadTag'];
  const missing = required.filter(id => !$(id));
  if (missing.length) {
    console.error('MATV simulator: missing HTML elements:', missing.join(', '));
    const viewEl = $('view');
    if (viewEl) viewEl.innerHTML = '<p style="padding:20px;color:#fff">Simulator could not start. Missing HTML elements: ' + missing.join(', ') + '</p>';
    return;
  }
  if (typeof THREE === 'undefined') {
    $('view').insertAdjacentHTML('beforeend', '<p style="padding:20px;color:#fff">Three.js did not load. Check your internet connection or CDN script.</p>');
    return;
  }

  const D = Math.PI / 180;
  const PI = Math.PI;
  const LIM = 17;
  const TMAX = 130;
  let TAU = 1.4;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const wrap = (a) => ((a + PI) % (2 * PI) + 2 * PI) % (2 * PI) - PI;
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const fmt = (v, d = 1) => (v >= 0 ? '+' : '') + v.toFixed(d);
  const view = $('view');

  // ---------------- Renderer ----------------
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true
    });
  } catch (err) {
    console.error('MATV simulator could not initialise WebGL:', err);
    view.innerHTML = '<p style="padding:20px;color:#fff">WebGL is unavailable in this browser or device.</p>';
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(Math.max(view.clientWidth, 1), Math.max(view.clientHeight, 1), false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.physicallyCorrectLights = true;
  renderer.domElement.id = 'matv-renderer';
  renderer.domElement.style.position = 'absolute';
  renderer.domElement.style.inset = '0';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.zIndex = '0';
  view.insertBefore(renderer.domElement, view.firstChild);
  ['camtag', 'hint', 'labels'].forEach(id => { const el = $(id); if (el) el.style.zIndex = '3'; });

  const scene = new THREE.Scene();
  // Pale blue atmospheric fog blends the distant test-bay floor into the sky.
  // The sky itself is rendered by a procedural dome just below.
  scene.background = null;
  scene.fog = new THREE.Fog(0x91c0e9, 26, 88);
  const camera = new THREE.PerspectiveCamera(39, 1, 0.1, 140);

  // ---------------- Reliable blue sky and softly moving clouds ----------------
  // Use CanvasTexture rather than a custom GLSL sky shader. This avoids shader
  // compiler differences across browsers while retaining a GPU-rendered sky dome.
  function makeSkyGradientTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0.00, '#1556b4');
    gradient.addColorStop(0.20, '#2875d0');
    gradient.addColorStop(0.42, '#5ca3e5');
    gradient.addColorStop(0.67, '#a8d3f4');
    gradient.addColorStop(0.85, '#d8edfc');
    gradient.addColorStop(1.00, '#a9d0ef');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // A very gentle glow around the horizon keeps the background atmospheric.
    const haze = ctx.createLinearGradient(0, 300, 0, 512);
    haze.addColorStop(0, 'rgba(225,244,255,0)');
    haze.addColorStop(1, 'rgba(229,244,255,0.42)');
    ctx.fillStyle = haze;
    ctx.fillRect(0, 300, canvas.width, 212);

    const texture = new THREE.CanvasTexture(canvas);
    texture.encoding = THREE.sRGBEncoding;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    return texture;
  }

  function makeCloudTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Seeded random numbers make the cloud layout consistent between reloads.
    let seed = 817263;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    function puff(x, y, rx, ry, alpha, underside = false) {
      // Draw duplicates over the horizontal edges so the cloud field wraps cleanly.
      for (const shift of [-canvas.width, 0, canvas.width]) {
        ctx.save();
        ctx.translate(x + shift, y);
        ctx.scale(Math.max(rx, 1), Math.max(ry, 1));
        const g = ctx.createRadialGradient(0, 0, 0.05, 0, 0, 1);
        if (underside) {
          g.addColorStop(0, `rgba(79,121,165,${alpha * 0.42})`);
          g.addColorStop(0.52, `rgba(105,151,191,${alpha * 0.28})`);
          g.addColorStop(1, 'rgba(120,160,198,0)');
        } else {
          g.addColorStop(0, `rgba(255,255,255,${alpha})`);
          g.addColorStop(0.46, `rgba(248,252,255,${alpha * 0.88})`);
          g.addColorStop(0.78, `rgba(235,246,255,${alpha * 0.36})`);
          g.addColorStop(1, 'rgba(255,255,255,0)');
        }
        ctx.fillStyle = g;
        ctx.fillRect(-1, -1, 2, 2);
        ctx.restore();
      }
    }

    // Several broken cumulus banks with soft, overlapping lobes and cool undersides.
    for (let bank = 0; bank < 23; bank++) {
      const cx = rand() * canvas.width;
      const cy = 145 + rand() * 185;
      const span = 34 + rand() * 100;
      const lobes = 5 + Math.floor(rand() * 13);
      const baseAlpha = 0.32 + rand() * 0.36;
      puff(cx, cy + 14, span * 0.82, 27 + rand() * 19, 0.40, true);
      for (let j = 0; j < lobes; j++) {
        const x = cx + (rand() - 0.5) * span * 1.65;
        const y = cy + (rand() - 0.54) * 51;
        const rx = 16 + rand() * 39;
        const ry = 11 + rand() * 28;
        puff(x, y + 7, rx * 1.12, ry * 0.8, baseAlpha * 0.62, true);
        puff(x, y, rx, ry, baseAlpha * (0.78 + rand() * 0.32), false);
      }
    }

    // High, thin wisps break up the saturated upper blue without covering it completely.
    for (let i = 0; i < 62; i++) {
      const x = rand() * canvas.width;
      const y = 80 + rand() * 105;
      puff(x, y, 10 + rand() * 40, 3 + rand() * 7, 0.13 + rand() * 0.13, false);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.encoding = THREE.sRGBEncoding;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    return texture;
  }

  const skyTexture = makeSkyGradientTexture();
  const cloudTexture = makeCloudTexture();
  const skyDome = new THREE.Mesh(
    new THREE.SphereGeometry(74, 48, 32),
    new THREE.MeshBasicMaterial({
      map: skyTexture,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      toneMapped: false
    })
  );
  skyDome.name = 'Blue atmospheric sky';
  skyDome.frustumCulled = false;
  skyDome.renderOrder = -1000;
  skyDome.castShadow = false;
  skyDome.receiveShadow = false;
  scene.add(skyDome);

  const cloudDome = new THREE.Mesh(
    new THREE.SphereGeometry(73.7, 48, 32),
    new THREE.MeshBasicMaterial({
      map: cloudTexture,
      transparent: true,
      opacity: 0.94,
      side: THREE.BackSide,
      depthWrite: false,
      // Keep depth testing enabled so clouds are hidden by the engine and floor.
      depthTest: true,
      toneMapped: false
    })
  );
  cloudDome.name = 'Soft cumulus cloud layer';
  cloudDome.frustumCulled = false;
  cloudDome.renderOrder = -999;
  cloudDome.castShadow = false;
  cloudDome.receiveShadow = false;
  scene.add(cloudDome);

  // Studio light cards make metallic surfaces legible without true ray tracing.
  const envScene = new THREE.Scene();
  envScene.background = new THREE.Color(0x8abbe9); // Blue-sky fill for bright, believable metal reflections.
  function lightCard(w, h, d, x, y, z, colour, intensity = 1) {
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(colour).multiplyScalar(intensity),
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    envScene.add(mesh);
  }
  lightCard(12, 0.18, 3, 0, 7, 0, 0xffffff, 2.8);
  lightCard(0.18, 5, 9, -7, 1.6, 0, 0xb9d7ff, 2.2);
  lightCard(0.18, 4, 7, 7, 1.8, 1, 0xffd8b4, 2.0);
  lightCard(10, 2.2, 0.18, 0, 3.2, -6, 0x789abd, 1.8);
  lightCard(6, 0.15, 4, 0, -1.4, 3, 0x99bfff, 0.9);
  let envTexture = null;
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    envTexture = pmrem.fromScene(envScene, 0.035).texture;
    scene.environment = envTexture;
    pmrem.dispose();
  } catch (err) {
    console.warn('Environment reflections could not be generated; continuing with direct lights.', err);
  }
  // The environment source geometry is no longer needed after PMREM conversion.
  envScene.clear();

  // ---------------- Lighting ----------------
  const key = new THREE.DirectionalLight(0xffedda, 3.0);
  key.position.set(-2.5, 8, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -7.5;
  key.shadow.camera.right = 7.5;
  key.shadow.camera.top = 6.5;
  key.shadow.camera.bottom = -6.5;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 28;
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.025;
  key.shadow.radius = 4;
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xc4dfff, 1.55);
  fill.position.set(3, 2.5, 8);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0x7eafff, 2.0);
  rim.position.set(2, 4, -7);
  scene.add(rim);
  const warm = new THREE.DirectionalLight(0xffbd82, 0.55);
  warm.position.set(-7, 1, 2);
  scene.add(warm);
  scene.add(new THREE.HemisphereLight(0xc5d7eb, 0x272d36, 1.1));
  const exhaustLight = new THREE.PointLight(0xff6b2c, 0, 8, 2);
  exhaustLight.name = 'exhaust-light';
  scene.add(exhaustLight);

  // ---------------- Scene floor and studio ----------------
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x141a22, metalness: 0.12, roughness: 0.82 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), floorMat);
  floor.rotation.x = -PI / 2;
  floor.position.y = -1.78;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(36, 36, 0x283a4d, 0x182432);
  grid.position.y = -1.765;
  grid.material.transparent = true;
  grid.material.opacity = 0.36;
  scene.add(grid);
  // Subtle stage discs add depth to the test-bay presentation.
  const stage = new THREE.Mesh(
    new THREE.CylinderGeometry(5.1, 5.25, 0.07, 96),
    new THREE.MeshStandardMaterial({ color: 0x111820, metalness: 0.24, roughness: 0.7 })
  );
  stage.position.set(-0.5, -1.72, 0);
  stage.receiveShadow = true;
  stage.castShadow = true;
  scene.add(stage);

  // ---------------- Materials and geometry helpers ----------------
  const mat = (colour, metalness, roughness, extra = {}) => new THREE.MeshStandardMaterial({
    color: colour,
    metalness,
    roughness,
    side: THREE.DoubleSide,
    envMapIntensity: 1.1,
    ...extra
  });
  const steel = mat(0xaeb9c4, 0.52, 0.36);
  const steelDark = mat(0x596572, 0.48, 0.43);
  const titanium = mat(0x9b968d, 0.44, 0.39);
  const darkSteel = mat(0x303943, 0.38, 0.52);
  const innerMetal = mat(0x242a31, 0.35, 0.58);
  const chrome = mat(0xdfe8f0, 0.72, 0.22);
  const standMat = mat(0x344b63, 0.28, 0.56);
  const blueMetal = mat(0x315b91, 0.34, 0.4);
  const brass = mat(0x9f8664, 0.55, 0.38);
  const convergentMat = mat(0xaaa08f, 0.35, 0.43, { emissive: 0x000000 });
  const divergentMat = mat(0x796e60, 0.32, 0.46, { emissive: 0x000000 });
  const blackCeramic = mat(0x171b20, 0.15, 0.67);

  function add(parent, object) {
    object.castShadow = true;
    object.receiveShadow = true;
    parent.add(object);
    return object;
  }
  function makeBox(parent, w, h, d, x, y, z, material, bevel = false) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    add(parent, mesh);
    return mesh;
  }
  function latheX(parent, profile, material, segments = 96) {
    const geometry = new THREE.LatheGeometry(profile.map(([x, radius]) => new THREE.Vector2(radius, x)), segments);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.z = -PI / 2;
    return add(parent, mesh);
  }
  function ringX(parent, x, radius, thickness, material, segments = 96) {
    const mesh = new THREE.Mesh(new THREE.TorusGeometry(radius, thickness, 12, segments), material);
    mesh.rotation.y = PI / 2;
    mesh.position.x = x;
    return add(parent, mesh);
  }
  function radialBolts(parent, x, radius, count, boltRadius = 0.022, material = darkSteel) {
    const geom = new THREE.CylinderGeometry(boltRadius, boltRadius, 0.035, 8);
    const mesh = new THREE.InstancedMesh(geom, material, count);
    const temp = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      const a = i / count * 2 * PI;
      const normal = V(0, Math.cos(a), Math.sin(a));
      temp.position.set(x, radius * Math.cos(a), radius * Math.sin(a));
      temp.quaternion.setFromUnitVectors(V(0, 1, 0), normal);
      temp.updateMatrix();
      mesh.setMatrixAt(i, temp.matrix);
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }
  function cylinderBetween(parent, p, q, radius, material, radialSegments = 16) {
    const delta = q.clone().sub(p);
    const length = delta.length();
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, Math.max(length, 0.001), radialSegments), material);
    mesh.position.copy(p).addScaledVector(delta, 0.5);
    mesh.quaternion.setFromUnitVectors(V(0, 1, 0), delta.normalize());
    return add(parent, mesh);
  }
  function makePlateGeometry(length, width0, width1, thickness, radialDrop = 0) {
    // Closed, bevel-free tapered metal plate; face winding is explicit for clean normals.
    const verts = [
      0, -thickness / 2, -width0 / 2,
      0, -thickness / 2, width0 / 2,
      0, thickness / 2, -width0 / 2,
      0, thickness / 2, width0 / 2,
      length, radialDrop - thickness / 2, -width1 / 2,
      length, radialDrop - thickness / 2, width1 / 2,
      length, radialDrop + thickness / 2, -width1 / 2,
      length, radialDrop + thickness / 2, width1 / 2
    ];
    const faces = [
      [0, 2, 3, 1], [4, 5, 7, 6], [2, 6, 7, 3],
      [0, 1, 5, 4], [1, 3, 7, 5], [0, 4, 6, 2]
    ];
    const positions = [];
    faces.forEach(f => positions.push(...f.map(i => [verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]]).flat()));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    return geometry;
  }

  // ---------------- Fixed core engine ----------------
  const engine = new THREE.Group();
  engine.name = 'fixed engine core';
  scene.add(engine);

  // Outer casings, flanges, machined seams and clamps.
  latheX(engine, [[-4.45, .42], [-4.40, .55], [-4.28, .65], [-4.05, .68], [-3.90, .67], [-3.72, .65], [-2.85, .65], [-2.75, .62]], steel);
  latheX(engine, [[-2.77, .615], [-2.72, .65], [-2.61, .65], [-2.48, .62], [-1.52, .60], [-1.39, .61], [-1.31, .59]], titanium);
  latheX(engine, [[-1.33, .585], [-1.28, .62], [-1.15, .63], [-0.86, .62], [-0.60, .60], [-0.42, .57]], steelDark);
  latheX(engine, [[-4.34, .50], [-4.30, .55], [-4.24, .55]], darkSteel);
  ringX(engine, -4.28, .62, .065, chrome);
  ringX(engine, -2.73, .647, .045, chrome);
  ringX(engine, -1.34, .61, .045, chrome);
  ringX(engine, -0.64, .61, .035, chrome);
  [-3.9, -3.65, -3.1, -2.45, -2.0, -1.75, -1.48, -1.08, -0.88].forEach((x, i) => {
    const r = x < -2.7 ? .66 : (x < -1.35 ? .61 : .625);
    ringX(engine, x, r, i % 2 ? .012 : .018, i % 2 ? darkSteel : steelDark, 80);
  });
  radialBolts(engine, -2.72, .655, 40, .019, darkSteel);
  radialBolts(engine, -1.34, .62, 36, .019, darkSteel);
  radialBolts(engine, -0.65, .615, 32, .018, darkSteel);

  // Axial strengthening bars and small casing service panels.
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * 2 * PI;
    const y = .642 * Math.cos(a), z = .642 * Math.sin(a);
    const bar = makeBox(engine, 1.02, .045, .045, -2.08, y, z, steelDark);
    bar.rotation.x = a;
  }
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * 2 * PI + 0.18;
    const panel = makeBox(engine, .34, .012, .15, -3.42, .665 * Math.cos(a), .665 * Math.sin(a), darkSteel);
    panel.rotation.x = a;
    const screw = new THREE.Mesh(new THREE.SphereGeometry(.018, 8, 6), chrome);
    screw.position.set(-3.49, .674 * Math.cos(a), .674 * Math.sin(a));
    add(engine, screw);
  }

  // Simplified compressor face, hub, and 28 curved-look blades.
  const fanDisk = new THREE.Mesh(new THREE.CylinderGeometry(.49, .49, .055, 64), innerMetal);
  fanDisk.rotation.z = PI / 2;
  fanDisk.position.x = -4.02;
  add(engine, fanDisk);
  const fanHub = new THREE.Mesh(new THREE.ConeGeometry(.19, .43, 40), chrome);
  fanHub.rotation.z = -PI / 2;
  fanHub.position.x = -4.10;
  add(engine, fanHub);
  const fanRing = ringX(engine, -3.98, .48, .018, brass, 72);
  for (let i = 0; i < 28; i++) {
    const a = i / 28 * 2 * PI;
    const blade = new THREE.Mesh(new THREE.BoxGeometry(.035, .31, .105), steel);
    blade.position.set(-4.00, .29 * Math.cos(a), .29 * Math.sin(a));
    blade.rotation.x = a;
    blade.rotation.y = 0.42;
    add(engine, blade);
  }

  // Rear hot-section liner and static gimbal housing.
  latheX(engine, [[-0.78, .49], [-0.66, .56], [-0.40, .61], [-0.14, .69], [0.10, .75]], darkSteel);
  latheX(engine, [[-0.28, .64], [-0.18, .76], [0.02, .83], [0.16, .82]], titanium);
  ringX(engine, -0.05, .81, .055, chrome);
  radialBolts(engine, -0.045, .82, 32, .018, darkSteel);
  latheX(engine, [[-0.02, .755], [0.10, .78], [0.18, .75]], blackCeramic);

  // ---------------- Test stand ----------------
  const stand = new THREE.Group();
  scene.add(stand);
  makeBox(stand, 7.8, .18, 2.05, -1.45, -1.47, 0, standMat);
  makeBox(stand, 7.8, .09, .10, -1.45, -1.34, .91, darkSteel);
  makeBox(stand, 7.8, .09, .10, -1.45, -1.34, -.91, darkSteel);
  makeBox(stand, 7.8, .06, .10, -1.45, -1.55, .91, chrome);
  makeBox(stand, 7.8, .06, .10, -1.45, -1.55, -.91, chrome);
  [-3.25, -1.05].forEach((x, idx) => {
    makeBox(stand, .28, .86, 1.55, x, -1.02, 0, standMat);
    makeBox(stand, .42, .12, 1.78, x, -.56, 0, darkSteel);
    [-1, 1].forEach(s => {
      const brace = makeBox(stand, .12, .90, .12, x, -1.02, s * .55, steelDark);
      brace.rotation.x = s * .28;
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(.075, .075, .30, 24), chrome);
      pin.rotation.x = PI / 2;
      pin.position.set(x, -.57, s * .73);
      add(stand, pin);
    });
  });

  // ---------------- Moving vectored nozzle ----------------
  const pivotX = 0.12;
  const nozzle = new THREE.Group();
  nozzle.name = 'movable nozzle';
  nozzle.position.x = pivotX;
  scene.add(nozzle);
  const pickMeshes = [];

  // Gimbal ball and nozzle barrel.
  const gimbal = new THREE.Mesh(new THREE.SphereGeometry(.70, 64, 40), titanium);
  gimbal.scale.set(.73, 1.08, 1.08);
  add(nozzle, gimbal);
  pickMeshes.push(gimbal);
  latheX(nozzle, [[0.12, .57], [0.19, .67], [0.33, .70], [0.49, .68], [0.68, .65], [0.80, .64]], steel);
  ringX(nozzle, .24, .675, .027, chrome);
  ringX(nozzle, .49, .67, .022, brass);
  ringX(nozzle, .77, .645, .033, chrome);
  radialBolts(nozzle, .77, .655, 36, .017, darkSteel);
  // Dark inner liner, heat shields, and concentric inside rings.
  latheX(nozzle, [[0.10, .51], [0.28, .535], [0.60, .54], [0.83, .55], [1.03, .57]], blackCeramic);
  ringX(nozzle, .32, .535, .014, brass, 72);
  ringX(nozzle, .57, .545, .012, steelDark, 72);
  ringX(nozzle, .88, .565, .018, brass, 72);
  const hotCore = new THREE.Mesh(new THREE.CircleGeometry(.49, 64), new THREE.MeshBasicMaterial({ color: 0x38140b, side: THREE.DoubleSide }));
  hotCore.rotation.y = PI / 2;
  hotCore.position.x = .14;
  nozzle.add(hotCore);

  // Twelve convergent and twelve divergent articulated petal pairs.
  const petalCount = 16;
  const HINGE_X = .82;
  const R0 = .61;
  const LC = .60;
  const LD = .54;
  const A0 = 13.5 * D;
  const B0 = 8.5 * D;
  const petals = [];
  const petalWidth0 = 2 * PI * R0 / petalCount * .96;
  const rMid = R0 - LC * Math.sin(A0);
  const petalWidth1 = 2 * PI * rMid / petalCount * .96;
  const rExit = rMid + LD * Math.sin(B0);
  const petalWidth2 = 2 * PI * rExit / petalCount * .96;

  for (let i = 0; i < petalCount; i++) {
    const az = i * 2 * PI / petalCount;
    const base = new THREE.Group();
    base.name = `petal-base-${i}`;
    base.position.set(HINGE_X, R0 * Math.cos(az), R0 * Math.sin(az));
    base.rotation.x = az;
    nozzle.add(base);
    const hinge = new THREE.Group();
    hinge.name = `petal-hinge-${i}`;
    base.add(hinge);
    const inner = new THREE.Mesh(makePlateGeometry(LC, petalWidth0, petalWidth1, .038, -LC * Math.sin(A0)), convergentMat);
    inner.position.z = 0;
    add(hinge, inner);
    pickMeshes.push(inner);

    // Raised longitudinal stiffener on each convergent segment.
    const rib = makeBox(hinge, LC * .86, .018, .024, LC * .48, -LC * Math.sin(A0) * .48 + .025, petalWidth0 * .17, steelDark);
    rib.rotation.z = -A0;

    const outerHinge = new THREE.Group();
    outerHinge.name = `petal-outer-${i}`;
    outerHinge.position.set(LC, -LC * Math.sin(A0), 0);
    hinge.add(outerHinge);
    const outer = new THREE.Mesh(makePlateGeometry(LD, petalWidth1, petalWidth2, .036, LD * Math.sin(B0)), divergentMat);
    add(outerHinge, outer);
    pickMeshes.push(outer);
    const outerRib = makeBox(outerHinge, LD * .78, .016, .022, LD * .43, LD * Math.sin(B0) * .43 + .022, 0, brass);
    outerRib.rotation.z = B0;
    petals.push({ base, hinge, outerHinge, az });
  }

  // Actuator attachment brackets around the gimbal.
  const fixedAnchors = [];
  const movingAnchors = [];
  const actuatorMeshes = [];
  for (let i = 0; i < 3; i++) {
    const a = i * 2 * PI / 3 + PI / 6;
    const c = Math.cos(a), s = Math.sin(a);
    const A = V(-0.30, .87 * c, .87 * s);
    const B = V(.56, .84 * c, .84 * s);
    const fixedBracket = makeBox(engine, .18, .28, .18, A.x, A.y, A.z, steelDark);
    fixedBracket.rotation.x = a;
    const movingBracket = makeBox(nozzle, .17, .26, .16, B.x, B.y, B.z, steelDark);
    movingBracket.rotation.x = a;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.12, 1, 24), blueMetal);
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 16), chrome);
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 24), darkSteel);
    const eyeA = new THREE.Mesh(new THREE.SphereGeometry(.067, 16, 12), chrome);
    const eyeB = new THREE.Mesh(new THREE.SphereGeometry(.067, 16, 12), chrome);
    [body, rod, collar, eyeA, eyeB].forEach(m => add(scene, m));
    const rest = A.distanceTo(nozzle.localToWorld(B.clone()));
    fixedAnchors.push(A);
    movingAnchors.push(B);
    actuatorMeshes.push({ A, B, body, rod, collar, eyeA, eyeB, rest, extension: 0 });
  }

  function placeCylinder(mesh, start, end, radiusX, radiusZ = radiusX) {
    const d = end.clone().sub(start);
    const len = d.length();
    mesh.position.copy(start).addScaledVector(d, .5);
    mesh.quaternion.setFromUnitVectors(V(0, 1, 0), d.clone().normalize());
    mesh.scale.set(radiusX, Math.max(len, .001), radiusZ);
  }

  // Fine flexible hydraulic lines and cable loops around actuator mount points.
  for (let i = 0; i < 3; i++) {
    const a = i * 2 * PI / 3 + PI / 6;
    const c = Math.cos(a), s = Math.sin(a);
    const points = [V(-.48, .72*c, .72*s), V(-.22, .80*c, .80*s), V(.06, .82*c, .82*s)];
    const curve = new THREE.CatmullRomCurve3(points);
    add(engine, new THREE.Mesh(new THREE.TubeGeometry(curve, 24, .014, 8, false), darkSteel));
  }

  // ---------------- Exhaust plume and reaction-force indicator ----------------
  function makeOpenCone(colour, opacity) {
    const geom = new THREE.ConeGeometry(1, 1, 48, 1, true);
    geom.translate(0, .5, 0);
    const material = new THREE.MeshBasicMaterial({
      color: colour, transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(geom, material);
    mesh.rotation.z = -PI / 2;
    mesh.renderOrder = 5;
    return mesh;
  }
  const plume = new THREE.Group();
  plume.name = 'exhaust-plume';
  plume.position.x = 1.85;
  nozzle.add(plume);
  const plumeOuter = makeOpenCone(0xff5a20, 0);
  const plumeInner = makeOpenCone(0xffdb91, 0);
  plumeInner.scale.set(.62, 1, .62);
  plume.add(plumeOuter, plumeInner);
  exhaustLight.position.set(1.1, 0, 0);
  nozzle.add(exhaustLight);

  // Lightweight exhaust particulate VFX. Particles are deterministic from frame
  // time, so they need no per-particle physics or random allocation each frame.
  const exhaustParticleCount = 120;
  const exhaustParticlePositions = new Float32Array(exhaustParticleCount * 3);
  const exhaustParticleGeometry = new THREE.BufferGeometry();
  exhaustParticleGeometry.setAttribute('position', new THREE.BufferAttribute(exhaustParticlePositions, 3));
  const exhaustParticleMaterial = new THREE.PointsMaterial({
    color: 0xffb36a, size: 0.045, transparent: true, opacity: 0.6,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true
  });
  const exhaustParticles = new THREE.Points(exhaustParticleGeometry, exhaustParticleMaterial);
  exhaustParticles.name = 'exhaust-particles';
  exhaustParticles.frustumCulled = false;
  exhaustParticles.renderOrder = 6;
  nozzle.add(exhaustParticles);
  exhaustParticlePositions.fill(0);
  exhaustParticleGeometry.attributes.position.needsUpdate = true;

  // Shock-diamond rings and warm shimmer ellipses are inexpensive geometric
  // approximations: intensity and spacing follow throttle, with no shader dependency.
  const shockDiamonds = [];
  for (let i = 0; i < 6; i++) {
    const ringMat = new THREE.MeshBasicMaterial({
      color: i % 2 ? 0x73c9ff : 0xffd59a,
      transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: false
    });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.22 + (i % 2) * 0.055, 0.025, 7, 36), ringMat);
    ring.name = `shock-diamond-${i + 1}`;
    ring.rotation.y = PI / 2;
    ring.position.x = 2.08 + i * 0.43;
    ring.scale.setScalar(0.65 + i * 0.07);
    ring.renderOrder = 7;
    plume.add(ring);
    shockDiamonds.push(ring);
  }
  const shimmerMaterial = new THREE.PointsMaterial({
    color: 0xffc47f, size: 0.075, transparent: true, opacity: 0,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true
  });
  const shimmerCount = 180;
  const shimmerPositions = new Float32Array(shimmerCount * 3);
  const shimmerGeometry = new THREE.BufferGeometry();
  shimmerGeometry.setAttribute('position', new THREE.BufferAttribute(shimmerPositions, 3));
  const heatShimmer = new THREE.Points(shimmerGeometry, shimmerMaterial);
  heatShimmer.name = 'heat-shimmer-particles';
  heatShimmer.frustumCulled = false;
  heatShimmer.renderOrder = 8;
  plume.add(heatShimmer);

  const forceArrow = new THREE.ArrowHelper(V(-1, 0, 0), V(pivotX, 0, 0), 1, 0x35d0ff, .22, .11);
  forceArrow.renderOrder = 10;
  [forceArrow.line.material, forceArrow.cone.material].forEach(m => {
    m.depthTest = false; m.transparent = true; m.opacity = .92;
  });
  scene.add(forceArrow);

  // ---------------- Ground contact / shadow helpers ----------------
  // Shadow maps do the actual shadowing. A very soft procedural contact decal
  // stabilises the stand visually on devices where shadow maps are noisy.
  function makeSoftShadowTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(64, 64, 3, 64, 64, 62);
    grad.addColorStop(0, 'rgba(0,0,0,0.38)');
    grad.addColorStop(.45, 'rgba(0,0,0,0.19)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(canvas);
    tex.encoding = THREE.sRGBEncoding;
    return tex;
  }
  const shadowTexture = makeSoftShadowTexture();
  const contactShadow = new THREE.Mesh(
    new THREE.PlaneGeometry(8.5, 3.0),
    new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false, opacity: .48, toneMapped: false })
  );
  contactShadow.rotation.x = -PI / 2;
  contactShadow.position.set(-1.35, -1.755, 0);
  contactShadow.renderOrder = 1;
  scene.add(contactShadow);

  // ---------------- Alternate 2D pitch-vectoring nozzle ----------------
  // This is a separate simplified rectangular nozzle assembly. It is shown only
  // in pitch-only mode; the axisymmetric hardware above remains the default.
  const nozzle2D = new THREE.Group();
  nozzle2D.name = '2D pitch-vectoring nozzle';
  nozzle2D.position.set(pivotX, 0, 0);
  scene.add(nozzle2D);
  const nozzle2DFrameMat = mat(0x768594, 0.62, 0.31);
  const nozzle2DPlateMat = mat(0xaaaeb0, 0.46, 0.39);
  const nozzle2DInnerMat = mat(0x171d25, 0.18, 0.60);
  function box2D(parent, w, h, d, x, y, z, material) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    add(parent, mesh);
    return mesh;
  }
  // Rectangular outlet rim.
  box2D(nozzle2D, 0.12, 0.98, 1.18, 0.90, 0, 0, nozzle2DFrameMat);
  box2D(nozzle2D, 0.78, 0.08, 1.10, 0.54, 0.47, 0, nozzle2DFrameMat);
  box2D(nozzle2D, 0.78, 0.08, 1.10, 0.54, -0.47, 0, nozzle2DFrameMat);
  box2D(nozzle2D, 0.78, 0.90, 0.08, 0.54, 0, 0.55, nozzle2DFrameMat);
  box2D(nozzle2D, 0.78, 0.90, 0.08, 0.54, 0, -0.55, nozzle2DFrameMat);
  box2D(nozzle2D, 0.30, 0.78, 0.92, 0.30, 0, 0, nozzle2DInnerMat);
  const n2TopHinge = new THREE.Group(); n2TopHinge.position.set(0.18, 0.41, 0); nozzle2D.add(n2TopHinge);
  const n2BottomHinge = new THREE.Group(); n2BottomHinge.position.set(0.18, -0.41, 0); nozzle2D.add(n2BottomHinge);
  const n2Top = box2D(n2TopHinge, 0.72, 0.075, 1.02, 0.37, 0.01, 0, nozzle2DPlateMat);
  const n2Bottom = box2D(n2BottomHinge, 0.72, 0.075, 1.02, 0.37, -0.01, 0, nozzle2DPlateMat);
  const n2LeftHinge = new THREE.Group(); n2LeftHinge.position.set(0.18, 0, -0.49); nozzle2D.add(n2LeftHinge);
  const n2RightHinge = new THREE.Group(); n2RightHinge.position.set(0.18, 0, 0.49); nozzle2D.add(n2RightHinge);
  box2D(n2LeftHinge, 0.72, 0.80, 0.06, 0.37, 0, -0.005, nozzle2DPlateMat);
  box2D(n2RightHinge, 0.72, 0.80, 0.06, 0.37, 0, 0.005, nozzle2DPlateMat);
  const nozzle2DGlow = new THREE.Mesh(
    new THREE.CylinderGeometry(0.30, 0.46, 2.8, 32, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xff8a3a, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending })
  );
  nozzle2DGlow.rotation.z = -PI / 2;
  nozzle2DGlow.position.x = 2.30;
  nozzle2D.add(nozzle2DGlow);
  nozzle2D.visible = false;

  // ---------------- Procedural aircraft silhouettes for flight dynamics ----------------
  // These are purpose-built low-detail teaching models rather than imported assets.
  const aircraft = new THREE.Group();
  aircraft.name = 'Illustrative thrust-vectoring aircraft';
  aircraft.visible = false;
  scene.add(aircraft);
  const airframeMat = mat(0x929faa, 0.48, 0.37, { metalness: 0.50, roughness: 0.38 });
  const panelMat = mat(0x586775, 0.42, 0.46);
  const canopyMat = new THREE.MeshPhysicalMaterial({ color: 0x1a4262, metalness: 0.3, roughness: 0.16, transparent: true, opacity: 0.78, clearcoat: 0.9, clearcoatRoughness: 0.12, envMapIntensity: 1.35 });
  const intakeMat = mat(0x101923, 0.20, 0.57);
  const controlSurfaceMat = mat(0x687987, 0.46, 0.40);
  function planformPair(parent, points, thickness, material) {
    const shape = new THREE.Shape();
    shape.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
    shape.closePath();
    const geom = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: true, bevelSegments: 1, steps: 1, bevelSize: 0.035, bevelThickness: 0.025, curveSegments: 2 });
    geom.translate(0, 0, -thickness / 2);
    const left = new THREE.Mesh(geom, material);
    left.rotation.x = PI / 2;
    add(parent, left);
    const right = left.clone();
    right.scale.y = -1;
    add(parent, right);
    return [left, right];
  }
  function verticalFin(parent, points, z, thickness, material, cant = 0) {
    const shape = new THREE.Shape(); shape.moveTo(points[0][0], points[0][1]);
    for (let i=1;i<points.length;i++) shape.lineTo(points[i][0], points[i][1]);
    shape.closePath();
    const geom = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: true, bevelSegments: 1, bevelSize: 0.025, bevelThickness: 0.018 });
    geom.translate(0, 0, -thickness/2);
    const mesh = new THREE.Mesh(geom, material); mesh.position.z = z; mesh.rotation.x = cant; add(parent, mesh); return mesh;
  }
  // Common slender fuselage, radome, canopy, intakes, and tailpipe treatment.
  latheX(aircraft, [
    [-7.15,0.035],[-6.86,0.09],[-6.42,0.15],[-5.75,0.23],[-4.90,0.33],[-3.90,0.43],
    [-2.65,0.55],[-1.0,0.68],[0.25,0.70],[1.45,0.58],[2.75,0.43],[3.78,0.27],[4.52,0.08],[4.72,0.025]
  ], airframeMat, 64);
  const cockpit = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), canopyMat);
  cockpit.scale.set(0.88, 0.29, 0.38); cockpit.position.set(-3.18, 0.59, 0); add(aircraft, cockpit);
  // Twin intake lips and inset dark faces add visual depth on the model.
  [-1,1].forEach(side => {
    const lip = new THREE.Mesh(new THREE.BoxGeometry(0.92,0.23,0.30), panelMat);
    lip.position.set(-1.28,-0.30,side*0.52); lip.rotation.z = -0.06; add(aircraft,lip);
    const dark = new THREE.Mesh(new THREE.BoxGeometry(0.66,0.16,0.12), intakeMat);
    dark.position.set(-1.42,-0.31,side*0.65); add(aircraft,dark);
  });
  const tailpipeRing = new THREE.Mesh(new THREE.TorusGeometry(0.39,0.07,12,48), chrome);
  tailpipeRing.rotation.y = PI/2; tailpipeRing.position.x = 4.35; add(aircraft, tailpipeRing);
  // Clone the existing exhaust effect onto the aircraft so the active flight
  // scene also shows a moving plume. A centre plume is used for the single-
  // engine silhouettes; twin side plumes are shown for the F-22 profile or when
  // the user selects twin-engine vectoring.
  const flightExhausts = [];
  function addFlightExhaust(name, z, sizeFactor, kind) {
    const root = plume.clone(true);
    root.name = name;
    root.position.set(4.38, 0, z);
    root.scale.set(sizeFactor, sizeFactor, sizeFactor);
    root.visible = false;
    const glow = new THREE.PointLight(0xff7137, 0, 5.5, 2);
    glow.position.set(0.38, 0, 0);
    root.add(glow);
    aircraft.add(root);
    flightExhausts.push({ root, glow, sizeFactor, kind, rings: shockDiamonds.map(r => root.getObjectByName(r.name)) });
  }
  addFlightExhaust('flight-exhaust-centre', 0, 0.90, 'centre');
  addFlightExhaust('flight-exhaust-left', -0.40, 0.62, 'twin');
  addFlightExhaust('flight-exhaust-right', 0.40, 0.62, 'twin');
  const variants = {};
  variants.f16 = new THREE.Group(); variants.f16.name = 'F-16 MATV style'; aircraft.add(variants.f16);
  planformPair(variants.f16, [[-2.40,0.42],[0.10,0.40],[1.58,3.18],[0.84,3.05],[-1.28,1.05],[-2.22,0.58]], 0.13, airframeMat);
  planformPair(variants.f16, [[1.95,0.25],[3.20,0.20],[4.10,1.42],[3.38,1.25],[2.36,0.62]], 0.095, panelMat);
  verticalFin(variants.f16, [[1.55,0.42],[3.22,0.42],[3.88,1.82],[3.28,1.53],[2.22,1.20]], 0, 0.12, airframeMat);
  variants.x31 = new THREE.Group(); variants.x31.name = 'X-31 demonstrator style'; aircraft.add(variants.x31);
  planformPair(variants.x31, [[-3.25,0.38],[-0.55,0.36],[1.88,3.0],[1.40,3.15],[-1.70,1.42],[-2.85,0.57]], 0.14, airframeMat);
  planformPair(variants.x31, [[-4.25,0.36],[-3.25,0.33],[-2.68,1.45],[-3.22,1.26],[-3.95,0.60]], 0.075, controlSurfaceMat);
  planformPair(variants.x31, [[2.00,0.23],[3.22,0.20],[4.14,1.1],[3.54,1.03],[2.33,0.54]], 0.09, panelMat);
  verticalFin(variants.x31, [[1.58,0.4],[3.18,0.4],[3.87,1.70],[3.25,1.48],[2.19,1.18]], 0, 0.12, airframeMat);
  variants.f22 = new THREE.Group(); variants.f22.name = 'F-22 style test article'; aircraft.add(variants.f22);
  planformPair(variants.f22, [[-2.15,0.48],[0.25,0.40],[1.72,3.25],[0.16,3.12],[-1.42,1.2],[-2.05,0.62]], 0.15, airframeMat);
  planformPair(variants.f22, [[2.0,0.27],[3.3,0.2],[4.05,1.36],[3.24,1.23],[2.27,0.58]], 0.10, panelMat);
  verticalFin(variants.f22, [[1.55,0.40],[3.36,0.40],[3.85,1.75],[3.28,1.51],[2.24,1.19]], -0.48, 0.10, airframeMat, -0.16);
  verticalFin(variants.f22, [[1.55,0.40],[3.36,0.40],[3.85,1.75],[3.28,1.51],[2.24,1.19]], 0.48, 0.10, airframeMat, 0.16);
  variants.x31.visible = false; variants.f22.visible = false;
  const tailControl = new THREE.Group(); tailControl.position.set(3.37,0.25,0); aircraft.add(tailControl);
  const elevatorLeft = new THREE.Mesh(new THREE.BoxGeometry(0.62,0.055,0.55), controlSurfaceMat); elevatorLeft.position.set(0,0,-0.64); add(tailControl,elevatorLeft);
  const elevatorRight = elevatorLeft.clone(); elevatorRight.position.z = 0.64; add(tailControl,elevatorRight);
  const flowGroup = new THREE.Group(); flowGroup.name = 'Aerodynamic flow field'; flowGroup.visible = false; scene.add(flowGroup);
  const flowLines = [];
  const flowLineMat = new THREE.LineBasicMaterial({ color: 0xc8ecff, transparent: true, opacity: 0.26, depthWrite: false });
  for (let lane = 0; lane < 28; lane++) {
    const z0 = (Math.floor(lane/4)-3.0) * 0.82;
    const y0 = ((lane%4)-1.5) * 0.67;
    const pts = [];
    for (let j = 0; j <= 28; j++) {
      const x = -10 + j * (20/28);
      const body = Math.exp(-Math.pow((x + 0.95)/1.55, 2));
      const y = y0 + Math.sign(y0 || 1) * 0.24 * body;
      const z = z0 + Math.sign(z0 || 1) * 0.48 * body;
      pts.push(V(x,y,z));
    }
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), flowLineMat);
    flowGroup.add(line); flowLines.push(line);
  }
  const flowParticleCount = 540;
  const flowParticlePositions = new Float32Array(flowParticleCount*3);
  const flowParticleGeometry = new THREE.BufferGeometry();
  flowParticleGeometry.setAttribute('position', new THREE.BufferAttribute(flowParticlePositions,3));
  const flowParticleMaterial = new THREE.PointsMaterial({ color: 0xe2f5ff, size: 0.033, transparent: true, opacity: 0.66, depthWrite: false, sizeAttenuation: true });
  const flowParticles = new THREE.Points(flowParticleGeometry, flowParticleMaterial);
  flowParticles.frustumCulled = false; flowGroup.add(flowParticles);
  const flowSeed = [];
  let flowRandSeed = 145903;
  const flowRand = () => { flowRandSeed = (flowRandSeed*1664525+1013904223)>>>0; return flowRandSeed/4294967296; };
  for(let i=0;i<flowParticleCount;i++) flowSeed.push({ phase:flowRand(), y:(flowRand()-.5)*3.2, z:(flowRand()-.5)*7.4, jitter:flowRand()*PI*2 });
  const vortexMat = new THREE.LineBasicMaterial({ color: 0x86cfff, transparent: true, opacity: 0.34 });
  const vortexLines = [];
  for (const side of [-1,1]) {
    const curvePts=[];
    for(let j=0;j<=36;j++) { const t=j/36; curvePts.push(V(1.1+t*7.8, 0.12+0.10*Math.sin(t*PI*4), side*(3.0+0.42*Math.sin(t*PI*5)))); }
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curvePts), vortexMat);
    flowGroup.add(line); vortexLines.push(line);
  }

  // Twin-engine variant: clone complete engine/nozzle geometry plus its actuator rods.
  const twinEngine = engine.clone(true); twinEngine.name = 'secondary engine core'; twinEngine.visible = false; scene.add(twinEngine);
  const twinNozzle = nozzle.clone(true); twinNozzle.name = 'secondary movable nozzle'; twinNozzle.visible = false; scene.add(twinNozzle);
  const twinPlume = twinNozzle.getObjectByName('exhaust-plume');
  const twinExhaustLight = twinNozzle.getObjectByName('exhaust-light');
  const twinExhaustParticles = twinNozzle.getObjectByName('exhaust-particles');
  const twinHeatShimmer = twinNozzle.getObjectByName('heat-shimmer-particles');
  const twinShockDiamonds = shockDiamonds.map(ring => twinNozzle.getObjectByName(ring.name));
  const twinPetals = petals.map(p => ({
    hinge: twinNozzle.getObjectByName(p.hinge.name),
    outerHinge: twinNozzle.getObjectByName(p.outerHinge.name)
  }));
  const twinActuatorMeshes = actuatorMeshes.map(a => {
    const clone = {};
    ['body','rod','collar','eyeA','eyeB'].forEach(k => { clone[k] = a[k].clone(); clone[k].visible = false; scene.add(clone[k]); });
    clone.A = a.A.clone(); clone.B = a.B.clone(); clone.rest = a.rest; clone.extension = 0;
    return clone;
  });
  const twinForceArrow = new THREE.ArrowHelper(V(-1,0,0), V(pivotX,0,0), 1, 0xffb36b, .22, .11);
  [twinForceArrow.line.material, twinForceArrow.cone.material].forEach(m => { m.depthTest = false; m.transparent = true; m.opacity = .85; });
  twinForceArrow.visible = false; scene.add(twinForceArrow);
  const benchObjects = [floor,grid,stage,engine,stand,nozzle,contactShadow,forceArrow,...actuatorMeshes.flatMap(a=>[a.body,a.rod,a.collar,a.eyeA,a.eyeB]),twinEngine,twinNozzle,twinForceArrow,...twinActuatorMeshes.flatMap(a=>[a.body,a.rod,a.collar,a.eyeA,a.eyeB]),nozzle2D];

  // ---------------- Simulation state ----------------
  const cmd = { p: 0, y: 0 };
  const state = { p: 0, y: 0 };
  const velocity = { p: 0, y: 0 };
  let throttleCmd = .45;
  let thrust = 0;
  let egtC = 430;
  let actuatorRate = 30;
  let paused = false;
  let simTime = 0;
  let rateLimited = false;
  const twinState = { p: 0, y: 0 };
  const twinVelocity = { p: 0, y: 0 };
  const flight = {
    speed: 220, altitude: 4200, pitch: 2.0*D, yaw: 0, roll: 0,
    gamma: -2.0*D, pitchRate: 0, yawRate: 0, rollRate: 0,
    alpha: 4.0*D, beta: 0, g: 1.0, qbar: 0, lift: 0, drag: 0,
    mach: 220/340, mass: 10500, wingArea: 27.8, span: 9.6, chord: 3.5
  };
  const flightControls = { elev: 0, ail: 0, rud: 0 };
  const cobraDemo = { active: false, time: 0, savedThrottle: 0.45 };
  let lastHapticAt = 0;
  function tryHaptic(duration = 9) {
    if (!$('haptics') || !$('haptics').checked) return;
    const now = performance.now();
    if (now - lastHapticAt < 100) return;
    lastHapticAt = now;
    try {
      if (navigator.vibrate) navigator.vibrate(duration);
      if (navigator.getGamepads) {
        for (const gamepad of Array.from(navigator.getGamepads()).filter(Boolean)) {
          const actuator = gamepad.vibrationActuator || (gamepad.hapticActuators && gamepad.hapticActuators[0]);
          if (actuator && typeof actuator.playEffect === 'function') {
            const effect = actuator.playEffect('dual-rumble', {
              duration: Math.max(10, duration), strongMagnitude: 0.22, weakMagnitude: 0.13
            });
            if (effect && typeof effect.catch === 'function') effect.catch(() => {});
          }
        }
      }
    } catch (_) { /* device/browser haptics are optional */ }
  }
  function setCommand(p, y) {
    if ($('nozzleMode') && $('nozzleMode').value === '2d') y = 0;
    const magnitude = Math.hypot(p, y);
    if (magnitude > LIM) { p *= LIM / magnitude; y *= LIM / magnitude; }
    cmd.p = clamp(p, -LIM, LIM);
    cmd.y = clamp(y, -LIM, LIM);
    $('auto').checked = false;
  }
  const H = 1 / 240;
  function physicsStep(h) {
    simTime += h;
    if ($('auto').checked) {
      cmd.p = LIM * .82 * Math.sin(simTime * .70);
      cmd.y = LIM * .82 * Math.sin(simTime * 1.07 + 1.15);
      const mag = Math.hypot(cmd.p, cmd.y);
      if (mag > LIM) { cmd.p *= LIM / mag; cmd.y *= LIM / mag; }
    }
    // Pitch-only 2D hardware cannot accept yaw commands, including those
    // generated by auto demonstration or direct programmatic demos.
    if ($('nozzleMode').value === '2d') cmd.y = 0;
    // First-order spool response with asymmetric spool-up / spool-down lag.
    // TAU is an adjustable time constant; the response is integrated exactly
    // over the fixed step rather than using a timestep-sensitive Euler gain.
    const spoolTau = Math.max(0.18, TAU * (throttleCmd > thrust ? 0.82 : 1.35));
    thrust += (throttleCmd - thrust) * (1 - Math.exp(-h / spoolTau));
    thrust = clamp(thrust, 0, 1);
    const egtTarget = 430 + 720 * Math.pow(thrust, 0.78);
    egtC += (egtTarget - egtC) * (1 - Math.exp(-h / 4.8));
    rateLimited = false;
    const nozzleMode = $('nozzleMode').value;
    const diff = nozzleMode === 'twin' ? Number($('diff').value) : 0;
    const mainTarget = { p: cmd.p, y: nozzleMode === '2d' ? 0 : (nozzleMode === 'twin' ? cmd.y : cmd.y) };
    const twinTarget = nozzleMode === 'twin' ? { p: cmd.p - diff, y: cmd.y } : { p: 0, y: 0 };
    if (nozzleMode === 'twin') {
      // Opposed pitch bias represents left/right differential vectoring and can
      // produce a rolling moment in the simplified flight model.
      mainTarget.p = cmd.p - diff;
      twinTarget.p = cmd.p + diff;
    }
    rateLimited = stepActuator(state, velocity, mainTarget.p, mainTarget.y, h) || rateLimited;
    if (nozzleMode === 'twin') rateLimited = stepActuator(twinState, twinVelocity, twinTarget.p, twinTarget.y, h) || rateLimited;
    else stepActuator(twinState, twinVelocity, 0, 0, h);

    // High-alpha demo choreography is an explanatory response sequence, not a
    // validated aerobatic flight control law.
    if (cobraDemo.active) {
      cobraDemo.time += h;
      const t = cobraDemo.time;
      if (t < 0.70) {
        flightControls.elev = 14*D; setCommand(17, 0);
      } else if (t < 1.45) {
        flightControls.elev = 24*D; setCommand(17, 0);
      } else if (t < 2.20) {
        flightControls.elev = -12*D; setCommand(-8, 0);
      } else if (t < 3.2) {
        flightControls.elev = 0; setCommand(0, 0);
      } else {
        cobraDemo.active = false;
        throttleCmd = cobraDemo.savedThrottle;
        $('thr').value = Math.round(throttleCmd*100);
        $('elev').value = 0; $('elevV').textContent = '+0°';
        flightControls.elev = 0;
      }
      if (cobraDemo.active) $('elev').value = Math.round(flightControls.elev/D);
    }
    stepFlightDynamics(h);
  }

  function stepActuator(s, v, targetP, targetY, h) {
    const mag = Math.hypot(targetP, targetY);
    if (mag > LIM) { targetP *= LIM/mag; targetY *= LIM/mag; }
    let limited = false;
    const targets = { p: targetP, y: targetY };
    ['p','y'].forEach(axis => {
      const error = targets[axis] - s[axis];
      const targetVelocity = clamp(error * 7.5, -actuatorRate, actuatorRate);
      if (Math.abs(error*7.5) > actuatorRate + 1e-4) limited = true;
      v[axis] += clamp(targetVelocity - v[axis], -actuatorRate*10*h, actuatorRate*10*h);
      s[axis] += v[axis]*h;
      if (Math.abs(error) < .002 && Math.abs(v[axis]) < .02) { s[axis] = targets[axis]; v[axis] = 0; }
    });
    const actual = Math.hypot(s.p,s.y);
    if (actual > LIM) {
      s.p *= LIM/actual; s.y *= LIM/actual;
      const radial = (v.p*s.p + v.y*s.y)/LIM;
      if (radial > 0) { v.p -= radial*s.p/LIM; v.y -= radial*s.y/LIM; }
      limited = true;
    }
    return limited;
  }

  function stepFlightDynamics(h) {
    const mode = $('nozzleMode').value;
    const twin = mode === 'twin';
    const totalThrust = thrust * 130000 * (twin ? 2 : 1);
    const speed = Math.max(80, flight.speed);
    const rho = 1.225 * Math.exp(-Math.max(0,flight.altitude)/8500);
    const qbar = 0.5 * rho * speed * speed;
    const alpha = clamp(flight.pitch - flight.gamma, -32*D, 45*D);
    flight.alpha = alpha;
    flight.mach = speed / Math.max(295, 340 - flight.altitude*0.0025);
    flight.qbar = qbar;
    // Simplified lift curve with post-stall roll-off and induced/wave drag.
    const alphaAbs = Math.abs(alpha);
    const linearCL = 0.18 + 3.45*alpha;
    const stall = clamp((alphaAbs-16*D)/(30*D-16*D),0,1);
    const cl = clamp(linearCL*(1-0.72*stall),-0.72,1.36);
    const cd = 0.024 + 0.058*cl*cl + 0.24*stall*stall + 0.045*Math.pow(clamp((flight.mach-0.78)/0.45,0,1),2);
    const lift = qbar * flight.wingArea * cl;
    const drag = qbar * flight.wingArea * cd;
    flight.lift = lift; flight.drag = drag;

    const pMean = twin ? (state.p + twinState.p)*0.5 : state.p;
    const yMean = twin ? (state.y + twinState.y)*0.5 : state.y;
    const pRad = pMean*D, yRad = yMean*D;
    // Aircraft axes use positive pitch as nose-up; a rearward TVC force has
    // the opposite sign convention from the visual nozzle pitch angle.
    const tvcPitchMoment = -totalThrust * 3.7 * Math.sin(pRad);
    const tvcYawMoment = totalThrust * 3.2 * Math.sin(yRad);
    const elevatorRad = flightControls.elev;
    const aileronRad = flightControls.ail;
    const rudderRad = flightControls.rud;
    const assist = $('flightAssist').checked ? 1 : 0.35;
    const pitchDamping = -qbar*flight.wingArea*flight.chord*2.0*(flight.pitchRate*flight.chord/(2*speed))*assist;
    const pitchRestoring = -qbar*flight.wingArea*flight.chord*0.52*alpha*assist;
    const elevatorMoment = qbar*flight.wingArea*flight.chord*0.32*elevatorRad;
    const pitchAccel = (tvcPitchMoment + elevatorMoment + pitchDamping + pitchRestoring)/46000;
    flight.pitchRate = clamp(flight.pitchRate + pitchAccel*h, -2.2, 2.2);
    flight.pitch += flight.pitchRate*h;
    flight.pitch = clamp(flight.pitch,-75*D,85*D);

    // Differential pitch between two engines contributes a roll couple.
    const singleThrust = thrust*130000;
    const differentialRollMoment = twin ? 0.88*singleThrust*(Math.sin(twinState.p*D)-Math.sin(state.p*D)) : 0;
    const rollMoment = qbar*flight.wingArea*flight.span*0.075*aileronRad + differentialRollMoment - 12500*flight.rollRate*assist;
    flight.rollRate = clamp(flight.rollRate + rollMoment/10500*h, -2.4, 2.4);
    flight.roll += flight.rollRate*h;
    flight.roll = clamp(flight.roll,-PI*0.94,PI*0.94);

    const yawDamping = -qbar*flight.wingArea*flight.span*0.055*flight.yawRate*assist;
    const rudderMoment = qbar*flight.wingArea*flight.span*0.055*rudderRad;
    const yawAccel = (tvcYawMoment + rudderMoment + yawDamping)/68000;
    flight.yawRate = clamp(flight.yawRate+yawAccel*h,-1.6,1.6);
    flight.yaw += flight.yawRate*h;
    flight.yaw = wrap(flight.yaw);
    flight.beta = clamp(flight.yawRate*2.4 + rudderRad*0.15,-18*D,18*D);

    const tvcVertical = totalThrust*Math.sin(pRad);
    const normalAccel = (lift + tvcVertical - flight.mass*9.81*Math.cos(flight.gamma))/flight.mass;
    flight.gamma += clamp(normalAccel/speed,-0.8,0.8)*h;
    flight.gamma = clamp(flight.gamma,-50*D,50*D);
    const axialThrust = totalThrust*Math.cos(pRad)*Math.cos(yRad);
    const gravityAlongPath = flight.mass*9.81*Math.sin(flight.gamma);
    flight.speed = clamp(flight.speed + (axialThrust-drag-gravityAlongPath)/flight.mass*h,90,360);
    flight.altitude = clamp(flight.altitude + flight.speed*Math.sin(flight.gamma)*h,500,11000);
    flight.g = clamp((lift + tvcVertical)/(flight.mass*9.81),-4,9);
  }

  // ---------------- Procedural audio (starts only after a user gesture) ----------------
  // No external audio files are required. Layered oscillators and filtered noise
  // approximate low turbine rumble, core whine, exhaust hiss, and actuator servos.
  let audioContext = null;
  let audioMaster = null;
  let audioPanner = null;
  let audioNodes = null;
  let audioEnabled = false;
  let lastAudioUpdate = 0;

  function createAudioSystem() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error('Web Audio is not supported by this browser.');
    audioContext = new AudioContextClass();
    audioMaster = audioContext.createGain();
    audioMaster.gain.value = 0;
    const panner = audioContext.createPanner();
    panner.panningModel = 'HRTF'; panner.distanceModel = 'inverse';
    panner.refDistance = 2; panner.maxDistance = 40; panner.rolloffFactor = 1.1;
    panner.coneInnerAngle = 360; panner.coneOuterAngle = 360; panner.coneOuterGain = 0.85;
    panner.connect(audioContext.destination);
    audioMaster.connect(panner);
    audioPanner = panner;

    const rumble = audioContext.createOscillator();
    rumble.type = 'sawtooth';
    const rumbleFilter = audioContext.createBiquadFilter();
    rumbleFilter.type = 'lowpass'; rumbleFilter.frequency.value = 130; rumbleFilter.Q.value = 0.65;
    const rumbleGain = audioContext.createGain(); rumbleGain.gain.value = 0.018;
    rumble.connect(rumbleFilter); rumbleFilter.connect(rumbleGain); rumbleGain.connect(audioMaster);

    const whine = audioContext.createOscillator();
    whine.type = 'triangle';
    const whineGain = audioContext.createGain(); whineGain.gain.value = 0.008;
    whine.connect(whineGain); whineGain.connect(audioMaster);

    const harmonic = audioContext.createOscillator();
    harmonic.type = 'sine';
    const harmonicGain = audioContext.createGain(); harmonicGain.gain.value = 0.004;
    harmonic.connect(harmonicGain); harmonicGain.connect(audioMaster);

    const noiseBuffer = audioContext.createBuffer(1, audioContext.sampleRate * 2, audioContext.sampleRate);
    const noiseData = noiseBuffer.getChannelData(0);
    for (let i = 0; i < noiseData.length; i++) noiseData[i] = (Math.random() * 2 - 1) * 0.55;
    const hiss = audioContext.createBufferSource();
    hiss.buffer = noiseBuffer; hiss.loop = true;
    const hissFilter = audioContext.createBiquadFilter();
    hissFilter.type = 'bandpass'; hissFilter.frequency.value = 700; hissFilter.Q.value = 0.45;
    const hissGain = audioContext.createGain(); hissGain.gain.value = 0;
    hiss.connect(hissFilter); hissFilter.connect(hissGain); hissGain.connect(audioMaster);

    const servo = audioContext.createOscillator();
    servo.type = 'sine'; servo.frequency.value = 260;
    const servoFilter = audioContext.createBiquadFilter();
    servoFilter.type = 'lowpass'; servoFilter.frequency.value = 900;
    const servoGain = audioContext.createGain(); servoGain.gain.value = 0;
    servo.connect(servoFilter); servoFilter.connect(servoGain); servoGain.connect(audioMaster);

    rumble.start(); whine.start(); harmonic.start(); hiss.start(); servo.start();
    audioNodes = { rumble, rumbleFilter, rumbleGain, whine, whineGain, harmonic, harmonicGain, hissFilter, hissGain, servo, servoFilter, servoGain };
  }

  async function toggleAudio() {
    try {
      if (!audioContext) {
        createAudioSystem();
        audioEnabled = true;
      } else {
        audioEnabled = !audioEnabled;
      }
      if (audioEnabled && audioContext.state === 'suspended') await audioContext.resume();
      if (audioMaster && audioContext) {
        audioMaster.gain.cancelScheduledValues(audioContext.currentTime);
        audioMaster.gain.setTargetAtTime(audioEnabled ? 0.58 : 0, audioContext.currentTime, 0.10);
      }
      $('audioBtn').textContent = audioEnabled ? 'Mute engine sound' : 'Enable engine sound';
      $('audioStatus').textContent = audioEnabled ? 'AUDIO ACTIVE · SYNTHESISED' : 'AUDIO MUTED';
      $('audioStatus').classList.toggle('is-active', audioEnabled);
    } catch (error) {
      audioEnabled = false;
      $('audioStatus').textContent = 'AUDIO UNAVAILABLE';
      console.warn('MATV audio could not start:', error);
    }
  }

  function updateAudio(now) {
    if (!audioContext || !audioNodes || now - lastAudioUpdate < 55) return;
    lastAudioUpdate = now;
    const t = audioContext.currentTime;
    const load = Math.pow(Math.max(0, thrust), 0.68);
    const servoMotion = clamp((Math.abs(velocity.p) + Math.abs(velocity.y)) / Math.max(8, actuatorRate * 1.25), 0, 1);
    const glide = (param, value, tau = 0.08) => param.setTargetAtTime(value, t, tau);
    glide(audioNodes.rumble.frequency, 34 + 41 * load);
    glide(audioNodes.rumbleGain.gain, 0.012 + 0.060 * load);
    glide(audioNodes.rumbleFilter.frequency, 105 + 145 * load);
    glide(audioNodes.whine.frequency, 120 + 220 * load);
    glide(audioNodes.whineGain.gain, 0.005 + 0.034 * load);
    glide(audioNodes.harmonic.frequency, 255 + 490 * load);
    glide(audioNodes.harmonicGain.gain, 0.003 + 0.012 * load);
    glide(audioNodes.hissFilter.frequency, 420 + 2350 * load);
    glide(audioNodes.hissGain.gain, 0.003 + 0.025 * load);
    glide(audioNodes.servo.frequency, 210 + 310 * servoMotion);
    glide(audioNodes.servoGain.gain, servoMotion * 0.043);
    // HRTF panning tracks the engine's apparent position; modern browsers use
    // this to create stereo/spatial motion as the camera follows the aircraft.
    if (audioPanner) {
      const soundPoint = $('sceneMode').value === 'flight' ? V(3.7,0,0).applyQuaternion(aircraft.quaternion).add(aircraft.position) : V(pivotX, 0, 0);
      const x = soundPoint.x + state.y*0.018;
      const y = soundPoint.y + state.p*0.014;
      const z = soundPoint.z + state.y*0.025;
      if (audioPanner.positionX && audioPanner.positionX.setTargetAtTime) {
        audioPanner.positionX.setTargetAtTime(x,t,0.08);
        audioPanner.positionY.setTargetAtTime(y,t,0.08);
        audioPanner.positionZ.setTargetAtTime(z,t,0.08);
      } else audioPanner.setPosition(x,y,z);
    }
  }

  // ---------------- Camera controls ----------------
  const benchPresets = [
    { name: 'SIDE PROFILE', theta: -0.04, phi: 1.42, radius: 8.6, target: [-.55, -.05, 0] },
    { name: 'REAR THREE-QUARTER', theta: 0.78, phi: 1.33, radius: 7.7, target: [.1, 0, 0] },
    { name: 'TOP-DOWN', theta: 0.10, phi: .16, radius: 9.1, target: [-.4, -.1, 0] },
    { name: 'NOZZLE DETAIL', theta: .12, phi: 1.43, radius: 4.25, target: [.7, 0, 0] }
  ];
  const flightPresets = [
    { name: 'FLIGHT CHASE', theta: 0.62, phi: 1.22, radius: 15.4, target: [-1.15, 0, 0] },
    { name: 'FLIGHT SIDE', theta: -0.10, phi: 1.42, radius: 15.0, target: [-1.10, 0, 0] },
    { name: 'FLIGHT TOP', theta: 0.15, phi: 0.22, radius: 15.8, target: [-1.0, 0, 0] },
    { name: 'FLIGHT FRONT QUARTER', theta: 2.35, phi: 1.18, radius: 15.2, target: [-1.15, 0, 0] }
  ];
  let presets = benchPresets;
  let presetIndex = 0;
  let userOrbited = false;
  const currentCam = { theta: presets[0].theta, phi: presets[0].phi, radius: presets[0].radius, target: V(...presets[0].target) };
  const goalCam = { theta: presets[0].theta, phi: presets[0].phi, radius: presets[0].radius, target: V(...presets[0].target) };
  function setPreset(index) {
    presetIndex = (index + presets.length) % presets.length;
    const p = presets[presetIndex];
    goalCam.theta = currentCam.theta + wrap(p.theta - currentCam.theta);
    goalCam.phi = p.phi;
    goalCam.radius = p.radius;
    goalCam.target.set(...p.target);
    userOrbited = false;
  }
  function updateCamera(dt) {
    const k = 1 - Math.exp(-dt * 5.8);
    currentCam.theta += (goalCam.theta - currentCam.theta) * k;
    currentCam.phi += (goalCam.phi - currentCam.phi) * k;
    currentCam.radius += (goalCam.radius - currentCam.radius) * k;
    currentCam.target.lerp(goalCam.target, k);
    const p = currentCam;
    camera.position.set(
      p.target.x + p.radius * Math.sin(p.phi) * Math.sin(p.theta),
      p.target.y + p.radius * Math.cos(p.phi),
      p.target.z + p.radius * Math.sin(p.phi) * Math.cos(p.theta)
    );
    camera.lookAt(p.target);
    $('camtag').textContent = `${presets[presetIndex].name}${userOrbited ? ' · ORBITED' : ''}  |  AZ ${(wrap(p.theta) / D).toFixed(0)}°  EL ${(90 - p.phi / D).toFixed(0)}°  |  ${(p.radius).toFixed(1)} m`;
  }
  function resize() {
    const w = Math.max(view.clientWidth, 1);
    const h = Math.max(view.clientHeight, 1);
    const mode = $('quality') ? $('quality').value : 'balanced';
    const maxDpr = mode === 'high' ? 2 : (mode === 'performance' ? 1 : 1.5);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxDpr));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(view);
  function applyQuality() {
    const mode = $('quality') ? $('quality').value : 'balanced';
    const maxDpr = mode === 'high' ? 2 : (mode === 'performance' ? 1 : 1.5);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxDpr));
    renderer.shadowMap.enabled = mode !== 'performance';
    renderer.shadowMap.type = mode === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    key.shadow.mapSize.set(mode === 'high' ? 2048 : (mode === 'performance' ? 512 : 1024), mode === 'high' ? 2048 : (mode === 'performance' ? 512 : 1024));
    key.shadow.needsUpdate = true;
    resize();
  }
  if ($('quality')) $('quality').addEventListener('change', applyQuality);
  applyQuality();

  // ---------------- Input: orbit, zoom, optional nozzle pick-drag ----------------
  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  let drag = null;
  view.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    view.setPointerCapture(event.pointerId);
    let mode = 'orbit';
    if ($('grab').checked) {
      const rect = view.getBoundingClientRect();
      pointerNdc.set((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointerNdc, camera);
      if (raycaster.intersectObjects(pickMeshes, false).length) mode = 'nozzle';
    }
    drag = { mode, x: event.clientX, y: event.clientY };
  });
  view.addEventListener('pointermove', event => {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (drag.mode === 'nozzle') {
      setCommand(cmd.p - dy * .12, cmd.y + dx * .12);
      tryHaptic(4);
    } else {
      goalCam.theta -= dx * .006;
      goalCam.phi = clamp(goalCam.phi - dy * .006, .045, 1.76);
      userOrbited = true;
    }
  });
  const endDrag = () => { drag = null; };
  view.addEventListener('pointerup', endDrag);
  view.addEventListener('pointercancel', endDrag);
  view.addEventListener('wheel', event => {
    event.preventDefault();
    goalCam.radius = clamp(goalCam.radius * (1 + Math.sign(event.deltaY) * .085), 3.0, 15);
    userOrbited = true;
  }, { passive: false });
  window.addEventListener('keydown', event => {
    if (event.key === 'e' || event.key === 'E') {
      event.preventDefault(); setPreset(presetIndex + 1);
    }
    if (event.key === ' ') {
      const target = event.target;
      if (target && /INPUT|TEXTAREA|BUTTON/.test(target.tagName)) return;
      event.preventDefault(); togglePause();
    }
  });

  // Nozzle pad — CSS size remains 180x180 while drawing at device pixel ratio.
  const pad = $('pad');
  const ctx = pad.getContext('2d');
  let padDrag = null;
  const PAD_SIZE = 180;
  const padDpr = Math.min(window.devicePixelRatio || 1, 2);
  pad.width = PAD_SIZE * padDpr;
  pad.height = PAD_SIZE * padDpr;
  ctx.scale(padDpr, padDpr);
  pad.addEventListener('pointerdown', e => {
    e.stopPropagation(); pad.setPointerCapture(e.pointerId);
    padDrag = { x: e.clientX, y: e.clientY };
    $('auto').checked = false;
  });
  pad.addEventListener('pointermove', e => {
    if (!padDrag) return;
    e.stopPropagation();
    setCommand(cmd.p - (e.clientY - padDrag.y) * .12, cmd.y + (e.clientX - padDrag.x) * .12);
    tryHaptic(4);
    padDrag.x = e.clientX; padDrag.y = e.clientY;
  });
  pad.addEventListener('pointerup', () => { padDrag = null; });
  pad.addEventListener('pointercancel', () => { padDrag = null; });

  function drawPad() {
    const c = 90, r = 76;
    ctx.clearRect(0, 0, PAD_SIZE, PAD_SIZE);
    ctx.fillStyle = '#080d13'; ctx.fillRect(0, 0, PAD_SIZE, PAD_SIZE);
    ctx.lineWidth = 1; ctx.strokeStyle = '#1b3044';
    [1, 2/3, 1/3].forEach(f => { ctx.beginPath(); ctx.arc(c, c, r*f, 0, 2*PI); ctx.stroke(); });
    ctx.beginPath(); ctx.moveTo(c-r, c); ctx.lineTo(c+r, c); ctx.moveTo(c, c-r); ctx.lineTo(c, c+r); ctx.stroke();
    ctx.fillStyle = '#6f8ca8'; ctx.font = '9px monospace';
    ctx.fillText('PITCH UP', c-26, 12); ctx.fillText('YAW +', 143, c-4); ctx.fillText('YAW −', 3, c-4);
    const ax = c + state.y/LIM*r, ay = c - state.p/LIM*r;
    const cx = c + cmd.y/LIM*r, cy = c - cmd.p/LIM*r;
    ctx.strokeStyle = '#35d0ff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, 8, 0, 2*PI); ctx.moveTo(cx-12,cy); ctx.lineTo(cx+12,cy); ctx.moveTo(cx,cy-12); ctx.lineTo(cx,cy+12); ctx.stroke();
    ctx.strokeStyle = '#ffb347'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(c,c); ctx.lineTo(ax,ay); ctx.stroke();
    ctx.fillStyle = '#ffb347'; ctx.beginPath(); ctx.arc(ax,ay,4,0,2*PI); ctx.fill();
  }

  // ---------------- Controls and telemetry ----------------
  const throttleInput = $('thr');
  const pitchInput = $('pit');
  const yawInput = $('yaw');
  const rateInput = $('rate');
  throttleInput.addEventListener('input', () => { throttleCmd = Number(throttleInput.value) / 100; });
  pitchInput.addEventListener('input', () => { setCommand(Number(pitchInput.value), cmd.y); tryHaptic(5); });
  yawInput.addEventListener('input', () => { setCommand(cmd.p, Number(yawInput.value)); tryHaptic(5); });
  rateInput.addEventListener('input', () => { actuatorRate = Number(rateInput.value); });
  $('diff').addEventListener('input', () => { $('diffV').textContent = `${fmt(Number($('diff').value),1)}°`; tryHaptic(6); });
  $('flightSpeed').addEventListener('input', () => { flight.speed = Number($('flightSpeed').value); $('speedV').textContent = `${flight.speed.toFixed(0)} m/s`; });
  $('flightAlt').addEventListener('input', () => { flight.altitude = Number($('flightAlt').value); $('altV').textContent = `${flight.altitude.toFixed(0)} m`; });
  $('elev').addEventListener('input', () => { flightControls.elev = Number($('elev').value)*D; $('elevV').textContent = `${fmt(Number($('elev').value),0)}°`; tryHaptic(7); });
  $('ail').addEventListener('input', () => { flightControls.ail = Number($('ail').value)*D; $('ailV').textContent = `${fmt(Number($('ail').value),0)}°`; tryHaptic(7); });
  $('rud').addEventListener('input', () => { flightControls.rud = Number($('rud').value)*D; $('rudV').textContent = `${fmt(Number($('rud').value),0)}°`; tryHaptic(7); });
  $('bCentre').addEventListener('click', () => setCommand(0, 0));
  if ($('spool')) {
    $('spool').addEventListener('input', () => {
      TAU = Number($('spool').value);
      if ($('spoolV')) $('spoolV').textContent = `${TAU.toFixed(1)} s`;
    });
  }
  if ($('audioBtn')) $('audioBtn').addEventListener('click', toggleAudio);
  if ($('bCamera')) $('bCamera').addEventListener('click', () => setPreset(presetIndex + 1));
  if ($('forceToggle')) $('forceToggle').addEventListener('change', () => {
    forceArrow.visible = $('forceToggle').checked && thrust > 0.01;
  });
  function setNozzleMode() {
    const mode = $('nozzleMode').value;
    $('yaw').disabled = mode === '2d';
    $('diff').disabled = mode !== 'twin';
    if (mode === '2d') {
      cmd.y = 0; $('yaw').value = 0; $('yawV').textContent = '+0.0°';
    }
    const bench = $('sceneMode').value === 'bench';
    nozzle.visible = bench && mode !== '2d';
    nozzle2D.visible = bench && mode === '2d';
    twinEngine.visible = bench && mode === 'twin';
    twinNozzle.visible = bench && mode === 'twin';
    twinActuatorMeshes.forEach(a=>['body','rod','collar','eyeA','eyeB'].forEach(k=>a[k].visible=bench&&mode==='twin'));
    const isTwin = mode === 'twin';
    $('thr').setAttribute('aria-label',isTwin?'Throttle command shared by two illustrative engines':'Throttle command');
    setSceneMode();
  }
  function setSceneMode() {
    const flightMode = $('sceneMode').value === 'flight';
    const mode = $('nozzleMode').value;
    presets = flightMode ? flightPresets : benchPresets;
    const activeBench = !flightMode;
    [floor,grid,stage,stand,contactShadow,engine].forEach(o=>o.visible=activeBench);
    nozzle.visible = activeBench && mode !== '2d';
    nozzle2D.visible = activeBench && mode === '2d';
    twinEngine.visible = activeBench && mode === 'twin';
    twinNozzle.visible = activeBench && mode === 'twin';
    forceArrow.visible = activeBench && !!$('forceToggle').checked;
    twinForceArrow.visible = activeBench && mode === 'twin' && !!$('forceToggle').checked;
    actuatorMeshes.forEach(a=>['body','rod','collar','eyeA','eyeB'].forEach(k=>a[k].visible=activeBench));
    twinActuatorMeshes.forEach(a=>['body','rod','collar','eyeA','eyeB'].forEach(k=>a[k].visible=activeBench&&mode==='twin'));
    aircraft.visible = flightMode;
    flowGroup.visible = flightMode;
    $('flightHud').style.display = flightMode ? 'block' : 'none';
    view.classList.toggle('flight-scene',flightMode);
    $('hint').innerHTML = flightMode
      ? 'DRAG TO ORBIT <span>·</span> WHEEL TO ZOOM <span>·</span> E TO CHANGE CAMERA <span>·</span> FLIGHT MODEL: ILLUSTRATIVE'
      : 'DRAG TO ORBIT <span>·</span> WHEEL TO ZOOM <span>·</span> E TO CHANGE CAMERA <span>·</span> SPACE TO PAUSE';
    setPreset(0);
  }
  function applyAircraftProfile() {
    const chosen = $('aircraftProfile').value;
    Object.keys(variants).forEach(key=>variants[key].visible=key===chosen);
  }
  $('nozzleMode').addEventListener('change',setNozzleMode);
  $('sceneMode').addEventListener('change',setSceneMode);
  $('aircraftProfile').addEventListener('change',applyAircraftProfile);
  $('forceToggle').addEventListener('change',setSceneMode);
  $('bCobra').addEventListener('click',()=>{
    $('sceneMode').value='flight'; setSceneMode();
    cobraDemo.savedThrottle=throttleCmd; cobraDemo.active=true; cobraDemo.time=0;
    throttleCmd=0.95; $('thr').value=95;
    flight.speed=Math.max(flight.speed,245); $('flightSpeed').value=Math.round(flight.speed);
    flight.pitch=2*D; flight.gamma=-2*D; flight.pitchRate=0; flight.yawRate=0; flight.rollRate=0;
    flightControls.elev=14*D; flightControls.ail=0; flightControls.rud=0;
    $('elev').value=14; $('ail').value=0; $('rud').value=0;
    setCommand(17,0); tryHaptic(18);
  });
  $('bLevel').addEventListener('click',()=>{
    cobraDemo.active=false; flight.pitch=flight.gamma+3*D; flight.pitchRate=0; flight.yawRate=0; flight.rollRate=0; flight.roll=0; flight.yaw=0;
    flightControls.elev=0; flightControls.ail=0; flightControls.rud=0;
    $('elev').value=0; $('ail').value=0; $('rud').value=0;
    setCommand(0,0); tryHaptic(8);
  });
  setNozzleMode(); applyAircraftProfile();

  function togglePause() {
    paused = !paused;
    $('bPause').textContent = paused ? 'Resume' : 'Pause';
  }
  $('bPause').addEventListener('click', togglePause);
  $('bReset').addEventListener('click', () => {
    $('auto').checked = false; $('grab').checked = false;
    setCommand(0, 0);
    throttleInput.value = 45; throttleCmd = .45;
    rateInput.value = 30; actuatorRate = 30;
    if ($('spool')) $('spool').value = 1.4;
    TAU = 1.4;
    if ($('spoolV')) $('spoolV').textContent = '1.4 s';
    if ($('vfx')) $('vfx').checked = true;
    if ($('forceToggle')) $('forceToggle').checked = true;
    $('nozzleMode').value = 'axisymmetric'; $('sceneMode').value = 'bench'; $('aircraftProfile').value = 'f16';
    $('diff').value = 0; $('diffV').textContent = '0.0°'; $('flightSpeed').value = 220; $('flightAlt').value = 4200;
    $('elev').value = 0; $('ail').value = 0; $('rud').value = 0; $('flightAssist').checked = true;
    flight.speed=220; flight.altitude=4200; flight.pitch=2*D; flight.gamma=-2*D; flight.yaw=0; flight.roll=0;
    flight.pitchRate=0; flight.yawRate=0; flight.rollRate=0; flightControls.elev=0; flightControls.ail=0; flightControls.rud=0;
    twinState.p=0; twinState.y=0; twinVelocity.p=0; twinVelocity.y=0; cobraDemo.active=false;
    $('haptics').checked=false;
    paused = false; $('bPause').textContent = 'Pause';
    setNozzleMode(); applyAircraftProfile(); setSceneMode();
  });

  const rows = [
    ['thc','Throttle command'], ['thr','Illustrative thrust'],
    ['pit','Pitch actual / command'], ['yaw','Yaw actual / command'],
    ['def','Total deflection'], ['fwd','Axial component'],
    ['ver','Vertical component'], ['lat','Lateral component'],
    ['sts','Actuator status'], ['a0','Actuator 1 travel'],
    ['a1','Actuator 2 travel'], ['a2','Actuator 3 travel'],
    ['n2','Core speed estimate'], ['egt','Estimated exhaust temperature'],
    ['fuel','Estimated fuel flow'], ['area','Effective exit area'],
    ['exh','Estimated exhaust speed'], ['tor','Vectoring moment magnitude']
  ];
  $('tele').innerHTML = rows.map(([key, label]) => `<tr><td>${label}</td><td id="t_${key}">—</td></tr>`).join('');
  const telemetry = {};
  rows.forEach(([key]) => { telemetry[key] = $('t_' + key); });
  const flightRows = [
    ['v','Airspeed'], ['mach','Mach estimate'], ['alt','Altitude'], ['alpha','Angle of attack'],
    ['beta','Sideslip estimate'], ['g','Normal load factor'], ['pitchRate','Pitch rate'],
    ['bank','Bank angle'], ['qbar','Dynamic pressure'], ['lift','Lift estimate'], ['drag','Drag estimate']
  ];
  $('flightTele').innerHTML = flightRows.map(([key,label])=>`<tr><td>${label}</td><td id="ft_${key}">—</td></tr>`).join('');
  const flightTelemetry = {};
  flightRows.forEach(([key])=>{ flightTelemetry[key] = $('ft_'+key); });

  const labelDefs = [
    ['TURBOFAN CORE · FIXED', () => V(-3.05, .76, 0)],
    ['SPHERICAL GIMBAL', () => V(.05, .92, 0)],
    ['HYDRAULIC ACTUATORS ×3', () => actuatorMeshes[0].body.position.clone()],
    ['ARTICULATED NOZZLE PETALS', () => nozzle.localToWorld(V(1.36, .57, 0))]
  ];
  const labels = labelDefs.map(([text, fn]) => {
    const el = document.createElement('div');
    el.className = 'lab'; el.textContent = text; $('labels').appendChild(el);
    return { el, fn };
  });
  const projected = V(0,0,0);
  let lastTelemetry = 0;
  const chart = $('simChart');
  const chartCtx = chart ? chart.getContext('2d') : null;
  const history = [];
  function drawHistory() {
    if (!chart || !chartCtx) return;
    const w = chart.width, h = chart.height;
    chartCtx.clearRect(0, 0, w, h);
    chartCtx.fillStyle = '#0a111b'; chartCtx.fillRect(0, 0, w, h);
    chartCtx.lineWidth = 1; chartCtx.strokeStyle = 'rgba(100,140,180,.18)';
    for (let i = 1; i < 5; i++) {
      const y = h * i / 5;
      chartCtx.beginPath(); chartCtx.moveTo(0, y); chartCtx.lineTo(w, y); chartCtx.stroke();
    }
    chartCtx.strokeStyle = 'rgba(100,140,180,.12)';
    for (let i = 1; i < 8; i++) {
      const x = w * i / 8;
      chartCtx.beginPath(); chartCtx.moveTo(x, 0); chartCtx.lineTo(x, h); chartCtx.stroke();
    }
    const plot = (key, colour, mapFn) => {
      if (history.length < 2) return;
      chartCtx.beginPath(); chartCtx.strokeStyle = colour; chartCtx.lineWidth = 2;
      history.forEach((sample, i) => {
        const x = i / Math.max(1, history.length - 1) * (w - 8) + 4;
        const y = h - 5 - clamp(mapFn(sample[key]), 0, 1) * (h - 10);
        if (i === 0) chartCtx.moveTo(x, y); else chartCtx.lineTo(x, y);
      });
      chartCtx.stroke();
    };
    plot('thrust', '#42d6ff', v => v);
    plot('egt', '#ffb469', v => (v - 350) / 850);
  }

  function updatePose(now) {
    // Slowly drift the translucent cloud layer; leave the sky gradient fixed.
    cloudTexture.offset.x = (now * 0.00000010) % 1;
    const qYaw = new THREE.Quaternion().setFromAxisAngle(V(0,1,0), -state.y * D);
    const qPitch = new THREE.Quaternion().setFromAxisAngle(V(0,0,1), -state.p * D);
    const twinOn = $('nozzleMode').value === 'twin';
    engine.position.z = twinOn ? -0.84 : 0;
    nozzle.position.z = twinOn ? -0.84 : 0;
    twinEngine.position.set(0,0,0.84);
    twinNozzle.position.set(pivotX,0,0.84);
    nozzle.quaternion.copy(qYaw).multiply(qPitch);
    const twinYaw = new THREE.Quaternion().setFromAxisAngle(V(0,1,0), -twinState.y * D);
    const twinPitch = new THREE.Quaternion().setFromAxisAngle(V(0,0,1), -twinState.p * D);
    twinNozzle.quaternion.copy(twinYaw).multiply(twinPitch);
    engine.updateMatrixWorld(true); nozzle.updateMatrixWorld(true);
    twinEngine.updateMatrixWorld(true); twinNozzle.updateMatrixWorld(true);

    // Flight attitude, airflow field, and wake vortices follow the integrated
    // approximate rigid-body state while preserving interactive camera orbit.
    aircraft.rotation.set(flight.roll, flight.yaw, -flight.pitch, 'ZYX');
    aircraft.position.set(0, 0.12 + 0.0015*(flight.altitude-4200), 0);
    aircraft.updateMatrixWorld(true);
    const qAlpha = new THREE.Quaternion().setFromAxisAngle(V(0,0,1), -flight.alpha*0.72);
    flowGroup.position.copy(aircraft.position);
    flowGroup.quaternion.copy(aircraft.quaternion).multiply(qAlpha);
    const flowArray = flowParticleGeometry.attributes.position.array;
    for (let i=0;i<flowParticleCount;i++) {
      const seed = flowSeed[i];
      const phase = (seed.phase*20 + simTime*(2.2 + flight.speed/75)) % 20;
      const x = -10 + phase;
      const wake = clamp((x-0.8)/7.2,0,1);
      const alphaFlow = Math.abs(flight.alpha);
      flowArray[i*3] = x;
      flowArray[i*3+1] = seed.y + Math.sin(seed.jitter + simTime*3.5 + x*0.63)*0.035 + wake*Math.sin(seed.jitter+simTime*5.4)*alphaFlow*0.55;
      flowArray[i*3+2] = seed.z + Math.cos(seed.jitter + simTime*3.1 + x*0.47)*0.045 + wake*Math.sin(seed.jitter+simTime*4.8)*alphaFlow*0.52;
    }
    flowParticleGeometry.attributes.position.needsUpdate = true;
    flowParticleMaterial.opacity = clamp(0.46 + Math.abs(flight.alpha)*0.7,0.45,0.86);
    vortexMat.opacity = clamp(0.18 + Math.abs(flight.alpha)*1.3,0.18,0.56);
    const elevatorAngle = flightControls.elev*0.65;
    tailControl.rotation.z = elevatorAngle;

    // Exhaust pressure gives a gentle illustrative nozzle-area change.
    const convergence = A0 - 2.8 * D * thrust;
    const divergence = B0 + 2.0 * D * thrust;
    petals.forEach(p => {
      p.hinge.rotation.z = -convergence;
      p.outerHinge.rotation.z = convergence + divergence;
    });
    twinPetals.forEach(p => {
      if (p.hinge) p.hinge.rotation.z = -convergence;
      if (p.outerHinge) p.outerHinge.rotation.z = convergence + divergence;
    });
    n2TopHinge.rotation.z = -state.p*D;
    n2BottomHinge.rotation.z = -state.p*D;
    n2LeftHinge.rotation.y = state.y*D;
    n2RightHinge.rotation.y = state.y*D;
    convergentMat.emissive.setRGB(.055 * thrust, .012 * thrust, .002 * thrust);
    divergentMat.emissive.setRGB(.12 * thrust, .024 * thrust, .004 * thrust);

    actuatorMeshes.forEach(a => {
      const Aworld = engine.localToWorld(a.A.clone());
      const Bworld = nozzle.localToWorld(a.B.clone());
      const direction = Bworld.clone().sub(Aworld).normalize();
      const bodyEnd = Aworld.clone().addScaledVector(direction, .47);
      const rodStart = Aworld.clone().addScaledVector(direction, .39);
      placeCylinder(a.body, Aworld, bodyEnd, .062, .062);
      placeCylinder(a.rod, rodStart, Bworld, .023, .023);
      placeCylinder(a.collar, bodyEnd.clone().addScaledVector(direction, -.04), bodyEnd.clone().addScaledVector(direction, .04), .078, .078);
      a.eyeA.position.copy(Aworld);
      a.eyeB.position.copy(Bworld);
      a.extension = Aworld.distanceTo(Bworld) - a.rest;
    });
    twinActuatorMeshes.forEach(a => {
      const Aworld = twinEngine.localToWorld(a.A.clone());
      const Bworld = twinNozzle.localToWorld(a.B.clone());
      const direction = Bworld.clone().sub(Aworld).normalize();
      const bodyEnd = Aworld.clone().addScaledVector(direction,.47);
      const rodStart = Aworld.clone().addScaledVector(direction,.39);
      placeCylinder(a.body,Aworld,bodyEnd,.062,.062);
      placeCylinder(a.rod,rodStart,Bworld,.023,.023);
      placeCylinder(a.collar,bodyEnd.clone().addScaledVector(direction,-.04),bodyEnd.clone().addScaledVector(direction,.04),.078,.078);
      a.eyeA.position.copy(Aworld); a.eyeB.position.copy(Bworld);
      a.extension = Aworld.distanceTo(Bworld)-a.rest;
    });

    const exhaustDirection = V(1,0,0).applyQuaternion(nozzle.quaternion);
    const active = thrust > .018;
    const vfxEnabled = !$('vfx') || $('vfx').checked;
    plume.visible = active && vfxEnabled;
    if (twinPlume) twinPlume.visible = twinOn && active && vfxEnabled;
    if (twinExhaustLight) twinExhaustLight.intensity = (twinOn && vfxEnabled) ? 10 * thrust : 0;
    if (twinExhaustParticles) twinExhaustParticles.visible = twinOn && vfxEnabled && thrust > .10;
    if (twinHeatShimmer) twinHeatShimmer.visible = twinOn && vfxEnabled && thrust > .18;
    const flicker = 1 + .018 * Math.sin(now * .012) + .012 * Math.sin(now * .027) + .012 * Math.sin(now * .061);
    plume.scale.set((.30 + 2.0 * thrust) * flicker, .50, .50);
    if (twinPlume) twinPlume.scale.copy(plume.scale);
    plumeOuter.material.opacity = vfxEnabled ? .34 * thrust : 0;
    plumeInner.material.opacity = vfxEnabled ? .54 * thrust : 0;
    exhaustLight.intensity = vfxEnabled ? 10 * thrust : 0;
    hotCore.material.color.setRGB(.12 + .65*thrust, .025 + .10*thrust, .012);
    shockDiamonds.forEach((ring,i) => {
      const pulse = 0.78 + 0.22*Math.sin(now*0.008 - i*0.75);
      ring.material.opacity = vfxEnabled && thrust>0.22 ? (0.09+0.27*thrust)*pulse : 0;
      ring.position.x = 2.02 + i*(0.39+0.08*thrust);
      ring.scale.setScalar((0.52+i*0.055)*(0.82+0.32*thrust)*pulse);
      ring.rotation.z = Math.sin(now*0.003+i)*0.018;
      const twinRing = twinShockDiamonds[i];
      if (twinRing) {
        twinRing.position.copy(ring.position);
        twinRing.scale.copy(ring.scale);
        twinRing.rotation.copy(ring.rotation);
      }
    });
    const dualFlightExhaust = twinOn || $('aircraftProfile').value === 'f22';
    flightExhausts.forEach(exhaust => {
      const kindMatches = exhaust.kind === 'centre' ? !dualFlightExhaust : dualFlightExhaust;
      exhaust.root.visible = $('sceneMode').value === 'flight' && kindMatches && active && vfxEnabled;
      exhaust.root.scale.set(plume.scale.x*exhaust.sizeFactor, plume.scale.y*exhaust.sizeFactor, plume.scale.z*exhaust.sizeFactor);
      const plumeSource = twinOn && exhaust.kind === 'twin' && exhaust.root.position.z > 0 ? twinNozzle : nozzle;
      exhaust.root.quaternion.copy(plumeSource.quaternion);
      exhaust.glow.intensity = ($('sceneMode').value === 'flight' && kindMatches && vfxEnabled) ? 8*thrust : 0;
      exhaust.rings.forEach((ring, i) => {
        if (!ring) return;
        ring.position.copy(shockDiamonds[i].position);
        ring.scale.copy(shockDiamonds[i].scale);
        ring.rotation.copy(shockDiamonds[i].rotation);
      });
    });
    const shimmerArray = shimmerGeometry.attributes.position.array;
    for(let i=0;i<shimmerCount;i++) {
      const phase=((now*0.00018+i*0.61803398875)%1+1)%1;
      const spread=(0.08+phase*0.27)*(0.15+thrust);
      shimmerArray[i*3]=1.9+phase*(1.0+3.3*thrust);
      shimmerArray[i*3+1]=Math.sin(i*9.81+now*0.009)*spread;
      shimmerArray[i*3+2]=Math.cos(i*6.27+now*0.008)*spread;
    }
    shimmerGeometry.attributes.position.needsUpdate = true;
    shimmerMaterial.opacity = vfxEnabled ? 0.23*thrust : 0;
    heatShimmer.visible = vfxEnabled && thrust>.18;
    nozzle2DGlow.material.opacity = vfxEnabled ? .19*thrust : 0;
    nozzle2DGlow.scale.set(0.6+2.0*thrust,0.48+0.25*thrust,0.48+0.25*thrust);

    // A few glowing tracer particles add depth to the exhaust plume without a
    // post-processing dependency. Their cloud follows the vectored nozzle.
    const particleArray = exhaustParticleGeometry.attributes.position.array;
    for (let i = 0; i < exhaustParticleCount; i++) {
      const phase = ((now * (0.00015 + thrust * 0.00034) + i * 0.61803398875) % 1 + 1) % 1;
      const spread = (0.018 + phase * 0.14) * (0.25 + thrust);
      particleArray[i * 3] = 1.88 + phase * (0.35 + 3.7 * thrust);
      particleArray[i * 3 + 1] = Math.sin(i * 12.9898 + now * 0.004) * spread;
      particleArray[i * 3 + 2] = Math.cos(i * 7.233 + now * 0.0037) * spread;
    }
    exhaustParticleGeometry.attributes.position.needsUpdate = true;
    exhaustParticles.visible = vfxEnabled && thrust > .10;
    exhaustParticleMaterial.opacity = .70 * thrust;

    forceArrow.position.set(pivotX, 0, twinOn ? -0.84 : 0);
    forceArrow.setDirection(exhaustDirection.clone().negate());
    forceArrow.setLength(.42 + 1.55 * thrust, .22, .11);
    forceArrow.visible = $('sceneMode').value === 'bench' && (!$('forceToggle') || $('forceToggle').checked) && thrust > .01;
    const twinDirection = V(1,0,0).applyQuaternion(twinNozzle.quaternion);
    twinForceArrow.position.set(pivotX,0,0.84);
    twinForceArrow.setDirection(twinDirection.clone().negate());
    twinForceArrow.setLength(.42+1.55*thrust,.22,.11);
    twinForceArrow.visible = $('sceneMode').value==='bench' && twinOn && (!$('forceToggle')||$('forceToggle').checked) && thrust>.01;

    // Screen-space labels are positioned over the scene, not rendered in 3D.
    const vw = view.clientWidth, vh = view.clientHeight;
    labels.forEach(label => {
      projected.copy(label.fn()).project(camera);
      const visible = $('sceneMode').value === 'bench' && projected.z > -1 && projected.z < 1 && Math.abs(projected.x) < 1.08 && Math.abs(projected.y) < 1.08;
      label.el.style.display = visible ? 'block' : 'none';
      label.el.style.left = ((projected.x * .5 + .5) * vw) + 'px';
      label.el.style.top = ((-projected.y * .5 + .5) * vh) + 'px';
    });

    if (now - lastTelemetry > 70) {
      lastTelemetry = now;
      const mode = $('nozzleMode').value;
      const F = thrust * TMAX * (mode === 'twin' ? 2 : 1);
      const moving = Math.hypot(velocity.p, velocity.y) > .06 || Math.hypot(twinVelocity.p,twinVelocity.y)>.06;
      telemetry.thc.textContent = `${(throttleCmd*100).toFixed(0)} %`;
      telemetry.thr.textContent = `${F.toFixed(1)} kN (${(thrust*100).toFixed(0)} %)`;
      telemetry.pit.textContent = `${fmt(state.p)}° / ${fmt(cmd.p)}°`;
      telemetry.yaw.textContent = `${fmt(state.y)}° / ${fmt(cmd.y)}°${mode==='twin' ? ` | R ${fmt(twinState.y)}°` : ''}`;
      telemetry.def.textContent = `${Math.hypot(state.p,state.y).toFixed(1)}° / ${LIM}°`;
      // Force components follow the reaction-force arrow (opposite the exhaust).
      telemetry.fwd.textContent = `${(-F*exhaustDirection.x).toFixed(1)} kN`;
      telemetry.ver.textContent = `${(-F*exhaustDirection.y).toFixed(1)} kN`;
      telemetry.lat.textContent = `${(-F*exhaustDirection.z).toFixed(1)} kN`;
      telemetry.sts.textContent = paused ? 'PAUSED' : (rateLimited ? 'RATE LIMITED' : (moving ? 'MOVING' : 'HOLDING'));
      actuatorMeshes.forEach((a, i) => { telemetry['a'+i].textContent = `${fmt(a.extension*1000,0)} mm`; });
      telemetry.n2.textContent = `${(61 + 39 * Math.sqrt(thrust)).toFixed(1)} % N2 (est.)`;
      telemetry.egt.textContent = `${egtC.toFixed(0)} °C`;
      telemetry.fuel.textContent = `${(0.45 + 4.0 * Math.pow(thrust, 1.7)).toFixed(2)} kg/s (est.)`;
      telemetry.area.textContent = `${(Math.PI * Math.pow(0.55 * (1 - 0.055 * thrust), 2) * 10000).toFixed(0)} cm²`;
      telemetry.exh.textContent = `${(180 + 720 * Math.sqrt(thrust)).toFixed(0)} m/s (est.)`;
      telemetry.tor.textContent = `${(F * 0.65 * Math.sin(Math.hypot(state.p, state.y) * D)).toFixed(1)} kN·m (est.)`;
      if (flightTelemetry.v) {
        flightTelemetry.v.textContent = `${flight.speed.toFixed(0)} m/s`;
        flightTelemetry.mach.textContent = `${flight.mach.toFixed(2)}`;
        flightTelemetry.alt.textContent = `${flight.altitude.toFixed(0)} m`;
        flightTelemetry.alpha.textContent = `${fmt(flight.alpha/D)}°`;
        flightTelemetry.beta.textContent = `${fmt(flight.beta/D)}°`;
        flightTelemetry.g.textContent = `${flight.g.toFixed(2)} G`;
        flightTelemetry.pitchRate.textContent = `${fmt(flight.pitchRate/D)} °/s`;
        flightTelemetry.bank.textContent = `${fmt(flight.roll/D)}°`;
        flightTelemetry.qbar.textContent = `${(flight.qbar/1000).toFixed(1)} kPa`;
        flightTelemetry.lift.textContent = `${(flight.lift/1000).toFixed(1)} kN`;
        flightTelemetry.drag.textContent = `${(flight.drag/1000).toFixed(1)} kN`;
      }
      $('speedV').textContent = `${flight.speed.toFixed(0)} m/s`;
      $('altV').textContent = `${flight.altitude.toFixed(0)} m`;
      $('elevV').textContent = `${fmt(flightControls.elev/D,0)}°`;
      $('ailV').textContent = `${fmt(flightControls.ail/D,0)}°`;
      $('rudV').textContent = `${fmt(flightControls.rud/D,0)}°`;
      $('diffV').textContent = `${fmt(Number($('diff').value),1)}°`;
      $('hudSpeed').textContent = `${flight.speed.toFixed(0)} m/s`;
      $('hudMach').textContent = `${flight.mach.toFixed(2)}`;
      $('hudAlpha').textContent = `${fmt(flight.alpha/D)}°`;
      $('hudG').textContent = `${flight.g.toFixed(1)} G`;
      history.push({ thrust, egt: egtC });
      if (history.length > 120) history.shift();
      drawHistory();
      const statusEl = $('simStatus');
      if (statusEl) {
        const statusText = paused ? 'PAUSED' : (rateLimited ? 'ACTUATOR RATE-LIMITED' : 'SIMULATION RUNNING');
        let dot = statusEl.querySelector('.status-dot');
        if (!dot) { dot = document.createElement('span'); dot.className = 'status-dot'; }
        statusEl.textContent = '';
        statusEl.appendChild(dot);
        statusEl.appendChild(document.createTextNode(statusText));
        statusEl.classList.toggle('is-warning', rateLimited || paused);
      }
      $('thrV').textContent = `${(throttleCmd*100).toFixed(0)} %`;
      $('pitV').textContent = `${fmt(cmd.p)}°`;
      $('yawV').textContent = `${fmt(cmd.y)}°`;
      $('rateV').textContent = `${actuatorRate} °/s`;
      if (document.activeElement !== pitchInput) pitchInput.value = cmd.p.toFixed(1);
      if (document.activeElement !== yawInput) yawInput.value = cmd.y.toFixed(1);
    }
  }

  // Gamepad API support is opt-in. The left stick drives the nozzle command;
  // controller rumble is attempted by tryHaptic() only when the user enables it.
  let lastGamepadId = '';
  let lastGamepadP = null;
  let lastGamepadY = null;
  function pollGamepad() {
    if (!$('gamepadToggle').checked) {
      $('gamepadTag').textContent = 'GAMEPAD: OFF';
      return;
    }
    if (!navigator.getGamepads) {
      $('gamepadTag').textContent = 'GAMEPAD: UNSUPPORTED';
      return;
    }
    const gamepad = Array.from(navigator.getGamepads()).filter(Boolean)[0];
    if (!gamepad) {
      lastGamepadId = ''; lastGamepadP = null; lastGamepadY = null;
      $('gamepadTag').textContent = 'GAMEPAD: NOT CONNECTED';
      return;
    }
    lastGamepadId = gamepad.id || 'CONNECTED';
    $('gamepadTag').textContent = 'GAMEPAD: ACTIVE';
    const deadzone = 0.12;
    const shape = value => {
      const v = clamp(Number(value) || 0, -1, 1);
      if (Math.abs(v) <= deadzone) return 0;
      return Math.sign(v) * (Math.abs(v) - deadzone) / (1 - deadzone);
    };
    const x = shape(gamepad.axes && gamepad.axes.length ? gamepad.axes[0] : 0);
    const y = shape(gamepad.axes && gamepad.axes.length > 1 ? gamepad.axes[1] : 0);
    const p = -y * LIM, yaw = x * LIM;
    if (lastGamepadP === null || Math.abs(p-lastGamepadP) > 0.8 || Math.abs(yaw-lastGamepadY) > 0.8) tryHaptic(7);
    lastGamepadP = p; lastGamepadY = yaw;
    setCommand(p, yaw);
  }

  // ---------------- Animation loop ----------------
  let lastFrame = performance.now();
  let accumulator = 0;
  let fpsFrameCount = 0;
  let fpsWindowStart = lastFrame;
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min((now - lastFrame) / 1000, .1);
    lastFrame = now;
    fpsFrameCount++;
    pollGamepad();
    if (now - fpsWindowStart >= 600) {
      if ($('fpsTag')) $('fpsTag').textContent = `${Math.round(fpsFrameCount * 1000 / (now - fpsWindowStart))} FPS · ${renderer.capabilities.isWebGL2 ? 'WEBGL2' : 'WEBGL'}`;
      fpsFrameCount = 0;
      fpsWindowStart = now;
    }
    if (!paused) {
      accumulator += dt;
      let safety = 0;
      while (accumulator >= H && safety < 40) {
        physicsStep(H); accumulator -= H; safety++;
      }
    }
    updateCamera(dt);
    updatePose(now);
    updateAudio(now);
    drawPad();
    renderer.render(scene, camera);
  }

  // A small runtime diagnostic if anything in initialisation fails.
  window.addEventListener('unhandledrejection', e => console.error('MATV simulator promise error:', e.reason));
  $('camtag').textContent = 'INITIALISING SIMULATION…';
  setNozzleMode(); applyAircraftProfile(); setSceneMode();
  console.info('MATV visualisation initialised. Renderer:', renderer.capabilities.isWebGL2 ? 'WebGL2' : 'WebGL1', 'Three.js:', THREE.REVISION);
  requestAnimationFrame(frame);
})();
