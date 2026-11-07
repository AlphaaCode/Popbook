### `scheduler` — one core shared by tasks (Gantt chart, quantum slider, optional levels)
```json
{ "type": "scheduler", "tasks": ["App A", "App B", "App C"],
  "quantum": { "label": "Quantum", "min": 0.05, "max": 1.5, "value": 0.6 },
  "ht": { "label": "Hyperthreading" },
  "levels": [ { "title": "HARDWARE", "sub": "hyperthreading", "tip": "…" } ] }
```
2–4 tasks; `ht` and `levels` (≤3, bottom → top) optional. Interactive ids: `core` + level ids.
