### `model` — a slider drives formulas; a threshold wall; an optional toggle
```json
{ "type": "model",
  "visual": "chip",
  "param":  { "id": "f", "label": "Frequency", "min": 1, "max": 5, "step": 0.1, "value": 2, "unit": "GHz" },
  "toggle": { "id": "n", "label": "Dual core", "off": 1, "on": 2 },
  "outputs": [ { "label": "heat", "expr": "n*(f/3.8)^3", "digits": 2, "warnAbove": 1.05 },
               { "label": "work", "expr": "n*f/3.8", "digits": 2 } ],
  "gauge": { "label": "Temperature", "expr": "n*(f/3.8)^3", "max": 1.4 },
  "threshold": { "value": 4, "label": "heat wall", "when": "n==1", "tip": "…" },
  "messages": [ { "when": "n==1 && f>=4", "text": "Heat wall: cannot be cooled!" },
                { "when": "true", "text": "Reference: 1 core at 3.8 GHz." } ] }
```
`expr`/`when` are math expressions over the param id and toggle id: numbers, + − * / ^ ( ),
comparisons, && || !, ?:, and min max abs sqrt log log10 exp pow round floor ceil. First matching message wins.
`visual`: `chip` (default: glowing processor units, one per toggle value), `tank` (liquid level = gauge), `dial`.
`param.step` defaults to 1/100 of the range, `param.value` to `min`.
Interactive ids: `param`, `threshold` (only if present), `toggle` (only if present).
