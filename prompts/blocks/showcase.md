### `showcase` — 1–4 objects on the page, each clickable, optionally cycling through steps
```json
{ "type": "showcase",
  "items": [ { "model": "globe", "label": "Weather", "sub": "mesh", "tip": "…",
               "steps": [ { "label": "28 km", "value": "points ×1" }, { "label": "7 km", "value": "points ×16" } ] } ] }
```
`model` ∈ `globe` (grid refines with each step), `head` (scan slice), `layers` (geological block with wells),
`server`, `chip`, `molecule`, `dna`, `gear`, `flask`, `cube`, `pyramid`, `sphere`, `cylinder`.
`steps` optional (a readout card shows the current step). Interactive ids: each item id.
