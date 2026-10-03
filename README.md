# SacredGrove · Rootwake

A VR foraging and apothecary game set on a Southern Illinois homestead, built with **Babylon.js** and **WebXR**. Runs in the Quest browser — no install.

**Play:** https://zephyrmaelstrom.github.io/SacredGrove/

## Status

| Milestone | What it proves | State |
| --- | --- | --- |
| M0 · Skeleton | Vite + TypeScript + Babylon.js, WebXR entry, hand tracking, teleport, auto-deploy to GitHub Pages | Done |
| M1 · The land | Map 1 terrain (road, ditch, yard, prairie, remnant corner, fencerows, tree line), gray-box homestead, early-March lighting | Done |
| M2 · Habitat grid | Light / moisture / disturbance / fertility / mow layers in a Web Worker | Next |

## Controls

**Headset:** open the Play link in the Quest browser, press the VR button. Point and push the thumbstick (or pinch with hands) to teleport.

**Desktop:** click to look, WASD to walk, Shift to hurry, **Z** toggles the zone overlay.

## Map 1 — Cedar Branch Road

About 16 acres, 160 m wide × 400 m deep. +X is east, +Z is north.

| Zone | Z range (m) | Notes |
| --- | --- | --- |
| Gravel road | 0–8 | Crowned gravel, utility poles |
| Roadside ditch | 8–14 | V-ditch, culvert under the drive |
| Yard & drive | 14–110 | Farmhouse, barn, barnyard, kitchen garden, raised beds, farm stand |
| Light prairie | 110–360 | Fallow pasture; never-plowed remnant corner in the NE (x 22–72, z 290–360) |
| Forest edge | 360–372 | Harvestable fringe: bush honeysuckle, spicebush, brambles |
| Tree line | 372+ | White oak, shagbark hickory, sugar maple, black walnut — no entry on this map |
| Fencerows | \|x\| 72–80 | Barbed wire, cedar, brambles, small trees, open gaps |

All site positions live in [`src/world/map.ts`](src/world/map.ts) so the M2 habitat worker uses the same numbers as the renderer.

## Project layout

```
src/
  main.ts                 boot: scene, world, XR, HUD
  xr/setupXR.ts           WebXR default experience, hand tracking, teleport
  xr/desktopControls.ts   WASD walker + walkable-area clamp
  world/map.ts            zones, site plan, terrain height (pure TS, worker-safe)
  world/terrain.ts        2 m terrain grid with March ground colours + zone debug view
  world/buildings.ts      gray-box farmhouse, barn, root cellar, farm stand, fences
  world/trees.ts          instanced bare hardwoods, red cedar, shrubs, fencerows
  world/sky.ts            March afternoon sun, sky, fog, homestead shadows
  debug/hud.ts            desktop zone/position/FPS readout
```

## Develop

```bash
npm install
npm run dev        # http://localhost:5173/SacredGrove/
npm run build      # type-check + production build to dist/
```

To test on a Quest during development, run `npm run dev` and open `https://<your-computer-ip>:5173/SacredGrove/` — WebXR needs HTTPS off localhost, so use the deployed Pages URL or a tunnel.

## First-time GitHub Pages setup

Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**. After that, every push to `main` deploys automatically.
