import { useEffect } from 'react'

/**
 * Phase 1 scaffold. The module worker is instantiated with the `new URL(...)`
 * form so Vite bundles it (see `worker: { format: 'es' }` in vite.config.js).
 * sanitizerWorker.js is currently a stub (`self.onmessage = () => {}`); Task 3
 * fills it with the real ONNX pipeline, and Task 5 replaces this UI.
 */
export default function App() {
  useEffect(() => {
    const worker = new Worker(
      new URL('./worker/sanitizerWorker.js', import.meta.url),
      { type: 'module' },
    )
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
