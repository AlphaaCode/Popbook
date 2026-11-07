### `plot` — an explorable curve y = f(x, p) on a standing paper panel
```json
{ "type": "plot",
  "expr": "1/((1-p)+p/x)",
  "x": { "label": "processors", "min": 1, "max": 64 },
  "y": { "label": "speed-up", "min": 0, "max": 20 },
  "param": { "id": "p", "label": "parallel fraction", "min": 0.5, "max": 0.99, "step": 0.01, "value": 0.9 },
  "marks": [ { "x": 16, "label": "16 cores" } ] }
```
Interactive ids: `param`, `curve`.
`"x": { "log": true }` makes the horizontal axis logarithmic (needs `x.min > 0`).
