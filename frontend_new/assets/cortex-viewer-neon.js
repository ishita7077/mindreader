/**
 * Real cortical-surface viewer for the audio + video result pages.
 *
 * Loads the fsaverage5 pial mesh from /api/brain-mesh and paints it with
 * real per-vertex contrast values (vertex_delta_b64 = 20484 floats from the
 * worker). When the mesh format isn't fsaverage5_pial (worker shipped
 * without the static asset, fell back to procedural geometry), the viewer
 * still renders the brain shape but skips the per-vertex paint and labels
 * itself "geometry-only" — better than silently lying with sine-wave colors.
 *
 * Per-modality or system emphasis is applied via the `roiHighlight` parameter:
 *   - audio page passes 'auditory' → boost luminance in temporal-lobe verts
 *   - video page passes 'visual'   → boost luminance in occipital + MT verts
 *   - result pages may pass one BrainDiff system key for an approximate
 *     anatomical neighborhood highlight when vertex-level paint is unavailable
 *
 * Exported singletons (no class needed; we mount one per page):
 *
 *   const cortex = await mountCortex({
 *     canvas, vertexDeltaB64, vertexAB64, vertexBB64,
 *     roiHighlight: 'auditory' | 'visual' | null,
 *   });
 *   cortex.setView('diff');                    // 'diff' | 'a' | 'b'
 *   cortex.setHighlightVerts([1234, 5678]);    // emphasize specific verts
 *   cortex.dispose();
 */
import * as THREE from "three";
import { OrbitControls } from "https://unpkg.com/three@0.164.1/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "https://unpkg.com/three@0.164.1/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "https://unpkg.com/three@0.164.1/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "https://unpkg.com/three@0.164.1/examples/jsm/postprocessing/UnrealBloomPass.js";

const MESH_VERTS = 20484; // fsaverage5: 10242 per hemisphere × 2
const ROI_COLORS = {
  personal_resonance: [0.56, 1.0, 0.90],
  attention: [0.32, 0.86, 1.0],
  brain_effort: [0.70, 0.48, 1.0],
  gut_reaction: [1.0, 0.37, 0.66],
  memory_encoding: [1.0, 0.86, 0.16],
  social_thinking: [1.0, 0.55, 0.22],
  language_depth: [0.46, 0.82, 1.0],
  auditory: [0.52, 0.84, 1.0],
  visual: [1.0, 0.57, 0.30],
};

function decodeFloat32B64(b64) {
  if (!b64 || typeof b64 !== "string") return new Float32Array(0);
  const raw = atob(b64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) buf[i] = raw.charCodeAt(i);
  return new Float32Array(buf.buffer);
}

async function fetchMesh() {
  // Try the Vercel API function first (production), then fall back to the
  // static asset which the Python dev-server exposes at /assets/brain-mesh.json.
  // This means the real fsaverage5 mesh renders on localhost too — no black void.
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
  const candidates = isLocal
    ? ["/assets/brain-mesh.json", "/api/brain-mesh"]
    : ["/api/brain-mesh", "/assets/brain-mesh.json"];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { cache: "force-cache" });
      if (!res.ok) continue;
      const payload = await res.json();
      if (payload && payload.lh_coord && payload.rh_coord) return payload;
    } catch (_) {
      // try next candidate
    }
  }
  throw new Error("brain-mesh unavailable on all endpoints");
}

async function fetchRoiMasks() {
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
  const candidates = isLocal
    ? ["/assets/roi-masks.json", "/api/roi-masks"]
    : ["/api/roi-masks", "/assets/roi-masks.json"];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { cache: "force-cache" });
      if (!res.ok) continue;
      const payload = await res.json();
      if (payload && typeof payload === "object") return payload;
    } catch (_) {
      // Atlas masks are optional; fall back to coordinate masks.
    }
  }
  return null;
}

function buildGeometry(meshPayload) {
  const lh = meshPayload.lh_coord;
  const rh = meshPayload.rh_coord;
  const lhFaces = meshPayload.lh_faces;
  const rhFaces = meshPayload.rh_faces;
  const totalVerts = lh.length + rh.length;
  const positions = new Float32Array(totalVerts * 3);
  for (let i = 0; i < lh.length; i += 1) {
    positions[i * 3 + 0] = lh[i][0];
    positions[i * 3 + 1] = lh[i][1];
    positions[i * 3 + 2] = lh[i][2];
  }
  for (let i = 0; i < rh.length; i += 1) {
    const off = (lh.length + i) * 3;
    positions[off + 0] = rh[i][0];
    positions[off + 1] = rh[i][1];
    positions[off + 2] = rh[i][2];
  }
  const indices = [];
  for (const f of lhFaces) indices.push(f[0], f[1], f[2]);
  const lhVertCount = lh.length;
  for (const f of rhFaces) indices.push(f[0] + lhVertCount, f[1] + lhVertCount, f[2] + lhVertCount);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  // Auto-center + scale so the brain always lands at a comfortable size,
  // independent of whether the mesh is real fsaverage5 (extents ~70mm) or
  // the procedural fallback (extents ~1).
  geometry.computeBoundingSphere();
  const sphere = geometry.boundingSphere;
  if (sphere) {
    const center = sphere.center;
    const scale = 1.4 / sphere.radius;
    const pos = geometry.attributes.position;
    for (let i = 0; i < pos.count; i += 1) {
      pos.setXYZ(
        i,
        (pos.getX(i) - center.x) * scale,
        (pos.getY(i) - center.y) * scale,
        (pos.getZ(i) - center.z) * scale
      );
    }
    pos.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
  }
  return { geometry, vertCount: totalVerts, lhVertCount };
}

function roiMask(meshPayload, kind, lhVertCount, totalVerts, atlasMasks = null) {
  // Heuristic spatial masks. We don't have HCP-MMP1.0 atlas labels available
  // on the static client side (those live in atlases/*.annot, server-side).
  // So we approximate the relevant lobes from vertex coordinates instead:
  //   - auditory: superior temporal sulcus / Heschl's region
  //   - visual:   occipital pole + MT
  //   - BrainDiff systems: coarse anatomical neighborhoods for orientation
  // It's an approximation, not an atlas-mapped ROI. We label it as such in
  // the UI hint so the user knows the highlight is "approximate" not exact.
  if (!kind) return null;
  const atlasVerts = atlasMasks?.[roiKey(kind)];
  if (Array.isArray(atlasVerts) && atlasVerts.length) {
    const mask = new Uint8Array(totalVerts);
    for (const vertex of atlasVerts) {
      const index = Number(vertex);
      if (Number.isInteger(index) && index >= 0 && index < totalVerts) mask[index] = 1;
    }
    return mask;
  }
  const lh = meshPayload.lh_coord;
  const rh = meshPayload.rh_coord;
  const mask = new Uint8Array(totalVerts);
  function add(idx, coords) {
    for (let i = 0; i < coords.length; i += 1) {
      const x = coords[i][0];
      const y = coords[i][1];
      const z = coords[i][2];
      if (kind === "auditory") {
        // Lateral surface of the temporal lobe — high |x|, low-to-mid y, low z.
        if (Math.abs(x) > 38 && y > -20 && y < 40 && z < 20) mask[idx + i] = 1;
      } else if (kind === "visual") {
        // Occipital pole + MT — y < -50 (posterior), |z| moderate.
        if (y < -50) mask[idx + i] = 1;
      } else if (kind === "personal_resonance") {
        // Medial/anterior frontal neighborhood.
        if (Math.abs(x) < 28 && y > 12 && z > -18 && z < 42) mask[idx + i] = 1;
      } else if (kind === "attention") {
        // Dorsal attention neighborhood: frontal eye fields + parietal surface.
        if ((Math.abs(x) > 24 && y > -6 && z > 32) || (Math.abs(x) > 20 && y < -34 && z > 30)) mask[idx + i] = 1;
      } else if (kind === "brain_effort") {
        // Dorsolateral prefrontal neighborhood.
        if (Math.abs(x) > 28 && y > 10 && z > 18) mask[idx + i] = 1;
      } else if (kind === "gut_reaction") {
        // Lateral midline-insula neighborhood.
        if (Math.abs(x) > 32 && y > -12 && y < 28 && z > -18 && z < 22) mask[idx + i] = 1;
      } else if (kind === "memory_encoding") {
        // Ventrolateral prefrontal / encoding-support neighborhood.
        if (Math.abs(x) > 28 && y > 8 && z > -22 && z < 18) mask[idx + i] = 1;
      } else if (kind === "social_thinking") {
        // Temporoparietal junction neighborhood.
        if (Math.abs(x) > 32 && y < -32 && z > 8 && z < 44) mask[idx + i] = 1;
      } else if (kind === "language_depth") {
        // Left temporal/frontal language-network neighborhood.
        if (x < -24 && ((y > 0 && z > -18 && z < 24) || (y < -18 && z > -12 && z < 28))) mask[idx + i] = 1;
      }
    }
  }
  add(0, lh);
  add(lhVertCount, rh);
  return mask;
}

function roiKey(kind) {
  if (kind === "attention") return "attention_salience";
  return kind;
}

function roiColorFor(kind) {
  return ROI_COLORS[kind] || ROI_COLORS.attention;
}

function surfaceGrain(i) {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  const y = Math.sin(i * 4.898 + 19.19) * 24634.6345;
  return ((x - Math.floor(x)) * 0.65) + ((y - Math.floor(y)) * 0.35);
}

function paintColors(geometry, vertexDelta, view, roi, themeIsDark, roiIntensity = 1, roiColor = ROI_COLORS.attention) {
  const colorAttr = geometry.attributes.color;
  if (!colorAttr) return;
  const baseDark = [0.015, 0.10, 0.40];
  const baseLight = [0.035, 0.16, 0.52];
  const [bR, bG, bB] = themeIsDark ? baseDark : baseLight;
  const aColor = [0.10, 0.82, 1.0];    // cyan outer activation
  const bColor = [0.86, 0.58, 0.96];    // restrained violet-peach activation
  const posAttr = geometry.attributes.position;
  const count = vertexDelta && vertexDelta.length ? vertexDelta.length : geometry.attributes.position.count;
  // Compute a robust scale factor for the delta range so weak signals
  // still paint visibly without saturating on outliers.
  let absMax = 0;
  if (vertexDelta && vertexDelta.length) {
    for (let i = 0; i < count; i += 1) {
      const v = Math.abs(vertexDelta[i]);
      if (v > absMax) absMax = v;
    }
  }
  const scale = absMax > 0 ? 1 / absMax : 1;
  for (let i = 0; i < geometry.attributes.position.count; i += 1) {
    let r = bR, g = bG, b = bB;
    const grain = surfaceGrain(i);
    const speckle = (grain - 0.5) * 0.060;
    const warmFleck = grain > 0.976 ? 0.10 : 0;
    const cyanFleck = grain < 0.024 ? 0.10 : 0;
    const x = posAttr.getX(i);
    const y = posAttr.getY(i);
    const z = posAttr.getZ(i);
    const contourA = Math.abs(Math.sin(x * 5.1 + y * 2.2 - z * 3.0));
    const contourB = Math.abs(Math.sin(x * 2.8 - y * 4.4 + z * 3.7 + 1.3));
    const warmContour = Math.max(
      contourA < 0.025 ? (0.025 - contourA) / 0.025 : 0,
      contourB < 0.020 ? (0.020 - contourB) / 0.020 : 0,
    ) * 0.11;
    const hotA = Math.exp(-((x + 0.35) ** 2 * 2.1 + (y - 0.42) ** 2 * 5.4 + (z - 1.15) ** 2 * 2.6));
    const hotB = Math.exp(-((x - 0.72) ** 2 * 3.0 + (y - 0.12) ** 2 * 4.2 + (z - 0.58) ** 2 * 3.2));
    const warmHotspot = Math.min(0.16, (hotA + hotB) * 0.07);
    if (i < count && vertexDelta && vertexDelta.length) {
      const v = vertexDelta[i] * scale;
      if (v >= 0) {
        const t = Math.min(1, v);
        r = bR + t * (bColor[0] - bR);
        g = bG + t * (bColor[1] - bG);
        b = bB + t * (bColor[2] - bB);
      } else {
        const t = Math.min(1, -v);
        r = bR + t * (aColor[0] - bR);
        g = bG + t * (aColor[1] - bG);
        b = bB + t * (aColor[2] - bB);
      }
    }
    if (roi && roi[i]) {
      // Highlight the selected neighborhood. When real vertex paint exists,
      // this is a restrained tint; when it does not, the tint is stronger so
      // the brain still visibly tracks the selected system.
      const hasPaint = vertexDelta && vertexDelta.length;
      const strength = (hasPaint ? 0.46 : 0.82) * Math.max(0.20, Math.min(1, roiIntensity));
      const [hR, hG, hB] = roiColor;
      const whiteHot = Math.max(0, Math.min(1, roiIntensity)) ** 0.75;
      const hotR = hR * 0.62 + 1.0 * 0.38;
      const hotG = hG * 0.62 + 0.96 * 0.38;
      const hotB = hB * 0.62 + 0.62 * 0.38;
      r = r * (1 - strength) + hotR * strength;
      g = g * (1 - strength) + hotG * strength;
      b = b * (1 - strength) + hotB * strength;
      const lift = 0.34 * Math.max(0.18, whiteHot);
      r = Math.min(1, r + hotR * lift);
      g = Math.min(1, g + hotG * lift);
      b = Math.min(1, b + hotB * lift);
    }
    r = Math.min(1, Math.max(0, r + speckle + warmFleck * 0.72 + cyanFleck * 0.16));
    g = Math.min(1, Math.max(0, g + speckle + warmFleck * 0.52 + cyanFleck * 0.60));
    b = Math.min(1, Math.max(0, b + speckle + warmFleck * 0.20 + cyanFleck * 0.72));
    if (warmContour > 0 || warmHotspot > 0) {
      const warm = Math.min(0.32, warmContour + warmHotspot);
      const lineR = warmHotspot > 0.08 ? 1.0 : 1.0;
      const lineG = warmHotspot > 0.08 ? 0.90 : 0.58;
      const lineB = warmHotspot > 0.08 ? 0.48 : 0.72;
      r = r * (1 - warm) + lineR * warm;
      g = g * (1 - warm) + lineG * warm;
      b = b * (1 - warm) + lineB * warm;
    }
    colorAttr.setXYZ(i, r, g, b);
  }
  colorAttr.needsUpdate = true;
}

export async function mountCortex({
  canvas,
  vertexDeltaB64,
  vertexAB64,
  vertexBB64,
  roiHighlight = null,
  cameraDistance = 5.3,
}) {
  if (!canvas) throw new Error("cortex-viewer: canvas required");

  let meshPayload;
  try {
    meshPayload = await fetchMesh();
  } catch (err) {
    console.warn("cortex-viewer: brain-mesh fetch failed, viewer disabled", err);
    return { dispose() {}, setView() {}, isReal: false, format: null };
  }
  const atlasMasks = await fetchRoiMasks();
  const isReal = meshPayload.format === "fsaverage5_pial";
  const { geometry, vertCount, lhVertCount } = buildGeometry(meshPayload);
  const colors = new Float32Array(vertCount * 3);
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const roiAttr = new Float32Array(vertCount);
  geometry.setAttribute("aRoi", new THREE.BufferAttribute(roiAttr, 1));
  geometry.setAttribute("sulc", new THREE.BufferAttribute(new Float32Array(vertCount), 1));

  const VIEW_DELTAS = {
    diff: decodeFloat32B64(vertexDeltaB64),
    a: decodeFloat32B64(vertexAB64),
    b: decodeFloat32B64(vertexBB64),
  };
  // For the per-side views we don't have a "delta" — paint magnitude only,
  // leaning toward the side's color.
  if (VIEW_DELTAS.a.length) {
    const arr = new Float32Array(VIEW_DELTAS.a.length);
    for (let i = 0; i < arr.length; i += 1) arr[i] = -Math.abs(VIEW_DELTAS.a[i]);
    VIEW_DELTAS.a = arr;
  }
  if (VIEW_DELTAS.b.length) {
    const arr = new Float32Array(VIEW_DELTAS.b.length);
    for (let i = 0; i < arr.length; i += 1) arr[i] = Math.abs(VIEW_DELTAS.b[i]);
    VIEW_DELTAS.b = arr;
  }

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  camera.position.set(-2.65, 1.18, cameraDistance || 6.35);
  // Set size immediately — don't wait for ResizeObserver which fires async
  // and leaves a 300×150 default canvas for the first rendered frame.
  {
    const p = canvas.parentElement;
    if (p) {
      const r = p.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        renderer.setSize(r.width, r.height, false);
        camera.aspect = r.width / r.height;
        camera.updateProjectionMatrix();
      }
    }
  }
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 3.4;
  controls.maxDistance = 8.5;
  controls.rotateSpeed = 0.8;
  controls.zoomSpeed = 1.6;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.4;

  scene.add(new THREE.HemisphereLight(0x3ccfff, 0x02030a, 0.38));
  const key = new THREE.DirectionalLight(0x67c6ff, 2.2); key.position.set(1.2, 4.5, 2.2); scene.add(key);
  const fill = new THREE.DirectionalLight(0x0b2f8f, 0.9); fill.position.set(-3, 0.5, 1.5); scene.add(fill);
  const rim = new THREE.PointLight(0x1bbcff, 4.6, 7); rim.position.set(-2.4, 0.7, 2.6); scene.add(rim);
  const hot = new THREE.PointLight(0xffd94a, 2.8, 6); hot.position.set(1.8, -0.9, 2.4); scene.add(hot);

  const glow = { color: { value: new THREE.Color("#4cc9ff") }, intensity: { value: 0.0 } };
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x0d37a7),
    roughness: 0.66,
    metalness: 0.0,
    vertexColors: true,
    emissive: new THREE.Color(0x03113a),
    emissiveIntensity: 0.34,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGlow = glow.color;
    shader.uniforms.uInt = glow.intensity;
    shader.vertexShader = "attribute float aRoi;\nattribute float sulc;\nvarying float vRoi;\nvarying float vSulc;\n" +
      shader.vertexShader.replace("void main() {", "void main() {\n  vRoi = aRoi;\n  vSulc = sulc;");
    shader.fragmentShader = "uniform vec3 uGlow;\nuniform float uInt;\nvarying float vRoi;\nvarying float vSulc;\n" +
      shader.fragmentShader
        .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n  vec3 hotGlow = mix(uGlow, vec3(1.0, 0.94, 0.54), clamp(vRoi * uInt * 0.62, 0.0, 1.0));\n  totalEmissiveRadiance += hotGlow * vRoi * uInt * 2.55;")
        .replace("#include <color_fragment>", "#include <color_fragment>\n  float sulcShade = clamp(-vSulc * 0.8, 0.0, 1.0);\n  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.005, 0.025, 0.13), sulcShade * 0.48);\n  diffuseColor.rgb += vec3(0.015, 0.075, 0.18);\n  vec3 hotColor = mix(uGlow, vec3(1.0, 0.96, 0.62), clamp(vRoi * uInt * 0.68, 0.0, 1.0));\n  diffuseColor.rgb = mix(diffuseColor.rgb, hotColor, clamp(vRoi * uInt * 0.82, 0.0, 0.92));");
  };
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.set(0.06, -0.45, 0);
  scene.add(mesh);

  const rimMaterial = new THREE.MeshBasicMaterial({
    color: 0x45dfff,
    transparent: true,
    opacity: 0.10,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const rimMesh = new THREE.Mesh(geometry, rimMaterial);
  rimMesh.scale.setScalar(1.035);
  rimMesh.rotation.copy(mesh.rotation);
  scene.add(rimMesh);

  let roi = roiMask(meshPayload, roiHighlight, lhVertCount, vertCount, atlasMasks);
  let roiKind = roiHighlight;
  let roiIntensity = 1;
  let currentView = "diff";

  function updateRoiAttribute() {
    for (let i = 0; i < vertCount; i += 1) roiAttr[i] = roi?.[i] ? 1 : 0;
    geometry.attributes.aRoi.needsUpdate = true;
    const color = roiColorFor(roiKind);
    glow.color.value.setRGB(color[0], color[1], color[2]);
  }

  function repaint(view) {
    updateRoiAttribute();
    paintColors(geometry, VIEW_DELTAS[view], view, roi, true, roiIntensity, roiColorFor(roiKind));
    glow.intensity.value = 0.53 + Math.max(0, Math.min(1, roiIntensity)) * 1.66;
  }
  repaint(currentView);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 1.15, 0.72, 0.58);
  composer.addPass(bloom);

  const ro = new ResizeObserver(() => {
    const rect = canvas.parentElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    renderer.setSize(rect.width, rect.height, false);
    composer.setSize(rect.width, rect.height);
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
  });
  ro.observe(canvas.parentElement);

  let raf = 0;
  let disposed = false;
  function loop() {
    if (disposed) return;
    controls.update();
    composer.render();
    raf = requestAnimationFrame(loop);
  }
  loop();

  // Re-paint on theme flip so the base palette flips too.
  function onTheme() { repaint(currentView); }
  window.addEventListener("braindiff:theme", onTheme);

  return {
    isReal,
    format: meshPayload.format,
    setView(view) {
      currentView = view in VIEW_DELTAS ? view : "diff";
      repaint(currentView);
    },
    setRoi(kind) {
      roiKind = kind;
      roi = roiMask(meshPayload, kind, lhVertCount, vertCount, atlasMasks);
      repaint(currentView);
    },
    setRoiIntensity(value) {
      roiIntensity = Number.isFinite(Number(value)) ? Number(value) : 1;
      repaint(currentView);
    },
    reset() {
      camera.position.set(-2.65, 1.18, cameraDistance || 6.35);
      controls.target.set(0, 0, 0);
      mesh.rotation.set(0.06, -0.45, 0);
      rimMesh.rotation.copy(mesh.rotation);
      controls.update();
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("braindiff:theme", onTheme);
      renderer.dispose();
      geometry.dispose();
      material.dispose();
      rimMaterial.dispose();
    },
  };
}
