// The waiting scene: a city that is drawn as a plan, gains detail, is given surfaces, and lights up.
// One fixed city (seeded), a handful of draw calls, no textures. The page drives it through
// `setStage(stage, progress)`; the picture never decides anything by itself.
import * as THREE from 'three';

// Colours are authored for the screen and written to it unchanged (no light transport here).
THREE.ColorManagement.enabled = false;

const COLORS = {
  night: new THREE.Color('#05080f'),
  dusk: new THREE.Color('#0a1022'),
  line: new THREE.Color('#aab6ff'),
  lineHot: new THREE.Color('#eef2ff'),
  roof: new THREE.Color('#39466f'),
  wallLit: new THREE.Color('#2b365c'),
  wallDark: new THREE.Color('#161d35'),
  pad: new THREE.Color('#131b30'),
  water: new THREE.Color('#0a1530'),
  park: new THREE.Color('#122036'),
  tree: new THREE.Color('#1f3352'),
  paint: new THREE.Color('#4a5784'),
  ground: new THREE.Color('#080c17'),
  glass: new THREE.Color('#0a1020'),
  lamp: new THREE.Color('#ffc98a'),
  lampHot: new THREE.Color('#ffe6bf'),
  head: new THREE.Color('#dfe8ff'),
};

// Daylight: the same model on drafting paper. Blue ink, white card, a low warm sun at the end.
const DAY = {
  night: '#e6eaf3',
  dusk: '#f4f1ea',
  line: '#4656c8',
  lineHot: '#1d2c8f',
  roof: '#ffffff',
  wallLit: '#f1f3f8',
  wallDark: '#c4ccdd',
  pad: '#dfe3ed',
  water: '#a3bce6',
  park: '#d3e2d6',
  tree: '#9dbfa3',
  paint: '#ffffff',
  ground: '#d3d9e5',
  glass: '#8c9dc2',
  lamp: '#ffd9a0',
  lampHot: '#fff5e2',
  head: '#27304d',
};

// Both palettes as colours; COLORS is what is on screen, somewhere between the two.
const NIGHT = Object.fromEntries(
  Object.entries(COLORS).map(([key, color]) => [key, color.clone()])
);
const DAYLIGHT = Object.fromEntries(
  Object.entries(DAY).map(([key, hex]) => [key, new THREE.Color(hex)])
);
const CAR_NIGHT = ['#2f3b62', '#46557f', '#1b2340', '#5d6a96', '#8792b6'].map(
  (hex) => new THREE.Color(hex)
);
const CAR_DAY = ['#ffffff', '#d7dcea', '#4656c8', '#27304d', '#9fb0d8'].map(
  (hex) => new THREE.Color(hex)
);

const BLOCK = 14;
const ROAD = 5;
const PITCH = BLOCK + ROAD;
const AVENUE = 9;
const RINGS = 4;
const MAX_H = 64;
const EDGE = RINGS * PITCH + BLOCK;
const COL1 = AVENUE / 2 + BLOCK / 2;
const RIVER_X = -(COL1 + PITCH);
const PARK = { x: -COL1, z: PITCH };
// Where the key light comes from; shadows fall the other way.
const SUN = new THREE.Vector3(0.55, 0.62, 0.56).normalize();
const SHADOW = new THREE.Vector2(-SUN.x, -SUN.z).normalize().multiplyScalar(0.62);
const TONE = { body: 0, pad: 1, water: 2, park: 3, tree: 4, paint: 5 };
// The tallest thing in the city; the surfaces rise to here.
const TOP = 92;
const LANDMARK = { x: COL1, z: 0 };

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const ease = (t) => t * t * (3 - 2 * t);
const radial = (x, z) => Math.hypot(x, z) / (RINGS * PITCH);

/** Every solid of the city as boxes, plus what moves and glows on it. */
function planCity(density, detail) {
  const rand = rng(20261117);
  const boxes = [];
  const lamps = [];
  const beacons = [];
  const trees = [];
  const cols = [];
  for (let i = 1; i <= RINGS; i++) {
    const x = COL1 + (i - 1) * PITCH;
    cols.push(x, -x);
  }
  const rows = [];
  for (let j = -RINGS; j <= RINGS; j++) rows.push(j * PITCH);
  const box = (b) => {
    boxes.push({ windows: false, shadow: false, lines: 'full', tone: TONE.body, ...b });
  };

  for (const bx of cols) {
    for (const bz of rows) {
      const r = radial(bx, bz);
      if (r > 1.28) continue;
      const dist = clamp01(r / 1.28);
      if (bx === RIVER_X) continue;
      if (bx === PARK.x && bz === PARK.z) {
        box({
          x: bx,
          z: bz,
          w: BLOCK,
          d: BLOCK,
          y: 0,
          h: 0.18,
          delay: dist * 0.5,
          dist,
          tone: TONE.park,
          lines: 'foot',
        });
        for (let i = 0; i < 26; i++) {
          const a = rand() * Math.PI * 2;
          const rr = 2.9 + rand() * 3.6;
          const s = 0.75 + rand() * 0.6;
          const th = 1.1 + rand() * 1.0;
          const tree = {
            x: bx + Math.cos(a) * rr,
            z: bz + Math.sin(a) * rr,
            delay: clamp01(dist * 0.78 + rand() * 0.2),
            dist,
            tone: TONE.tree,
            lines: 'none',
          };
          box({ ...tree, w: 0.14, d: 0.14, y: 0.18, h: 0.7 });
          box({
            ...tree,
            w: s * 1.7,
            d: s * 1.7,
            y: 0.6,
            h: th * 1.3,
            shape: 'ball',
            shadow: true,
            cast: th + 0.6,
          });
        }
        continue;
      }
      if (bx === LANDMARK.x && bz === LANDMARK.z) {
        // The one building that is not like the others: a long taper to a spire, on its own plaza.
        const lm = { x: bx, z: bz, delay: 0.03, dist: 0.05 };
        box({ ...lm, w: BLOCK, d: BLOCK, y: 0, h: 0.18, tone: TONE.pad, lines: 'foot' });
        box({ ...lm, w: 12.4, d: 12.4, y: 0.18, h: 0.5, lines: 'box' });
        let y = 0.68;
        const tiers = [
          [10.2, 4.2],
          [8.4, 25],
          [7.2, 16],
          [5.8, 11],
          [4.2, 8],
          [2.7, 6],
        ];
        const total = tiers.reduce((sum, t) => sum + t[1], 0.68);
        tiers.forEach(([w, h], i) => {
          box({ ...lm, w, d: w, y, h, windows: true, shadow: i === 0, cast: total });
          // Four fins up the corners of the shaft: what gives it its outline against the others.
          if (i >= 1 && i <= 3) {
            for (const [fx, fz] of [
              [1, 1],
              [1, -1],
              [-1, 1],
              [-1, -1],
            ])
              box({
                ...lm,
                x: bx + (fx * w) / 2,
                z: bz + (fz * w) / 2,
                w: 0.5,
                d: 0.5,
                y,
                h: h + 1.4,
                lines: 'box',
              });
          }
          y += h;
        });
        box({ ...lm, w: 1.5, d: 1.5, y, h: 1.6, lines: 'box' });
        box({ ...lm, w: 0.3, d: 0.3, y: y + 1.6, h: 13, lines: 'box' });
        beacons.push({ x: bx, y: y + 14.9, z: bz, dist: 0, big: true });
        continue;
      }
      // The block's own slab: reads as pavement against the roads once surfaces arrive.
      box({
        x: bx,
        z: bz,
        w: BLOCK,
        d: BLOCK,
        y: 0,
        h: 0.18,
        delay: dist * 0.5,
        dist,
        tone: TONE.pad,
        lines: 'foot',
      });

      const split = rand();
      const nx = split < 0.22 ? 1 : 2;
      const nz = split > 0.78 ? 1 : 2;
      const gap = 1.1;
      const lw = (BLOCK - 1.6 - gap * (nx - 1)) / nx;
      const ld = (BLOCK - 1.6 - gap * (nz - 1)) / nz;
      for (let ix = 0; ix < nx; ix++) {
        for (let iz = 0; iz < nz; iz++) {
          if (rand() > density) continue;
          const cx = bx - (BLOCK - 1.6) / 2 + lw / 2 + ix * (lw + gap);
          const cz = bz - (BLOCK - 1.6) / 2 + ld / 2 + iz * (ld + gap);
          const lr = radial(cx, cz);
          const core = Math.exp(-Math.pow(lr * 2.05, 2));
          let h = 2.6 + rand() * 4.2 + core * MAX_H * (0.42 + 0.58 * rand());
          if (lr > 0.95) h = Math.min(h, 3 + rand() * 4);
          h = Math.min(h, MAX_H);
          const ldist = clamp01(lr / 1.28);
          const delay = clamp01(ldist * 0.78 + rand() * 0.22);
          const w = lw * (0.78 + rand() * 0.22);
          const d = ld * (0.78 + rand() * 0.22);
          const base = { x: cx, z: cz, delay, dist: ldist };

          if (h > 24) {
            // A tower: a podium, two or three tiers each set back, a crown and a mast.
            const tiers = h > 40 ? 3 : 2;
            const podium = 2.4;
            box({
              ...base,
              w: Math.min(lw, w + 1.1),
              d: Math.min(ld, d + 1.1),
              y: 0,
              h: podium,
              windows: true,
              shadow: true,
              cast: h,
            });
            let y = podium;
            let tw = w * 0.9;
            let td = d * 0.9;
            const cuts = tiers === 3 ? [0.5, 0.3, 0.2] : [0.64, 0.36];
            for (let t = 0; t < tiers; t++) {
              const th = (h - podium) * cuts[t];
              box({ ...base, w: tw, d: td, y, h: th, windows: true });
              y += th;
              tw *= 0.74;
              td *= 0.74;
            }
            box({ ...base, w: tw * 0.9, d: td * 0.9, y, h: 0.9, lines: 'box' });
            y += 0.9;
            if (rand() < 0.8) {
              const mast = 3.5 + rand() * 5.5;
              box({ ...base, w: 0.26, d: 0.26, y, h: mast, lines: 'box' });
              beacons.push({ x: cx, y: y + mast + 0.2, z: cz, dist: ldist });
            }
          } else if (h > 9 && rand() < 0.4 && lw > 5) {
            // An L: a tall wing and a low one.
            box({ ...base, w, d: d * 0.5, z: cz - d * 0.25, y: 0, h, windows: true, shadow: true });
            box({
              ...base,
              w: w * 0.5,
              d: d * 0.5,
              x: cx - w * 0.25,
              z: cz + d * 0.25,
              y: 0,
              h: h * 0.55,
              windows: true,
              shadow: true,
            });
          } else {
            box({ ...base, w, d, y: 0, h, windows: true, shadow: true });
            if (h > 6 && rand() < 0.65) {
              const rw = w * (0.25 + rand() * 0.2);
              const rd = d * (0.25 + rand() * 0.2);
              box({
                ...base,
                x: cx + (rand() - 0.5) * (w - rw) * 0.7,
                z: cz + (rand() - 0.5) * (d - rd) * 0.7,
                w: rw,
                d: rd,
                y: h,
                h: 0.7 + rand() * 0.9,
                lines: 'box',
              });
            }
            if (h > 12 && rand() < 0.5) {
              // A parapet: the thin band that finishes a roof.
              box({ ...base, w: w + 0.16, d: d + 0.16, y: h, h: 0.22, lines: 'none' });
            }
          }
        }
      }
    }
  }

  // The river: one column of the grid is water, crossed where the streets meet it.
  const riverLen = EDGE + PITCH * 2.5;
  box({
    x: RIVER_X,
    z: 0,
    w: BLOCK,
    d: riverLen * 2,
    y: 0,
    h: 0.05,
    delay: 0.1,
    dist: 0.2,
    tone: TONE.water,
    lines: 'none',
  });
  const bridges = [];
  for (const z of rows) {
    const zr = z + PITCH / 2;
    if (radial(RIVER_X, zr) > 1.15) continue;
    const dist = clamp01(radial(RIVER_X, zr) / 1.28);
    bridges.push(zr);
    box({
      x: RIVER_X,
      z: zr,
      w: BLOCK + 1.2,
      d: ROAD - 1.2,
      y: 0.5,
      h: 0.32,
      delay: dist * 0.7,
      dist,
      lines: 'box',
      shadow: true,
      cast: 1.4,
    });
    for (const off of [-3.4, 3.4])
      box({
        x: RIVER_X + off,
        z: zr,
        w: 0.7,
        d: ROAD - 2,
        y: 0.05,
        h: 0.45,
        delay: dist * 0.7,
        dist,
        lines: 'none',
      });
  }

  // Lamps along the streets, the avenue and the park's paths.
  for (const z of rows) {
    const zr = z + PITCH / 2;
    for (let x = -EDGE; x <= EDGE; x += PITCH / 2) {
      if (Math.abs(x - RIVER_X) < BLOCK / 2 && !bridges.includes(zr)) continue;
      if (radial(x, zr) < 1.2) lamps.push({ x, z: zr, dist: clamp01(radial(x, zr) / 1.28) });
    }
  }
  for (let z = -EDGE; z <= EDGE; z += PITCH / 2.5) {
    for (const side of [-1, 1]) {
      if (Math.abs(z) / (RINGS * PITCH) < 1.25)
        lamps.push({
          x: side * (AVENUE / 2 - 0.9),
          z,
          dist: clamp01(Math.abs(z) / (RINGS * PITCH) / 1.28),
        });
    }
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    lamps.push({
      x: PARK.x + Math.cos(a) * 2.2,
      z: PARK.z + Math.sin(a) * 2.2,
      dist: clamp01(radial(PARK.x, PARK.z) / 1.28),
      small: true,
    });
  }

  // The avenue is the street people end up standing in: trees down both sides, and real lamp posts.
  const trand = rng(515);
  for (let z = -EDGE; z <= EDGE; z += 3.8) {
    const rz = Math.abs(z) / (RINGS * PITCH);
    if (rz > 1.25) continue;
    const cross = (((z - PITCH / 2) % PITCH) + PITCH) % PITCH;
    if (cross < 3.5 || cross > PITCH - 3.5) continue;
    const dist = clamp01(rz / 1.28);
    for (const side of [-1, 1]) {
      const x = side * 3.95;
      const delay = clamp01(dist * 0.78 + trand() * 0.15);
      const tall = 0.85 + trand() * 0.45;
      const base = { x, z: z + (trand() - 0.5) * 0.5, delay, dist, tone: TONE.tree, lines: 'none' };
      box({ ...base, w: 0.16, d: 0.16, y: 0.18, h: 1.0 * tall });
      box({
        ...base,
        w: 1.6,
        d: 1.6,
        y: 0.18 + 0.8 * tall,
        h: 1.5 * tall,
        shape: 'ball',
        shadow: true,
        cast: 2.3 * tall,
      });
      box({ ...base, w: 1.05, d: 1.05, y: 0.18 + 1.75 * tall, h: 1.0 * tall, shape: 'ball' });
      trees.push({ x, z: base.z, dist });
    }
  }
  for (const l of lamps) {
    if (l.small || Math.abs(Math.abs(l.x) - (AVENUE / 2 - 0.9)) > 0.01) continue;
    const post = { x: l.x, z: l.z, delay: clamp01(l.dist * 0.8), dist: l.dist, lines: 'none' };
    box({ ...post, w: 0.1, d: 0.1, y: 0.18, h: 2.4 });
    box({ ...post, x: l.x - Math.sign(l.x) * 0.3, w: 0.7, d: 0.2, y: 2.52, h: 0.1 });
  }

  // Where the streets meet the avenue: the stripes people cross on, and a signal over each way in.
  const signals = [];
  for (const z of rows) {
    const zr = z + PITCH / 2;
    if (Math.abs(zr) > EDGE - 2) continue;
    const dist = clamp01(Math.abs(zr) / (RINGS * PITCH) / 1.28);
    const paint = {
      delay: clamp01(dist * 0.8),
      dist,
      tone: TONE.paint,
      lines: 'none',
      y: 0.012,
      h: 0.012,
    };
    for (const side of [-1, 1]) {
      const cz = zr + side * (ROAD / 2 + 1.0);
      for (let x = -3.0; x <= 3.01; x += 0.75) box({ ...paint, x, z: cz, w: 0.4, d: 1.5 });
      const cx = side * (AVENUE / 2 + 1.0);
      for (let dz = -1.5; dz <= 1.51; dz += 0.75)
        box({ ...paint, x: cx, z: zr + dz, w: 1.5, d: 0.4 });
      // A post on the pavement, an arm over the lanes, the head hanging from it.
      const px = side * (AVENUE / 2 - 0.45);
      const pz = zr - side * (ROAD / 2 + 0.5);
      const post = { delay: clamp01(dist * 0.8), dist, lines: 'none' };
      box({ ...post, x: px, z: pz, w: 0.13, d: 0.13, y: 0.18, h: 3.3 });
      box({ ...post, x: px - side * 1.05, z: pz, w: 2.2, d: 0.1, y: 3.4, h: 0.1 });
      box({ ...post, x: px - side * 2.0, z: pz, w: 0.26, d: 0.26, y: 2.72, h: 0.68 });
      signals.push({ x: px - side * 2.0, y: 2.9, z: pz + side * 0.16, dist });
    }
  }

  // Traffic: lanes on every street that runs the whole city.
  const lanes = [];
  for (const z of rows) {
    const zr = z + PITCH / 2;
    if (Math.abs(zr) < EDGE) lanes.push({ axis: 0, line: zr });
  }
  lanes.push({ axis: 1, line: 0, wide: true });
  for (let i = 1; i < RINGS; i++) {
    const x = AVENUE / 2 + BLOCK + ROAD / 2 + (i - 1) * PITCH;
    lanes.push({ axis: 1, line: x }, { axis: 1, line: -x });
  }
  const cars = [];
  const crand = rng(909);
  for (const l of lanes) {
    const count = Math.round((l.wide ? 18 : 4) * detail);
    for (let i = 0; i < count; i++) {
      const forward = crand() < 0.5 ? 1 : -1;
      cars.push({
        axis: l.axis,
        line: l.line + forward * (l.wide ? 1.7 : 0.85),
        speed: forward * (5 + crand() * 5),
        phase: crand() * 400,
        tint: Math.floor(crand() * 5),
      });
    }
  }
  return { boxes, lamps, beacons, cars, trees, rows, bridges, signals };
}

const FOG_GLSL = `
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  float fogAmount(vec3 world) { return smoothstep(uFogNear, uFogFar, length(world.xz)); }
  vec3 withFog(vec3 color, vec3 world) { return mix(color, uFogColor, fogAmount(world)); }
`;

const CLOUD_GLSL = `
  // Slow, large shadows of clouds that are never seen: only by day.
  uniform float uCloudTime;
  float cloudShade(vec3 world, float day) {
    vec2 p = world.xz;
    float n = sin(p.x * 0.021 + uCloudTime * 0.05) * sin(p.y * 0.017 - uCloudTime * 0.035) + 0.5 * sin(p.x * 0.043 - p.y * 0.037 + uCloudTime * 0.06);
    return 1.0 - 0.14 * day * smoothstep(0.15, 0.95, n * 0.5 + 0.5);
  }
`;

// How far up a building's surfaces have been laid, from the global fill and its own delay.
const RISE_GLSL = `
  uniform float uFill;
  uniform float uMaxH;
  float riseHeight(float delay) {
    float local = clamp(uFill * 1.55 - delay * 0.55, 0.0, 1.0);
    return local * (uMaxH + 4.0) - 0.4;
  }
`;

function buildSolids(boxes) {
  const pos = [];
  const nor = [];
  const delay = [];
  const tone = [];
  const quad = (a, b, c, d, n, dl, tn) => {
    for (const p of [a, b, c, a, c, d]) {
      pos.push(p[0], p[1], p[2]);
      nor.push(n[0], n[1], n[2]);
      delay.push(dl);
      tone.push(tn);
    }
  };
  // A crown of leaves: a low sphere, its own normals, so the light rolls over it.
  const ball = (b) => {
    const rings = 5;
    const around = 8;
    const at = (i, j) => {
      const v = (i / rings) * Math.PI;
      const u = (j / around) * Math.PI * 2;
      const n = [Math.sin(v) * Math.cos(u), Math.cos(v), Math.sin(v) * Math.sin(u)];
      return {
        p: [b.x + (n[0] * b.w) / 2, b.y + b.h / 2 + (n[1] * b.h) / 2, b.z + (n[2] * b.d) / 2],
        n,
      };
    };
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < around; j++) {
        const q = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
        for (const k of [0, 1, 2, 0, 2, 3]) {
          pos.push(q[k].p[0], q[k].p[1], q[k].p[2]);
          nor.push(q[k].n[0], q[k].n[1], q[k].n[2]);
          delay.push(b.delay);
          tone.push(b.tone);
        }
      }
    }
  };
  for (const b of boxes) {
    if (b.shape === 'ball') {
      ball(b);
      continue;
    }
    const x0 = b.x - b.w / 2;
    const x1 = b.x + b.w / 2;
    const z0 = b.z - b.d / 2;
    const z1 = b.z + b.d / 2;
    const y0 = b.y;
    const y1 = b.y + b.h;
    quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [0, 1, 0], b.delay, b.tone);
    if (b.tone === TONE.water || b.tone === TONE.paint) continue;
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], b.delay, b.tone);
    quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], b.delay, b.tone);
    quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], b.delay, b.tone);
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], b.delay, b.tone);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aDelay', new THREE.Float32BufferAttribute(delay, 1));
  g.setAttribute('aTone', new THREE.Float32BufferAttribute(tone, 1));
  return g;
}

function buildLines(plan, detail) {
  const pos = [];
  const along = [];
  const appear = [];
  const group = [];
  const seg = (a, b, ap, gr) => {
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    along.push(0, 1);
    appear.push(ap, ap);
    group.push(gr, gr);
  };
  const loop = (x0, x1, z0, z1, y, ap, gr) => {
    seg([x0, y, z0], [x1, y, z0], ap, gr);
    seg([x1, y, z0], [x1, y, z1], ap, gr);
    seg([x1, y, z1], [x0, y, z1], ap, gr);
    seg([x0, y, z1], [x0, y, z0], ap, gr);
  };
  const ring = (cx, cz, r, y, n, ap, spread, gr) => {
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * Math.PI * 2;
      const a1 = ((k + 1) / n) * Math.PI * 2;
      seg(
        [cx + Math.cos(a0) * r, y, cz + Math.sin(a0) * r],
        [cx + Math.cos(a1) * r, y, cz + Math.sin(a1) * r],
        clamp01(ap + (k / n) * spread),
        gr
      );
    }
  };
  const rand = rng(77);

  for (const b of plan.boxes) {
    if (b.lines === 'none') continue;
    const x0 = b.x - b.w / 2;
    const x1 = b.x + b.w / 2;
    const z0 = b.z - b.d / 2;
    const z1 = b.z + b.d / 2;
    const y0 = b.y;
    const y1 = b.y + b.h;
    const ap = b.lines === 'foot' ? b.delay * 0.6 : b.delay;

    // Group 0, the outline: footprint first, then the four risers, then the top.
    loop(x0, x1, z0, z1, y0 + 0.02, ap * 0.9, 0);
    if (b.lines === 'foot') continue;
    for (const [x, z] of [
      [x0, z0],
      [x1, z0],
      [x1, z1],
      [x0, z1],
    ])
      seg([x, y0, z], [x, y1, z], ap * 0.9 + 0.05, 0);
    loop(x0, x1, z0, z1, y1, ap * 0.9 + 0.1, 0);
    if (!b.windows || b.h < 3.2) continue;

    // Group 1, the detail: floors bottom to top, then mullions, then the roof's inset.
    const floorH = 1.75;
    const floors = Math.floor(b.h / floorH);
    const stride = detail < 1 ? 2 : 1;
    for (let f = 1; f < floors; f += stride) {
      loop(
        x0,
        x1,
        z0,
        z1,
        y0 + f * floorH,
        clamp01(b.delay * 0.62 + (f / floors) * 0.3 + rand() * 0.04),
        1
      );
    }
    const bay = detail < 1 ? 3.4 : 2.3;
    const nx = Math.max(1, Math.round(b.w / bay));
    const nz = Math.max(1, Math.round(b.d / bay));
    const apM = clamp01(b.delay * 0.62 + 0.34);
    for (let i = 1; i < nx; i++) {
      const x = x0 + (b.w * i) / nx;
      seg([x, y0, z0], [x, y1, z0], apM, 1);
      seg([x, y0, z1], [x, y1, z1], apM, 1);
    }
    for (let i = 1; i < nz; i++) {
      const z = z0 + (b.d * i) / nz;
      seg([x0, y0, z], [x0, y1, z], apM, 1);
      seg([x1, y0, z], [x1, y1, z], apM, 1);
    }
    if (b.w > 2.4 && b.d > 2.4)
      loop(x0 + 0.5, x1 - 0.5, z0 + 0.5, z1 - 0.5, y1 + 0.02, clamp01(apM + 0.05), 1);
  }

  // The river's banks (outline) and its current (detail).
  const riverLen = EDGE + PITCH * 2.5;
  for (const side of [-1, 1]) {
    for (let z = -riverLen; z < riverLen; z += PITCH) {
      seg(
        [RIVER_X + (side * BLOCK) / 2, 0.06, z],
        [RIVER_X + (side * BLOCK) / 2, 0.06, z + PITCH],
        clamp01(Math.abs(z) / (riverLen * 1.1)),
        0
      );
    }
  }
  for (let i = 0; i < 70 * detail; i++) {
    const z = (rand() * 2 - 1) * riverLen * 0.8;
    const x = RIVER_X + (rand() - 0.5) * (BLOCK - 2.4);
    seg(
      [x, 0.07, z],
      [x, 0.07, z + 1.6 + rand() * 3.4],
      clamp01(Math.abs(z) / riverLen + rand() * 0.2),
      1
    );
  }

  // The park: a round path, two crossing ones.
  ring(PARK.x, PARK.z, 2.2, 0.2, 20, 0.3, 0.08, 1);
  ring(PARK.x, PARK.z, 5.6, 0.2, 32, 0.34, 0.1, 1);
  for (const [dx, dz] of [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ])
    seg(
      [PARK.x + dx * 1.6, 0.2, PARK.z + dz * 1.6],
      [PARK.x + dx * 6.6, 0.2, PARK.z + dz * 6.6],
      0.4,
      1
    );

  // Each avenue tree as the small circle a plan gives it.
  for (const t of plan.trees) ring(t.x, t.z, 0.6, 0.04, 8, clamp01(t.dist * 0.7 + 0.2), 0, 1);

  // Road markings.
  for (const z of plan.rows) {
    const zr = z + PITCH / 2;
    if (Math.abs(zr) > EDGE) continue;
    for (let x = -EDGE; x < EDGE; x += 3.2) {
      if (Math.abs(x) < AVENUE / 2 + 0.5) continue;
      seg(
        [x, 0.03, zr],
        [x + 1.6, 0.03, zr],
        clamp01(Math.hypot(x, zr) / (EDGE * 1.3)) * 0.8 + 0.1,
        1
      );
    }
  }
  for (let z = -EDGE; z < EDGE; z += 3.6) {
    seg([0, 0.03, z], [0, 0.03, z + 2], clamp01(Math.abs(z) / (EDGE * 1.3)) * 0.8 + 0.05, 1);
  }

  // Figures, as seven strokes each, lying on the sheet and read from the front.
  const STROKES = {
    a: [0, 1, 1, 1],
    b: [1, 1, 1, 0.5],
    c: [1, 0.5, 1, 0],
    d: [0, 0, 1, 0],
    e: [0, 0.5, 0, 0],
    f: [0, 1, 0, 0.5],
    g: [0, 0.5, 1, 0.5],
  };
  const DIGITS = [
    'abcdef',
    'bc',
    'abged',
    'abgcd',
    'fgbc',
    'afgcd',
    'afgedc',
    'abc',
    'abcdefg',
    'abfgcd',
  ];
  const figure = (text, cx, cz, size, ap) => {
    const w = size * 0.56;
    const gap = size * 0.3;
    let x = cx - (text.length * w + (text.length - 1) * gap) / 2;
    for (const ch of text) {
      for (const k of DIGITS[Number(ch)] || '') {
        const q = STROKES[k];
        seg([x + q[0] * w, 0.02, cz - q[1] * size], [x + q[2] * w, 0.02, cz - q[3] * size], ap, 3);
      }
      x += w + gap;
    }
  };
  // The front and the side of the plan, measured: a line, a tick at every street, the pitch written in.
  const dimZ = EDGE + 8;
  seg([-EDGE, 0.02, dimZ], [EDGE, 0.02, dimZ], 0.5, 3);
  for (let i = -RINGS; i <= RINGS + 1; i++) {
    const x = (i - 0.5) * PITCH;
    if (Math.abs(x) > EDGE + 0.1) continue;
    seg([x, 0.02, dimZ - 1.3], [x, 0.02, dimZ + 1.3], 0.52, 3);
    if (i <= RINGS && Math.abs(i) % 2 === 1)
      figure(String(PITCH), x + PITCH / 2, dimZ + 6.4, 3.6, 0.6);
  }
  figure(String(Math.round(EDGE * 2)), 0, dimZ + 14.5, 4.8, 0.66);
  const dimX = -(EDGE + 8);
  seg([dimX, 0.02, -EDGE], [dimX, 0.02, EDGE], 0.5, 3);
  for (let i = -RINGS; i <= RINGS + 1; i++) {
    const z = (i - 0.5) * PITCH;
    if (Math.abs(z) > EDGE + 0.1) continue;
    seg([dimX - 1.3, 0.02, z], [dimX + 1.3, 0.02, z], 0.52, 3);
    if (i <= RINGS && Math.abs(i) % 2 === 0)
      figure(String(PITCH), dimX - 5.4, z + PITCH / 2 + 1.8, 3.6, 0.6);
  }
  // North, in the corner of the sheet.
  const nx = EDGE + 12;
  const nz = EDGE + 2;
  ring(nx, nz, 4.2, 0.02, 28, 0.62, 0.1, 3);
  seg([nx, 0.02, nz + 3.2], [nx, 0.02, nz - 6.2], 0.7, 3);
  seg([nx, 0.02, nz - 6.2], [nx - 1.5, 0.02, nz - 3.4], 0.74, 3);
  seg([nx, 0.02, nz - 6.2], [nx + 1.5, 0.02, nz - 3.4], 0.74, 3);
  // Group 2: the drawing's grid. Group 3: its axes' ticks and three survey rings.
  const step = PITCH / 4;
  const ext = EDGE + PITCH * 2;
  for (let v = -ext; v <= ext + 0.01; v += step) {
    const ap = clamp01(Math.abs(v) / ext) * 0.8;
    seg([v, 0, -ext], [v, 0, ext], ap, 2);
    seg([-ext, 0, v], [ext, 0, v], ap, 2);
  }
  for (const r of [34, 68, 104]) ring(0, 0, r, 0.01, 120, 0.05 + r / 400, 0.55, 3);
  for (let v = -ext; v <= ext; v += PITCH) {
    seg([v, 0.01, -1.4], [v, 0.01, 1.4], clamp01(Math.abs(v) / ext) * 0.7, 3);
    seg([-1.4, 0.01, v], [1.4, 0.01, v], clamp01(Math.abs(v) / ext) * 0.7, 3);
  }

  // Each stroke becomes a ribbon of two triangles; the vertex shader gives it its width on screen.
  const count = pos.length / 6;
  const here = new Float32Array(count * 12);
  const other = new Float32Array(count * 12);
  const side = new Float32Array(count * 4);
  const end = new Float32Array(count * 4);
  const when = new Float32Array(count * 4);
  const kind = new Float32Array(count * 4);
  const index = new Uint32Array(count * 6);
  for (let i = 0; i < count; i++) {
    for (let v = 0; v < 4; v++) {
      const atEnd = v >= 2 ? 1 : 0;
      for (let c = 0; c < 3; c++) {
        here[i * 12 + v * 3 + c] = pos[i * 6 + atEnd * 3 + c];
        other[i * 12 + v * 3 + c] = pos[i * 6 + (1 - atEnd) * 3 + c];
      }
      side[i * 4 + v] = v % 2 === 0 ? -1 : 1;
      end[i * 4 + v] = atEnd;
      when[i * 4 + v] = appear[i * 2];
      kind[i * 4 + v] = group[i * 2];
    }
    index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(here, 3));
  g.setAttribute('aOther', new THREE.BufferAttribute(other, 3));
  g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
  g.setAttribute('aAlong', new THREE.BufferAttribute(end, 1));
  g.setAttribute('aAppear', new THREE.BufferAttribute(when, 1));
  g.setAttribute('aGroup', new THREE.BufferAttribute(kind, 1));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  return g;
}

function buildWindows(boxes, detail) {
  const pos = [];
  const uv = [];
  const delay = [];
  const seed = [];
  const dist = [];
  const rand = rng(4242);
  const floorH = 1.75;
  const out = 0.035;
  const push = (corners, dl, sd, ds) => {
    const uvs = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      pos.push(corners[i][0], corners[i][1], corners[i][2]);
      uv.push(uvs[i][0], uvs[i][1]);
      delay.push(dl);
      seed.push(sd);
      dist.push(ds);
    }
  };
  for (const b of boxes) {
    if (!b.windows || b.h < 2.2) continue;
    const floors = Math.max(1, Math.floor(b.h / floorH));
    const bay = detail < 1 ? 3.4 : 2.3;
    const hw = b.w / 2;
    const hd = b.d / 2;
    const faces = [
      {
        n: Math.max(1, Math.round(b.w / bay)),
        len: b.w,
        at: (a, c, y0, y1) => [
          [b.x - hw + a, y0, b.z + hd + out],
          [b.x - hw + c, y0, b.z + hd + out],
          [b.x - hw + c, y1, b.z + hd + out],
          [b.x - hw + a, y1, b.z + hd + out],
        ],
      },
      {
        n: Math.max(1, Math.round(b.w / bay)),
        len: b.w,
        at: (a, c, y0, y1) => [
          [b.x + hw - a, y0, b.z - hd - out],
          [b.x + hw - c, y0, b.z - hd - out],
          [b.x + hw - c, y1, b.z - hd - out],
          [b.x + hw - a, y1, b.z - hd - out],
        ],
      },
      {
        n: Math.max(1, Math.round(b.d / bay)),
        len: b.d,
        at: (a, c, y0, y1) => [
          [b.x + hw + out, y0, b.z + hd - a],
          [b.x + hw + out, y0, b.z + hd - c],
          [b.x + hw + out, y1, b.z + hd - c],
          [b.x + hw + out, y1, b.z + hd - a],
        ],
      },
      {
        n: Math.max(1, Math.round(b.d / bay)),
        len: b.d,
        at: (a, c, y0, y1) => [
          [b.x - hw - out, y0, b.z - hd + a],
          [b.x - hw - out, y0, b.z - hd + c],
          [b.x - hw - out, y1, b.z - hd + c],
          [b.x - hw - out, y1, b.z - hd + a],
        ],
      },
    ];
    // Whole floors go dark together now and then: offices, not confetti.
    const floorMood = [];
    for (let f = 0; f < floors; f++) floorMood.push(rand());
    for (const face of faces) {
      const cell = face.len / face.n;
      for (let f = 0; f < floors; f++) {
        const y0 = b.y + f * floorH + floorH * 0.36;
        const y1 = b.y + f * floorH + floorH * 0.78;
        if (y1 > b.y + b.h - 0.15) continue;
        for (let i = 0; i < face.n; i++) {
          const lit = floorMood[f] < 0.26 ? 2 : rand() < 0.48 ? 2 : rand();
          push(
            face.at(i * cell + cell * 0.23, (i + 1) * cell - cell * 0.23, y0, y1),
            b.delay,
            lit,
            b.dist
          );
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aDelay', new THREE.Float32BufferAttribute(delay, 1));
  g.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 1));
  g.setAttribute('aDist', new THREE.Float32BufferAttribute(dist, 1));
  return g;
}

/** What each building throws on the ground: its footprint swept away from the light. */
function buildShadows(boxes) {
  const base = [];
  const far = [];
  const height = [];
  const delay = [];
  const vert = (x, z, f, h, dl) => {
    base.push(x, 0.2, z);
    far.push(f);
    height.push(h);
    delay.push(dl);
  };
  for (const b of boxes) {
    if (!b.shadow) continue;
    const h = b.cast ?? b.h;
    const c = [
      [b.x - b.w / 2, b.z - b.d / 2],
      [b.x + b.w / 2, b.z - b.d / 2],
      [b.x + b.w / 2, b.z + b.d / 2],
      [b.x - b.w / 2, b.z + b.d / 2],
    ];
    for (let i = 0; i < 4; i++) {
      const p = c[i];
      const q = c[(i + 1) % 4];
      for (const [pt, f] of [
        [p, 0],
        [q, 0],
        [q, 1],
        [p, 0],
        [q, 1],
        [p, 1],
      ])
        vert(pt[0], pt[1], f, h, b.delay);
    }
    for (const i of [0, 1, 2, 0, 2, 3]) vert(c[i][0], c[i][1], 1, h, b.delay);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(base, 3));
  g.setAttribute('aFar', new THREE.Float32BufferAttribute(far, 1));
  g.setAttribute('aHeight', new THREE.Float32BufferAttribute(height, 1));
  g.setAttribute('aDelay', new THREE.Float32BufferAttribute(delay, 1));
  return g;
}

function buildPools(lamps) {
  const pos = [];
  const uv = [];
  const dist = [];
  for (const l of lamps) {
    const r = l.small ? 2.6 : 5.2;
    const c = [
      [l.x - r, 0.24, l.z - r],
      [l.x - r, 0.24, l.z + r],
      [l.x + r, 0.24, l.z + r],
      [l.x + r, 0.24, l.z - r],
    ];
    const u = [
      [-1, -1],
      [-1, 1],
      [1, 1],
      [1, -1],
    ];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      pos.push(c[i][0], c[i][1], c[i][2]);
      uv.push(u[i][0], u[i][1]);
      dist.push(l.dist);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aDist', new THREE.Float32BufferAttribute(dist, 1));
  return g;
}

function buildTraffic(cars) {
  const lane = [];
  const move = [];
  const corner = [];
  for (const car of cars) {
    // Two points per car: white ahead, warm behind.
    for (const kind of [0, 1]) {
      for (const c of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        lane.push(car.axis, car.line, kind);
        move.push(car.phase, car.speed);
        corner.push(c[0], c[1]);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(lane.length), 3));
  g.setAttribute('aLane', new THREE.Float32BufferAttribute(lane, 3));
  g.setAttribute('aMove', new THREE.Float32BufferAttribute(move, 2));
  g.setAttribute('aCorner', new THREE.Float32BufferAttribute(corner, 2));
  return g;
}

/** The cars themselves: a body and a cabin each, moved along their lane by the vertex shader. */
function buildCars(cars) {
  const local = [];
  const normal = [];
  const lane = [];
  const move = [];
  const part = [];
  const solid = (a0, a1, y0, y1, c, car, kind, t0 = a0, t1 = a1) => {
    const faces = [
      [
        [t0, y1, -c],
        [t0, y1, c],
        [t1, y1, c],
        [t1, y1, -c],
        [0, 1, 0],
      ],
      [
        [a0, y0, c],
        [a1, y0, c],
        [t1, y1, c],
        [t0, y1, c],
        [0, 0, 1],
      ],
      [
        [a1, y0, -c],
        [a0, y0, -c],
        [t0, y1, -c],
        [t1, y1, -c],
        [0, 0, -1],
      ],
      [
        [a1, y0, c],
        [a1, y0, -c],
        [t1, y1, -c],
        [t1, y1, c],
        [0.86, 0.5, 0],
      ],
      [
        [a0, y0, -c],
        [a0, y0, c],
        [t0, y1, c],
        [t0, y1, -c],
        [-0.92, 0.38, 0],
      ],
    ];
    for (const f of faces) {
      for (const i of [0, 1, 2, 0, 2, 3]) {
        local.push(f[i][0], f[i][1], f[i][2]);
        normal.push(f[4][0], f[4][1], f[4][2]);
        lane.push(car.axis, car.line, car.tint);
        move.push(car.phase, car.speed);
        part.push(kind);
      }
    }
  };
  for (const car of cars) {
    // Body, a cabin that leans back at the screen and in at the tail, four wheels.
    solid(-0.92, 0.92, 0.17, 0.56, 0.4, car, 0, -0.9, 0.84);
    solid(-0.56, 0.4, 0.56, 0.9, 0.35, car, 1, -0.4, 0.1);
    for (const a of [-0.56, 0.56]) {
      for (const c of [-0.36, 0.36]) {
        const before = local.length;
        solid(a - 0.17, a + 0.17, 0.02, 0.34, 0.07, car, 2);
        for (let i = before + 2; i < local.length; i += 3) local[i] += c;
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(local, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  g.setAttribute('aLane', new THREE.Float32BufferAttribute(lane, 3));
  g.setAttribute('aMove', new THREE.Float32BufferAttribute(move, 2));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  return g;
}

function buildBeacons(beacons, signals) {
  const pos = [];
  const info = [];
  const rand = rng(31);
  for (const b of beacons) {
    pos.push(b.x, b.y, b.z);
    info.push(rand(), b.big ? 1 : 0);
  }
  for (const sg of signals) {
    pos.push(sg.x, sg.y, sg.z);
    info.push(rand(), 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aInfo', new THREE.Float32BufferAttribute(info, 2));
  return g;
}

/** Stars over the far end of the streets: only ever seen from down in them. */
function buildStars() {
  const rand = rng(1234);
  const pos = [];
  const seed = [];
  for (let i = 0; i < 520; i++) {
    const a = rand() * Math.PI * 2;
    const e = (0.02 + Math.pow(rand(), 1.6) * 0.95) * (Math.PI / 2) * 0.7;
    const r = 1050;
    pos.push(Math.cos(e) * Math.sin(a) * r, Math.sin(e) * r, Math.cos(e) * Math.cos(a) * r);
    seed.push(rand());
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 1));
  return g;
}

/** Scene into a texture, its bright parts blurred small, both put on the screen. */
function createBloom(renderer) {
  let sceneRT;
  let a;
  let b;
  try {
    sceneRT = new THREE.WebGLRenderTarget(2, 2, {
      samples: 4,
      depthBuffer: true,
      stencilBuffer: true,
    });
    a = new THREE.WebGLRenderTarget(2, 2, { depthBuffer: false });
    b = new THREE.WebGLRenderTarget(2, 2, { depthBuffer: false });
  } catch (e) {
    return null;
  }
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  const stage = new THREE.Scene();
  stage.add(quad);
  const vertexShader = `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
  const flat = { depthTest: false, depthWrite: false };
  const bright = new THREE.ShaderMaterial({
    ...flat,
    uniforms: { tMap: { value: null }, uThreshold: { value: 0.6 } },
    vertexShader,
    fragmentShader: `
      uniform sampler2D tMap;
      uniform float uThreshold;
      varying vec2 vUv;
      void main() {
        vec3 c = texture2D(tMap, vUv).rgb;
        float peak = max(c.r, max(c.g, c.b));
        gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold + 0.3, peak), 1.0);
      }
    `,
  });
  const blur = new THREE.ShaderMaterial({
    ...flat,
    uniforms: { tMap: { value: null }, uStep: { value: new THREE.Vector2() } },
    vertexShader,
    fragmentShader: `
      uniform sampler2D tMap;
      uniform vec2 uStep;
      varying vec2 vUv;
      void main() {
        vec3 c = texture2D(tMap, vUv).rgb * 0.227027;
        c += (texture2D(tMap, vUv + uStep * 1.3846).rgb + texture2D(tMap, vUv - uStep * 1.3846).rgb) * 0.316216;
        c += (texture2D(tMap, vUv + uStep * 3.2308).rgb + texture2D(tMap, vUv - uStep * 3.2308).rgb) * 0.070270;
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  const join = new THREE.ShaderMaterial({
    ...flat,
    uniforms: { tScene: { value: null }, tBloom: { value: null }, uStrength: { value: 0.8 } },
    vertexShader,
    fragmentShader: `
      uniform sampler2D tScene;
      uniform sampler2D tBloom;
      uniform float uStrength;
      varying vec2 vUv;
      void main() {
        gl_FragColor = vec4(texture2D(tScene, vUv).rgb + texture2D(tBloom, vUv).rgb * uStrength, 1.0);
      }
    `,
  });
  const pass = (material, target) => {
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(stage, camera);
  };
  return {
    setSize(w, h) {
      sceneRT.setSize(w, h);
      a.setSize(Math.max(2, w >> 2), Math.max(2, h >> 2));
      b.setSize(Math.max(2, w >> 2), Math.max(2, h >> 2));
    },
    render(scene, view, strength, threshold) {
      renderer.setRenderTarget(sceneRT);
      renderer.render(scene, view);
      bright.uniforms.tMap.value = sceneRT.texture;
      bright.uniforms.uThreshold.value = threshold;
      pass(bright, a);
      for (const reach of [1, 2.2]) {
        blur.uniforms.tMap.value = a.texture;
        blur.uniforms.uStep.value.set(reach / a.width, 0);
        pass(blur, b);
        blur.uniforms.tMap.value = b.texture;
        blur.uniforms.uStep.value.set(0, reach / a.height);
        pass(blur, a);
      }
      join.uniforms.tScene.value = sceneRT.texture;
      join.uniforms.tBloom.value = a.texture;
      join.uniforms.uStrength.value = strength;
      pass(join, null);
    },
    dispose() {
      for (const target of [sceneRT, a, b]) target.dispose();
      for (const material of [bright, blur, join]) material.dispose();
      quad.geometry.dispose();
    },
  };
}

export function createCity(canvas, options = {}) {
  const reduced = options.reducedMotion === true;
  // 0 night, 1 day; the picture passes through every value between when the theme is switched.
  let themeWant = options.theme === 'day' ? 1 : 0;
  let themeNow = themeWant;
  const day = { uDay: { value: themeNow } };
  const carTints = CAR_NIGHT.map((color) => color.clone());
  const applyTheme = () => {
    for (const key of Object.keys(NIGHT))
      COLORS[key].copy(NIGHT[key]).lerp(DAYLIGHT[key], themeNow);
    for (let i = 0; i < carTints.length; i++)
      carTints[i].copy(CAR_NIGHT[i]).lerp(CAR_DAY[i], themeNow);
    day.uDay.value = themeNow;
  };
  applyTheme();
  // Light added to the dark and ink laid on the paper, from one blend: colour is written
  // premultiplied, and an alpha of 0 leaves what is behind untouched.
  const INK = {
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  };
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      stencil: true,
      powerPreference: 'high-performance',
    });
  } catch (e) {
    return null;
  }
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  const small = Math.min(window.innerWidth, window.innerHeight) < 600;
  const detail = small ? 0.6 : 1;
  const plan = planCity(small ? 0.86 : 0.94, detail);
  const dprCap = small ? 1.75 : 2;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(23, 1, 1.2, 1400);
  const fog = {
    uFogColor: { value: COLORS.night.clone() },
    uFogNear: { value: 46 },
    uFogFar: { value: 100 },
  };
  const rise = { uFill: { value: 0 }, uMaxH: { value: TOP } };
  const lit = { uLights: { value: 0 } };
  const time = { uTime: { value: 0 } };
  const wave = { uWave: { value: -1 } };
  const cloud = { uCloudTime: { value: 0 } };
  // Distance the traffic has covered: it stands still until the lights are on.
  const drive = { uDrive: { value: 0 } };
  const meshes = [];
  const add = (object) => {
    object.frustumCulled = false;
    scene.add(object);
    meshes.push(object);
    return object;
  };

  const solidMat = new THREE.ShaderMaterial({
    uniforms: {
      ...fog,
      ...rise,
      ...lit,
      ...time,
      ...day,
      ...wave,
      ...cloud,
      uRoof: { value: COLORS.roof },
      uWallLit: { value: COLORS.wallLit },
      uWallDark: { value: COLORS.wallDark },
      uPad: { value: COLORS.pad },
      uWater: { value: COLORS.water },
      uPark: { value: COLORS.park },
      uTree: { value: COLORS.tree },
      uPaint: { value: COLORS.paint },
      uEdge: { value: COLORS.lineHot },
      uWarm: { value: COLORS.lamp },
      uSun: { value: SUN },
    },
    vertexShader: `
      attribute float aDelay;
      attribute float aTone;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vDelay;
      varying float vTone;
      void main() {
        vWorld = position;
        vNormal = normal;
        vDelay = aDelay;
        vTone = aTone;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      ${FOG_GLSL}
      ${RISE_GLSL}
      uniform vec3 uRoof;
      uniform vec3 uWallLit;
      uniform vec3 uWallDark;
      uniform vec3 uPad;
      uniform vec3 uWater;
      uniform vec3 uPark;
      uniform vec3 uTree;
      uniform vec3 uPaint;
      uniform vec3 uEdge;
      uniform vec3 uWarm;
      uniform vec3 uSun;
      uniform float uLights;
      uniform float uTime;
      uniform float uDay;
      uniform float uWave;
      ${CLOUD_GLSL}
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vDelay;
      varying float vTone;
      void main() {
        float top = riseHeight(vDelay);
        if (vWorld.y > top) discard;
        vec3 n = normalize(vNormal);
        float up = step(0.5, n.y);
        float key = max(dot(n, uSun), 0.0);
        vec3 color;
        if (vTone < 0.5) {
          color = mix(mix(uWallDark, uWallLit, key), uRoof, up);
          // Walls settle into the street: darker towards the ground, a model's soft contact.
          color *= mix(mix(0.55, 0.84, uDay), 1.0, smoothstep(0.0, 9.0, vWorld.y));
          // Height reads as light: the tallest roofs catch the most sky.
          color *= 1.0 + 0.24 * (1.0 - uDay) * smoothstep(6.0, 58.0, vWorld.y);
          // Street light climbing the lowest floors once the lamps are on.
          color += uWarm * uLights * 0.2 * (1.0 - uDay) * (1.0 - smoothstep(0.0, 5.5, vWorld.y)) * (1.0 - up);
          // By day the last stage is the sun coming out: the lit faces warm a little.
          color = mix(color, color * uWarm * 1.1, uDay * uLights * 0.2 * max(key, up * 0.6));
        } else if (vTone < 1.5) {
          color = uPad;
        } else if (vTone < 2.5) {
          // Water: nearly black, with the lamps of the banks drawn out along the current.
          float ripple = sin(vWorld.z * 0.5 + sin(vWorld.x * 0.8 + uTime * 0.35) * 1.3 + uTime * 0.6);
          float bank = smoothstep(2.0, 6.6, abs(vWorld.x - (${RIVER_X.toFixed(2)})));
          color = uWater * (1.0 + mix(0.07, 0.025, uDay) * ripple);
          color += uWarm * uLights * 0.16 * (1.0 - uDay) * bank * (0.45 + 0.55 * smoothstep(0.2, 1.0, ripple));
          color += vec3(0.07) * uDay * smoothstep(0.7, 1.0, ripple);
        } else if (vTone < 3.5) {
          color = uPark;
        } else {
          if (vTone > 4.5) {
            color = uPaint;
          } else {
          color = mix(uTree * 0.6, uTree * 1.1, clamp(dot(n, uSun) * 0.5 + 0.5, 0.0, 1.0));
          color += uWarm * uLights * 0.08 * (1.0 - uDay);
          }
        }
        color *= cloudShade(vWorld, uDay);
        float ring = uWave < 0.0 ? 0.0 : exp(-pow((length(vWorld.xz) - uWave) / 7.0, 2.0));
        color = mix(color + uEdge * ring * 0.24, mix(color, uEdge, ring * 0.12), uDay);
        // The seam where the surface is being laid.
        float seam = (1.0 - smoothstep(0.0, 1.1, top - vWorld.y)) * step(uFill, 0.995) * step(0.001, uFill);
        color = mix(color + uEdge * seam * 0.55, mix(color, uEdge, seam * 0.5), uDay);
        gl_FragColor = vec4(withFog(color, vWorld), 1.0);
      }
    `,
    polygonOffset: true,
    polygonOffsetFactor: 1.2,
    polygonOffsetUnits: 1.2,
  });
  add(new THREE.Mesh(buildSolids(plan.boxes), solidMat));

  const groundMat = new THREE.ShaderMaterial({
    uniforms: {
      ...fog,
      ...rise,
      ...day,
      ...wave,
      ...cloud,
      uGround: { value: COLORS.ground },
      uEdge: { value: COLORS.lineHot },
    },
    vertexShader: `varying vec3 vWorld; void main() { vWorld = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      ${FOG_GLSL}
      ${CLOUD_GLSL}
      uniform vec3 uGround;
      uniform vec3 uEdge;
      uniform float uFill;
      uniform float uDay;
      uniform float uWave;
      varying vec3 vWorld;
      void main() {
        float glow = 1.0 - smoothstep(0.0, 95.0, length(vWorld.xz));
        vec3 color = mix(uFogColor, uGround * (1.0 + glow * 0.55), smoothstep(0.0, 0.5, uFill));
        color *= mix(1.0, cloudShade(vWorld, uDay), smoothstep(0.0, 0.5, uFill));
        float ring = uWave < 0.0 ? 0.0 : exp(-pow((length(vWorld.xz) - uWave) / 7.0, 2.0));
        color = mix(color + uEdge * ring * 0.12, mix(color, uEdge, ring * 0.07), uDay);
        gl_FragColor = vec4(withFog(color, vWorld), 1.0);
      }
    `,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 2,
  });
  const groundGeo = new THREE.BufferGeometry();
  const G = 900;
  groundGeo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [-G, 0, -G, -G, 0, G, G, 0, G, -G, 0, -G, G, 0, G, G, 0, -G],
      3
    )
  );
  add(new THREE.Mesh(groundGeo, groundMat));

  // Shadows: one flat layer, each pixel darkened once however many shadows cross it (stencil).
  const shadowMat = new THREE.ShaderMaterial({
    uniforms: { ...fog, ...rise, ...lit, ...day, uDir: { value: SHADOW } },
    vertexShader: `
      ${RISE_GLSL}
      attribute float aFar;
      attribute float aHeight;
      attribute float aDelay;
      uniform vec2 uDir;
      varying vec3 vWorld;
      varying float vShow;
      void main() {
        float risen = clamp(riseHeight(aDelay), 0.0, aHeight);
        vec3 p = position;
        p.xz += uDir * risen * aFar;
        vWorld = p;
        vShow = step(0.05, risen);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: `
      ${FOG_GLSL}
      uniform float uLights;
      uniform float uDay;
      varying vec3 vWorld;
      varying float vShow;
      void main() {
        if (vShow < 0.5) discard;
        float alpha = mix(mix(0.4, 0.26, uLights), mix(0.13, 0.3, uLights), uDay) * (1.0 - fogAmount(vWorld));
        gl_FragColor = vec4(mix(vec3(0.0, 0.0, 0.02), vec3(0.16, 0.2, 0.36), uDay), alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    stencilWrite: true,
    stencilRef: 1,
    stencilFunc: THREE.NotEqualStencilFunc,
    stencilZPass: THREE.ReplaceStencilOp,
  });
  const shadows = add(new THREE.Mesh(buildShadows(plan.boxes), shadowMat));
  shadows.renderOrder = 1;

  const lineMat = new THREE.ShaderMaterial({
    uniforms: {
      ...fog,
      ...day,
      uColor: { value: COLORS.line },
      uHot: { value: COLORS.lineHot },
      uProgress: { value: new THREE.Vector4(0, 0, 0, 0) },
      uAlpha: { value: new THREE.Vector4(0, 0, 0, 0) },
      uScan: { value: -200 },
      uScanAmount: { value: 0 },
      ...wave,
      uRes: { value: new THREE.Vector2(1, 1) },
      uPixel: { value: 1 },
    },
    vertexShader: `
      attribute vec3 aOther;
      attribute float aSide;
      attribute float aAlong;
      attribute float aAppear;
      attribute float aGroup;
      uniform vec2 uRes;
      uniform float uPixel;
      varying float vAlong;
      varying float vAppear;
      varying float vGroup;
      varying float vSide;
      varying vec3 vWorld;
      void main() {
        vAlong = aAlong;
        vAppear = aAppear;
        vGroup = aGroup;
        vSide = aSide;
        vWorld = position;
        vec4 a = modelViewMatrix * vec4(position, 1.0);
        vec4 b = modelViewMatrix * vec4(aOther, 1.0);
        // Down in the street a stroke can pass behind the eye: keep the part in front of it.
        float near = -1.25;
        if (a.z > near && b.z > near) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          return;
        }
        if (a.z > near) a = mix(b, a, (near - b.z) / (a.z - b.z));
        if (b.z > near) b = mix(a, b, (near - a.z) / (b.z - a.z));
        vec4 ca = projectionMatrix * a;
        vec4 cb = projectionMatrix * b;
        vec2 d = (cb.xy / cb.w - ca.xy / ca.w) * uRes;
        float len = length(d);
        d = len > 0.0001 ? d / len : vec2(1.0, 0.0);
        vec2 n = vec2(-d.y, d.x) * aSide * (aAlong > 0.5 ? -1.0 : 1.0);
        ca.xy += n * (4.5 * uPixel) / (uRes * 0.5) * ca.w;
        gl_Position = ca;
      }
    `,
    fragmentShader: `
      ${FOG_GLSL}
      uniform vec3 uColor;
      uniform vec3 uHot;
      uniform vec4 uProgress;
      uniform vec4 uAlpha;
      uniform float uScan;
      uniform float uScanAmount;
      uniform float uWave;
      uniform float uDay;
      varying float vAlong;
      varying float vAppear;
      varying float vGroup;
      varying float vSide;
      varying vec3 vWorld;
      void main() {
        float p = vGroup < 0.5 ? uProgress.x : (vGroup < 1.5 ? uProgress.y : (vGroup < 2.5 ? uProgress.z : uProgress.w));
        float a = vGroup < 0.5 ? uAlpha.x : (vGroup < 1.5 ? uAlpha.y : (vGroup < 2.5 ? uAlpha.z : uAlpha.w));
        float grow = clamp((p * 1.16 - vAppear) / 0.16, 0.0, 1.0);
        // Nothing of a stroke shows before the pen reaches it (not even its first point).
        if (grow <= 0.0 || vAlong > grow || a <= 0.001) discard;
        // The pen's tip while a line is still being drawn.
        float tip = (1.0 - smoothstep(0.0, 0.22, grow - vAlong)) * step(grow, 0.999);
        float scan = exp(-pow((vWorld.x * 0.62 + vWorld.z * 0.78 - uScan) / 7.0, 2.0)) * uScanAmount;
        float wave = uWave < 0.0 ? 0.0 : exp(-pow((length(vWorld.xz) - uWave) / 6.0, 2.0));
        // Across the ribbon: a core a little over a pixel wide, and the faint light around it.
        float px = abs(vSide) * 4.5;
        float core = 1.0 - smoothstep(0.3, 1.0, px);
        float halo = exp(-px * px / 4.0) * 0.1 * (1.0 - uDay);
        // What is written on the sheet (figures, rings) stays readable further out than the city does.
        float far = vGroup > 2.5 ? smoothstep(uFogNear + 44.0, uFogFar + 64.0, length(vWorld.xz)) : fogAmount(vWorld);
        vec3 color = mix(uColor, uHot, clamp(tip + scan + wave, 0.0, 1.0));
        float alpha = a * (1.0 + tip * 1.4 + scan * 1.6 + wave * 2.2) * (1.0 - far);
        float ink = min(alpha * 1.1, 1.0) * core;
        float light = alpha * alpha * (core + halo) * 0.5;
        gl_FragColor = mix(vec4(color * light, 0.0), vec4(color * ink, ink), uDay);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    ...INK,
  });
  const lines = add(new THREE.Mesh(buildLines(plan, detail), lineMat));
  lines.renderOrder = 2;

  const windowMat = new THREE.ShaderMaterial({
    uniforms: {
      ...fog,
      ...rise,
      ...lit,
      ...day,
      uGlass: { value: COLORS.glass },
      uLamp: { value: COLORS.lamp },
      uLampHot: { value: COLORS.lampHot },
    },
    vertexShader: `
      attribute float aDelay;
      attribute float aSeed;
      attribute float aDist;
      varying vec3 vWorld;
      varying vec2 vUv;
      varying float vDelay;
      varying float vSeed;
      varying float vDist;
      void main() {
        vWorld = position;
        vUv = uv;
        vDelay = aDelay;
        vSeed = aSeed;
        vDist = aDist;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      ${FOG_GLSL}
      ${RISE_GLSL}
      uniform vec3 uGlass;
      uniform vec3 uLamp;
      uniform vec3 uLampHot;
      uniform float uLights;
      uniform float uDay;
      varying vec3 vWorld;
      varying vec2 vUv;
      varying float vDelay;
      varying float vSeed;
      varying float vDist;
      void main() {
        if (vWorld.y > riseHeight(vDelay) - 0.6) discard;
        // seed 2 = never lit. Others come on in a wave from the centre outwards.
        float never = step(1.5, vSeed);
        float on = smoothstep(0.0, 0.07, uLights * 1.32 - (vDist * 0.92 + vSeed * 0.3)) * (1.0 - never);
        float soft = smoothstep(0.0, 0.16, vUv.x) * smoothstep(1.0, 0.84, vUv.x) * smoothstep(0.0, 0.2, vUv.y) * smoothstep(1.0, 0.8, vUv.y);
        vec3 glow = mix(uLamp, uLampHot, fract(vSeed * 7.31)) * (0.38 + 0.72 * fract(vSeed * 3.17));
        vec3 color = mix(uGlass, glow, on * mix(0.55, 1.0, soft) * mix(1.0, 0.5, uDay));
        gl_FragColor = vec4(withFog(color, vWorld), 1.0);
      }
    `,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  add(new THREE.Mesh(buildWindows(plan.boxes, detail), windowMat));

  const poolMat = new THREE.ShaderMaterial({
    uniforms: { ...fog, ...lit, ...day, uLamp: { value: COLORS.lamp } },
    vertexShader: `
      attribute float aDist;
      varying vec2 vUv;
      varying float vDist;
      varying vec3 vWorld;
      void main() { vUv = uv; vDist = aDist; vWorld = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: `
      ${FOG_GLSL}
      uniform vec3 uLamp;
      uniform float uLights;
      uniform float uDay;
      varying vec2 vUv;
      varying float vDist;
      varying vec3 vWorld;
      void main() {
        float on = smoothstep(0.0, 0.1, uLights * 1.25 - vDist * 0.95 - 0.12);
        float r = length(vUv);
        float pool = pow(max(1.0 - r, 0.0), 2.0) * 0.6 + pow(max(1.0 - r * 8.0, 0.0), 1.5) * 1.4;
        float alpha = pool * on * (1.0 - fogAmount(vWorld)) * (1.0 - uDay);
        gl_FragColor = vec4(uLamp * alpha, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const pools = add(new THREE.Mesh(buildPools(plan.lamps), poolMat));
  pools.renderOrder = 3;

  const carMat = new THREE.ShaderMaterial({
    uniforms: {
      ...fog,
      ...rise,
      ...lit,
      ...drive,
      ...day,
      uTints: { value: carTints },
      uGlass: { value: COLORS.glass },
      uWarm: { value: COLORS.lamp },
      uSun: { value: SUN },
      uSpan: { value: EDGE * 2 },
    },
    vertexShader: `
      attribute vec3 aLane;
      attribute vec2 aMove;
      attribute float aPart;
      uniform float uDrive;
      uniform float uSpan;
      uniform float uFill;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vTint;
      varying float vPart;
      void main() {
        float dir = sign(aMove.y);
        float along = mod(aMove.x + uDrive * aMove.y, uSpan) - uSpan * 0.5;
        // Cars arrive with the last of the surfaces.
        float grown = smoothstep(0.86, 1.0, uFill);
        vec3 l = position * vec3(grown, grown, grown);
        vec3 p = aLane.x < 0.5 ? vec3(along + l.x * dir, l.y, aLane.y + l.z) : vec3(aLane.y + l.z, l.y, along + l.x * dir);
        vNormal = aLane.x < 0.5 ? vec3(normal.x * dir, normal.y, normal.z) : vec3(normal.z, normal.y, normal.x * dir);
        vWorld = p;
        vTint = aLane.z;
        vPart = aPart;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: `
      ${FOG_GLSL}
      uniform vec3 uTints[5];
      uniform vec3 uGlass;
      uniform vec3 uWarm;
      uniform vec3 uSun;
      uniform float uLights;
      uniform float uFill;
      uniform float uDay;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vTint;
      varying float vPart;
      void main() {
        if (uFill < 0.87) discard;
        vec3 n = normalize(vNormal);
        float up = step(0.5, n.y);
        float key = max(dot(n, uSun), 0.0);
        int i = int(vTint + 0.5);
        vec3 tint = i == 0 ? uTints[0] : (i == 1 ? uTints[1] : (i == 2 ? uTints[2] : (i == 3 ? uTints[3] : uTints[4])));
        vec3 color = tint * mix(0.62, 1.0, max(key, up));
        // The cabin's sides and screens are glass; the wheels are simply dark.
        float cabin = step(0.5, vPart) * step(vPart, 1.5);
        color = mix(color, uGlass * 1.3, cabin * (1.0 - step(0.8, n.y)) * 0.85);
        color = mix(color, vec3(0.03, 0.04, 0.07), step(1.5, vPart));
        color += uWarm * uLights * 0.1 * (1.0 - uDay);
        gl_FragColor = vec4(withFog(color, vWorld), 1.0);
      }
    `,
  });
  add(new THREE.Mesh(buildCars(plan.cars), carMat));

  const trafficMat = new THREE.ShaderMaterial({
    uniforms: {
      ...fog,
      ...lit,
      ...drive,
      ...day,
      uHead: { value: COLORS.head },
      uTail: { value: COLORS.lamp },
      uSpan: { value: EDGE * 2 },
    },
    vertexShader: `
      attribute vec3 aLane;
      attribute vec2 aMove;
      attribute vec2 aCorner;
      uniform float uDrive;
      uniform float uSpan;
      varying vec2 vCorner;
      varying float vKind;
      varying vec3 vWorld;
      void main() {
        float dir = sign(aMove.y);
        float along = mod(aMove.x + uDrive * aMove.y, uSpan) - uSpan * 0.5;
        // Head ahead of the car, tail behind it.
        along += dir * (aLane.z < 0.5 ? 1.05 : -1.0);
        vec2 size = vec2(aLane.z < 0.5 ? 0.95 : 0.7, 0.36);
        vec2 off = aCorner * size;
        vec3 p = aLane.x < 0.5 ? vec3(along + off.x, 0.38, aLane.y + off.y) : vec3(aLane.y + off.y, 0.38, along + off.x);
        vCorner = aCorner;
        vKind = aLane.z;
        vWorld = p;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: `
      ${FOG_GLSL}
      uniform vec3 uHead;
      uniform vec3 uTail;
      uniform float uLights;
      uniform float uDay;
      varying vec2 vCorner;
      varying float vKind;
      varying vec3 vWorld;
      void main() {
        float spot = pow(max(1.0 - length(vCorner), 0.0), 1.6);
        float alpha = spot * smoothstep(0.55, 1.0, uLights) * (vKind < 0.5 ? 0.95 : 0.7) * (1.0 - fogAmount(vWorld));
        float ink = min(alpha * 1.4, 0.85);
        gl_FragColor = mix(vec4((vKind < 0.5 ? uHead : uTail) * alpha * alpha, 0.0), vec4(uHead * ink, ink), uDay);
      }
    `,
    transparent: true,
    depthWrite: false,
    ...INK,
  });
  const traffic = add(new THREE.Mesh(buildTraffic(plan.cars), trafficMat));
  traffic.renderOrder = 4;

  const beaconMat = new THREE.ShaderMaterial({
    uniforms: {
      ...fog,
      ...rise,
      ...lit,
      ...time,
      ...day,
      uColor: { value: COLORS.lampHot },
      uGo: { value: new THREE.Color('#7dffb8') },
      uSize: { value: 1 },
    },
    vertexShader: `
      attribute vec2 aInfo;
      uniform float uSize;
      varying vec2 vInfo;
      varying vec3 vWorld;
      void main() {
        vInfo = aInfo;
        vWorld = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float size = aInfo.y > 1.5 ? 620.0 : (aInfo.y > 0.5 ? 3600.0 : 1500.0);
        gl_PointSize = clamp(uSize * size / -mv.z, 1.0, 64.0 * uSize);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      ${FOG_GLSL}
      uniform vec3 uColor;
      uniform vec3 uGo;
      uniform float uLights;
      uniform float uFill;
      uniform float uTime;
      uniform float uDay;
      varying vec2 vInfo;
      varying vec3 vWorld;
      void main() {
        float r = length(gl_PointCoord - 0.5) * 2.0;
        float t = fract(uTime * 0.42 + vInfo.x);
        float pulse = 0.3 + 0.7 * smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.08, 0.6, t));
        float signal = step(1.5, vInfo.y);
        // Beacons blink once the city is lit; a signal is simply on as soon as its post stands.
        float on = mix(pulse * smoothstep(0.75, 1.0, uLights) * (1.0 - uDay), smoothstep(0.9, 1.0, uFill) * (0.55 + 0.45 * uLights), signal);
        float alpha = pow(max(1.0 - r, 0.0), 2.0) * on * (1.0 - fogAmount(vWorld));
        gl_FragColor = vec4(mix(uColor, uGo, signal) * alpha, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const beacons = add(new THREE.Points(buildBeacons(plan.beacons, plan.signals), beaconMat));
  beacons.renderOrder = 5;

  const starMat = new THREE.ShaderMaterial({
    uniforms: { ...time, ...day, uSize: { value: 1 } },
    vertexShader: `
      attribute float aSeed;
      uniform float uSize;
      varying float vSeed;
      void main() {
        vSeed = aSeed;
        gl_PointSize = uSize * (1.8 + aSeed * 2.8);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uDay;
      varying float vSeed;
      void main() {
        float r = length(gl_PointCoord - 0.5) * 2.0;
        float twinkle = 0.7 + 0.3 * sin(uTime * (0.6 + vSeed * 1.7) + vSeed * 40.0);
        float alpha = max(1.0 - r, 0.0) * twinkle * (0.45 + 0.55 * vSeed) * (1.0 - uDay);
        gl_FragColor = vec4(vec3(0.86, 0.9, 1.0), alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const stars = add(new THREE.Points(buildStars(), starMat));
  stars.renderOrder = -2;

  // The moon, or the sun: it waits at the far end of the avenue, and the way out drives into it.
  const orbMat = new THREE.ShaderMaterial({
    uniforms: {
      ...day,
      uMoon: { value: new THREE.Color('#dfe8ff') },
      uSunDisc: { value: new THREE.Color('#fff3d6') },
    },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform vec3 uMoon;
      uniform vec3 uSunDisc;
      uniform float uDay;
      varying vec2 vUv;
      void main() {
        float r = length(vUv) * 5.4;
        float disc = (1.0 - smoothstep(0.96, 1.02, r)) * 0.9;
        float halo = exp(-r * r * 0.55) * 0.5 + exp(-r * 0.9) * 0.22;
        vec3 color = mix(uMoon, uSunDisc, uDay);
        float alpha = clamp(disc + halo * mix(0.7, 1.3, uDay), 0.0, 1.0);
        gl_FragColor = vec4(color * alpha, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const orb = add(new THREE.Mesh(new THREE.PlaneGeometry(380, 380), orbMat));
  orb.renderOrder = -1;
  orb.visible = false;

  // What the page asks for, and what is on screen (which follows it smoothly).
  // `sheet` is the empty drawing itself (grid and survey rings): there before anything is asked for.
  const want = { sheet: 1, outline: 0, detail: 0, fill: 0, lights: 0, mute: 0 };
  const now = { sheet: 0, outline: 0, detail: 0, fill: 0, lights: 0, mute: 0 };
  let pulse = 0;
  // The ring that crosses the city once when the last light is on (-1: not running).
  let waveAt = -1;
  let waved = false;
  // The way out: a slow turn down onto the avenue, then along it, faster and faster, into the light.
  // The way out is flown: a turn onto the avenue's line, a glide down to it, and on along it without stopping.
  const APPROACH = 8.6;
  const FINAL_LENGTH = 250;
  const FINAL_HEIGHT = 40;
  const LAND = EDGE * 0.98;
  let leaving = null;
  let angle = options.angle ?? -0.62;
  let frozen = options.still === true;
  let last = performance.now();
  let clock = 0;
  let raf = 0;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let disposed = false;
  const bloom = options.bloom === false ? null : createBloom(renderer);
  // Turning the model by hand: a drag, or the arrow keys. It coasts, then the slow walk takes over.
  let spin = 0;
  let drag = null;

  function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    if (w === width && h === height) return;
    width = w;
    height = h;
    dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    if (bloom) bloom.setSize(Math.round(w * dpr), Math.round(h * dpr));
    lineMat.uniforms.uRes.value.set(w * dpr, h * dpr);
    lineMat.uniforms.uPixel.value = dpr;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function frame(t) {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    clock += dt;
    resize();

    const k = reduced ? 1 : 1 - Math.exp(-dt * 5.5);
    for (const key of Object.keys(now))
      now[key] +=
        (want[key] - now[key]) * (key === 'sheet' && !reduced ? 1 - Math.exp(-dt * 1.1) : k);
    pulse *= Math.exp(-dt * 1.6);
    if (now.lights > 0.96 && !waved && !reduced) {
      waved = true;
      waveAt = 0;
    }
    if (now.lights < 0.2) waved = false;
    if (waveAt >= 0) {
      waveAt += dt * 64;
      if (waveAt > 200) waveAt = -1;
    }
    wave.uWave.value = waveAt;
    cloud.uCloudTime.value = reduced ? 0 : clock;
    if (!drag) {
      angle += spin * dt;
      spin *= Math.exp(-dt * 2.4);
      // The slow walk comes back as the push dies away.
      if (!frozen && !reduced) angle += dt * 0.021 * (1 - clamp01(Math.abs(spin) * 4));
    }
    time.uTime.value = reduced ? 0 : clock;
    if (themeNow !== themeWant) {
      themeNow += (themeWant - themeNow) * (reduced ? 1 : 1 - Math.exp(-dt * 2.4));
      if (Math.abs(themeWant - themeNow) < 0.003) themeNow = themeWant;
      applyTheme();
    }
    if (!reduced) drive.uDrive.value += dt * ease(clamp01((now.lights - 0.35) / 0.5));

    const outline = ease(clamp01(now.outline));
    const detailP = clamp01(now.detail);
    const fill = clamp01(now.fill);
    const lights = clamp01(now.lights);
    const mute = clamp01(now.mute);
    const dim = 1 - mute * 0.5;

    // Lines: bright while they are the picture, then only the edges of the model.
    const filled = ease(clamp01(fill * 1.25));
    const sheet = clamp01(now.sheet);
    lineMat.uniforms.uProgress.value.set(outline, detailP, sheet, sheet);
    lineMat.uniforms.uAlpha.value.set(
      (0.92 - 0.14 * detailP - 0.36 * filled) * dim,
      (0.5 - 0.37 * filled) * dim,
      (0.42 - 0.25 * outline - 0.12 * filled) * dim * (1 + pulse * 1.2),
      (0.85 - 0.3 * outline - 0.1 * detailP - 0.28 * filled) * dim * (1 + pulse * 1.0)
    );
    // A slow pass of light over the plan while detail is still being added: never a still picture.
    // Over the empty sheet too, more faintly: the table is waiting, not switched off.
    const scanning = Math.max(clamp01(now.detail * 4) * (1 - filled), (1 - outline) * sheet * 0.5);
    lineMat.uniforms.uScan.value = ((clock * 16) % 420) - 210;
    lineMat.uniforms.uScanAmount.value = reduced || frozen ? 0 : scanning * 0.55;

    rise.uFill.value = fill;
    lit.uLights.value = lights;
    beaconMat.uniforms.uSize.value = dpr;
    starMat.uniforms.uSize.value = dpr;

    const sky = fog.uFogColor.value
      .copy(COLORS.night)
      .lerp(COLORS.dusk, ease(lights) * 0.9 + filled * 0.1);
    sky.multiplyScalar(1 - mute * 0.35);
    renderer.setClearColor(sky, 1);

    // Camera: a slow walk around the model, a little closer at every stage.
    const aspect = width / Math.max(1, height);
    const reach = aspect < 1 ? 1 + (1 - aspect) * 0.95 : 1;
    const progress = (outline + detailP + fill + lights) / 4;
    const baseDist = (396 - progress * 40) * reach;
    const basePitch = THREE.MathUtils.degToRad(27);
    const baseY = 16 + progress * 12;
    const lift = options.lift ?? 0.045;
    let offset = lift;
    let fov = 23;
    if (leaving === null) {
      camera.position.set(
        Math.sin(angle) * Math.cos(basePitch) * baseDist,
        baseY + Math.sin(basePitch) * baseDist,
        Math.cos(angle) * Math.cos(basePitch) * baseDist
      );
      camera.lookAt(0, baseY, 0);
    } else {
      if (leaving.at === null) {
        // Round the city once more, the way it was already going, coming down all the while; the
        // turn runs out as the avenue's line is reached, so the last of the descent is straight
        // down that line, onto it, and on along it. One curve, no corner in it.
        const a1 = Math.ceil((angle + 1.3) / Math.PI) * Math.PI;
        const side = Math.cos(a1) > 0 ? 1 : -1;
        const r0 = Math.cos(basePitch) * baseDist;
        const y0 = baseY + Math.sin(basePitch) * baseDist;
        const touch = LAND * 0.72;
        const pts = [];
        const n = 220;
        for (let k = 0; k < n; k++) {
          const u = k / n;
          // The turn slows evenly to nothing while the way in quickens evenly from nothing: the nose
          // comes round to the avenue a little at a time, never all at once.
          const turned = clamp01(u / 0.86);
          const a = angle + (a1 - angle) * (1 - (1 - turned) * (1 - turned));
          const r = r0 + (touch - r0) * (0.4 * u + 0.6 * u * u);
          pts.push([Math.sin(a) * r, 2.4 + (y0 - 2.4) * Math.pow(1 - u, 1.9), Math.cos(a) * r]);
        }
        // On along the avenue and past its far end: the picture is all light before the ground runs out.
        for (let k = 0; k <= 60; k++) {
          const out = touch + (-LAND * 6 - touch) * (k / 60);
          pts.push([Math.sin(a1) * out, 2.4 - 0.4 * Math.min(1, k / 10), Math.cos(a1) * out]);
        }
        const run = [0];
        for (let k = 1; k < pts.length; k++)
          run.push(
            run[k - 1] +
              Math.hypot(
                pts[k][0] - pts[k - 1][0],
                pts[k][1] - pts[k - 1][1],
                pts[k][2] - pts[k - 1][2]
              )
          );
        leaving.at = clock;
        leaving.pts = pts;
        leaving.run = run;
        leaving.total = run[run.length - 1];
        leaving.ground = run[n];
        leaving.avenueEnd = leaving.ground + touch + LAND;
        // About the same time down whether the turn left to fly was a half or nearly a whole one.
        leaving.cruise = Math.max(100, Math.min(235, leaving.ground / 5.6));
        leaving.d = 0;
        leaving.look0 = baseY;
        orb.position.set(0, 62, -side * 1020);
        orb.visible = true;
      }
      const { pts, run } = leaving;
      const at = (d) => {
        const dd = Math.max(0, Math.min(leaving.total, d));
        let lo = 0;
        let hi = run.length - 1;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (run[mid] <= dd) lo = mid;
          else hi = mid;
        }
        const span = run[hi] - run[lo] || 1;
        const k = (dd - run[lo]) / span;
        return [0, 1, 2].map((c) => pts[lo][c] + (pts[hi][c] - pts[lo][c]) * k);
      };
      // One speed, gathered smoothly out of the slow walk and held all the way down: it never
      // slows for the landing. On the ground it opens up, a little at a time.
      const t = clock - leaving.at;
      const onGround = clamp01((leaving.d - leaving.ground) / 140);
      const speed =
        leaving.cruise * (0.05 + 0.95 * ease(clamp01(t / 2.2))) * (1 + 0.5 * onGround * onGround);
      leaving.d = Math.min(leaving.total, leaving.d + speed * dt);
      const here = at(leaving.d);
      const from = at(leaving.d - 3);
      const to = at(leaving.d + 3);
      let dx = to[0] - from[0];
      let dy = to[1] - from[1];
      let dz = to[2] - from[2];
      const len = Math.hypot(dx, dy, dz) || 1;
      dx /= len;
      dy /= len;
      dz /= len;
      // The eye stays on the city all the way round, and comes up to the way ahead only at the end,
      // when the way ahead is the city.
      const down = clamp01(leaving.d / leaving.ground);
      const forward = ease(clamp01((down - 0.62) / 0.38));
      const lead = 110;
      const over = Math.max(0, leaving.d + lead - leaving.total);
      const spot = at(leaving.d + lead);
      const aim = [
        spot[0] + dx * over,
        spot[1] + dy * over + 2.6 * ease(onGround),
        spot[2] + dz * over,
      ];
      camera.up.set(0, 1, 0);
      camera.position.set(here[0], here[1], here[2]);
      camera.lookAt(
        aim[0] * forward,
        (leaving.look0 * (1 - down) + 3.4 * down) * (1 - forward) + aim[1] * forward,
        aim[2] * forward
      );
      fov = 23 + 25 * ease(clamp01((down - 0.45) / 0.6));
      offset = lift * (1 - ease(clamp01(down / 0.5)));
      // The light begins a third of the way along the avenue and is complete before its end.
      if (
        !leaving.flashed &&
        leaving.d > leaving.ground + (leaving.avenueEnd - leaving.ground) * 0.3
      ) {
        leaving.flashed = true;
        if (leaving.onFlash) leaving.onFlash();
      }
      if (!leaving.done && leaving.d >= leaving.total - 1) {
        leaving.done = true;
        if (leaving.onDone) leaving.onDone();
      }
    }
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    camera.setViewOffset(width, height, 0, Math.round(height * offset), width, height);
    // From out on the approach the whole city has to be there to fly at.
    const away = leaving && leaving.at !== null ? ease(clamp01((clock - leaving.at) / 2.5)) : 0;
    fog.uFogNear.value = 46 + progress * 8 + away * 20;
    fog.uFogFar.value = 100 + progress * 12 + away * 34;

    if (bloom) {
      // By night the windows, the lamps and the pen bleed a little; by day almost nothing does.
      const strength = (0.3 + 0.55 * lights) * (1 - themeNow) + 0.1 * themeNow;
      bloom.render(scene, camera, strength * (1 - mute * 0.5), 0.62 + 0.3 * themeNow);
    } else {
      renderer.render(scene, camera);
    }
  }

  function onPointerDown(event) {
    if (leaving !== null || (event.pointerType === 'mouse' && event.button !== 0)) return;
    drag = { id: event.pointerId, x: event.clientX, at: performance.now() };
    spin = 0;
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('turning');
  }
  function onPointerMove(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const at = performance.now();
    const turn = (-(event.clientX - drag.x) / Math.max(1, width)) * 2.6;
    angle += turn;
    spin = turn / Math.max(0.008, (at - drag.at) / 1000);
    drag.x = event.clientX;
    drag.at = at;
  }
  function onPointerUp(event) {
    if (!drag || event.pointerId !== drag.id) return;
    // A finger that stopped before lifting leaves the model where it is.
    if (performance.now() - drag.at > 120) spin = 0;
    spin = Math.max(-3, Math.min(3, spin));
    drag = null;
    canvas.classList.remove('turning');
  }
  function onKey(event) {
    if (leaving !== null || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowLeft') spin = Math.min(spin, 0) - 0.5;
    else if (event.key === 'ArrowRight') spin = Math.max(spin, 0) + 0.5;
  }
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('keydown', onKey);

  function onVisibility() {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
    } else if (!raf && !disposed) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  }
  document.addEventListener('visibilitychange', onVisibility);
  raf = requestAnimationFrame(frame);

  return {
    /** stage 1 plan, 2 detail, 3 surfaces, 4 lights; progress 0..1 inside the stage. */
    setStage(stage, progress) {
      const p = clamp01(progress);
      want.outline = stage > 1 ? 1 : stage === 1 ? p : 0;
      want.detail = stage > 2 ? 1 : stage === 2 ? p : 0;
      want.fill = stage > 3 ? 1 : stage === 3 ? p : 0;
      want.lights = stage > 4 ? 1 : stage === 4 ? p : 0;
    },
    /** Jump without easing (first paint, reduced motion, screenshots). */
    snap() {
      for (const key of Object.keys(now)) now[key] = want[key];
    },
    /** 'day' or 'night'; the picture crosses over unless `instant`. */
    setTheme(name, instant) {
      themeWant = name === 'day' ? 1 : 0;
      if (instant) {
        themeNow = themeWant;
        applyTheme();
      }
    },
    /** A short brightening of the sheet: the moment the request is made. */
    pulse() {
      pulse = 1;
    },
    setMuted(muted) {
      want.mute = muted ? 1 : 0;
    },
    /** Starts the way out. `onFlash` when the picture should start to brighten, `onDone` at the end. */
    leave(callbacks = {}) {
      if (leaving === null) leaving = { at: null, flashed: false, done: false, ...callbacks };
    },
    leaveSeconds: 9,
    freeze(value) {
      frozen = value;
    },
    counts() {
      return {
        boxes: plan.boxes.length,
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        lines: renderer.info.render.lines,
      };
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('keydown', onKey);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      if (bloom) bloom.dispose();
      for (const mesh of meshes) {
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
      renderer.dispose();
    },
  };
}
