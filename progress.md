# PasteGuard — Project Progress

**Status: all tasks complete** · Branch `feature/pasteguard` · Deadline Nov 22, 2026

PasteGuard is a 100% client-side "AI sanitization airlock": paste sensitive text, detect
secrets/PII with a 3-stage pipeline (Regex → Shannon entropy → BERT-NER in a Web Worker),
replace them with format-preserving aliases, send the safe prompt to an LLM, then re-hydrate the
reply locally. Spec authority: `plan.md` (§0 refinements R1–R11, §1 architecture rules).

## Task status

| Task | Scope | State | Commits |
|---|---|---|---|
| 1 | Scaffold Vite+React, Tailwind v3, ES module worker, build gate | DONE (review clean) | `378cee4..2b6ef46` |
| 2 | `src/utils/entropy.js` + `src/utils/vault.js` (Stages A/B, overlap resolver, aliases, sanitize/rehydrate) | DONE (fix round 1) | `2b6ef46..6111a2d` |
| 3 | `src/worker/sanitizerWorker.js` (singleton ONNX NER pipeline, hybrid scanner, message protocol) | DONE | `9b5a6e3` |
| 4 | `src/data/samplePresets.js` (3 synthetic judge presets) | DONE (verified, real model) | — | `babf631` |
| 5 | `src/App.jsx` (airlock UI, state orchestration) | DONE (build clean, dev smoke OK) | — | `3307b97` |

## What exists now

- `src/utils/entropy.js` — 7 plan-mandated regex patterns (verbatim), Shannon entropy scanner
  (`>4.2` bits, len ≥ 20, quoted/`KEY=` assignments), `runFastPass(text)`.
- `src/utils/vault.js` — `resolveOverlaps` (range-based, `Regex > Entropy > BERT-NER > Manual`),
  memoized deterministic aliases, `applySanitization` (offset-slice only), `rehydrateText`
  (literal split/join, length-desc), `makeCustomEntry`. Round-trip byte-exactness was asserted
  in Task 2's 30-check sanity run.
- `src/worker/sanitizerWorker.js` — module worker: env flags, bundled WASM (`?url` imports of
  `onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs/.wasm`), `wasmPaths = { mjs, wasm }`
  override (verified against `@huggingface/transformers@4.3.2` + `onnxruntime-web` sources: the
  library defaults those two paths to jsdelivr, the override removes all CDN egress),
  memoized singleton pipeline, per-file averaged download progress, `requestId` protocol
  (`fast_pass_complete` → `complete` / `neural_unavailable`), WordPiece→char-offset mapping.
- `vite.config.js` — `worker: { format: 'es' }`, `optimizeDeps.exclude` for the transformers lib.

## Critical bug found & fixed (Task 3)

**Symptom:** the neural pass produced fragments — `"oss"` instead of `"Voss"`, `"side"` instead of
`"Northside Medical Group"` — and one preset sample returned *zero* entities.

**Root cause:** `computeTokenSpans` scans a *normalized* (lowercased, NFD) text but searched with
the token piece in the vocab's *original* casing. BERT's vocab contains capitalized words
(`Elena`, `North`, `Medical`), so `indexOf` missed, the parent token was skipped, and only
lowercase `##` continuations mapped — every entity lost its leading subword.
Found by running the **real model** (`Xenova/bert-base-NER`, `dtype: 'q8'`) in Node via
`onnxruntime-node` and diffing raw predictions against computed spans (debug scripts in
`/tmp/opencode/neural-debug*.mjs`).

**Fix:** normalize each piece with the same lowercase+NFD transform before scanning
(`normalizePiece`). Committed in `9b5a6e3` with evidence in `/tmp/opencode/neural-verify.log`.

## Verification evidence (real, not assumed)

- `npm run build` — **clean, zero warnings**; worker chunk `dist/assets/sanitizerWorker-*.js`
  (554 kB) and both wasm assets (`ort-wasm-simd-threaded.asyncify-*.{mjs,wasm}`) emit from our
  own origin → no `cdn.jsdelivr.net` dependency (checklist item 9).
- `dtype: 'q8'` resolves to `onnx/model_quantized.onnx` (exists in the HF repo — verified via the
  HF API), so no dtype fallback needed.
- Real-model end-to-end run (Node): model loads q8; every NER entity's `text.slice(start,end)`
  equals its value; multi-token grouping works (`"Acme Gizmo Support"`, 4 subwords); merged
  regex+NER entity list through `applySanitization`→`rehydrateText` is **byte-exact** on all
  three sample cores; no original secret survives sanitization. Log: `/tmp/opencode/neural-verify.log`.
- Known model behaviour (not a defect, plan-mandated): the 0.70 score threshold drops weak
  continuations, e.g. `"Ruiz"` (0.473) after `"Elena"` (0.951) → sanitized JSON keeps `"Ruiz"`.
  Presets must be rich enough that ≥4 detections still land across ≥3 sources (they are).

## Decisions a future session must respect

1. `plan.md` §0/§1 are binding; don't "restore" original-spec wording.
2. Vault = volatile React state only; model weights are the only persisted artifact.
3. Re-derive sanitized text from `rawText + entities` on every change (R10) — no in-place mutation.
4. Custom entries (`makeCustomEntry`, `source: 'Manual'`) rank **below** every detector (fixed in
   `6111a2d`) — a one-word redaction must never evict a detected secret.
5. No test framework sanctioned; gate = clean `npm run build` + `plan.md` §5 manual checklist.
6. OpenRouter free-tier quota was exhausted (2026-11-11); use `opencode/*` models for subagents.
7. Detailed task-by-task ledger lives in `.superpowers/sdd/plan/progress.md`.
