import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockAppendFileBase64,
  mockFileSize,
  mockOpenDirectoryDialog,
  mockOpenMultipleFilesDialog,
  mockSessionEndZmodem,
  mockSessionEndZmodemWithTrailing,
  mockSessionStartZmodem,
  mockSessionWrite,
  mockSessionWriteBinary,
  mockReadFileChunkBase64,
  mockWriteFileBase64,
  sentryInstances,
  runtimeState,
} = vi.hoisted(() => {
  const sentryInstances: any[] = []
  const runtimeState = {
    binaryHandler: null as null | ((ev: any) => void),
    consumeError: null as Error | null,
  }
  return {
    mockAppendFileBase64: vi.fn().mockResolvedValue(undefined),
    mockFileSize: vi.fn().mockResolvedValue(3),
    mockOpenDirectoryDialog: vi.fn().mockResolvedValue('C:\\Downloads'),
    mockOpenMultipleFilesDialog: vi.fn().mockResolvedValue([]),
    mockSessionEndZmodem: vi.fn().mockResolvedValue(undefined),
    mockSessionEndZmodemWithTrailing: vi.fn().mockResolvedValue(undefined),
    mockSessionStartZmodem: vi.fn().mockResolvedValue(undefined),
    mockSessionWrite: vi.fn().mockResolvedValue(undefined),
    mockSessionWriteBinary: vi.fn().mockResolvedValue(undefined),
    mockReadFileChunkBase64: vi.fn().mockResolvedValue('AQID'),
    mockWriteFileBase64: vi.fn().mockResolvedValue(undefined),
    sentryInstances,
    runtimeState,
  }
})

vi.mock('zmodem.js/src/zmodem_browser', () => ({
  default: {
    Sentry: vi.fn(function (this: any, options) {
      sentryInstances.push(options)
      this.consume = vi.fn(() => {
        if (runtimeState.consumeError) throw runtimeState.consumeError
      })
    }),
  },
}))

vi.mock('@wailsio/runtime', () => ({
  Events: {
    On: vi.fn((_name: string, handler: (ev: any) => void) => {
      runtimeState.binaryHandler = handler
      return () => { runtimeState.binaryHandler = null }
    }),
    Off: vi.fn(),
  },
}))

vi.mock('../../bindings/github.com/ys-ll/uniterm/app', () => ({
  AppendFileBase64: mockAppendFileBase64,
  FileSize: mockFileSize,
  OpenDirectoryDialog: mockOpenDirectoryDialog,
  OpenMultipleFilesDialog: mockOpenMultipleFilesDialog,
  ReadFileChunkBase64: mockReadFileChunkBase64,
  SessionEndZmodem: mockSessionEndZmodem,
  SessionEndZmodemWithTrailing: mockSessionEndZmodemWithTrailing,
  SessionStartZmodem: mockSessionStartZmodem,
  SessionWrite: mockSessionWrite,
  SessionWriteBinary: mockSessionWriteBinary,
  WriteFileBase64: mockWriteFileBase64,
}))

const mockStore = {
  addTransfer: vi.fn(),
  updateTransfer: vi.fn(),
  getPendingUploadFiles: vi.fn(),
  unregisterAbort: vi.fn(),
}

vi.mock('../stores/zmodemStore', () => ({
  useZmodemStore: vi.fn(() => mockStore),
}))

import { startZmodemService } from './zmodemService'

const BATCH = 64 * 1024

async function sleepTicks() {
  for (let i = 0; i < 100; i++) {
    await Promise.resolve()
  }
}

function base64ToBytes(b64: string): number[] {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return Array.from(out)
}

// Builds a fake zmodem 'receive' session + offer for a download of the given
// byte chunks. Returns handles the test can drive.
function makeDownload(chunks: number[][]) {
  const state: {
    offerHandler?: (offer: any) => void | Promise<void>
    sessionEndHandler?: () => void
    accept?: any
    zsession: any
  } = {} as any
  const offer = {
    get_details: () => ({ name: 'large.bin', size: chunks.flat().length }),
    accept: vi.fn(async (options?: { on_input?: (payload: number[]) => void }) => {
      state.accept = { options }
      for (const c of chunks) options?.on_input?.(c)
    }),
    skip: vi.fn(),
  }
  const zsession = {
    type: 'receive',
    on: vi.fn((event: string, handler: any) => {
      if (event === 'offer') state.offerHandler = handler
      if (event === 'session_end') state.sessionEndHandler = handler
    }),
    // The real session's start() resolves when the ZMODEM protocol ends (all
    // file data received), which is decoupled from our disk writes. We fire
    // the offer handler in the background and resolve immediately, mirroring
    // that: on_input runs synchronously, but its writes may still be pending
    // on disk.
    start: vi.fn(() => {
      const task = state.offerHandler?.(offer)
      Promise.resolve(task).then(() => state.sessionEndHandler?.())
      return Promise.resolve()
    }),
    abort: vi.fn(),
    close: vi.fn(),
  }
  state.zsession = zsession
  return state
}

// Builds a fake zmodem 'send' session (the local side of an rz upload).
function makeUpload() {
  const zsession = {
    type: 'send',
    on: vi.fn(),
    abort: vi.fn(),
    close: vi.fn(),
    send_offer: vi.fn(),
  }
  return { zsession }
}

describe('startZmodemService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sentryInstances.length = 0
    runtimeState.binaryHandler = null
    runtimeState.consumeError = null
    mockOpenDirectoryDialog.mockResolvedValue('C:\\Downloads')
    mockOpenMultipleFilesDialog.mockResolvedValue([])
    mockAppendFileBase64.mockResolvedValue(undefined)
    mockSessionWriteBinary.mockResolvedValue(undefined)
    mockSessionStartZmodem.mockResolvedValue(undefined)
    mockSessionEndZmodem.mockResolvedValue(undefined)
    mockSessionEndZmodemWithTrailing.mockResolvedValue(undefined)
    mockStore.getPendingUploadFiles.mockReturnValue(undefined)
  })

  it('buffers small sz chunks into a single batched disk write', async () => {
    vi.useFakeTimers()
    const s = makeDownload([
      [1, 2, 3],
      [4, 5],
    ])
    const onComplete = vi.fn()
    startZmodemService({ sessionId: 's1', onComplete })

    sentryInstances[0].on_detect({ confirm: () => s.zsession })
    await sleepTicks()
    await vi.runOnlyPendingTimersAsync()
    vi.useRealTimers()

    // Only a single batched Write — not one per tiny chunk.
    expect(mockAppendFileBase64).toHaveBeenCalledTimes(1)
    expect(mockAppendFileBase64).toHaveBeenNthCalledWith(1, 'C:\\Downloads\\large.bin', 'AQIDBAU=', 0)
    expect(mockWriteFileBase64).not.toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalledWith(['C:\\Downloads\\large.bin'])
    expect(mockSessionEndZmodem).toHaveBeenCalledWith('s1')
  })

  it('flushes an in-flight batch once the buffer exceeds the batch size', async () => {
    vi.useFakeTimers()
    // 3 × 30KB = 90KB total → first flush at 64KB boundary, remainder at end.
    const make = (v: number, len: number) => Array.from({ length: len }, () => v)
    const s = makeDownload([
      make(1, 30000),
      make(2, 30000),
      make(3, 30000),
    ])
    const onComplete = vi.fn()
    startZmodemService({ sessionId: 's1', onComplete })

    sentryInstances[0].on_detect({ confirm: () => s.zsession })
    await sleepTicks()
    await vi.runOnlyPendingTimersAsync()
    vi.useRealTimers()

    expect(mockAppendFileBase64).toHaveBeenCalledTimes(2)
    const c0 = mockAppendFileBase64.mock.calls[0]
    const c1 = mockAppendFileBase64.mock.calls[1]
    expect(c0[2]).toBe(0)
    expect(c1[2]).toBe(BATCH)
    // Reassembled file content equals the source bytes, in order.
    const reassembled = base64ToBytes(c0[1]).concat(base64ToBytes(c1[1]))
    expect(reassembled.length).toBe(90000)
    expect(reassembled[0]).toBe(1)
    expect(reassembled[65536]).toBe(3)
    expect(reassembled[89999]).toBe(3)
  })

  it('waits for the final disk write before completing the download', async () => {
    vi.useFakeTimers()
    const s = makeDownload([[1, 2, 3, 4, 5]])
    const onComplete = vi.fn()

    // Simulate a slow disk: the append write stays pending until we resolve it.
    const appendResolvers: (() => void)[] = []
    mockAppendFileBase64.mockImplementation(
      () => new Promise<void>((res) => appendResolvers.push(res)),
    )

    startZmodemService({ sessionId: 's1', onComplete })

    sentryInstances[0].on_detect({ confirm: () => s.zsession })
    await sleepTicks()

    // A pending disk write must not be mistaken for completed work.
    expect(onComplete).not.toHaveBeenCalled()
    expect(mockAppendFileBase64).toHaveBeenCalledTimes(1)

    // Now the disk catches up.
    appendResolvers[0]()
    await sleepTicks()
    vi.useRealTimers()

    expect(onComplete).toHaveBeenCalledWith(['C:\\Downloads\\large.bin'])
    expect(mockSessionEndZmodem).toHaveBeenCalledWith('s1')
  })

  // Wails v3 rejects the dialog promise with "cancelled by user" when the
  // user dismisses the picker. The service must treat that as a cancel:
  // abort the zsession (so the remote rz exits), end zmodem mode, and fire
  // the cancel path — not report an error.
  it('treats upload dialog rejection as a user cancel', async () => {
    vi.useFakeTimers()
    const u = makeUpload()
    const onComplete = vi.fn()
    const onError = vi.fn()
    mockOpenMultipleFilesDialog.mockRejectedValue(
      Object.assign(new Error('cancelled by user'), { name: 'RuntimeError' }),
    )

    startZmodemService({ sessionId: 's1', onComplete, onError })
    sentryInstances[0].on_detect({ confirm: () => u.zsession })
    await sleepTicks()
    await vi.runOnlyPendingTimersAsync()
    vi.useRealTimers()

    expect(u.zsession.abort).toHaveBeenCalled()
    expect(mockSessionEndZmodem).toHaveBeenCalledWith('s1')
    expect(onComplete).toHaveBeenCalledWith([])
    expect(onError).not.toHaveBeenCalled()
  })

  it('treats download dialog rejection as a user cancel', async () => {
    vi.useFakeTimers()
    const s = makeDownload([[1, 2, 3]])
    const onComplete = vi.fn()
    const onError = vi.fn()
    mockOpenDirectoryDialog.mockRejectedValue(
      Object.assign(new Error('cancelled by user'), { name: 'RuntimeError' }),
    )

    startZmodemService({ sessionId: 's1', onComplete, onError })
    sentryInstances[0].on_detect({ confirm: () => s.zsession })
    await sleepTicks()
    await vi.runOnlyPendingTimersAsync()
    vi.useRealTimers()

    expect(s.zsession.abort).toHaveBeenCalled()
    expect(mockSessionEndZmodem).toHaveBeenCalledWith('s1')
    expect(onComplete).toHaveBeenCalledWith([])
    expect(onError).not.toHaveBeenCalled()
  })

  it('reports a stalled transfer after 20 seconds and restores terminal mode', async () => {
    vi.useFakeTimers()
    const s = makeDownload([[1, 2, 3]])
    const onError = vi.fn()
    mockAppendFileBase64.mockImplementation(() => new Promise<void>(() => {}))

    startZmodemService({ sessionId: 's1', onError })
    sentryInstances[0].on_detect({ confirm: () => s.zsession })
    await sleepTicks()
    await vi.advanceTimersByTimeAsync(20_000)
    await sleepTicks()
    vi.useRealTimers()

    expect(onError).toHaveBeenCalledWith('ZMODEM transfer timed out after 20s without activity')
    expect(mockSessionEndZmodem).toHaveBeenCalledWith('s1')
  })

  it('finishes local cancellation even when writing the cancel sequence fails', async () => {
    const u = makeUpload()
    const registered: Array<() => void> = []
    const onComplete = vi.fn()
    mockOpenMultipleFilesDialog.mockImplementation(() => new Promise<string[]>(() => {}))
    mockSessionWriteBinary.mockRejectedValue(new Error('bridge closed'))

    startZmodemService({
      sessionId: 's1', onComplete, onRegister: abort => registered.push(abort),
    })
    sentryInstances[0].on_detect({ confirm: () => u.zsession })
    registered[0]()
    await sleepTicks()

    expect(u.zsession.abort).toHaveBeenCalledTimes(1)
    expect(mockSessionEndZmodem).toHaveBeenCalledWith('s1')
  })

  it('propagates protocol bridge write failures and restores terminal mode', async () => {
    const u = makeUpload()
    const xfer = { send: vi.fn(), end: vi.fn().mockResolvedValue(undefined) }
    u.zsession.send_offer.mockImplementation(async () => {
      // zmodem.js calls sender synchronously while producing protocol frames.
      sentryInstances[0].sender([1, 2, 3])
      return xfer
    })
    mockOpenMultipleFilesDialog.mockResolvedValue(['/tmp/a.bin'])
    mockSessionWriteBinary.mockRejectedValue(new Error('bridge closed'))
    const onError = vi.fn()

    startZmodemService({ sessionId: 's1', onError })
    sentryInstances[0].on_detect({ confirm: () => u.zsession })
    for (let i = 0; i < 20 && onError.mock.calls.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(onError).toHaveBeenCalledWith('bridge closed')
    expect(mockSessionEndZmodem).toHaveBeenCalledWith('s1')
  })

  it('sends one complete cancel sequence in protocol order', async () => {
    const u = makeUpload()
    const registered: Array<() => void> = []
    mockOpenMultipleFilesDialog.mockImplementation(() => new Promise<string[]>(() => {}))

    startZmodemService({ sessionId: 's1', onRegister: abort => registered.push(abort) })
    sentryInstances[0].on_detect({ confirm: () => u.zsession })
    registered[0]()
    await sleepTicks()

    const bytes = base64ToBytes(mockSessionWriteBinary.mock.calls[0][1])
    expect(bytes).toEqual([
      ...Array(10).fill(0x18),
      ...Array(10).fill(0x08),
    ])
  })

  it('unregisters the global abort handler when disposed', async () => {
    const onUnregister = vi.fn()
    const service = startZmodemService({ sessionId: 's1', onUnregister })
    await service.dispose()
    await service.dispose()
    expect(onUnregister).toHaveBeenCalledTimes(1)
  })

  it('restores backend mode before reporting a synchronous parser failure', async () => {
    const events: string[] = []
    mockSessionEndZmodem.mockImplementation(async () => { events.push('end') })
    const onError = vi.fn(() => events.push('error'))
    startZmodemService({ sessionId: 's1', onError })
    runtimeState.consumeError = new Error('bad frame')

    runtimeState.binaryHandler?.({ data: { id: 's1', data: 'AQ==' } })
    for (let i = 0; i < 20 && onError.mock.calls.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }

    expect(events).toEqual(['end', 'error'])
  })

  it('waits for a pending backend start before ending after a quick cancel', async () => {
    let resolveStart!: () => void
    mockSessionStartZmodem.mockImplementation(() => new Promise<void>(resolve => { resolveStart = resolve }))
    const registered: Array<() => void> = []
    const service = startZmodemService({
      sessionId: 's1', onRegister: abort => registered.push(abort),
    })

    service.start('**\x18B0000000000')
    registered[0]()
    await sleepTicks()
    expect(mockSessionEndZmodem).not.toHaveBeenCalled()

    resolveStart()
    await sleepTicks()
    expect(mockSessionStartZmodem).toHaveBeenCalledWith('s1')
    expect(mockSessionEndZmodem).toHaveBeenCalledWith('s1')
  })

  it('ends a pending backend start when the service is disposed', async () => {
    let resolveStart!: () => void
    mockSessionStartZmodem.mockImplementation(() => new Promise<void>(resolve => { resolveStart = resolve }))
    const service = startZmodemService({ sessionId: 's1' })

    service.start('**\x18B0000000000')
    const disposed = service.dispose()
    await sleepTicks()
    expect(mockSessionEndZmodem).not.toHaveBeenCalled()

    resolveStart()
    await disposed
    expect(mockSessionEndZmodem).toHaveBeenCalledWith('s1')
  })

  it('retries backend mode cleanup and reports a persistent failure', async () => {
    const onError = vi.fn()
    const registered: Array<() => void> = []
    mockSessionEndZmodem.mockRejectedValue(new Error('end bridge closed'))
    startZmodemService({
      sessionId: 's1', onError, onRegister: abort => registered.push(abort),
    })

    registered[0]()
    await sleepTicks()

    expect(mockSessionEndZmodem).toHaveBeenCalledTimes(3)
    expect(onError).toHaveBeenCalledWith('end bridge closed')
  })

  it('waits for session_end and receives every file in a batch', async () => {
    const handlers: Record<string, (...args: any[]) => void> = {}
    const makeOffer = (name: string, byte: number) => ({
      get_details: () => ({ name, size: 1 }),
      accept: vi.fn(async ({ on_input }: any) => on_input([byte])),
      skip: vi.fn(),
    })
    const zsession = {
      type: 'receive',
      on: vi.fn((event: string, handler: (...args: any[]) => void) => { handlers[event] = handler }),
      start: vi.fn(async () => {
        handlers.offer(makeOffer('one.bin', 1))
        await sleepTicks()
        handlers.offer(makeOffer('two.bin', 2))
        await sleepTicks()
        handlers.session_end()
      }),
      abort: vi.fn(),
    }
    const onComplete = vi.fn()

    startZmodemService({ sessionId: 's-batch', onComplete })
    sentryInstances[0].on_detect({ confirm: () => zsession })
    for (let i = 0; i < 20 && onComplete.mock.calls.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }

    expect(onComplete).toHaveBeenCalledWith([
      'C:\\Downloads\\one.bin',
      'C:\\Downloads\\two.bin',
    ])
    expect(mockAppendFileBase64).toHaveBeenCalledTimes(2)
  })

  it('restores shell output trailing the final sz handshake', async () => {
    const s = makeDownload([[1, 2, 3]])
    const events: string[] = []
    const onComplete = vi.fn(() => events.push('complete'))
    const onTerminalRestoreState = vi.fn((restoring: boolean) => {
      events.push(`restoring:${restoring}`)
    })

    s.zsession.start.mockImplementation(() => {
      const task = s.offerHandler?.({
        get_details: () => ({ name: 'a.bin', size: 3 }),
        accept: vi.fn(async ({ on_input }: any) => on_input([1, 2, 3])),
        skip: vi.fn(),
      })
      return Promise.resolve(task).then(() => {
        s.sessionEndHandler?.()
        // This is the order used by Sentry.consume(): session_end fires while
        // parsing OO, then trailing bytes are forwarded before consume returns.
        sentryInstances[0].to_terminal(Array.from(new TextEncoder().encode('root@host:~# ')))
      })
    })

    startZmodemService({ sessionId: 's1', onComplete, onTerminalRestoreState })
    sentryInstances[0].on_detect({ confirm: () => s.zsession })
    await sleepTicks()

    expect(events).toEqual([
      'restoring:true',
      'complete',
      'restoring:false',
    ])
    expect(mockSessionEndZmodemWithTrailing).toHaveBeenCalledWith(
      's1',
      btoa('root@host:~# '),
    )
  })

  it('warns without cancelling a completed transfer if restoring shell output fails', async () => {
    const s = makeDownload([[1]])
    const onError = vi.fn()
    const onComplete = vi.fn()
    const onWarning = vi.fn()
    mockSessionEndZmodemWithTrailing.mockRejectedValue(new Error('trailing bridge closed'))
    s.zsession.start.mockImplementation(() => {
      const task = s.offerHandler?.({
        get_details: () => ({ name: 'a.bin', size: 1 }),
        accept: vi.fn(async ({ on_input }: any) => on_input([1])),
        skip: vi.fn(),
      })
      return Promise.resolve(task).then(() => {
        s.sessionEndHandler?.()
        sentryInstances[0].to_terminal([0x24, 0x20])
      })
    })

    startZmodemService({ sessionId: 's1', onError, onComplete, onWarning })
    sentryInstances[0].on_detect({ confirm: () => s.zsession })
    await sleepTicks()

    expect(mockSessionEndZmodemWithTrailing).toHaveBeenCalledTimes(1)
    expect(mockSessionEndZmodem).toHaveBeenCalledWith('s1')
    expect(onComplete).toHaveBeenCalledWith(['C:\\Downloads\\a.bin'])
    expect(onWarning).toHaveBeenCalledWith('Shell output restore failed: trailing bridge closed')
    expect(onError).not.toHaveBeenCalled()
    expect(mockSessionWriteBinary).not.toHaveBeenCalled()
  })

  it('rejects download filenames that escape the selected directory', async () => {
    const s = makeDownload([[1]])
    const handlers = sentryInstances
    const onError = vi.fn()
    s.zsession.start.mockImplementation(() => {
      const offer = {
        get_details: () => ({ name: '..\\evil.txt', size: 1 }),
        accept: vi.fn(),
        skip: vi.fn(),
      }
      s.offerHandler?.(offer)
      return Promise.resolve()
    })

    startZmodemService({ sessionId: 's-path', onError })
    handlers[0].on_detect({ confirm: () => s.zsession })
    for (let i = 0; i < 20 && onError.mock.calls.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }

    expect(onError).toHaveBeenCalledWith('Unsafe ZMODEM filename: "..\\\\evil.txt"')
    expect(mockAppendFileBase64).not.toHaveBeenCalled()
  })
})
