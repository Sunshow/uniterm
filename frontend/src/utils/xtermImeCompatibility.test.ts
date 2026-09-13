import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { installImeCompatibilityPatch } from './xtermImeCompatibility'

interface FakeCore {
  [key: string]: unknown
  _inputEvent: (this: Record<string, unknown>, ev: InputEvent) => boolean
  _keyDownSeen: boolean
  _compositionHelper: Record<string, unknown>
  textarea: {
    value: string
    listeners: Map<string, EventListener>
    addEventListener: (type: string, fn: EventListener) => void
    removeEventListener: (type: string, fn: EventListener) => void
  }
}

function makeFakeCore(inputEventResult: boolean = true) {
  const calls: { keyDownSeenAtCall: boolean | undefined }[] = []
  const core: FakeCore = {
    _inputEvent: function (this: Record<string, unknown>, ev: InputEvent) {
      calls.push({ keyDownSeenAtCall: this._keyDownSeen as boolean | undefined })
      // Mirror the browser: by the time the input event is dispatched the
      // textarea already holds the inserted data.
      if (ev.data) core.textarea.value += ev.data
      return inputEventResult
    },
    _keyDownSeen: true,
    _compositionHelper: { _isComposing: false, _isSendingComposition: false },
    textarea: {
      value: '',
      listeners: new Map(),
      addEventListener(type: string, fn: EventListener) {
        core.textarea.listeners.set(type, fn)
      },
      removeEventListener(type: string, fn: EventListener) {
        if (core.textarea.listeners.get(type) === fn) core.textarea.listeners.delete(type)
      },
    },
  }
  return { core, calls }
}

function fakeTerminal(core: FakeCore, input = vi.fn()) {
  return { _core: core, input } as unknown as import('@xterm/xterm').Terminal
}

function keydown(
  keyCode: number,
  opts: {
    key?: string
    isComposing?: boolean
    shiftKey?: boolean
    capsLock?: boolean
  } = {},
) {
  return {
    keyCode,
    key: opts.key ?? 'a',
    isComposing: opts.isComposing ?? false,
    shiftKey: opts.shiftKey ?? false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    getModifierState: (modifier: string) => modifier === 'CapsLock' && (opts.capsLock ?? false),
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent
}

function insertText(data: string, opts: { isComposing?: boolean } = {}) {
  return {
    inputType: 'insertText',
    data,
    isComposing: opts.isComposing ?? false,
  } as unknown as InputEvent
}

beforeEach(() => {
  vi.stubGlobal('navigator', { userAgent: 'Macintosh; Intel Mac OS X 10_15_7' })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('installImeCompatibilityPatch', () => {
  it('is a no-op on non-mac platforms', () => {
    vi.stubGlobal('navigator', { userAgent: 'Windows NT 10.0' })
    const { core, calls } = makeFakeCore()
    const disposable = installImeCompatibilityPatch(fakeTerminal(core))
    expect(core._inputEvent).toBe(core._inputEvent)
    expect(core.textarea.listeners.size).toBe(0)
    disposable.dispose()
    expect(calls).toHaveLength(0)
  })

  it('does not patch when xterm internals are missing', () => {
    const disposable = installImeCompatibilityPatch({ _core: {} } as never)
    expect(disposable.dispose).toBeTypeOf('function')
    disposable.dispose()
  })

  it('forces direct delivery for a single printable char after a 229 keydown', () => {
    const { core, calls } = makeFakeCore()
    installImeCompatibilityPatch(fakeTerminal(core))

    core.textarea.listeners.get('keydown')!(keydown(229))
    core._inputEvent.call(core, insertText('a'))

    // Original handler must see _keyDownSeen cleared (direct path)...
    expect(calls).toEqual([{ keyDownSeenAtCall: false }])
    // ...and the flag restored afterwards so xterm bookkeeping stays intact.
    expect(core._keyDownSeen).toBe(true)
  })

  it('restores the textarea snapshot after direct delivery', () => {
    const { core } = makeFakeCore()
    core.textarea.value = 'aba'
    installImeCompatibilityPatch(fakeTerminal(core))

    core.textarea.listeners.get('keydown')!(keydown(229))
    core._inputEvent.call(core, insertText('a'))

    // The queued xterm textarea diff must observe the same value it captured
    // before keydown, even when the textarea already contains repeated text.
    expect(core.textarea.value).toBe('aba')
  })

  it('delivers consecutive phantom 229 input once and preserves its case', () => {
    const { core } = makeFakeCore()
    const delivered: string[] = []
    const originalInputEvent = core._inputEvent
    core._inputEvent = function (this: Record<string, unknown>, ev: InputEvent) {
      if (ev.data !== null) delivered.push(ev.data)
      return originalInputEvent.call(this, ev)
    }
    installImeCompatibilityPatch(fakeTerminal(core))

    for (const character of 'asdf') {
      core.textarea.listeners.get('keydown')!(keydown(229))
      core._inputEvent.call(core, insertText(character))
    }

    expect(delivered).toEqual(['a', 's', 'd', 'f'])
    expect(core.textarea.value).toBe('')
  })

  it('injects every English letter after Caps Lock when no input event follows', () => {
    vi.useFakeTimers()
    const { core } = makeFakeCore()
    const input = vi.fn()
    installImeCompatibilityPatch(fakeTerminal(core, input))

    for (const key of 'ASDF') {
      core.textarea.listeners.get('keydown')!(
        keydown(229, { key, capsLock: true }),
      )
    }
    expect(input).not.toHaveBeenCalled()

    vi.runAllTimers()
    expect(input).toHaveBeenNthCalledWith(1, 'a')
    expect(input).toHaveBeenNthCalledWith(2, 's')
    expect(input).toHaveBeenNthCalledWith(3, 'd')
    expect(input).toHaveBeenNthCalledWith(4, 'f')
  })

  it('keeps Shift uppercase in the Caps Lock fallback', () => {
    vi.useFakeTimers()
    const { core } = makeFakeCore()
    const input = vi.fn()
    installImeCompatibilityPatch(fakeTerminal(core, input))

    core.textarea.listeners.get('keydown')!(
      keydown(229, { key: 'A', shiftKey: true, capsLock: true }),
    )
    vi.runAllTimers()

    expect(input).toHaveBeenCalledWith('A')
  })

  it('cancels the Caps Lock fallback when the input event arrives', () => {
    vi.useFakeTimers()
    const { core, calls } = makeFakeCore()
    const input = vi.fn()
    installImeCompatibilityPatch(fakeTerminal(core, input))

    core.textarea.listeners.get('keydown')!(keydown(229, { key: 'A', capsLock: true }))
    core._inputEvent.call(core, insertText('a'))
    vi.runAllTimers()

    expect(input).not.toHaveBeenCalled()
    expect(calls).toEqual([{ keyDownSeenAtCall: false }])
  })

  it('suppresses a late input event after the Caps Lock fallback injected', () => {
    vi.useFakeTimers()
    const { core, calls } = makeFakeCore()
    const input = vi.fn()
    installImeCompatibilityPatch(fakeTerminal(core, input))

    core.textarea.listeners.get('keydown')!(keydown(229, { key: 'A', capsLock: true }))
    vi.runAllTimers()
    core._inputEvent.call(core, insertText('a'))

    expect(input).toHaveBeenCalledTimes(1)
    expect(input).toHaveBeenCalledWith('a')
    expect(calls).toEqual([])
    expect(core.textarea.value).toBe('')
  })

  it('does not inject fallback when input was delivered before its keydown', () => {
    vi.useFakeTimers()
    const { core } = makeFakeCore()
    const input = vi.fn()
    installImeCompatibilityPatch(fakeTerminal(core, input))

    expect(core._inputEvent.call(core, insertText('s'))).toBe(true)
    core.textarea.listeners.get('keydown')!(keydown(229, { key: 'S', capsLock: true }))
    vi.runAllTimers()

    expect(input).not.toHaveBeenCalled()
  })

  it('injects fallback when an earlier input event was not delivered', () => {
    vi.useFakeTimers()
    const { core } = makeFakeCore(false)
    const input = vi.fn()
    installImeCompatibilityPatch(fakeTerminal(core, input))

    expect(core._inputEvent.call(core, insertText('a'))).toBe(false)
    core.textarea.listeners.get('keydown')!(keydown(229, { key: 'A', capsLock: true }))
    vi.runAllTimers()

    expect(input).toHaveBeenCalledTimes(1)
    expect(input).toHaveBeenCalledWith('a')
  })

  it('suppresses late composing input after the Caps Lock fallback injected', () => {
    vi.useFakeTimers()
    const { core, calls } = makeFakeCore()
    const input = vi.fn()
    installImeCompatibilityPatch(fakeTerminal(core, input))

    for (const [key, character] of [['A', 'a'], ['S', 's'], ['D', 'd'], ['F', 'f']] as const) {
      core.textarea.listeners.get('keydown')!(keydown(229, { key, capsLock: true }))
      vi.runAllTimers()
      core._inputEvent.call(core, insertText(character, { isComposing: true }))
    }

    expect(input.mock.calls).toEqual([['a'], ['s'], ['d'], ['f']])
    expect(calls).toEqual([])
    expect(core.textarea.value).toBe('')
  })

  it('uses the Caps Lock fallback for consecutive missing input events', () => {
    vi.useFakeTimers()
    const { core } = makeFakeCore()
    const input = vi.fn()
    installImeCompatibilityPatch(fakeTerminal(core, input))

    core.textarea.listeners.get('keydown')!(keydown(229, { key: 'A', capsLock: true }))
    vi.runAllTimers()
    core.textarea.listeners.get('keydown')!(keydown(229, { key: 'S', capsLock: true }))
    vi.runAllTimers()

    expect(input).toHaveBeenNthCalledWith(1, 'a')
    expect(input).toHaveBeenNthCalledWith(2, 's')
  })

  it('does not use the Caps Lock fallback for ordinary keydowns', () => {
    vi.useFakeTimers()
    const { core } = makeFakeCore()
    const input = vi.fn()
    installImeCompatibilityPatch(fakeTerminal(core, input))

    core.textarea.listeners.get('keydown')!(keydown(65, { key: 'A', capsLock: true }))
    vi.runAllTimers()

    expect(input).not.toHaveBeenCalled()
  })

  it('mixes fallback injection with direct input delivery without duplicates', () => {
    vi.useFakeTimers()
    const { core, calls } = makeFakeCore()
    const input = vi.fn()
    installImeCompatibilityPatch(fakeTerminal(core, input))

    core.textarea.listeners.get('keydown')!(keydown(229, { key: 'A', capsLock: true }))
    vi.runAllTimers()
    core.textarea.listeners.get('keydown')!(keydown(229, { key: 'S', capsLock: true }))
    vi.runAllTimers()
    core.textarea.listeners.get('keydown')!(keydown(229, { key: 'D', capsLock: true }))
    core._inputEvent.call(core, insertText('d'))
    core.textarea.listeners.get('keydown')!(keydown(229, { key: 'A', capsLock: true }))
    core._inputEvent.call(core, insertText('a'))
    vi.runAllTimers()

    expect(input).toHaveBeenNthCalledWith(1, 'a')
    expect(input).toHaveBeenNthCalledWith(2, 's')
    expect(calls).toEqual([
      { keyDownSeenAtCall: false },
      { keyDownSeenAtCall: false },
    ])
  })

  it('leaves input untouched without a preceding 229 keydown', () => {
    const { core, calls } = makeFakeCore()
    installImeCompatibilityPatch(fakeTerminal(core))

    core.textarea.listeners.get('keydown')!(keydown(65))
    core._inputEvent.call(core, insertText('a'))

    expect(calls).toEqual([{ keyDownSeenAtCall: true }])
  })

  it('only forces once per keydown', () => {
    const { core, calls } = makeFakeCore()
    installImeCompatibilityPatch(fakeTerminal(core))

    core.textarea.listeners.get('keydown')!(keydown(229))
    core._inputEvent.call(core, insertText('a'))
    core._inputEvent.call(core, insertText('b'))

    expect(calls).toEqual([
      { keyDownSeenAtCall: false },
      { keyDownSeenAtCall: true },
    ])
  })

  it('leaves real composition untouched', () => {
    const { core, calls } = makeFakeCore()
    installImeCompatibilityPatch(fakeTerminal(core))

    core.textarea.listeners.get('keydown')!(keydown(229))
    core._inputEvent.call(core, insertText('a', { isComposing: true }))
    expect(calls).toEqual([{ keyDownSeenAtCall: true }])

    core._compositionHelper._isComposing = true
    core.textarea.listeners.get('keydown')!(keydown(229))
    core._inputEvent.call(core, insertText('a'))
    expect(calls).toEqual([
      { keyDownSeenAtCall: true },
      { keyDownSeenAtCall: true },
    ])
  })

  it('leaves multi-character and non-insertText input untouched', () => {
    const { core, calls } = makeFakeCore()
    installImeCompatibilityPatch(fakeTerminal(core))

    core.textarea.listeners.get('keydown')!(keydown(229))
    core._inputEvent.call(core, insertText('ab'))
    expect(calls).toEqual([{ keyDownSeenAtCall: true }])

    core.textarea.listeners.get('keydown')!(keydown(229))
    core._inputEvent.call(core, { inputType: 'deleteContentBackward' } as unknown as InputEvent)
    expect(calls).toEqual([
      { keyDownSeenAtCall: true },
      { keyDownSeenAtCall: true },
    ])
  })

  it('is always active on macOS', () => {
    const { core, calls } = makeFakeCore()
    installImeCompatibilityPatch(fakeTerminal(core))

    core.textarea.listeners.get('keydown')!(keydown(229))
    core._inputEvent.call(core, insertText('a'))
    core.textarea.listeners.get('keydown')!(keydown(229))
    core._inputEvent.call(core, insertText('b'))

    expect(calls).toEqual([
      { keyDownSeenAtCall: false },
      { keyDownSeenAtCall: false },
    ])
  })

  it('dispose restores the original handler and removes the keydown listener', () => {
    const { core } = makeFakeCore()
    const original = core._inputEvent
    const disposable = installImeCompatibilityPatch(fakeTerminal(core))

    expect(core._inputEvent).not.toBe(original)
    expect(core.textarea.listeners.has('keydown')).toBe(true)

    disposable.dispose()
    expect(core._inputEvent).toBe(original)
    expect(core.textarea.listeners.size).toBe(0)
  })
})
