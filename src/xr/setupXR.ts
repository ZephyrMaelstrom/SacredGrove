import {
  AbstractMesh,
  Scene,
  WebXRDefaultExperience,
  WebXRFeatureName,
  WebXRState,
} from "@babylonjs/core";

export interface XRHandle {
  xr: WebXRDefaultExperience | null;
  inXR: () => boolean;
}

/**
 * M0: enter VR, see your hands, teleport.
 * Hand tracking falls back to controllers automatically when hands aren't
 * available. Smooth locomotion is added later (M5) as a comfort option.
 */
export async function setupXR(scene: Scene, floors: AbstractMesh[]): Promise<XRHandle> {
  const supported = !!navigator.xr && (await navigator.xr.isSessionSupported("immersive-vr").catch(() => false));
  if (!supported) {
    console.info("[xr] immersive-vr not supported here; desktop mode only.");
    return { xr: null, inXR: () => false };
  }

  const xr = await scene.createDefaultXRExperienceAsync({
    floorMeshes: floors,
    disableTeleportation: false,
    uiOptions: { sessionMode: "immersive-vr", referenceSpaceType: "local-floor" },
    optionalFeatures: true,
  });

  try {
    xr.baseExperience.featuresManager.enableFeature(
      WebXRFeatureName.HAND_TRACKING,
      "latest",
      { xrInput: xr.input, jointMeshes: { enablePhysics: false } },
      true,
      false,
    );
  } catch (e) {
    console.warn("[xr] hand tracking unavailable, using controllers", e);
  }

  // Teleport tuning: a forager walks; keep the arc short and snappy.
  const tp = xr.teleportation;
  if (tp) {
    tp.parabolicRayEnabled = true;
    tp.parabolicCheckRadius = 6;
    tp.rotationEnabled = true;
  }

  return { xr, inXR: () => xr.baseExperience.state === WebXRState.IN_XR };
}
