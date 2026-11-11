import { useEffect, useRef } from 'react'

/**
 * Phase 1 scaffold. The module worker is instantiated with the `new URL(...)`
 * form so Vite bundles it (see `worker: { format: 'es' }` in vite.config.js).
 * Task 3 replaces the placeholder handler in sanitizerWorker.js with the real
 * ONNX pipeline; Task 5 replaces this placeholder UI.
 */
export default function App() {
  const workerRef = useRef(null)

  useEffect(() => {
    const worker = new Worker(
      new URL('./worker/sanitizerWorker.js', import.meta.url),
      { type: 'module' },
    )
    workerRef.current = worker
    return () => worker.terminate()
  }, [])

  return (
    <main className="bg-grid flex min-h-screen items-center justify-center">
      <div className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-100">
          PasteGuard
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          Phase 1 scaffold — module worker wired, UI lands in Phase 5.
        </p>
      </div>
    </main>
  )
}
