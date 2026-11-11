/**
 * PasteGuard neural worker.
 *
 * All ONNX inference happens here so React never blocks. The worker owns the
 * singleton transformers.js pipeline, the model download progress stream and the
 * hybrid (regex + entropy + BERT-NER) merge.
 */

import { env, pipeline } from '@huggingface/transformers'
// Bundle ORT's wasm factory + binary on our own origin. Without this, ORT would
// fetch them from cdn.jsdelivr.net (see transformers.js onnx backend defaults).
import wasmFactoryUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url'
import wasmBinaryUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'
import { runFastPass } from '../utils/entropy.js'
import { resolveOverlaps } from '../utils/vault.js'

const MODEL_ID = 'Xenova/bert-base-NER'

let pipe = null
let pipePromise = null
let currentRequestId = 0

const fileProgress = new Map()

function post(message) {
  self.postMessage(message)
}

function configureEnvironment() {
  env.allowLocalModels = false
  env.useBrowserCache = true
  env.useWasmCache = true

  const onnx = env.backends?.onnx
  if (!onnx?.wasm) {
    console.warn('[PasteGuard] ONNX wasm backend unavailable; neural pass will be skipped.')
    return
  }
  onnx.wasm.wasmPaths = {
    mjs: wasmFactoryUrl,
    wasm: wasmBinaryUrl,
  }
}

function handleProgress(progress) {
  if (!progress?.file) return
  const value =
    progress.status === 'done'
      ? 100
      : progress.status === 'initiate'
        ? 0
        : Number(progress.progress ?? 0)

  fileProgress.set(progress.file, value)
  const values = [...fileProgress.values()]
  const average = values.length
    ? values.reduce((sum, item) => sum + item, 0) / values.length
    : 0

  post({
    status: 'download',
    progress: Math.round(average),
    file: progress.file,
    requestId: currentRequestId,
  })
}

function getPipe() {
  if (pipe) return Promise.resolve(pipe)
  if (pipePromise) return pipePromise

  pipePromise = pipeline('token-classification', MODEL_ID, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: handleProgress,
  })
    .then((loaded) => {
      pipe = loaded
      post({ status: 'model_ready', requestId: currentRequestId })
      return loaded
    })
    .catch((error) => {
      pipePromise = null
      throw error
    })

  return pipePromise
}

/** Lowercase + strip diacritics, keeping a map from normalized index to original index. */
function normalizeWithMap(text) {
  const chars = []
  const map = []
  for (let i = 0; i < text.length; i += 1) {
    const normalized = text[i]
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
    for (const char of normalized) {
      chars.push(char)
      map.push(i)
    }
  }
  return { normalized: chars.join(''), map }
}

/**
 * Map WordPiece token indexes to character offsets by scanning the normalized
 * text in token order. The cursor prevents a repeated token from matching an
 * earlier occurrence; continuation pieces (`##...`) must follow their parent.
 */
function computeTokenSpans(text, tokens) {
  const { normalized, map } = normalizeWithMap(text)
  const spans = new Map()
  let cursor = 0

  for (let i = 0; i < tokens.length; i += 1) {
    const piece = tokens[i]
    if (!piece || piece.startsWith('[')) continue

    const continuation = piece.startsWith('##')
    const clean = continuation ? piece.slice(2) : piece
    if (!clean) continue

    let index = normalized.indexOf(clean, cursor)
    if (index === -1) {
      // Recovery for unusual normalizer output (e.g. accent expansion).
      index = normalized.indexOf(clean, 0)
      if (index === -1) continue
    }

    const start = map[index]
    const lastIndex = Math.min(index + clean.length - 1, map.length - 1)
    const end = map[lastIndex] + 1
    spans.set(i, { start, end })
    cursor = index + clean.length
  }

  return spans
}

function splitBio(entity) {
  const value = String(entity ?? '').toUpperCase()
  if (value === 'O') return null
  const match = value.match(/^([BIES])-(.+)$/)
  if (match) return { prefix: match[1], tag: match[2] }
  return { prefix: 'I', tag: value }
}

function toEntityType(tag) {
  const value = String(tag ?? '').toUpperCase()
  if (value === 'PER' || value === 'PERSON') return 'PERSON'
  if (value === 'ORG') return 'ORG'
  if (value === 'LOC') return 'LOC'
  return 'MISC'
}

async function runNeuralPass(classifier, text) {
  if (!text?.trim()) return []

  // The pipeline truncates to the model's max length; `_encode_text` returns the
  // token strings for the same (untruncated) input, which is all we need to map
  // prediction indexes back to character offsets.
  let tokenStrings = classifier.tokenizer._encode_text(text)
  if (!Array.isArray(tokenStrings)) return []
  if (tokenStrings[0] !== '[CLS]') tokenStrings = ['[CLS]', ...tokenStrings]

  const predictions = await classifier(text)
  const spans = computeTokenSpans(text, tokenStrings)

  const sorted = [...predictions]
    .filter((prediction) => prediction && Number.isFinite(prediction.score))
    .sort((a, b) => a.index - b.index)

  const groups = []
  let current = null

  for (const prediction of sorted) {
    if (prediction.score < 0.7) continue
    const span = spans.get(prediction.index)
    if (!span) continue

    const bio = splitBio(prediction.entity)
    if (!bio) continue

    const type = toEntityType(bio.tag)
    const continues = bio.prefix === 'I' || bio.prefix === 'E'

    if (current && current.type === type && continues) {
      current.end = Math.max(current.end, span.end)
      current.score = Math.min(current.score, prediction.score)
    } else {
      current = { type, start: span.start, end: span.end, score: prediction.score }
      groups.push(current)
    }
  }

  const entities = []
  for (const group of groups) {
    const value = text.slice(group.start, group.end).trimEnd().replace(/[.,;:!?)\]]+$/, '')
    if (value.length <= 2) continue
    const start = group.start
    const end = start + value.length
    entities.push({
      type: group.type,
      value,
      start,
      end,
      source: 'BERT-NER',
      confidence: Number(Math.max(0.7, Math.min(1, group.score)).toFixed(2)),
    })
  }

  return entities
}

function dedupeEntities(entities) {
  const seen = new Set()
  return entities.filter((entity) => {
    const key = `${entity.type}|${entity.value}|${entity.start}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

self.onmessage = async (event) => {
  const { type, text, runNeural, requestId } = event.data ?? {}
  if (type !== 'ANALYZE') return

  const id = requestId ?? (currentRequestId += 1)
  currentRequestId = id

  let fastEntities = []
  try {
    fastEntities = runFastPass(text ?? '')
  } catch (error) {
    post({
      status: 'error',
      requestId: id,
      reason: `Fast pass failed: ${error?.message ?? error}`,
    })
    return
  }

  post({ status: 'fast_pass_complete', requestId: id, entities: fastEntities })

  if (!runNeural) {
    post({ status: 'complete', requestId: id, entities: fastEntities, neural: false })
    return
  }

  try {
    const classifier = await getPipe()
    const neuralEntities = await runNeuralPass(classifier, text ?? '')
    const merged = resolveOverlaps(dedupeEntities([...fastEntities, ...neuralEntities]))
    post({ status: 'complete', requestId: id, entities: merged, neural: true })
  } catch (error) {
    const reason = error?.message ?? String(error)
    post({
      status: 'neural_unavailable',
      requestId: id,
      reason,
      entities: fastEntities,
    })
  }
}

configureEnvironment()