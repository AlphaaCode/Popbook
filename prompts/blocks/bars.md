### `bars` — ordered values as rising towers, with log/linear toggle and optional growth law
```json
{ "type": "bars",
  "items": [ { "label": "4004", "x": 1971, "value": 2300, "valueText": "2 300", "tip": "…" } ],
  "growth": { "label": "×2 every 2 years", "factor": 2, "every": 2 },
  "unitLabel": "transistors" }
```
2–7 items, `x` increasing numbers (years, sizes…). Log scale unless `"log": false`. `valueText` defaults to the value.
`growth` optional: draws value₀·factor^((x−x₀)/every).
Interactive ids: `play`, `bar`, `scale`.
