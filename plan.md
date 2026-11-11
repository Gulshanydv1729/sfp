# PasteGuard — Local AI Sanitization Airlock
### Refined Execution Plan (SafeSpace Hacks · Deadline Nov 22, 2026)

> This is the refined, bug-fixed version of the master blueprint. It keeps the original
> architecture and rubric alignment, corrects false/outdated commands, fixes regex bugs,
> and adds the missing engineering details (entity overlap resolution, NER offset mapping,
> model download progress, WASM asset loading) needed for a working prototype.

---

## 0. Refinements Applied to the Original Spec

These are deliberate deviations. Do not "restore" the original wording.

| # | Original spec | Problem | This plan |
|---|---|---|---|
| R1 | `npx tailwindcss init -p` | **Fails on current Tailwind v4.3.5** (CLI removed) | Pin `tailwindcss@^3.4.17 postcss autoprefixer` as devDeps, then `npx tailwindcss init -p` works as written |
| R2 | "Use `@huggingface/transformers` (v3+)" | Latest published is **4.3.2** | Install `@huggingface/transformers@^4` — API (`pipeline`, `env`) is the same |
| R3 | `PRIVATE_IP` regex: `(?:10\|172\.(...)\|192\.168)(?:\.\d{1,3}){2}` | `10` branch yields only **3 octets** (`10.1.2`) | Split into three complete alternatives, each with the right number of octets |
| R4 | `PHONE` regex with bare `\d{3}[-.\s]?\d{3}[-.\s]?\d{4}` | Matches timestamps, IDs, `1234.567.8901` | Require a separator/parens/`+`, add `(?<![\d.])` lookbehind, cap length |
| R5 | "Sort entities by value length descending" only | Two stages can flag **overlapping spans** (`John` vs `John Smith`, email inside a DB URI) → duplicated/​corrupted replacement | Range-based overlap resolution: sort by start index, keep non-overlapping, prefer higher-priority source |
| R6 | NER results merged into text | No mention of **character offsets** | Use `return_timestamps: 'word'` to get char offsets; map subwords back to exact spans; never re-find by string search for NER |
| R7 | "ONNX download progress bar (0–100%)" | No mechanism specified | Pass `progress_callback` to `pipeline()` and forward `{status:'download', p}` messages to the UI |
| R8 | "Zero external network calls" but ONNX runtime loads `.wasm` from a CDN by default | Violates rule #1 of the spec | Bundle `onnxruntime-web` `.wasm` assets with Vite `?url` imports and set `env.backends.onnx.wasm.wasmPaths`; verify in DevTools Network tab |
| R9 | `optimizeDeps.exclude: ['@huggingface/transformers']` "if needed" | Vague | Keep it excluded (it ships pre-bundled ESM + wasm), set `worker: { format: 'es' }`, and verify **both** `npm run dev` and `npm run build` |
| R10 | Toggle checkbox "dynamically restores" | Mutating a string in place makes toggling back impossible | Store `entities[]` in state; **re-derive** sanitized text from `rawText + enabledEntities` on every change |
| R11 | Vault described as "React State only" | Correct, but model cache is external | Clarify: vault = volatile RAM only; only the Hugging Face model weights persist (Cache API). State this in the Limitations card |

---

## 1. Architecture Rules (Unchanged — Do Not Violate)

1. **100% client-side.** No backend, no inference API calls. Only network traffic: initial
   model weight download from Hugging Face Hub (`Xenova/bert-base-NER`), plus bundled WASM
   served from our own origin (never a CDN).
2. **`@huggingface/transformers@^4`** — never `@xenova/transformers`.
3. **All ONNX inference runs in `src/worker/sanitizerWorker.js`** (module Web Worker) so React never blocks.
4. **Honest UI:** confidence scores, detection source badges (`Regex` / `Entropy` / `BERT-NER`),
   live `navigator.onLine` airgap badge, and a permanent "Honest Limitations & Safeguards" panel.

### 3-Stage Detection Pipeline

```
Stage A  Deterministic Regex   → instant, confidence 1.00, source "Regex"
Stage B  Shannon Entropy       → instant, source "Entropy" (shows bits/char)
Stage C  BERT-NER (Web Worker) → after model ready, source "BERT-NER" (shows score)
                ↓
     Overlap resolver (range-based, priority A > B > C on ties)
                ↓
     Format-preserving alias vault  →  sanitized prompt  →  LLM  →  1-click re-hydration
```

---

## 2. Tech Stack & Initialization

- React 18+ via Vite: `npm create vite@latest pasteguard -- --template react`
- `npm install @huggingface/transformers@^4 lucide-react`
- `npm install -D tailwindcss@^3.4.17 postcss autoprefixer` → `npx tailwindcss init -p`
  ⚠️ **Pin v3 explicitly.** Installing bare `tailwindcss` gives v4, which has no `init` and no
  `tailwind.config.js`, breaking Phase 1 and the target directory structure.
- Verify early: `npm run build` must pass before writing any app code.

---

## 3. Target Directory Structure (unchanged)

```text
pasteguard/
├── index.html
├── package.json
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
└── src/
    ├── main.jsx
    ├── index.css                 # @tailwind base/components/utilities
    ├── App.jsx                   # 3-step airlock UI + state orchestration
    ├── data/
    │   └── samplePresets.js      # 3 synthetic judge presets
    ├── utils/
    │   ├── entropy.js            # Shannon entropy + SECRET_PATTERNS + entropy scanner
    │   └── vault.js              # Alias generator, overlap resolver, applySanitization, rehydrateText
    └── worker/
        └── sanitizerWorker.js    # Singleton ONNX pipeline + hybrid scanner
```

---

## 4. Phase-by-Phase Execution Plan

### PHASE 1 — Scaffold & Configure Vite for Web Workers

1. Scaffold, install deps (versions per §2), run `npx tailwindcss init -p`.
2. `vite.config.js`:
   ```js
   export default defineConfig({
     plugins: [react()],
     worker: { format: 'es' },
     optimizeDeps: { exclude: ['@huggingface/transformers'] },
   })
   ```
3. Worker instantiation in `App.jsx` (must be the `new URL(...)` form for Vite bundling):
   ```js
   const worker = new Worker(new URL('./worker/sanitizerWorker.js', import.meta.url), { type: 'module' })
   ```
4. Tailwind v3 wiring: `tailwind.config.js` content globs → `./index.html`, `./src/**/*.{js,jsx}`;
   `src/index.css` starts with the three `@tailwind` directives.
5. **Gate:** `npm run build` compiles with zero errors. Also smoke-test `npm run dev` loads.

### PHASE 2 — Deterministic, Entropy & Vault Engines (`src/utils/`)

**`entropy.js`**
- `calculateShannonEntropy(str)` → `H(X) = -Σ P(xᵢ)·log₂ P(xᵢ)` bits/char.
- `SECRET_PATTERNS` — an ordered array of `{ type, regex, priority }` (array, not object, so
  priority ordering is explicit and stable):
  - `JWT_TOKEN`: `/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/g`
  - `AWS_KEY`: `/\bAKIA[0-9A-Z]{16}\b/g`
  - `API_SECRET`: `/\b(sk_live_[0-9a-zA-Z]{16,}|ghp_[0-9a-zA-Z]{20,}|xox[baprs]-[0-9a-zA-Z-]{10,})\b/g`
  - `DB_URI`: `/\b(postgres|postgresql|mongodb(?:\+srv)?|mysql|redis):\/\/[^\s"']+/gi`
  - `EMAIL`: `/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g`
  - `PRIVATE_IP` **(fixed)**:
    `/\b(?:(?:10|127)(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})\b/g`
  - `PHONE` **(fixed)**:
    `/(?<![\d.])(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}(?![\d.])/g`
    (requires at least one real separator → won't eat timestamps/IDs)
- `scanHighEntropyStrings(text)` → extract quoted literals / `key = "…"` assignments with
  length ≥ 20, no whitespace, entropy > 4.2, and **not already covered by a regex span**.
- Export a `runFastPass(text)` helper: runs Stage A + B and returns deduped, range-resolved entities.

**`vault.js`**
- Deterministic, format-preserving aliases (per-session counters, one shared counter per type):
  - `EMAIL` → `user_N@example-safe.org`
  - `PRIVATE_IP` → `10.0.0.101`, `10.0.0.102`, …
  - `DB_URI` → `postgres://synth_user_N:synth_pass_N@db.internal.example:5432/app_db`
    (preserves scheme + shape so SQL/conn code stays valid)
  - `PER` → `Person_A…`, `ORG` → `Org_Alpha…`, `LOC` → `Location_X…`
  - `API_SECRET` / `JWT_TOKEN` / `HIGH_ENTROPY_SECRET` → `SYNTH_SECRET_TOKEN_N`
  - `PHONE` → `+1-555-0100`, `+1-555-0101`, … (shape-preserving; add this — spec omitted it)
- `resolveOverlaps(entities)` **(new, R5)**: sort by `start` asc then length desc; walk keeping
  occupied `[start,end)` ranges; on collision prefer priority `Regex > Entropy > BERT-NER`,
  then higher confidence, then longer span.
- `applySanitization(rawText, entities)`:
  - dedupe by `(type, value)` → resolve overlaps → for each *enabled* entity, slice-replace
    using **offsets** (build the output from segments; never `String.replace` by value).
  - Returns `{ sanitizedText, vaultEntries }` where each entry is
    `{ id, original, alias, type, source, confidence, start, end, enabled: true }`.
- `rehydrateText(llmResponseText, vaultEntries)`:
  - Only entries with `enabled === true`; sort aliases by length desc; replace via
    `split(alias).join(original)` (no regex-escaping pitfalls); returns
    `{ restoredText, restoredRanges }` so the UI can highlight restored segments.
- Custom redaction: `makeCustomEntry(word)` → alias `REDACTED_N`, source `"Manual"`.

### PHASE 3 — Neural NER Web Worker (`src/worker/sanitizerWorker.js`)

1. `import { pipeline, env } from '@huggingface/transformers'`.
2. Env flags:
   ```js
   env.allowLocalModels = false     // don't probe /public for models
   env.useBrowserCache = true       // persist weights in Cache API
   env.backends.onnx.wasm.wasmPaths = { 'ort-wasm-simd-threaded.wasm': wasmUrl, ... }  // bundled, not CDN (R8)
   ```
   (`wasmUrl` from `import … from 'onnxruntime-web/dist/…wasm?url'`; if the exact filenames
   differ in the installed version, read them from `node_modules/onnxruntime-web/dist/`.)
3. Singleton loader with **memoized promise** so concurrent ANALYZE messages never double-load:
   ```js
   const getPipe = () => pipe ??= pipeline('token-classification', 'Xenova/bert-base-NER', {
     dtype: 'q8', device: 'wasm',
     progress_callback: (p) => post({ status: 'download', progress: p }),
   })
   ```
4. Message `{ type: 'ANALYZE', text, runNeural }` handler:
   - **Fast pass:** Stage A + B → `postMessage({ status: 'fast_pass_complete', entities })` immediately.
   - **Neural pass** (if `runNeural`): await `getPipe()`, run
     `clf(text, { top_k: null, return_timestamps: 'word' })` → merge `##`/`X-` WordPiece subwords
     into word spans, drop score < 0.70 or token length ≤ 2, map word timestamps to **char
     offsets**, convert `PER/ORG/LOC/MISC` → entity records with `source: 'BERT-NER'` →
     `postMessage({ status: 'complete', entities })`.
   - **Fallback:** any throw (no WASM, blocked fetch, download error) →
     `postMessage({ status: 'neural_unavailable', reason, entities: fastPassEntities })`;
     UI keeps working on Stages A+B and shows a clear amber notice.
5. Also handle `{ type: 'CANCEL' }` / re-analysis by ignoring stale responses: every ANALYZE
   carries a `requestId`, and the UI drops responses whose id ≠ latest.

### PHASE 4 — Synthetic Test Presets (`src/data/samplePresets.js`)

Three exports, all synthetic, each `{ id, label, buttonLabel, text }`:

1. **Production Crash Log & .env Leak** — Node/Postgres stack trace containing
   `postgres://admin:K9#mP2$vL8@192.168.1.44:5432/prod_users`, `AKIAIOSFODNN7EXAMPLE`,
   `sarah.connor@cyberdyne-ind.com`, `Reported by Marcus Wright in Austin`,
   plus a high-entropy `SESSION_SECRET` line for Stage B.
2. **Customer Support Escalation Ticket** — billing dispute with
   `sk_live_51Nx92kL8mP2qR7vT9wX4yZ1a`, a formatted phone number, a street address,
   and internal org names (exercises `ORG`/`LOC` via NER).
3. **Medical Portal Debug Payload** — JSON with a 3-part `eyJ…` JWT bearer token,
   patient name, clinic organization, and `192.168.4.17`.

Each preset must deterministically trigger ≥ 4 detections across ≥ 3 different sources.

### PHASE 5 — Airlock UI (`src/App.jsx`)

Dark-slate/indigo security aesthetic, 4 zones:

1. **Trust Header** — title + subtitle; **Network Status Pill** driven by
   `navigator.onLine` + `online`/`offline` listeners:
   - Online → "Online · Model cached — safe to disconnect Wi-Fi"
   - Offline → "Offline Airgap active · zero network egress possible"
   - **AI Engine Status Pill** — download progress bar (0–100% from worker `download`
     messages), then "Local Neural + Heuristic Engine Ready", or amber
     "Heuristic-only mode (model unavailable)".
2. **Column 1 — Raw Input** — textarea + 3 preset buttons.
3. **Column 2 — Ephemeral Vault (transparency centerpiece)** — per entity: enable checkbox,
   `Original → Alias` (strikethrough original / monospace alias), color-coded source badge
   (`Regex 100%`, `Entropy 4.5b`, `BERT-NER 94%`, `Manual`), confidence, and an
   "Add custom word" input.
4. **Column 3 — Sanitized Prompt & Re-Hydration Airlock**
   - **Tab A:** sanitized text with `<mark>`-styled aliases + "Copy Safe Prompt for
     ChatGPT/Claude" (`navigator.clipboard.writeText`).
   - **Tab B:** textarea for the LLM reply + **"Simulate Cloud AI Reply"** button that
     renders a canned code/SQL response *embedding the current aliases*, then
     **Restored Local Output** showing originals re-inserted with highlight.
5. **Bottom Rubric Section** — "Safer Outcome" card (format-preserving aliases keep
   code/SQL valid) + "Honest Limitations & Safeguards" card with the three mandated
   disclosures (contextual business logic; multiline/obfuscated & non-English recall;
   volatile-RAM-only vault), noting model weights are the only persisted artifact.

**State model (enables R10):**
```js
rawText, entities[], vaultEntries[], stage ('idle'|'fast'|'complete'|'neural_unavailable'),
downloadProgress, isOnline, activeTab, llmReply, requestId
```
Sanitized text is always derived: `useMemo(() => applySanitization(rawText, entities), [rawText, entities])`.
Toggling a checkbox flips `entity.enabled` → output re-derives. No in-place mutation.

---

## 5. Verification & Acceptance Checklist

Run in order; do not claim completion until each passes:

- [ ] `npm run build` — zero errors, zero warnings that indicate missing worker/wasm assets.
- [ ] `npm run dev` — app loads; worker spawns (check DevTools → Sources → Workers).
- [ ] Preset 1/2/3 each populate all three columns with ≥ 4 detections across ≥ 3 sources.
- [ ] "Simulate Cloud AI Reply" → Re-Hydrator restores every original value end-to-end.
- [ ] Vault checkbox toggle hides/restores exactly that one entity in Tab A (both directions).
- [ ] Custom word redaction works and is reversible.
- [ ] DevTools → Network: after first model load, typing/pasting triggers **zero** requests.
- [ ] Model `.wasm` files load from our own origin (no `cdn.jsdelivr.net` entries).
- [ ] Kill Wi-Fi (`navigator.onLine` false) → airgap badge flips, fast-pass detection still works.
- [ ] Delete site cache + reload → model re-downloads with visible progress bar (proves `progress_callback`).

### Out of scope (explicitly)
README / Devpost submission text, tests beyond the manual checklist, mobile-first layout
polish, persistence of any kind, backend anything.
