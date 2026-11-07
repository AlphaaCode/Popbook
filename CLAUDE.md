# PopBook — agent instructions

This repo turns course material (PDF slides, textbook pages, notes) into an interactive 3D pop-up book.
A fixed engine (`viewer/`) renders any `books/<slug>/book.json`. **Your job is to write that JSON**, not
3D code, unless no scene block fits an idea (see "Custom scenes" below).

## Make a book

1. **Get the pages.** Either extract text:
   ```
   node tools/pdf2pages.mjs <file.pdf> --pages 1-10 --out books/<slug>
   ```
   (writes `books/<slug>/pages/page-NNN.txt` and copies the PDF to `books/<slug>/source.pdf`), or read the PDF
   directly with your file-reading tool. Look at the PDF itself for diagrams, tables and scanned pages; the text
   files lose layout. `<slug>` is short, lowercase, ASCII, dashes (e.g. `thermo-ch3`).
2. **Read `prompts/core.md` completely**, then `prompts/blocks/<name>.md` for each block you may use. They define the
   format, length limits, the scene blocks and how to choose one. Follow them exactly. Write in the language of the source unless told otherwise.
3. **Write `books/<slug>/book.json`.**
4. **Check it:**
   ```
   node tools/check.mjs books/<slug>
   ```
   Fix every `error` and re-run until it prints `OK`. Treat `warning`s about length seriously: long text overflows
   the printed page.
5. Tell the user to open **http://localhost:5173/viewer/?book=<slug>** (start the server with `npm start` if it is
   not running). `node tools/export.mjs books/<slug>` makes a single shareable HTML file.

Only write inside `books/<slug>/`. Never edit `viewer/`, `lib/` or the other books to make a book work.

## Custom scenes (only when no block fits)

Prefer the built-in blocks: they are tested and look consistent. If an idea truly needs its own model, write
`books/<slug>/scenes/<name>.js` and reference it from the spread:

```json
"scene": { "type": "custom", "module": "scenes/<name>.js", "targets": ["bob", "length"] }
```

The module default-exports a function `(kit, scene, ctx) => ({ G, pops, update, controls, demo, targets })`:

| field | meaning |
|---|---|
| `G` | a `THREE.Group` holding everything on the right page |
| `pops` | the objects that fold flat / pop up on page turns (usually a few top-level groups) |
| `update(dt, t)` | called every frame (seconds) |
| `controls` | widgets on the left page: `{ id, kind: 'range', label, min, max, step, value, fmt(v), onInput(v) }`, `{ id, kind: 'button', label, onClick() }`, `{ id, kind: 'toggle', label, on, onClick(on) }` |
| `demo` | guided tour steps: `{ focus: [x, y, z], d: distance, act: () => promise?, wait: ms }` |
| `targets` | ids the reader must touch to earn the stamp; call `ctx.touch(id)` when they do |

Coordinates: the right page is `x ∈ [0.05, 0.95]`, `z ∈ [-0.62, 0.62]` (negative z = far edge), the paper surface is
`y = kit.PY`. Keep models under ~0.3 tall and away from the far edge (they lean outwards in perspective). The
figure caption sits at `z ≈ 0.58`.

Interaction: set `mesh.userData = { tip: [title, text], click: hit => {}, target: 'id' }` on any mesh (or an invisible
`kit.hitBox`) — hover shows the tip, click calls `click` and touches `target`.

`ctx`: `touch(id)`, `setControl(id, { value | label | on })` (update a left-page widget), `fmt(v, digits)` (locale
number), `ui` (interface strings), `lang`.

`kit` (from `viewer/kit.js`) — use only this, do not import anything:

| name | what |
|---|---|
| `THREE` | three.js r160 |
| `PY`, `W`, `H`, `INK`, `PALETTE`, `hexCss(hex)` | page height, page size, ink colour, 6 accent colours |
| `ink(geometry, hex, { edges, hull, thresh, soft })` | paper mesh with ink edges; `hull: 0.002` adds an outline for round shapes |
| `glow(mesh, amount 0–1, hex)` | glowing colour fill on an `ink` mesh |
| `inkMat(hex)`, `LINE`, `LINE_SOFT` | raw materials |
| `at(obj, x, y, z)`, `V(x, y, z)`, `lerp`, `clamp` | helpers |
| `polyline(points)`, `lineLoop(r, y)`, `circlePts(r, n, y)` | ink lines |
| `glassCyl(r, h)` | glass jar whose silhouette lines face the camera |
| `hitBox(w, h, d, y)` | invisible click target |
| `card(w, h, draw(g, cw, ch), { flat, noHit, ppu, ltr })` | canvas-textured plane; `card.redraw(fn)` repaints |
| `flatLabel(w, h, [[text, px, 'mono'/'serif'/'news', colour, weight]], { box })` | paper label lying on the page |
| `boxed, txt, fitTxt, wrapTxt, F(px, family, weight)` | canvas drawing helpers for cards |
| `tween(seconds, u => {}, 'io'/'out'/'back'/'lin', delay)` | promise-based animation |
| `wait(ms)`, `ease` | timing |

`books/blocks-demo/scenes/pendulum.js` is a complete example. Custom scenes are agent-mode only: the studio's API
mode never produces them.
