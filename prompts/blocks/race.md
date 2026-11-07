### `race` — A vs B on up to 4 cases (glass jars fill as a simulated clock runs)
```json
{ "type": "race",
  "a": { "label": "Lab server" }, "b": { "label": "HPC cluster" },
  "unit": "days",
  "items": [ { "label": "Hogenom", "tip": "…", "a": 365, "b": 3, "aText": "1 year", "bText": "3 days" } ] }
```
`a`/`b` are numbers in the same `unit` (`"days"` formats as d / months / years; any other unit is printed raw).
When the source is vague ("several years") pick a sensible number and keep the source wording in `aText`/`bText`
(default: the number). An item's `short` label defaults to "aText → bText".
Interactive ids: each item id.
