# SacredGrove · Rootwake

A VR foraging and apothecary game set on a Southern Illinois homestead, built with **Babylon.js** and **WebXR**. Runs in the Quest browser with no install.

**Play:** https://zephyrmaelstrom.github.io/SacredGrove/

## Status

| Milestone | What it proves | State |
| --- | --- | --- |
| M0 · Skeleton | Vite + TypeScript + Babylon.js, WebXR entry, hand tracking, teleport, auto-deploy to GitHub Pages | Done |
| M1 · The land | Map 1 terrain, gray-box homestead, early-March lighting | Done |
| M2 · Habitat grid | Light, moisture (real water-flow routing), disturbance, fertility, mowing, plow and fire history on a 2 m grid, computed in a Web Worker | Done |
| M3 · Vegetation | 94 species placed by habitat fit, phenology for every plant, procedural meshes, streaming renderer, seasonal trees | Done |
| M4 · Time | Day clock, weather, sleep-to-advance | Next |

## Controls

**Headset:** open the Play link in the Quest browser and press the VR button. Point and push the thumbstick (or pinch) to teleport.

**Desktop**

| Key | Does |
| --- | --- |
| Click, mouse | Look |
| WASD, Shift | Walk, hurry |
| Aim at a plant | HUD names it, its stage today, how well it fits that spot, and what limits it |
| Z | Cycle habitat overlays: zones, light, moisture, wetness, disturbance, fertility, garden-escape reach, bird perches, mowing, plow history |
| X | Paint where the plant you're looking at can grow |
| `[` `]` / `,` `.` | Back / forward one week / one day |
| V | Vegetation on/off (performance comparison) |
| F, then Q/E | Fly mode, down/up |

**URL options:** `?doy=200` start on a day of the year · `?quality=low|medium|high` · `?overlay=moisture` · `?fly`

## How the world grows

The plants are not placed by hand. They grow where the land says they can.

1. **Habitat (M2, `src/sim/habitat.ts`).** Every 2 m node gets growing-season light (tree line, fencerow canopy, building and yard-tree shade), soil moisture (priority-flood + multiple-flow-direction routing gives a topographic wetness index; the ditch, shade and roof drip add to it), disturbance, fertility (manure plume, old dooryard, rich swales vs. worn ridges), mowing regime, plow history, burn history, substrate, and how close it is to the old garden and to bird perches.
2. **Suitability (`src/sim/suitability.ts`).** Each plant's niche (optimum and tolerance for light, moisture, disturbance, fertility) is scored with Gaussians, then gated by substrate, mowing tolerance, competition from tall sward, land history (C-value 6+ plants never return after the plow), and seed arrival (bird-sown under perches, squirrel-cached nuts near the woods, garden escapes near the garden). `explain()` reports every factor, which is what powers the HUD's "limited by".
3. **Placement (`src/sim/placement.ts`).** Each node gets up to 5 individuals drawn from those scores, times each plant's own clumping pattern. Trees and shrubs are a sparser pass with spacing; fungi grow on the fallen logs. Deterministic from the world seed.
4. **Phenology (`src/sim/phenology.ts`).** Every plant moves through winter form → emerging → leaf → bloom → seed → dieback by day of year. Winter annuals run across New Year. Biennials split into first-year rosettes and bolting plants. Spicebush blooms on bare twigs.
5. **Rendering (`src/veg`).** Procedural meshes per plant and growth stage (≤ 90 triangles, enforced by tests), drawn with thin instances that stream in around the player. A sward layer covers the ground near and far, tinted by whatever dominates each spot today.

### Check the ecology

```bash
npm run census                      # plant share per zone, like a field survey
npm run census -- --zone remnant    # one zone in full
npm run census -- --plant "Rattlesnake"   # where a plant grows, and why not elsewhere
npm run report:habitat              # mean habitat values per zone
npm test                            # ecology, phenology and geometry tests
```

The tests encode field patterns the world must keep: the yard is a lawn, jimsonweed stays in the barnyard, garlic mustard stays in the shade, conservative prairie plants stay on never-plowed ground, fencerow trees are bird-planted rather than squirrel-planted, goldenrod takes over the unmowed field, and more.

## Plant data

The species workbook is the single source of truth: [`data/Rootwake_Species_Database.xlsx`](data/Rootwake_Species_Database.xlsx).

- **Plants tab:** one row per living plant: growth form, height, colours, phenology dates, crown shape, niche optima and tolerances, mowing tolerance, C-value, origin, dispersal, patch scale, abundance, flower shape.
- **Species tab:** one row per harvestable product (Common Mullein *and* Mullein Flower), joined to its plant by Latin name.

After editing the workbook in Excel, run `npm run data`. It validates both tabs (fails loudly on bad values) and writes `src/data/plants.gen.json`. `npm run build` does this automatically.

To add a plant to Map 1: add a row to the Plants tab with `1` in Maps, make sure a Species row shares its Latin name, run `npm run data`, then `npm run census -- --plant "<name>"` to see where it landed.

## Map 1 · Cedar Branch Road

About 16 acres, 160 m wide × 400 m deep. +X is east, +Z is north.

| Zone | Z range (m) | What grows there |
| --- | --- | --- |
| Gravel road | 0–8 | Pineapple weed, purslane, chicory, mullein |
| Roadside ditch | 8–14 | Fescue, Queen Anne's lace, wild parsnip, chicory, curly dock, horsetail at the culvert |
| Yard & drive | 14–110 | Mowed lawn: dandelion, bluegrass, henbit, deadnettle, clover, wild garlic, violets |
| Barnyard | x 24–56, z 46–82 | Lamb's quarters, foxtail, amaranth, burdock, jimsonweed, nettle at the manure heap |
| Old kitchen garden | x −52–−30, z 82–100 | Horseradish, tansy, hops, feverfew, lemon balm, comfrey, peppermint |
| Light prairie | 110–360 | Goldenrod old field with fescue, broomsedge, milkweed, black-eyed Susan; mowed path to the woods |
| Remnant corner | x 22–72, z 290–360 | Never plowed: little bluestem, butterfly weed, rattlesnake master, coneflower, compass plant |
| Fencerows | \|x\| 72–80 | Bird-planted cherry, sassafras, persimmon, cedar, hawthorn; brambles, poison ivy, garlic mustard |
| Forest edge | 360–372 | Shrub wall (honeysuckle, spicebush, elderberry), mayapple, cleavers, sedge, fallen logs with fungi |
| Tree line | 372+ | White oak, shagbark hickory, sugar maple, black walnut. No entry on this map |

All site positions live in [`src/world/map.ts`](src/world/map.ts), shared by the renderer and the simulation.

## Project layout

```
data/Rootwake_Species_Database.xlsx   the species workbook (source of truth)
scripts/build-data.mjs                workbook → src/data/plants.gen.json (validated)
scripts/census.ts                     ecology census and plant diagnostics
src/
  main.ts                 boot: worker, world, vegetation, XR, HUD, debug keys
  data/plants.ts          typed plant database
  sim/                    pure TypeScript, runs in the worker and in tests
    grid.ts               2 m habitat grid
    habitat.ts            M2 habitat layers + water-flow routing
    suitability.ts        niche fit and why
    placement.ts          M3 plant population
    phenology.ts          stage and look by day of year
    sim.worker.ts         Web Worker entry; client.ts is the main-thread side
  veg/
    geometry.ts           procedural plant meshes (Babylon-free, tested)
    herbs.ts              streaming thin-instance renderer + sward layer
    treeMeshes.ts         branch and crown builders
    woody.ts              trees and shrubs, seasonal crowns
    wind.ts               wind sway shader plugin
  world/                  map, terrain, buildings, sky, structural woods
  xr/                     WebXR setup, desktop walker / fly camera
  debug/                  HUD, habitat overlays
tests/                    ecology, phenology, geometry
```

## Develop

```bash
npm install
npm run dev        # http://localhost:5173/SacredGrove/
npm run build      # data export + type-check + production build to dist/
npm test
```

WebXR needs HTTPS off localhost, so test on a headset with the deployed Pages URL or a tunnel.

## Performance notes

Measured with the HUD (desktop): about 100–120 draw calls and 300–500k triangles in the densest prairie views at `medium`. The Quest budget is under 150 draw calls and 500k triangles at 72 fps. If the headset drops frames, try `?quality=low` first (smaller near radius), then compare with V (vegetation off) to see whether vegetation is the cost.

## First-time GitHub Pages setup

Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**. After that, every push to `main` deploys automatically.
