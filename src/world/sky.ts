import {
  Color3,
  Color4,
  DirectionalLight,
  HemisphericLight,
  Scene,
  ShadowGenerator,
  Vector3,
} from "@babylonjs/core";

/**
 * Overcast-bright March afternoon, ~3 pm, 38°N (Mount Vernon, IL).
 * Sun sits in the south-west at roughly 35° elevation.
 */
export function createSky(scene: Scene) {
  scene.clearColor = new Color4(0.74, 0.78, 0.82, 1);
  scene.ambientColor = new Color3(0.25, 0.25, 0.27);

  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogDensity = 0.0017;
  scene.fogColor = new Color3(0.74, 0.78, 0.82);

  const hemi = new HemisphericLight("skyLight", new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.62;
  hemi.diffuse = new Color3(0.86, 0.9, 0.98);
  hemi.groundColor = new Color3(0.36, 0.33, 0.27);

  // Direction the light travels: from the SW sky toward the NE ground.
  const sun = new DirectionalLight("sun", new Vector3(0.5, -0.57, 0.65).normalize(), scene);
  sun.intensity = 1.05;
  sun.diffuse = new Color3(1.0, 0.95, 0.86);
  sun.position = new Vector3(-60, 80, -20);

  // Shadows cover the homestead only; the far prairie and woods do without.
  const shadows = new ShadowGenerator(2048, sun);
  shadows.usePercentageCloserFiltering = true;
  shadows.bias = 0.0008;
  shadows.normalBias = 0.02;
  sun.autoUpdateExtends = false;
  sun.shadowMinZ = 1;
  sun.shadowMaxZ = 220;
  sun.orthoLeft = -75;
  sun.orthoRight = 75;
  sun.orthoTop = 75;
  sun.orthoBottom = -75;

  return { sun, hemi, shadows };
}
