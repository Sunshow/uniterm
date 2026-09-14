import Zmodem from 'zmodem.js/src/zmodem_browser'
import {
  SessionEndZmodem,
  SessionEndZmodemWithTrailing,
  SessionStartZmodem,
  SessionWriteBinary,
  AppendFileBase64,
  FileSize,
  ReadFileChunkBase64,
  OpenDirectoryDialog,
  OpenMultipleFilesDialog,
} from '../../bindings/github.com/ys-ll/uniterm/app'
import { Events } from '@wailsio/runtime'
import { useZmodemStore } from '../stores/zmodemStore'
import { queuedSessionWrite } from './sessionWriter'

const dialogLocks = new Set<string>()
const TRANSFER_TIMEOUT_MS = 20_000
const CANCEL_WRITE_TIMEOUT_MS = 2_000
const END_MODE_ATTEMPTS = 3
const CANCEL_SEQUENCE = new Uint8Array([
  0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18,
  0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08,
])

interface TransferControl {
  promise: Promise<never>
  abort(error?: Error): void
}

interface ActivityWatchdog {
  start(): void
  touch(): void
  stop(): void
  race<T>(promise: Promise<T>): Promise<T>
}

export interface ZmodemServiceOptions {
  sessionId: string
  direction?: 'upload' | 'download'
  getDefaultDownloadDir?: () => string
  onComplete?: (files: string[], hint?: string) => void
  onError?: (err: string) => void
  onWarning?: (warning: string) => void
  onTerminalRestoreState?: (restoring: boolean) => void
  onRegister?: (abort: () => void) => void
  onUnregister?: () => void
}

export function startZmodemService(options: ZmodemServiceOptions) {
  let binaryUnsub: (() => void) | null = null
  let currentZsession: import('zmodem.js/src/zmodem_browser').Session | null = null
  let aborted = false
  let disposed = false
  let notified = false
  let writeChain: Promise<void> = Promise.resolve()
  let writeFailure: unknown = null
  let suppressSender = false
  let cancelPromise: Promise<void> | null = null
  let startSessionPromise: Promise<void> | null = null
  let endSessionPromise: Promise<void> | null = null
  let captureTrailingOutput = false
  const trailingOutput: number[] = []
  const { sessionId } = options
  const abortCtl = createTransferControl()
  const watchdog = createActivityWatchdog(TRANSFER_TIMEOUT_MS)

  const notifyComplete = (files: string[], hint?: string) => {
    if (notified) return
    notified = true
    watchdog.stop()
    if (hint === undefined) options.onComplete?.(files)
    else options.onComplete?.(files, hint)
  }
  const notifyError = (error: unknown) => {
    if (notified) return
    notified = true
    watchdog.stop()
    options.onError?.(errorMessage(error))
  }

  function sender(octets: number[]) {
    if (aborted || disposed || suppressSender) return
    const base64 = arrayBufferToBase64(new Uint8Array(octets))
    writeChain = writeChain
      .then(() => {
        if (aborted || disposed) return
        return SessionWriteBinary(sessionId, base64)
      })
      .then(() => watchdog.touch())
      .catch((error) => {
        writeFailure = writeFailure || error
        abortCtl.abort(error instanceof Error ? error : new Error(errorMessage(error)))
      })
  }

  async function drainWrites() {
    const pending = writeChain
    await watchdog.race(pending)
    if (writeFailure) throw writeFailure
  }

  function startBackendMode(): Promise<void> {
    if (!startSessionPromise) startSessionPromise = SessionStartZmodem(sessionId)
    return startSessionPromise!
  }

  function endBackendMode(trailing?: Uint8Array): Promise<void> {
    if (endSessionPromise) return endSessionPromise
    endSessionPromise = (async () => {
      // A quick cancel can arrive while the start bridge call is still in
      // flight. Never let that delayed start overtake the matching end.
      try { await startSessionPromise } catch (_) {}
      if (trailing && trailing.length > 0) {
        // Decoding advances the session's streaming decoder, so this call is
        // deliberately not retried: replaying it could duplicate output or
        // corrupt decoder state if the first response was lost.
        try {
          await watchdog.race(
            SessionEndZmodemWithTrailing(sessionId, arrayBufferToBase64(trailing)),
          )
          return
        } catch (error) {
          // The bridge may have failed before the backend handled the call.
          // A plain end is idempotent and prevents binary mode remaining set;
          // preserve the original error because the prompt could be missing.
          try { await withTimeout(SessionEndZmodem(sessionId), CANCEL_WRITE_TIMEOUT_MS) } catch (_) {}
          throw error
        }
      }
      let lastError: unknown
      for (let attempt = 0; attempt < END_MODE_ATTEMPTS; attempt++) {
        try {
          await SessionEndZmodem(sessionId)
          return
        } catch (error) {
          lastError = error
        }
      }
      throw lastError
    })()
    return endSessionPromise
  }

  function cancel(reason = new Error('aborted')): Promise<void> {
    if (cancelPromise) return cancelPromise
    aborted = true
    watchdog.stop()
    abortCtl.abort(reason)
    suppressSender = true
    try { currentZsession?.abort() } catch (_) {}

    cancelPromise = (async () => {
      // Preserve protocol ordering where possible. A broken in-flight bridge
      // call is bounded so it cannot prevent local recovery.
      try { await withTimeout(writeChain, CANCEL_WRITE_TIMEOUT_MS) } catch (_) {}
      try {
        await withTimeout(
          SessionWriteBinary(sessionId, arrayBufferToBase64(CANCEL_SEQUENCE)),
          CANCEL_WRITE_TIMEOUT_MS,
        )
      } catch (_) {
        // Local cleanup below must run even if the session bridge is broken.
      } finally {
        queuedSessionWrite(sessionId, '\x03')
        await endBackendMode()
      }
    })()
    return cancelPromise
  }

  async function fail(error: unknown) {
    const reason = error instanceof Error ? error : new Error(errorMessage(error))
    try {
      await cancel(reason)
      notifyError(error)
    } catch (cleanupError) {
      notifyError(cleanupError)
    }
  }

  const sentry = new Zmodem.Sentry({
    // A receive session can deliver the final "OO" and the restored shell
    // prompt in one chunk. zmodem.js strips OO and forwards the remaining
    // bytes here; retain them until the completion message has been shown.
    to_terminal: (octets: number[]) => {
      if (captureTrailingOutput && octets.length > 0) trailingOutput.push(...octets)
    },
    sender,
    on_detect: (detection: import('zmodem.js/src/zmodem_browser').Detection) => {
      if (disposed || dialogLocks.has(sessionId)) return
      const zsession = detection.confirm()
      currentZsession = zsession
      dialogLocks.add(sessionId)

      const run = async () => {
        if (zsession.type === 'send') {
          const store = useZmodemStore()
          const pendingPaths = store.getPendingUploadFiles(sessionId)
          const paths: string[] = pendingPaths && pendingPaths.length > 0
            ? pendingPaths
            : await abortable(
              OpenMultipleFilesDialog().catch((err: unknown) => dialogCancelToEmpty<string[]>(err, [])),
              abortCtl,
            )
          if (paths.length === 0) {
            await cancel()
            notifyComplete([])
            return
          }
          watchdog.start()
          const result = await handleSend(zsession, sessionId, paths, drainWrites, () => aborted, abortCtl, watchdog)
          await endBackendMode()
          dialogLocks.delete(sessionId)
          notifyComplete(result.files, result.hint)
        } else {
          const configuredDir = options.getDefaultDownloadDir?.() || ''
          const saveDir: string = configuredDir.trim() ? configuredDir : await abortable(
            OpenDirectoryDialog().catch((err: unknown) => dialogCancelToEmpty<string>(err, '')),
            abortCtl,
          )
          if (!saveDir) {
            await cancel()
            notifyComplete([])
            return
          }
          watchdog.start()
          const files = await handleReceive(
            zsession, sessionId, saveDir, () => aborted, abortCtl, watchdog,
            () => {
              captureTrailingOutput = true
              options.onTerminalRestoreState?.(true)
            },
          )
          try {
            await endBackendMode(Uint8Array.from(trailingOutput))
            trailingOutput.length = 0
            dialogLocks.delete(sessionId)
            notifyComplete(files)
          } catch (error) {
            // The transfer itself has completed. Failure to restore trailing
            // shell output must not enter fail()/cancel(), which would send a
            // ZMODEM cancel sequence and Ctrl+C to the restored shell.
            dialogLocks.delete(sessionId)
            notifyComplete(files)
            options.onWarning?.(`Shell output restore failed: ${errorMessage(error)}`)
          } finally {
            options.onTerminalRestoreState?.(false)
          }
        }
      }

      run().catch(async (err: unknown) => {
        if (disposed) return
        if (errorMessage(err) === 'aborted') {
          try {
            await cancel()
            notifyComplete([])
          } catch (cleanupError) {
            notifyError(cleanupError)
          }
          return
        }
        await fail(err)
      }).finally(() => {
        dialogLocks.delete(sessionId)
        watchdog.stop()
      })
    },
    on_retract: () => { currentZsession = null },
  })

  binaryUnsub = Events.On('session:binary', (ev) => {
    const payload: { id: string; data: string } = ev.data
    if (payload.id !== sessionId || disposed) return
    watchdog.touch()
    try {
      sentry.consume(base64ToUint8Array(payload.data))
    } catch (err) {
      void fail(err)
    }
  })

  const svc = {
    start: (data: string) => {
      if (disposed) return
      void startBackendMode().catch(err => { void fail(err) })
      svc.consume(data)
    },
    consume: (data: string) => {
      if (disposed) return
      watchdog.touch()
      try {
        sentry.consume(new TextEncoder().encode(data))
      } catch (err) {
        void fail(err)
      }
    },
    dispose: async () => {
      if (disposed) return
      disposed = true
      watchdog.stop()
      abortCtl.abort(new Error('aborted'))
      binaryUnsub?.()
      binaryUnsub = null
      dialogLocks.delete(sessionId)
      options.onUnregister?.()
      // Pair disposal with an ordered end even when the component is
      // unmounted before the pending start bridge call completes.
      try { await endBackendMode() } catch (_) {}
    },
    isAborted: () => aborted,
    abort: async () => {
      try { await cancel() } catch (err) { notifyError(err) }
    },
  }

  options.onRegister?.(() => { void svc.abort() })
  return svc
}

async function handleSend(
  zsession: import('zmodem.js/src/zmodem_browser').Session,
  sessionId: string,
  paths: string[],
  drainWrites: () => Promise<void>,
  isAborted: () => boolean,
  abortCtl: TransferControl,
  watchdog: ActivityWatchdog,
): Promise<{ files: string[]; hint?: string }> {
  const store = useZmodemStore()
  const files: string[] = []
  for (let i = 0; i < paths.length; i++) {
    if (isAborted()) throw new Error('aborted')
    const path = paths[i]
    const filename = path.split(/[\\/]/).pop() || 'unknown'
    const transferId = `${sessionId}-up-${i}`
    const fileSize = Number(await watchdog.race<number>(FileSize(path)))
    store.addTransfer(sessionId, {
      id: transferId, sessionId, filename, size: fileSize, transferred: 0,
      direction: 'upload', status: 'transferring', speed: 0,
    })

    const xfer: any = await abortable(
      watchdog.race((zsession as any).send_offer({
        name: filename, size: fileSize, mode: 0o644, mtime: new Date(),
        files_remaining: paths.length - i,
        bytes_remaining: fileSize,
      })),
      abortCtl,
    )
    if (!xfer) {
      store.updateTransfer(sessionId, transferId, {
        status: 'cancelled', error: 'File exists, please delete and retry',
      })
      await watchdog.race(zsession.close())
      return {
        files,
        hint: `"${filename}" already exists. Please delete it first (rm "${filename}"), then retry.`,
      }
    }

    await abortable(
      sendFileChunks(xfer, path, fileSize, CHUNK, sessionId, transferId, drainWrites, isAborted, watchdog),
      abortCtl,
    )
    store.updateTransfer(sessionId, transferId, { status: 'completed', transferred: fileSize })
    files.push(filename)
  }
  if (!isAborted()) await abortable(watchdog.race(zsession.close()), abortCtl)
  return { files }
}

const CHUNK = 8192
const READ_CHUNK = CHUNK * 16
const DOWNLOAD_BATCH = 64 * 1024

async function sendFileChunks(
  xfer: any, path: string, size: number, chunkSize: number,
  sessionId: string, transferId: string,
  drainWrites: () => Promise<void>,
  isAborted: () => boolean,
  watchdog: ActivityWatchdog,
) {
  const store = useZmodemStore()
  let offset = 0
  while (offset < size) {
    if (isAborted()) throw new Error('aborted')
    const length = Math.min(READ_CHUNK, size - offset)
    const encoded = await watchdog.race<string>(ReadFileChunkBase64(path, offset, length))
    const data = base64ToUint8Array(encoded)
    if (data.length === 0) throw new Error(`Read empty chunk at offset ${offset}`)
    for (let chunkOffset = 0; chunkOffset < data.length;) {
      if (isAborted()) throw new Error('aborted')
      const end = Math.min(chunkOffset + chunkSize, data.length)
      const chunk = Array.from(data.slice(chunkOffset, end)) as number[]
      xfer.send(chunk)
      await drainWrites()
      chunkOffset = end
      offset += chunk.length
      watchdog.touch()
      store.updateTransfer(sessionId, transferId, { transferred: offset })
    }
  }
  await watchdog.race(xfer.end([]))
  await drainWrites()
}

async function handleReceive(
  zsession: import('zmodem.js/src/zmodem_browser').Session,
  sessionId: string,
  saveDir: string,
  isAborted: () => boolean,
  abortCtl: TransferControl,
  watchdog: ActivityWatchdog,
  onSessionEnd: () => void,
): Promise<string[]> {
  const store = useZmodemStore()
  const files: string[] = []
  const activeOffers = new Set<Promise<void>>()
  let offerCount = 0
  let offerFailure: unknown = null
  const windowsPath = /^[a-zA-Z]:[\\/]/.test(saveDir) || saveDir.startsWith('\\\\')
  const sep = windowsPath ? '\\' : '/'
  let endSession!: () => void
  const sessionEnded = new Promise<void>(resolve => { endSession = resolve })
  zsession.on('session_end', () => {
    onSessionEnd()
    endSession()
  })

  zsession.on('offer', (offer: any) => {
    if (isAborted()) {
      try { offer.skip() } catch (_) {}
      return
    }
    const task = receiveOffer(offer, saveDir, sep, sessionId, offerCount++, store, watchdog, files)
    activeOffers.add(task)
    task.catch(err => {
      offerFailure = offerFailure || err
      abortCtl.abort(err instanceof Error ? err : new Error(errorMessage(err)))
    }).finally(() => activeOffers.delete(task))
  })

  await abortable(watchdog.race(zsession.start()), abortCtl)
  await abortable(watchdog.race(sessionEnded), abortCtl)
  while (activeOffers.size > 0) {
    await abortable(watchdog.race(Promise.allSettled([...activeOffers]).then(() => undefined)), abortCtl)
  }
  if (offerFailure) throw offerFailure
  return files
}

async function receiveOffer(
  offer: any, saveDir: string, sep: string, sessionId: string, offerIndex: number,
  store: ReturnType<typeof useZmodemStore>, watchdog: ActivityWatchdog, files: string[],
) {
  watchdog.touch()
  const details = offer.get_details()
  const filename = safeDownloadFilename(details.name, sep === '\\')
  const size = details.size || 0
  const finalSavePath = `${saveDir}${saveDir.endsWith('/') || saveDir.endsWith('\\') ? '' : sep}${filename}`
  const transferId = `${sessionId}-dl-${offerIndex}`
  store.addTransfer(sessionId, {
    id: transferId, sessionId, filename, size, transferred: 0,
    direction: 'download', status: 'transferring', speed: 0, savePath: finalSavePath,
  })

  let received = 0
  let buffer: number[] = []
  let bufferOffset = 0
  let pendingWrites: Promise<void> = Promise.resolve()
  const flush = () => {
    while (buffer.length > 0) {
      const bytes = buffer.splice(0, Math.min(DOWNLOAD_BATCH, buffer.length))
      const offset = bufferOffset
      bufferOffset += bytes.length
      pendingWrites = pendingWrites.then(async () => {
        await watchdog.race(AppendFileBase64(
          finalSavePath, arrayBufferToBase64(Uint8Array.from(bytes)), offset,
        ))
        watchdog.touch()
      })
    }
  }
  const onInput = (payload: number[]) => {
    buffer.push(...payload)
    received += payload.length
    watchdog.touch()
    store.updateTransfer(sessionId, transferId, { transferred: received })
    if (buffer.length >= DOWNLOAD_BATCH) flush()
  }

  try {
    await watchdog.race(offer.accept({ on_input: onInput }))
    flush()
    await watchdog.race(pendingWrites)
    store.updateTransfer(sessionId, transferId, { status: 'completed', transferred: received })
    files.push(finalSavePath)
  } catch (err) {
    store.updateTransfer(sessionId, transferId, { status: 'error', error: errorMessage(err) })
    throw err
  }
}

function createActivityWatchdog(timeoutMs: number): ActivityWatchdog {
  let timer: ReturnType<typeof setTimeout> | null = null
  let rejectTimeout: ((error: Error) => void) | null = null
  let timeoutPromise: Promise<never> = new Promise(() => {})
  let running = false

  const arm = () => {
    if (!running) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      rejectTimeout?.(new Error(`ZMODEM transfer timed out after ${timeoutMs / 1000}s without activity`))
    }, timeoutMs)
  }
  return {
    start() {
      if (running) return
      running = true
      timeoutPromise = new Promise<never>((_, reject) => { rejectTimeout = reject })
      arm()
    },
    touch: arm,
    stop() {
      running = false
      if (timer) clearTimeout(timer)
      timer = null
      rejectTimeout = null
    },
    race<T>(promise: Promise<T>) {
      return running ? Promise.race([promise, timeoutPromise]) : promise
    },
  }
}

async function abortable<T>(promise: Promise<T>, control: TransferControl): Promise<T> {
  return Promise.race([promise, control.promise])
}

function createTransferControl(): TransferControl {
  let reject!: (error: Error) => void
  let aborted = false
  const promise = new Promise<never>((_, rejectPromise) => { reject = rejectPromise })
  void promise.catch(() => {})
  return {
    promise,
    abort(error = new Error('aborted')) {
      if (aborted) return
      aborted = true
      reject(error)
    },
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cancel write timed out')), timeoutMs)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

function dialogCancelToEmpty<T>(err: unknown, empty: T): T {
  if (String(err).toLowerCase().includes('cancel')) return empty
  throw err
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safeDownloadFilename(value: unknown, windowsPath: boolean): string {
  const name = String(value || '')
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error(`Unsafe ZMODEM filename: ${JSON.stringify(name)}`)
  }
  if (windowsPath && (/[<>:"|?*]/.test(name) || /[. ]$/.test(name))) {
    throw new Error(`Unsafe ZMODEM filename: ${JSON.stringify(name)}`)
  }
  return name
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function arrayBufferToBase64(buffer: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < buffer.length; i++) binary += String.fromCharCode(buffer[i])
  return btoa(binary)
}
