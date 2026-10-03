/**
 * Wind sway for plants, injected into Babylon's standard material shader.
 * Displacement grows with the square of height above the plant's base, so
 * stems bend and rosettes stay put. Phase varies across the field, so gusts
 * roll across the prairie instead of everything nodding in unison.
 */
import { MaterialPluginBase, type Material, type MaterialDefines, type UniformBuffer } from "@babylonjs/core";

export class WindPlugin extends MaterialPluginBase {
  /** Global wind strength (0 calm – 2 gusty). Weather drives this from M4 on. */
  static strength = 1;

  constructor(material: Material) {
    super(material, "Wind", 200, { WIND: false });
    this._enable(true);
  }

  override prepareDefines(defines: MaterialDefines) {
    defines["WIND"] = true;
  }

  override getUniforms() {
    return {
      ubo: [{ name: "windParams", size: 2, type: "vec2" }],
      vertex: "#ifdef WIND\nuniform vec2 windParams;\n#endif\n",
    };
  }

  override bindForSubMesh(ubo: UniformBuffer) {
    ubo.updateFloat2("windParams", performance.now() / 1000, WindPlugin.strength);
  }

  override getClassName() {
    return "WindPlugin";
  }

  override getCustomCode(shaderType: string) {
    if (shaderType !== "vertex") return null;
    return {
      CUSTOM_VERTEX_UPDATE_WORLDPOS: `
#ifdef WIND
  float windH = max(positionUpdated.y, 0.0);
  float windPh = dot(worldPos.xz, vec2(0.11, 0.07));
  float gust = 0.6 + 0.4 * sin(windParams.x * 0.35 + worldPos.x * 0.02 + worldPos.z * 0.015);
  float bend = windH * windH * windParams.y * gust;
  worldPos.x += sin(windParams.x * 1.9 + windPh) * 0.05 * bend;
  worldPos.z += cos(windParams.x * 1.4 + windPh * 1.3) * 0.035 * bend;
#endif
`,
    };
  }
}
