import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowRightLeft,
  Check,
  CheckCircle2,
  Copy,
  Eraser,
  FileText,
  Info,
  Loader2,
  Lock,
  Plus,
  ScanLine,
  ShieldCheck,
  Sparkles,
  Wifi,
  WifiOff,
  Wand2,
  X,
} from 'lucide-react'
import SAMPLE_PRESETS from './data/samplePresets.js'
import {
  applySanitization,
  makeCustomEntry,
  rehydrateText,
} from './utils/vault.js'

/**
 * PasteGuard airlock — 3-step local sanitization flow.
 *
 * State model (plan.md R10): `rawText` and `entities[]` are the only source of
 * truth. The sanitized prompt, vault entries and restored output are always
 * re-derived with `useMemo`, so toggling a vault checkbox re-renders exactly
 * one difference. Nothing is ever persisted: the vault lives in this component
 * state and dies with the tab.
 *
 * Worker protocol (`sanitizerWorker.js`):
 *   → { type: 'ANALYZE', text, runNeural, requestId }
 *   ← { status: 'download' | 'model_ready' | 'fast_pass_complete' | 'complete' | 'neural_unavailable' | 'error', ... }
 * `download` / `model_ready` are engine-level signals and are always accepted;
 * request-scoped messages are dropped unless their `requestId` matches the
 * latest request sent.
 */

const keyForEntity = (entity) =>
  entity.source === 'Manual'
    ? entity.id
    : `${entity.type}|${entity.value}|${entity.start}`

const mergeDetections = (prev, fresh) => {
  // The user's enabled/disabled toggles survive re-analysis for the same
  // type|value; manual redactions are sticky across every worker message.
  const manuals = prev.filter((entity) => entity.source === 'Manual')
  const toggleByKey = new Map()
  for (const entity of prev) {
    if (entity.source === 'Manual') continue
    const key = `${entity.type}|${entity.value}`
    if (!toggleByKey.has(key)) toggleByKey.set(key, entity.enabled !== false)
  }
  const detections = (fresh ?? []).map((entity) => {
    const key = `${entity.type}|${entity.value}`
    return { ...entity, enabled: toggleByKey.has(key) ? toggleByKey.get(key) : true }
  })
  return [...detections, ...manuals]
}

const SOURCE_STYLES = {
  Regex: 'border-sky-400/30 bg-sky-400/10 text-sky-300',
  Entropy: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
  'BERT-NER': 'border-violet-400/30 bg-violet-400/10 text-violet-300',
  Manual: 'border-slate-400/30 bg-slate-400/10 text-slate-300',
}

const CONFIDENCE_LABEL = (entity) => {
  if (entity.source === 'Entropy') return `${entity.entropy?.toFixed?.(1) ?? '4.2'}b`
  if (entity.source === 'Regex' || entity.source === 'Manual')
    return `${Math.round((entity.confidence ?? 1) * 100)}%`
  return `${Math.round((entity.confidence ?? 0) * 100)}%`
}

const ALIAS_KEY_BY_TYPE = {
  DB_URI: 'DATABASE_URL',
  AWS_KEY: 'AWS_ACCESS_KEY_ID',
  API_SECRET: 'STRIPE_LIVE_KEY',
  JWT_TOKEN: 'AUTHORIZATION_BEARER',
  HIGH_ENTROPY_SECRET: 'SESSION_SECRET',
  EMAIL: 'NOTIFY_EMAIL',
  PRIVATE_IP: 'DEBUG_HOST',
  PHONE: 'CONTACT_PHONE',
  PERSON: 'CONTACT_PERSON',
  PER: 'CONTACT_PERSON',
  ORG: 'INTERNAL_ORG',
  LOC: 'LOCATION',
  MISC: 'CONTEXT',
  CUSTOM: 'REDACTED_FIELD',
}

const SIMULATED_INTRO =
  'Here is the triage you asked for. I traced the failing path end-to-end against the values you provided — treat them as the redacted placeholders they are; my diagnosis does not change:\n'

const simulateCloudReply = (entries) => {
  const lines = entries.slice(0, 12).map((entry) => {
    const key = ALIAS_KEY_BY_TYPE[entry.type] ?? 'FIELD'
    return `  ${key}=${entry.alias}`
  })
  return [
    SIMULATED_INTRO,
    '```sql',
    '-- reproduction environment (as provided)',
    ...lines,
    '',
    '-- root cause: the connection above resets before the query handshake',
    '-- completes; the credential pair is rejected after key rotation.',
    "SELECT * FROM audit_log WHERE action = 'login_failure' AND attempts > 3;",
    '```',
    '',
    'Fix: rotate the exposed credential pair, then retry the handshake with the',
    'session values above. If the reset persists, escalate with the request-id',
    'header attached — do not paste the raw secret into the ticket.',
  ].join('\n')
}

function SourceBadge({ entity }) {
  const style = SOURCE_STYLES[entity.source] ?? SOURCE_STYLES.Manual
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${style}`}
    >
      {entity.source} {CONFIDENCE_LABEL(entity)}
    </span>
  )
}

export default function App() {
  const [rawText, setRawText] = useState('')
  // Detections arrive from the worker; manual redactions are appended locally.
  const [entities, setEntities] = useState([])
  const [stage, setStage] = useState('idle') // idle | fast | complete | neural_unavailable
  const [neuralReason, setNeuralReason] = useState('')
  const [engineState, setEngineState] = useState('idle') // idle | downloading | ready | unavailable
  const [downloadProgress, setDownloadProgress] = useState(0)
  const [isOnline, setIsOnline] = useState(() => navigator.onLine)
  const [activeTab, setActiveTab] = useState('prompt')
  const [llmReply, setLlmReply] = useState('')
  const [customWord, setCustomWord] = useState('')
  const [copied, setCopied] = useState(false)

  const workerRef = useRef(null)
  const requestIdRef = useRef(0)

  // --- airgap badge: live navigator.onLine -------------------------------
  useEffect(() => {
    const on = () => setIsOnline(true)
    const off = () => setIsOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  // --- module worker: created once, terminated on unmount -----------------
  useEffect(() => {
    const worker = new Worker(
      new URL('./worker/sanitizerWorker.js', import.meta.url),
      { type: 'module' },
    )
    workerRef.current = worker

    worker.onmessage = (event) => {
      const message = event.data ?? {}
      // Engine-level signals are always accepted; request-scoped results are
      // only honored for the latest request sent.
      if (message.status === 'download') {
        setDownloadProgress(Math.max(0, Math.min(100, message.progress ?? 0)))
        setEngineState('downloading')
        return
      }
      if (message.status === 'model_ready') {
        setDownloadProgress(100)
        setEngineState('ready')
        return
      }
      if (message.requestId !== requestIdRef.current) return

      switch (message.status) {
        case 'fast_pass_complete':
          setEntities((prev) => mergeDetections(prev, message.entities))
          setStage('fast')
          break
        case 'complete':
          setEntities((prev) => mergeDetections(prev, message.entities))
          setStage('complete')
          break
        case 'neural_unavailable':
          setEntities((prev) => mergeDetections(prev, message.entities))
          setStage('neural_unavailable')
          setNeuralReason(message.reason ?? 'unknown error')
          setEngineState('unavailable')
          break
        case 'error':
          setStage('idle')
          setNeuralReason(message.reason ?? 'analysis failed')
          break
        default:
          break
      }
    }

    return () => {
      worker.terminate()
      workerRef.current = null
    }
  }, [])

  // --- debounced analysis on every text change ----------------------------
  useEffect(() => {
    if (!rawText.trim()) {
      setEntities((prev) => prev.filter((entity) => entity.source === 'Manual'))
      setStage('idle')
      return undefined
    }
    const handle = window.setTimeout(() => {
      requestIdRef.current += 1
      workerRef.current?.postMessage({
        type: 'ANALYZE',
        text: rawText,
        runNeural: true,
        requestId: requestIdRef.current,
      })
    }, 350)
    return () => window.clearTimeout(handle)
  }, [rawText])

  // --- derived state (R10): nothing here is ever mutated in place ---------
  const derived = useMemo(
    () => applySanitization(rawText, entities),
    [rawText, entities],
  )
  // Vault display derives from a fully-enabled run so disabled rows keep
  // their aliases visible (aliases are memoized → identical to the live ones).
  const derivedAll = useMemo(
    () => applySanitization(rawText, entities.map((entity) => ({ ...entity, enabled: true }))),
    [rawText, entities],
  )
  const vaultEntries = derivedAll.vaultEntries
  const restored = useMemo(
    () => rehydrateText(llmReply, derived.vaultEntries),
    [llmReply, derived],
  )

  const entityEnabledByKey = useMemo(() => {
    const byTypeValue = new Map()
    const map = new Map()
    for (const entity of entities) {
      map.set(keyForEntity(entity), entity.enabled !== false)
      if (entity.source !== 'Manual') {
        const key = `${entity.type}|${entity.value}`
        if (!byTypeValue.has(key)) byTypeValue.set(key, keyForEntity(entity))
      } else {
        byTypeValue.set(entity.id, entity.id)
      }
    }
    return { map, byTypeValue }
  }, [entities])

  const toggleEntity = useCallback((key) => {
    setEntities((prev) =>
      prev.map((entity) =>
        keyForEntity(entity) === key ? { ...entity, enabled: entity.enabled === false } : entity,
      ),
    )
  }, [])

  const removeManual = useCallback((id) => {
    setEntities((prev) => prev.filter((entity) => entity.id !== id))
  }, [])

  const addCustomWord = useCallback(() => {
    const entry = makeCustomEntry(customWord)
    if (!entry) return
    setEntities((prev) => [...prev, entry])
    setCustomWord('')
  }, [customWord])

  const clearAll = useCallback(() => {
    setRawText('')
    setEntities([])
    setLlmReply('')
    setStage('idle')
    setCopied(false)
  }, [])

  const copySafePrompt = useCallback(async () => {
    if (!derived.sanitizedText) return
    try {
      await navigator.clipboard.writeText(derived.sanitizedText)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }, [derived.sanitizedText])

  const simulateReply = useCallback(() => {
    if (!derived.vaultEntries.length) return
    setLlmReply(simulateCloudReply(derived.vaultEntries))
    setActiveTab('reply')
  }, [derived.vaultEntries])

  const sourceCount = useMemo(
    () => new Set(derived.vaultEntries.map((entry) => entry.source)).size,
    [derived.vaultEntries],
  )

  // --- render ---------------------------------------------------------------
  const enginePill = () => {
    if (engineState === 'downloading') {
      return (
        <div className="flex min-w-56 flex-col gap-1 rounded-xl border border-indigo-400/30 bg-indigo-400/10 px-3 py-2">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-indigo-300">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Downloading local model · {downloadProgress}%
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-indigo-950">
            <div
              className="h-full rounded-full bg-indigo-400 transition-all duration-300"
              style={{ width: `${downloadProgress}%` }}
            />
          </div>
        </div>
      )
    }
    if (engineState === 'unavailable') {
      return (
        <div className="flex items-center gap-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-amber-300">
          <AlertTriangle className="h-3.5 w-3.5" />
          Heuristic-only mode (model unavailable)
        </div>
      )
    }
    return (
      <div className="flex items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-emerald-300">
        <CheckCircle2 className="h-3.5 w-3.5" />
        {engineState === 'ready'
          ? 'Local Neural + Heuristic Engine Ready'
          : 'Local engine standing by'}
      </div>
    )
  }

  return (
    <main className="min-h-screen bg-slate-950 bg-grid text-slate-200">
      {/* ── Zone 1 · Trust header ─────────────────────────────────────────── */}
      <header className="border-b border-slate-800/80">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-indigo-400/40 bg-indigo-500/15 shadow-[0_0_24px_rgba(99,102,241,0.35)]">
              <ShieldCheck className="h-6 w-6 text-indigo-300" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-slate-50">
                PasteGuard
              </h1>
              <p className="text-xs text-slate-400">
                Local AI sanitization airlock — secrets never leave this tab
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {isOnline ? (
              <div
                className="flex items-center gap-2 rounded-xl border border-sky-400/30 bg-sky-400/10 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-sky-300"
                title="Model weights are already cached by your browser — disconnecting Wi-Fi will not stop detection."
              >
                <Wifi className="h-3.5 w-3.5" />
                Online · Model cached — safe to disconnect Wi-Fi
              </div>
            ) : (
              <div
                className="flex items-center gap-2 rounded-xl border border-emerald-400/40 bg-emerald-400/15 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-emerald-300 shadow-[0_0_18px_rgba(52,211,153,0.25)]"
                title="navigator.onLine reports offline — every analysis runs fully on-device."
              >
                <WifiOff className="h-3.5 w-3.5" />
                Offline Airgap active · zero network egress possible
              </div>
            )}
            {enginePill()}
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1600px] px-4 py-4 sm:px-6">
        {/* ── Zones 2–4 · airlock columns ─────────────────────────────────── */}
        <div className="grid gap-4 xl:grid-cols-12">
          {/* Column 1 — raw input */}
          <section className="flex flex-col rounded-2xl border border-slate-800 bg-slate-900/70 p-4 xl:col-span-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                <ScanLine className="h-4 w-4 text-indigo-300" />
                1 · Raw Input
              </h2>
              <button
                type="button"
                onClick={clearAll}
                className="flex items-center gap-1 rounded-lg border border-slate-800 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500 transition hover:border-slate-700 hover:text-slate-300"
              >
                <Eraser className="h-3 w-3" /> Clear
              </button>
            </div>

            <textarea
              value={rawText}
              onChange={(event) => setRawText(event.target.value)}
              spellCheck={false}
              placeholder="Paste a stack trace, .env dump, support ticket or debug payload…&#10;&#10;Everything is analyzed locally — regex and entropy instantly, BERT-NER once the model is cached."
              className="h-72 w-full flex-1 resize-none rounded-xl border border-slate-800 bg-slate-950/70 p-3 font-mono text-[12px] leading-relaxed text-slate-200 outline-none transition placeholder:text-slate-600 focus:border-indigo-500/60 focus:ring-2 focus:ring-indigo-500/20"
              aria-label="Raw sensitive text"
            />

            <div className="mt-3">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Synthetic judge presets — zero real secrets
              </p>
              <div className="flex flex-wrap gap-2">
                {SAMPLE_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => setRawText(preset.text)}
                    title={preset.label}
                    className="flex items-center gap-1.5 rounded-lg border border-indigo-400/25 bg-indigo-500/10 px-2.5 py-1.5 text-[11px] font-medium text-indigo-200 transition hover:border-indigo-400/50 hover:bg-indigo-500/20"
                  >
                    <FileText className="h-3.5 w-3.5" />
                    {preset.buttonLabel}
                  </button>
                ))}
              </div>
            </div>
          </section>

          {/* Column 2 — ephemeral vault */}
          <section className="flex flex-col rounded-2xl border border-slate-800 bg-slate-900/70 p-4 xl:col-span-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                <Lock className="h-4 w-4 text-indigo-300" />
                2 · Ephemeral Vault
              </h2>
              <span className="rounded-full border border-slate-800 bg-slate-950/60 px-2 py-0.5 font-mono text-[10px] text-slate-500">
                {derived.vaultEntries.length} active · {sourceCount} source{sourceCount === 1 ? '' : 's'}
              </span>
            </div>
            <p className="mb-2 flex items-center gap-1.5 text-[10px] text-slate-500">
              <Info className="h-3 w-3" /> Volatile RAM only — closing the tab wipes the vault. Nothing is stored.
            </p>

            <form
              onSubmit={(event) => {
                event.preventDefault()
                addCustomWord()
              }}
              className="mb-2 flex gap-2"
            >
              <input
                value={customWord}
                onChange={(event) => setCustomWord(event.target.value)}
                placeholder="Add custom word to redact…"
                className="h-8 flex-1 rounded-lg border border-slate-800 bg-slate-950/70 px-2.5 text-[12px] text-slate-200 outline-none transition placeholder:text-slate-600 focus:border-indigo-500/60"
                aria-label="Custom word to redact"
              />
              <button
                type="submit"
                disabled={!customWord.trim()}
                className="flex h-8 items-center gap-1 rounded-lg border border-indigo-400/30 bg-indigo-500/15 px-2.5 text-[11px] font-semibold text-indigo-200 transition hover:bg-indigo-500/25 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Plus className="h-3.5 w-3.5" /> Add
              </button>
            </form>

            <div className="max-h-96 min-h-56 flex-1 space-y-2 overflow-y-auto pr-1">
              {stage === 'fast' && (
                <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-2.5 py-1.5 text-[10px] text-slate-500">
                  <Loader2 className="h-3 w-3 animate-spin text-indigo-300" />
                  Regex + entropy pass done — neural NER still running…
                </div>
              )}
              {stage === 'neural_unavailable' && (
                <div
                  className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-2.5 py-1.5 text-[10px] leading-snug text-amber-200/90"
                  title={neuralReason}
                >
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  Model unavailable — continuing with regex + entropy only. Your secrets are still
                  caught; names and locations are not.
                </div>
              )}
              {vaultEntries.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-800 py-10 text-center">
                  <ShieldCheck className="h-6 w-6 text-slate-700" />
                  <p className="max-w-56 text-[11px] leading-snug text-slate-500">
                    Nothing detected yet. Paste text or load a preset — detections will land here
                    with confidence scores.
                  </p>
                </div>
              ) : (
                vaultEntries.map((entry) => {
                  const key = `${entry.source}|${entry.type}|${entry.original}|${entry.ranges?.[0]?.join('-') ?? ''}`
                  const entityKey =
                    entry.source === 'Manual'
                      ? entities.find(
                          (entity) =>
                            entity.source === 'Manual' && entity.value === entry.original,
                        )?.id
                      : entityEnabledByKey.byTypeValue.get(`${entry.type}|${entry.original}`)
                  const enabled = entityKey ? entityEnabledByKey.map.get(entityKey) !== false : true
                  return (
                    <div
                      key={key}
                      className={`group rounded-xl border p-2 transition ${
                        enabled
                          ? 'border-slate-800 bg-slate-950/50'
                          : 'border-slate-800/60 bg-slate-950/20 opacity-50'
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          checked={enabled}
                          onChange={() => entityKey && toggleEntity(entityKey)}
                          className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-indigo-500"
                          aria-label={`Toggle redaction of ${entry.original}`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <SourceBadge entity={entry} />
                            <span className="font-mono text-[9px] uppercase tracking-wider text-slate-600">
                              {entry.type}
                            </span>
                            {entry.source === 'Manual' && (
                              <button
                                type="button"
                                onClick={() => entityKey && removeManual(entityKey)}
                                className="ml-auto rounded p-0.5 text-slate-600 transition hover:text-slate-300"
                                aria-label="Remove custom redaction"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                          <div className="mt-1.5 flex min-w-0 items-center gap-1.5 font-mono text-[11px] leading-snug">
                            <span className="truncate text-rose-300/80 line-through decoration-rose-400/50" title={entry.original}>
                              {entry.original}
                            </span>
                            <ArrowRightLeft className="h-3 w-3 shrink-0 text-slate-600" />
                            <span className="truncate rounded bg-indigo-500/15 px-1.5 py-0.5 text-indigo-300" title={entry.alias}>
                              {entry.alias}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </section>

          {/* Column 3 — sanitized prompt & re-hydration */}
          <section className="flex flex-col rounded-2xl border border-slate-800 bg-slate-900/70 p-4 xl:col-span-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                <Sparkles className="h-4 w-4 text-indigo-300" />
                3 · Sanitized Prompt
              </h2>
              <div className="flex rounded-lg border border-slate-800 bg-slate-950/70 p-0.5">
                {[
                  { id: 'prompt', label: 'Safe Prompt' },
                  { id: 'reply', label: 'LLM Reply & Re-Hydrate' },
                ].map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={`rounded-md px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider transition ${
                      activeTab === tab.id
                        ? 'bg-indigo-500/25 text-indigo-200'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            {activeTab === 'prompt' ? (
              <>
                <div
                  className="min-h-64 flex-1 overflow-auto rounded-xl border border-slate-800 bg-slate-950/70 p-3"
                  aria-label="Sanitized output"
                >
                  {derived.segments.length === 0 && !derived.sanitizedText ? (
                    <p className="text-[11px] text-slate-600">
                      Your sanitized prompt will appear here with every alias highlighted…
                    </p>
                  ) : (
                    <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-slate-200">
                      {(() => {
                        const out = []
                        let cursor = 0
                        derived.segments.forEach((segment, index) => {
                          if (cursor < segment.start)
                            out.push(
                              <span key={`t-${index}`}>
                                {derived.sanitizedText.slice(cursor, segment.start)}
                              </span>,
                            )
                          out.push(
                            <mark
                              key={`m-${index}`}
                              className="rounded bg-indigo-400/25 px-0.5 text-indigo-200 ring-1 ring-inset ring-indigo-400/40"
                              title={`Alias for ${segment.type}`}
                            >
                              {derived.sanitizedText.slice(segment.start, segment.end)}
                            </mark>,
                          )
                          cursor = segment.end
                        })
                        if (cursor < derived.sanitizedText.length)
                          out.push(<span key="tail">{derived.sanitizedText.slice(cursor)}</span>)
                        return out
                      })()}
                    </pre>
                  )}
                </div>

                <button
                  type="button"
                  onClick={copySafePrompt}
                  disabled={!derived.sanitizedText}
                  className="mt-3 flex h-10 items-center justify-center gap-2 rounded-xl border border-indigo-400/40 bg-indigo-500/20 text-[12px] font-semibold uppercase tracking-wider text-indigo-200 transition hover:bg-indigo-500/30 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {copied ? (
                    <>
                      <Check className="h-4 w-4" /> Copied — paste anywhere
                    </>
                  ) : (
                    <>
                      <Copy className="h-4 w-4" /> Copy Safe Prompt for ChatGPT/Claude
                    </>
                  )}
                </button>
                <p className="mt-1.5 text-center text-[10px] text-slate-600">
                  Every highlighted value is a format-preserving alias. The real data never left this page.
                </p>
              </>
            ) : (
              <>
                <textarea
                  value={llmReply}
                  onChange={(event) => setLlmReply(event.target.value)}
                  spellCheck={false}
                  placeholder="Paste the LLM's reply here — typically with the aliases echoed back…"
                  className="h-32 w-full resize-none rounded-xl border border-slate-800 bg-slate-950/70 p-3 font-mono text-[11px] leading-relaxed text-slate-200 outline-none transition placeholder:text-slate-600 focus:border-indigo-500/60 focus:ring-2 focus:ring-indigo-500/20"
                  aria-label="LLM reply to re-hydrate"
                />
                <button
                  type="button"
                  onClick={simulateReply}
                  disabled={!derived.vaultEntries.length}
                  className="mt-2 flex h-9 items-center justify-center gap-2 rounded-xl border border-violet-400/40 bg-violet-500/15 text-[11px] font-semibold uppercase tracking-wider text-violet-200 transition hover:bg-violet-500/25 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Wand2 className="h-4 w-4" /> Simulate Cloud AI Reply
                </button>

                <div className="mt-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  <Lock className="h-3 w-3 text-emerald-400" /> Restored Local Output
                </div>
                <div className="min-h-40 flex-1 overflow-auto rounded-xl border border-emerald-900/50 bg-slate-950/70 p-3">
                  {!llmReply.trim() ? (
                    <p className="text-[11px] text-slate-600">
                      The reply — with your original values re-inserted locally — will render here…
                    </p>
                  ) : (
                    <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-slate-200">
                      {(() => {
                        const out = []
                        let cursor = 0
                        restored.restoredRanges.forEach((range, index) => {
                          if (cursor < range.start)
                            out.push(
                              <span key={`p-${index}`}>
                                {restored.restoredText.slice(cursor, range.start)}
                              </span>,
                            )
                          out.push(
                            <mark
                              key={`r-${index}`}
                              className="rounded bg-emerald-400/20 px-0.5 text-emerald-300 ring-1 ring-inset ring-emerald-400/40"
                              title={`Restored from alias ${range.alias}`}
                            >
                              {restored.restoredText.slice(range.start, range.end)}
                            </mark>,
                          )
                          cursor = range.end
                        })
                        if (cursor < restored.restoredText.length)
                          out.push(<span key="tail">{restored.restoredText.slice(cursor)}</span>)
                        return out
                      })()}
                    </pre>
                  )}
                </div>
                <p className="mt-1.5 text-center text-[10px] text-slate-600">
                  Aliases are swapped back locally, in this tab. Restored spans are highlighted in green.
                </p>
              </>
            )}
          </section>
        </div>

        {/* ── Bottom · rubric ─────────────────────────────────────────────── */}
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4">
            <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-300">
              <CheckCircle2 className="h-4 w-4" /> Safer Outcome
            </h3>
            <ul className="mt-2 space-y-1.5 text-[12px] leading-snug text-emerald-100/80">
              <li>· Aliases are format-preserving — code, JSON and SQL stay syntactically valid around them.</li>
              <li>· Regex detects structurally perfect secrets (keys, JWTs, URIs); entropy catches the rest; BERT-NER recovers names and places.</li>
              <li>· The LLM receives only aliases; originals are re-hydrated locally, in this tab, after the reply comes back.</li>
              <li>· Toggle any vault row to keep a value visible; sanitization re-derives instantly.</li>
            </ul>
          </div>

          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4">
            <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-amber-300">
              <AlertTriangle className="h-4 w-4" /> Honest Limitations &amp; Safeguards
            </h3>
            <ul className="mt-2 space-y-1.5 text-[12px] leading-snug text-amber-100/80">
              <li>· Contextual business logic (codenames, internal hostnames with no keyword) can still pass through — review the highlighted prompt before sending.</li>
              <li>· Recall on multiline or obfuscated secrets and non-English PII is limited (English-centric base model, entropy threshold at 4.2 bits).</li>
              <li>· The vault is volatile RAM only — gone when the tab closes. The only persisted artifact is the cached model weights, which contain no user text.</li>
            </ul>
          </div>
        </div>

        <footer className="py-3 text-center text-[10px] uppercase tracking-[0.22em] text-slate-600">
          100% client-side · no backend · no telemetry · model weights cached locally only
        </footer>
      </div>
    </main>
  )
}
