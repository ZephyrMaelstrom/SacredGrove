/**
 * Fade to black and back (sleep, passing out). A black sphere around the
 * active camera, drawn over everything, so it works the same on desktop and
 * in the headset.
 */
import { Color3, Mesh, MeshBuilder, Scene, StandardMaterial } from "@babylonjs/core";

export class Fader {
  private mesh: Mesh;
  private mat: StandardMaterial;
  private alpha = 0;
  private target = 0;
  private speed = 1.5;
  private done: (() => void) | null = null;

  constructor(private scene: Scene) {
    this.mesh = MeshBuilder.CreateSphere("fader", { diameter: 0.6, segments: 8, sideOrientation: Mesh.BACKSIDE }, scene);
    this.mat = new StandardMaterial("faderMat", scene);
    this.mat.emissiveColor = Color3.Black();
    this.mat.diffuseColor = Color3.Black();
    this.mat.disableLighting = true;
    this.mat.disableDepthWrite = true;
    this.mat.alpha = 0;
    this.mesh.material = this.mat;
    this.mesh.renderingGroupId = 3;
    this.mesh.isPickable = false;
    this.mesh.applyFog = false;
    this.mesh.setEnabled(false);
    scene.setRenderingAutoClearDepthStencil(3, true);
    scene.onBeforeRenderObservable.add(() => this.step(scene.getEngine().getDeltaTime() / 1000));
  }

  private step(dt: number) {
    if (this.alpha !== this.target) {
      const d = this.speed * dt;
      this.alpha = this.alpha < this.target ? Math.min(this.target, this.alpha + d) : Math.max(this.target, this.alpha - d);
      if (this.alpha === this.target && this.done) {
        const cb = this.done;
        this.done = null;
        cb();
      }
    }
    this.mat.alpha = this.alpha;
    this.mesh.setEnabled(this.alpha > 0.001);
    const cam = this.scene.activeCamera;
    if (cam) this.mesh.position.copyFrom(cam.globalPosition);
  }

  out(): Promise<void> {
    return new Promise((res) => { this.target = 1; this.done = res; });
  }
  in(): Promise<void> {
    return new Promise((res) => { this.target = 0; this.done = res; });
  }
  get busy() {
    return this.alpha > 0 || this.target > 0;
  }
}
