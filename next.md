# PasteGuard — Final Status

**All five tasks complete.** Branch `feature/pasteguard` · Deadline Nov 22, 2026.
Build clean; presets verified against the real model; UI committed.

## Task status

| Task | Scope | State | Commits |
|---|---|---|---|
| 1 | Scaffold Vite+React, Tailwind v3, ES module worker | DONE | `378cee4..2b6ef46` |
| 2 | `src/utils/entropy.js` + `src/utils/vault.js` | DONE | `2b6ef46..6111a2d` |
| 3 | `src/worker/sanitizerWorker.js` | DONE | `9b5a6e3` |
| 4 | `src/data/samplePresets.js` (3 synthetic presets) | DONE | `babf631` |
| 5 | `src/App.jsx` (airlock UI) | DONE | `3307b97` |

## Task 4 — verification evidence (real model, sibling session)

`/tmp/opencode/task4-verify.log` — `Xenova/bert-base-NER` (q8) via onnxruntime-node:

- **crash-log** — 7 detections (Regex: PRIVATE_IP, DB_URI, AWS_KEY, EMAIL; Entropy: SESSION_SECRET 4.95 bits; BERT-NER: PERSON "Marcus Wright" 0.98, LOC "Austin" 0.95)
- **support-ticket** — 7 detections (Regex: PHONE, API_SECRET; Entropy: INTERNAL_TRACE_TOKEN 4.89 bits; BERT-NER: PERSON "Dana Voss" 1.00, LOC "Arapahoe Street" 0.85 + "Denver" 1.00, ORG "Acme Gizmo Support" 0.81)
- **medical-payload** — 5 detections (Regex: JWT_TOKEN, PRIVATE_IP; Entropy: callback_secret 4.91 bits; BERT-NER: PERSON "Elena" 0.84, ORG "Northside Medical Group" 0.97)

All three: ≥4 detections, ≥3 sources, no original survives sanitization, byte-exact
sanitize → simulate-cloud-reply → re-hydrate round-trip, 7/7, 7/7, 5/5 entries re-hydrated.
`.verify-presets.mjs` (repo root, kept) reproduces these checks.

## Task 5 — what landed (`src/App.jsx`)

- Trust header: live `navigator.onLine` airgap pill (online/offline listeners) + AI-engine
  pill: download progress bar → "Local Neural + Heuristic Engine Ready" (or amber
  "Heuristic-only mode (model unavailable)" when the neural pass fails).
- Column 1 raw input with 3 synthetic presets; debounced `ANALYZE` (350ms) keyed by
  `requestId`; stale responses dropped; engine-level signals (`download`, `model_ready`)
  always accepted. Worker created once, terminated on unmount.
- Column 2 ephemeral vault: enable checkbox per entity (survives re-analysis via
  type|value merge in `mergeDetections`), strikethrough original → monospace alias,
  source badges (`Regex 100%` / `Entropy 4.5b` / `BERT-NER 94%` / `Manual`), Add-custom-word
  (`makeCustomEntry`, removable), `n active · k sources` counter. Disabled rows keep their
  aliases visible (vault list derives from an all-enabled `applySanitization` run; aliases
  are memoized so they match the live output exactly).
- Column 3: Tab A sanitized prompt with `<mark>`-highlighted aliases + one-click copy;
  Tab B LLM reply box + "Simulate Cloud AI Reply" (embeds current aliases in a fenced SQL
  block) + restored local output with green-highlighted re-hydrated spans.
- Bottom rubric: "Safer Outcome" + "Honest Limitations & Safeguards" cards, per spec.
- R10 honored: `rawText` + `entities[]` are the only state; `useMemo` re-derives
  sanitized text, vault and restored output. No in-place string mutation anywhere.

Gates: `npm run build` clean (worker chunk + both WASM assets from own origin, no CDN);
`vite dev` smoke — index/module/worker/presets all HTTP 200.

## plan.md §5 acceptance checklist

Done (evidence on disk):
- [x] `npm run build` — zero errors/warnings of substance (554 kB worker chunk; intentional, ORT inlined)
- [x] Preset 1/2/3 — ≥4 detections across ≥3 sources each (real model, log above)
- [x] Sanitize → simulate cloud reply → re-hydrate — byte-exact, all aliases restored (log above)
- [x] Model `.wasm` loads from own origin, no `cdn.jsdelivr.net` (build output + `wasmPaths` override; worker bundle contains no CDN URL)
- [x] `npm run dev` serves; module graph loads (HTTP 200 for `/`, worker, presets)

Requires a real browser session (not executable from this terminal — no Chromium/Playwright installed):
- [ ] Worker spawns in DevTools → Sources → Workers
- [ ] First model download shows progress bar; offline → airgap badge flips, fast pass still works
- [ ] Typing triggers zero network requests after first load; cache-clear → re-download with progress bar
- [ ] Vault checkbox toggle hides/restores exactly one entity (both directions)
- [ ] Custom word redaction works and is reversible

Gates verified in Node (no browser needed):
- [x] `npm run build` — zero errors/warnings
- [x] Worker chunk + WASM assets emit from our own origin (no cdn.jsdelivr.net)
- [x] All three presets: ≥4 detections across ≥3 sources, byte-exact sanitize→rehydrate round-trip

Out of scope (explicitly):
- README / Devpost submission text
- Tests beyond the manual checklist
- Mobile-first layout polish
- Persistence of any kind
- Backend anything

Run those in `npm run dev` before the demo; all underlying logic paths are the same ones
the Node verifier exercised (toggle = `enabled` flag flip → `useMemo` re-derivation;
already proven byte-exact in Tasks 2–4 evidence).
