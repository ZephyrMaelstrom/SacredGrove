/**
 * Sky, sun and weather visuals (M4).
 *
 * A gradient sky dome (horizon → zenith, a sun glow, stars at night) and the
 * scene lights follow the real sun position for the date and time, softened
 * by cloud cover. Rain and snow are particle curtains that travel with the
 * player; storms add wind and the odd lightning flash; fog thickens the air.
 */
import {
  Color3,
  Color4,
  DirectionalLight,
  DynamicTexture,
  Effect,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  ParticleSystem,
  Scene,
  ShaderMaterial,
  ShadowGenerator,
  Vector3,
} from "@babylonjs/core";
import { sunVector } from "../time/sun";
import { isFoggy, isPrecipitating, type DayWeather } from "../time/climate";
import { WindPlugin } from "../veg/wind";

type RGB = [number, number, number];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const smooth = (e0: number, e1: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const c3 = (c: RGB) => new Color3(c[0], c[1], c[2]);

Effect.ShadersStore["skyVertexShader"] = `
precision highp float;
attribute vec3 position;
uniform mat4 worldViewProjection;
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}`;

Effect.ShadersStore["skyFragmentShader"] = `
precision highp float;
varying vec3 vDir;
uniform vec3 horizon;
uniform vec3 zenith;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform float glow;
uniform float stars;
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, -0.2, 1.0);
  vec3 col = mix(horizon, zenith, pow(max(h, 0.0), 0.55));
  if (d.y < 0.0) col = horizon * 0.85;
  float s = max(dot(d, normalize(sunDir)), 0.0);
  col += sunColor * (pow(s, 600.0) * 4.0 * glow + pow(s, 12.0) * 0.35 * glow);
  if (stars > 0.0 && d.y > 0.05) {
    vec3 cell = floor(d * 700.0);
    float r = hash(cell);
    col += vec3(step(0.9992, r) * stars * (0.5 + 0.5 * hash(cell + 3.0)));
  }
  gl_FragColor = vec4(col, 1.0);
}`;

export interface Environment {
  doy: number;
  minutes: number;
  weather: DayWeather;
}

export interface Sky {
  sun: DirectionalLight;
  hemi: HemisphericLight;
  shadows: ShadowGenerator;
  /** Call every frame (cheap). */
  update(env: Environment, cameraPos: Vector3, dt: number): void;
  /** 0 night – 1 full day, for anything else that cares. */
  daylight(): number;
}

function dropTexture(scene: Scene, name: string, streak: boolean) {
  const t = new DynamicTexture(name, { width: 32, height: 32 }, scene, false);
  const ctx = t.getContext() as CanvasRenderingContext2D;
  const g = streak ? ctx.createLinearGradient(16, 0, 16, 32) : ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.5, "rgba(255,255,255,0.9)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  t.hasAlpha = true;
  t.update();
  return t;
}

function precipitation(scene: Scene, snow: boolean) {
  const ps = new ParticleSystem(snow ? "snow" : "rain", snow ? 3000 : 4000, scene);
  ps.particleTexture = dropTexture(scene, snow ? "snowTex" : "rainTex", !snow);
  ps.emitter = new Vector3(0, 0, 0);
  ps.minEmitBox = new Vector3(-14, 8, -14);
  ps.maxEmitBox = new Vector3(14, 12, 14);
  if (snow) {
    ps.minSize = 0.03; ps.maxSize = 0.07;
    ps.minLifeTime = 6; ps.maxLifeTime = 9;
    ps.direction1 = new Vector3(-0.3, -1, -0.3);
    ps.direction2 = new Vector3(0.3, -1, 0.3);
    ps.minEmitPower = 1.2; ps.maxEmitPower = 1.8;
    ps.color1 = new Color4(1, 1, 1, 0.9);
    ps.color2 = new Color4(0.92, 0.95, 1, 0.8);
  } else {
    ps.billboardMode = ParticleSystem.BILLBOARDMODE_STRETCHED;
    ps.minSize = 0.012; ps.maxSize = 0.02;
    ps.minScaleY = 12; ps.maxScaleY = 18;
    ps.minLifeTime = 1.1; ps.maxLifeTime = 1.4;
    ps.direction1 = new Vector3(0, -1, 0);
    ps.direction2 = new Vector3(0, -1, 0);
    ps.minEmitPower = 9; ps.maxEmitPower = 11;
    ps.color1 = new Color4(0.75, 0.8, 0.88, 0.45);
    ps.color2 = new Color4(0.7, 0.75, 0.82, 0.35);
  }
  ps.colorDead = new Color4(1, 1, 1, 0);
  ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
  ps.emitRate = 0;
  ps.start();
  return ps;
}

export function createSky(scene: Scene): Sky {
  scene.ambientColor = new Color3(0.25, 0.25, 0.27);
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogDensity = 0.0017;

  const hemi = new HemisphericLight("skyLight", new Vector3(0, 1, 0), scene);
  const sun = new DirectionalLight("sun", new Vector3(0.5, -0.57, 0.65).normalize(), scene);
  sun.position = new Vector3(-60, 80, -20);

  // Shadows cover the homestead only; the far prairie and woods do without.
  const shadows = new ShadowGenerator(2048, sun);
  shadows.usePercentageCloserFiltering = true;
  shadows.bias = 0.0008;
  shadows.normalBias = 0.02;
  sun.autoUpdateExtends = false;
  sun.shadowMinZ = 1;
  sun.shadowMaxZ = 260;
  sun.orthoLeft = -75;
  sun.orthoRight = 75;
  sun.orthoTop = 75;
  sun.orthoBottom = -75;

  const dome = MeshBuilder.CreateSphere("skyDome", { diameter: 1600, segments: 16, sideOrientation: Mesh.BACKSIDE }, scene);
  dome.infiniteDistance = true;
  dome.isPickable = false;
  dome.applyFog = false;
  const skyMat = new ShaderMaterial("skyMat", scene, { vertex: "sky", fragment: "sky" }, {
    attributes: ["position"],
    uniforms: ["worldViewProjection", "horizon", "zenith", "sunDir", "sunColor", "glow", "stars"],
  });
  skyMat.backFaceCulling = false;
  skyMat.disableDepthWrite = true;
  dome.material = skyMat;
  dome.renderingGroupId = 0;

  const rain = precipitation(scene, false);
  const snow = precipitation(scene, true);
  let flash = 0, nextFlash = 8, daylight = 1;

  return {
    sun, hemi, shadows,
    daylight: () => daylight,
    update(env, cam, dt) {
      const [e, u, n] = sunVector(env.doy, env.minutes);
      const w = env.weather;
      const raining = isPrecipitating(w, env.minutes);
      const foggy = isFoggy(w, env.minutes);
      const cloud = raining ? 1 : w.cloud;
      const day = smooth(-0.12, 0.2, u); // civil twilight → day
      daylight = day;
      const lowSun = smooth(0.35, 0.0, Math.abs(u)) * smooth(-0.15, 0.0, u); // dawn and dusk glow

      // ---- sky colours
      const zenithDay = mix([0.36, 0.55, 0.85], [0.6, 0.63, 0.67], cloud);
      const horizonDay = mix([0.72, 0.8, 0.9], [0.72, 0.74, 0.76], cloud);
      const night: RGB = [0.03, 0.045, 0.09], nightHorizon: RGB = [0.08, 0.1, 0.16];
      let zenith = mix(night, zenithDay, day);
      let horizon = mix(nightHorizon, horizonDay, day);
      horizon = mix(horizon, [0.98, 0.62, 0.38], lowSun * (1 - cloud * 0.7) * 0.75);
      zenith = mix(zenith, [0.45, 0.45, 0.62], lowSun * 0.3);
      if (foggy) horizon = zenith = mix(horizon, [0.78, 0.8, 0.8], 0.75 * day + 0.2);
      if (flash > 0) {
        zenith = mix(zenith, [0.85, 0.88, 1], flash);
        horizon = mix(horizon, [0.85, 0.88, 1], flash);
      }
      const sunCol: RGB = mix([1, 0.55, 0.3], [1, 0.95, 0.85], smooth(0, 0.4, u));
      skyMat.setColor3("horizon", c3(horizon));
      skyMat.setColor3("zenith", c3(zenith));
      skyMat.setVector3("sunDir", new Vector3(e, u, n));
      skyMat.setColor3("sunColor", c3(sunCol));
      skyMat.setFloat("glow", smooth(-0.05, 0.05, u) * (1 - cloud * 0.9));
      skyMat.setFloat("stars", (1 - smooth(-0.18, -0.04, u)) * (1 - cloud));

      scene.clearColor = new Color4(horizon[0], horizon[1], horizon[2], 1);
      scene.fogColor = c3(horizon);
      let fog = 0.0017 + 0.0008 * cloud;
      if (raining) fog = w.condition === "snow" ? 0.0055 : 0.0038;
      if (foggy) fog = 0.011 * smooth(w.fogUntil * 60, w.fogUntil * 60 - 90, env.minutes) + 0.002;
      scene.fogDensity = fog;

      // ---- lights: the sun by day, a faint moon by night
      const above = u > -0.02;
      const dir = above ? new Vector3(-e, -u, -n) : new Vector3(e * 0.6, -0.8, n * 0.6);
      sun.direction = dir.normalize();
      sun.position = sun.direction.scale(-140).add(new Vector3(0, 0, 60));
      sun.intensity = above ? 1.15 * smooth(-0.02, 0.3, u) * (1 - 0.75 * cloud) : 0.18 * (1 - 0.6 * cloud);
      sun.diffuse = above ? c3(sunCol) : new Color3(0.55, 0.62, 0.85);
      // Night stays readable (moonlight-blue), so foraging after dark is possible but dim.
      hemi.intensity = 0.26 + 0.42 * day * (1 - 0.2 * cloud) + flash * 1.2;
      hemi.diffuse = c3(mix([0.4, 0.48, 0.75], mix([0.86, 0.9, 0.98], [0.82, 0.84, 0.86], cloud), day));
      hemi.groundColor = c3(mix([0.12, 0.13, 0.17], [0.36, 0.33, 0.27], day));
      shadows.setDarkness(1 - (1 - cloud) * smooth(0.03, 0.2, u) * 0.75);

      // ---- precipitation follows the player
      const precipRate = raining ? Math.min(1, 0.25 + w.precipMm / 15) : 0;
      const isSnow = w.condition === "snow";
      (rain.emitter as Vector3).copyFrom(cam);
      (snow.emitter as Vector3).copyFrom(cam);
      rain.emitRate = raining && !isSnow ? 2600 * precipRate : 0;
      snow.emitRate = raining && isSnow ? 900 * precipRate : 0;
      const windX = (w.wind - 0.4) * 2.2;
      rain.direction1.set(windX * 0.08, -1, 0.02);
      rain.direction2.set(windX * 0.12, -1, 0.05);
      snow.direction1.set(windX * 0.3 - 0.3, -1, -0.3);
      snow.direction2.set(windX * 0.3 + 0.3, -1, 0.3);

      // ---- wind and lightning
      const gust = w.condition === "storm" && raining ? 1.6 : 1;
      WindPlugin.strength = (0.35 + w.wind * 0.75) * gust;
      if (w.condition === "storm" && raining) {
        nextFlash -= dt;
        if (nextFlash <= 0) {
          flash = 1;
          nextFlash = 6 + Math.random() * 18;
        }
      }
      flash = Math.max(0, flash - dt * 5);
    },
  };
}
