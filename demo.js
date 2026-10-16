(() => {
  'use strict';

  // F-16 MATV / AVEN nozzle bench — procedural visualisation.
  // Uses Three.js r128 WebGL rendering, PBR materials, environment reflections,
  // soft shadow maps and raycasting for pointer interaction. This is not a
  // hardware ray-traced renderer or an engineering-accurate engine model.

  const $ = (id) => document.getElementById(id);
  const required = ['view','thr','pit','yaw','rate','pad','camtag','labels','tele','auto','grab','bCentre','bPause','bReset'];
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
  const TAU = 1.4;
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

  // ---------------- Procedural blue sky and animated clouds ----------------
  // The cloud field is GPU generated, so no external textures or image assets are needed.
  // The lighting, cloud silver-lining and metal reflections approximate ray-traced visuals;
  // Three.js r128's standard WebGL renderer does not provide true hardware ray tracing.
  const skyUniforms = {
    uTime: { value: 0 },
    uSunDirection: { value: new THREE.Vector3(-0.48, 0.47, 0.74).normalize() }
  };
  const skyMaterial = new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    toneMapped: false,
    vertexShader: `
      varying vec3 vSkyDirection;
      void main() {
        vSkyDirection = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      varying vec3 vSkyDirection;
      uniform float uTime;
      uniform vec3 uSunDirection;

      float hash21(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      float noise2(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = hash21(i);
        float b = hash21(i + vec2(1.0, 0.0));
        float c = hash21(i + vec2(0.0, 1.0));
        float d = hash21(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }

      float fbm(vec2 p) {
        float value = 0.0;
        float amplitude = 0.5;
        mat2 turn = mat2(0.80, -0.60, 0.60, 0.80);
        for (int i = 0; i < 4; i++) {
          value += amplitude * noise2(p);
          p = turn * p * 2.02 + vec2(7.1, 3.7);
          amplitude *= 0.5;
        }
        return value;
      }

      void main() {
        vec3 dir = normalize(vSkyDirection);
        float elevation = clamp(dir.y, -0.12, 1.0);
        float skyFade = smoothstep(-0.10, 0.84, elevation);
        vec3 horizonBlue = vec3(0.72, 0.86, 0.98);
        vec3 zenithBlue = vec3(0.055, 0.30, 0.70);
        vec3 sky = mix(horizonBlue, zenithBlue, pow(max(skyFade, 0.0), 0.78));

        // Spherical mapping gives continuous clouds while the camera orbits the engine.
        vec2 cloudUV = vec2(atan(dir.z, dir.x) * 2.25, asin(clamp(dir.y, -1.0, 1.0)) * 3.9);
        cloudUV += vec2(uTime * 0.009, uTime * 0.0018);
        float broadCloud = fbm(cloudUV * 1.45);
        float cloudDetail = fbm(cloudUV * 3.35 + vec2(11.7, 4.3));
        float wisps = fbm(cloudUV * vec2(6.0, 2.0) + vec2(-uTime * 0.005, 2.8));
        float density = broadCloud * 0.70 + cloudDetail * 0.22 + wisps * 0.08;
        float clouds = smoothstep(0.505, 0.675, density);
        clouds *= smoothstep(-0.19, 0.12, dir.y);
        // Preserve a little more saturated blue high overhead.
        clouds *= 1.0 - 0.20 * smoothstep(0.48, 0.92, dir.y);

        float sunDot = max(dot(dir, normalize(uSunDirection)), 0.0);
        float broadHalo = pow(sunDot, 7.0) * 0.15;
        float tightHalo = pow(sunDot, 24.0) * 0.19;
        float sunDisc = pow(sunDot, 220.0) * 0.78;
        vec3 sunColour = vec3(1.0, 0.88, 0.70);

        // Cloud tops brighten toward the sun; undersides remain cool blue-grey.
        float cloudLight = clamp(0.67 + sunDot * 0.38 + (cloudDetail - 0.42) * 0.24, 0.42, 1.05);
        vec3 cloudColour = vec3(0.94, 0.97, 1.0) * cloudLight;
        float underside = smoothstep(0.48, 0.64, density) * (1.0 - smoothstep(0.68, 0.79, density));
        cloudColour = mix(cloudColour, vec3(0.54, 0.67, 0.82), underside * 0.42);
        float silverLining = smoothstep(0.50, 0.57, density) * (1.0 - smoothstep(0.59, 0.68, density));
        cloudColour += sunColour * silverLining * sunDot * 0.16;
        sky = mix(sky, cloudColour, clamp(clouds * 0.97, 0.0, 1.0));
        sky += sunColour * (broadHalo + tightHalo + sunDisc);

        // Soft haze close to the horizon gives the scene atmospheric depth.
        float horizonGlow = exp(-abs(dir.y) * 7.0) * 0.105;
        sky += vec3(0.40, 0.62, 0.86) * horizonGlow;
        gl_FragColor = vec4(sky, 1.0);
      }
    `
  });
  const skyDome = new THREE.Mesh(new THREE.SphereGeometry(74, 56, 36), skyMaterial);
  skyDome.name = 'Procedural blue sky and cloud dome';
  skyDome.frustumCulled = false;
  skyDome.renderOrder = -1000;
  skyDome.castShadow = false;
  skyDome.receiveShadow = false;
  scene.add(skyDome);

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
    base.position.set(HINGE_X, R0 * Math.cos(az), R0 * Math.sin(az));
    base.rotation.x = az;
    nozzle.add(base);
    const hinge = new THREE.Group();
    base.add(hinge);
    const inner = new THREE.Mesh(makePlateGeometry(LC, petalWidth0, petalWidth1, .038, -LC * Math.sin(A0)), convergentMat);
    inner.position.z = 0;
    add(hinge, inner);
    pickMeshes.push(inner);

    // Raised longitudinal stiffener on each convergent segment.
    const rib = makeBox(hinge, LC * .86, .018, .024, LC * .48, -LC * Math.sin(A0) * .48 + .025, petalWidth0 * .17, steelDark);
    rib.rotation.z = -A0;

    const outerHinge = new THREE.Group();
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
  plume.position.x = 1.85;
  nozzle.add(plume);
  const plumeOuter = makeOpenCone(0xff5a20, 0);
  const plumeInner = makeOpenCone(0xffdb91, 0);
  plumeInner.scale.set(.62, 1, .62);
  plume.add(plumeOuter, plumeInner);
  exhaustLight.position.set(1.1, 0, 0);
  nozzle.add(exhaustLight);

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

  // ---------------- Simulation state ----------------
  const cmd = { p: 0, y: 0 };
  const state = { p: 0, y: 0 };
  const velocity = { p: 0, y: 0 };
  let throttleCmd = .45;
  let thrust = 0;
  let actuatorRate = 30;
  let paused = false;
  let simTime = 0;
  let rateLimited = false;
  function setCommand(p, y) {
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
    thrust += (throttleCmd - thrust) * h / TAU;
    rateLimited = false;
    ['p', 'y'].forEach(axis => {
      const error = cmd[axis] - state[axis];
      const targetVelocity = clamp(error * 7.5, -actuatorRate, actuatorRate);
      if (Math.abs(error * 7.5) > actuatorRate) rateLimited = true;
      velocity[axis] += clamp(targetVelocity - velocity[axis], -actuatorRate * 10 * h, actuatorRate * 10 * h);
      state[axis] += velocity[axis] * h;
      if (Math.abs(error) < .002 && Math.abs(velocity[axis]) < .02) {
        state[axis] = cmd[axis];
        velocity[axis] = 0;
      }
    });
  }

  // ---------------- Camera controls ----------------
  const presets = [
    { name: 'SIDE PROFILE', theta: -0.04, phi: 1.42, radius: 8.6, target: [-.55, -.05, 0] },
    { name: 'REAR THREE-QUARTER', theta: 0.78, phi: 1.33, radius: 7.7, target: [.1, 0, 0] },
    { name: 'TOP-DOWN', theta: 0.10, phi: .16, radius: 9.1, target: [-.4, -.1, 0] },
    { name: 'NOZZLE DETAIL', theta: .12, phi: 1.43, radius: 4.25, target: [.7, 0, 0] }
  ];
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
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(view);
  resize();

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
  pitchInput.addEventListener('input', () => setCommand(Number(pitchInput.value), cmd.y));
  yawInput.addEventListener('input', () => setCommand(cmd.p, Number(yawInput.value)));
  rateInput.addEventListener('input', () => { actuatorRate = Number(rateInput.value); });
  $('bCentre').addEventListener('click', () => setCommand(0, 0));
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
    paused = false; $('bPause').textContent = 'Pause';
    setPreset(0);
  });

  const rows = [
    ['thc','Throttle command'], ['thr','Illustrative thrust'],
    ['pit','Pitch actual / command'], ['yaw','Yaw actual / command'],
    ['def','Total deflection'], ['fwd','Axial component'],
    ['ver','Vertical component'], ['lat','Lateral component'],
    ['sts','Actuator status'], ['a0','Actuator 1 travel'],
    ['a1','Actuator 2 travel'], ['a2','Actuator 3 travel']
  ];
  $('tele').innerHTML = rows.map(([key, label]) => `<tr><td>${label}</td><td id="t_${key}">—</td></tr>`).join('');
  const telemetry = {};
  rows.forEach(([key]) => { telemetry[key] = $('t_' + key); });

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

  function updatePose(now) {
    skyUniforms.uTime.value = now * 0.001;
    const qYaw = new THREE.Quaternion().setFromAxisAngle(V(0,1,0), -state.y * D);
    const qPitch = new THREE.Quaternion().setFromAxisAngle(V(0,0,1), -state.p * D);
    nozzle.quaternion.copy(qYaw).multiply(qPitch);
    nozzle.updateMatrixWorld(true);

    // Exhaust pressure gives a gentle illustrative nozzle-area change.
    const convergence = A0 - 2.8 * D * thrust;
    const divergence = B0 + 2.0 * D * thrust;
    petals.forEach(p => {
      p.hinge.rotation.z = -convergence;
      p.outerHinge.rotation.z = convergence + divergence;
    });
    convergentMat.emissive.setRGB(.055 * thrust, .012 * thrust, .002 * thrust);
    divergentMat.emissive.setRGB(.12 * thrust, .024 * thrust, .004 * thrust);

    actuatorMeshes.forEach(a => {
      const Bworld = nozzle.localToWorld(a.B.clone());
      const direction = Bworld.clone().sub(a.A).normalize();
      const bodyEnd = a.A.clone().addScaledVector(direction, .47);
      const rodStart = a.A.clone().addScaledVector(direction, .39);
      placeCylinder(a.body, a.A, bodyEnd, .062, .062);
      placeCylinder(a.rod, rodStart, Bworld, .023, .023);
      placeCylinder(a.collar, bodyEnd.clone().addScaledVector(direction, -.04), bodyEnd.clone().addScaledVector(direction, .04), .078, .078);
      a.eyeA.position.copy(a.A);
      a.eyeB.position.copy(Bworld);
      a.extension = a.A.distanceTo(Bworld) - a.rest;
    });

    const exhaustDirection = V(1,0,0).applyQuaternion(nozzle.quaternion);
    const active = thrust > .018;
    plume.visible = active;
    const flicker = 1 + .018 * Math.sin(now * .012) + .012 * Math.sin(now * .027);
    plume.scale.set((.30 + 2.0 * thrust) * flicker, .50, .50);
    plumeOuter.material.opacity = .34 * thrust;
    plumeInner.material.opacity = .54 * thrust;
    exhaustLight.intensity = 10 * thrust;
    hotCore.material.color.setRGB(.12 + .65*thrust, .025 + .10*thrust, .012);

    forceArrow.position.set(pivotX, 0, 0);
    forceArrow.setDirection(exhaustDirection.clone().negate());
    forceArrow.setLength(.42 + 1.55 * thrust, .22, .11);
    forceArrow.visible = thrust > .01;

    // Screen-space labels are positioned over the scene, not rendered in 3D.
    const vw = view.clientWidth, vh = view.clientHeight;
    labels.forEach(label => {
      projected.copy(label.fn()).project(camera);
      const visible = projected.z > -1 && projected.z < 1 && Math.abs(projected.x) < 1.08 && Math.abs(projected.y) < 1.08;
      label.el.style.display = visible ? 'block' : 'none';
      label.el.style.left = ((projected.x * .5 + .5) * vw) + 'px';
      label.el.style.top = ((-projected.y * .5 + .5) * vh) + 'px';
    });

    if (now - lastTelemetry > 70) {
      lastTelemetry = now;
      const F = thrust * TMAX;
      const moving = Math.hypot(velocity.p, velocity.y) > .06;
      telemetry.thc.textContent = `${(throttleCmd*100).toFixed(0)} %`;
      telemetry.thr.textContent = `${F.toFixed(1)} kN (${(thrust*100).toFixed(0)} %)`;
      telemetry.pit.textContent = `${fmt(state.p)}° / ${fmt(cmd.p)}°`;
      telemetry.yaw.textContent = `${fmt(state.y)}° / ${fmt(cmd.y)}°`;
      telemetry.def.textContent = `${Math.hypot(state.p,state.y).toFixed(1)}° / ${LIM}°`;
      telemetry.fwd.textContent = `${(F*exhaustDirection.x).toFixed(1)} kN`;
      telemetry.ver.textContent = `${(-F*exhaustDirection.y).toFixed(1)} kN`;
      telemetry.lat.textContent = `${(F*exhaustDirection.z).toFixed(1)} kN`;
      telemetry.sts.textContent = paused ? 'PAUSED' : (rateLimited ? 'RATE LIMITED' : (moving ? 'MOVING' : 'HOLDING'));
      actuatorMeshes.forEach((a, i) => { telemetry['a'+i].textContent = `${fmt(a.extension*1000,0)} mm`; });
      $('thrV').textContent = `${(throttleCmd*100).toFixed(0)} %`;
      $('pitV').textContent = `${fmt(cmd.p)}°`;
      $('yawV').textContent = `${fmt(cmd.y)}°`;
      $('rateV').textContent = `${actuatorRate} °/s`;
      if (document.activeElement !== pitchInput) pitchInput.value = cmd.p.toFixed(1);
      if (document.activeElement !== yawInput) yawInput.value = cmd.y.toFixed(1);
    }
  }

  // ---------------- Animation loop ----------------
  let lastFrame = performance.now();
  let accumulator = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min((now - lastFrame) / 1000, .1);
    lastFrame = now;
    if (!paused) {
      accumulator += dt;
      let safety = 0;
      while (accumulator >= H && safety < 40) {
        physicsStep(H); accumulator -= H; safety++;
      }
    }
    updateCamera(dt);
    updatePose(now);
    drawPad();
    renderer.render(scene, camera);
  }

  // A small runtime diagnostic if anything in initialisation fails.
  window.addEventListener('error', e => console.error('MATV simulator runtime error:', e.message, e.filename, e.lineno));
  window.addEventListener('unhandledrejection', e => console.error('MATV simulator promise error:', e.reason));
  $('camtag').textContent = 'INITIALISING SIMULATION…';
  console.info('MATV visualisation initialised. Renderer:', renderer.capabilities.isWebGL2 ? 'WebGL2' : 'WebGL1', 'Three.js:', THREE.REVISION);
  requestAnimationFrame(frame);
})();
