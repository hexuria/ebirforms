import { dlopen, FFIType, suffix } from 'bun:ffi'

/**
 * Windows-only window chrome helpers for the frameless (titlebarTransparent)
 * window. GPUIX hides the OS caption on Windows but does not expose gpui's
 * window-control hitboxes to JS, so dragging is implemented manually:
 * onMouseDown records the cursor + window position, and onMouseMove (which
 * GPUIX keeps firing while the button is held — see README pointer capture)
 * moves the window with SetWindowPos.
 *
 * Every helper is a no-op off Windows.
 */

const isWin = process.platform === 'win32'

const WM_CLOSE = 0x0010
const SWP_NOSIZE = 0x0001
const SWP_NOZORDER = 0x0004
const SWP_NOACTIVATE = 0x0010

type User32 = ReturnType<typeof loadUser32>

function loadUser32() {
  return dlopen(`user32.${suffix}`, {
    FindWindowW: {
      args: [FFIType.ptr, FFIType.ptr],
      returns: FFIType.u64,
    },
    PostMessageW: {
      args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64],
      returns: FFIType.i32,
    },
    GetCursorPos: { args: [FFIType.ptr], returns: FFIType.i32 },
    GetWindowRect: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    SetWindowPos: {
      args: [FFIType.u64, FFIType.u64, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u32],
      returns: FFIType.i32,
    },
    IsZoomed: { args: [FFIType.u64], returns: FFIType.i32 },
  })
}

let user32: User32 | null | undefined
let cachedHwnd = 0

function lib(): User32 | null {
  if (!isWin) return null
  if (user32 === undefined) {
    try {
      user32 = loadUser32()
    } catch {
      user32 = null
    }
  }
  return user32 ?? null
}

function wideString(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length * 2 + 2)
  for (let i = 0; i < text.length; i += 1) {
    bytes[i * 2] = text.charCodeAt(i) & 0xff
    bytes[i * 2 + 1] = text.charCodeAt(i) >> 8
  }
  return bytes
}

function hwnd(title: string): bigint {
  if (cachedHwnd) return BigInt(cachedHwnd)
  const u = lib()
  if (!u) return 0n
  try {
    const found = u.symbols.FindWindowW(null, wideString(title))
    cachedHwnd = Number(found)
  } catch {
    cachedHwnd = 0
  }
  return BigInt(cachedHwnd)
}

export type DragAnchor = { cursorX: number; cursorY: number; windowX: number; windowY: number }

function cursorPos(): { x: number; y: number } | null {
  const u = lib()
  if (!u) return null
  const buf = new Int32Array(2)
  if (!u.symbols.GetCursorPos(buf)) return null
  return { x: buf[0], y: buf[1] }
}

/**
 * Call from the drag region's onMouseDown. Returns the drag anchor used by
 * dragWindowTo, or null when dragging can't start (e.g. maximized, off-Windows).
 */
export function beginWindowDrag(title: string): DragAnchor | null {
  const u = lib()
  const target = hwnd(title)
  if (!u || !target) return null
  if (u.symbols.IsZoomed(target)) return null
  const cursor = cursorPos()
  if (!cursor) return null
  const rect = new Int32Array(4)
  if (!u.symbols.GetWindowRect(target, rect)) return null
  return { cursorX: cursor.x, cursorY: cursor.y, windowX: rect[0], windowY: rect[1] }
}

/** Call from the drag region's onMouseMove while the button is held. */
export function dragWindowTo(title: string, anchor: DragAnchor): void {
  const u = lib()
  const target = hwnd(title)
  if (!u || !target) return
  const cursor = cursorPos()
  if (!cursor) return
  u.symbols.SetWindowPos(
    target,
    0n,
    anchor.windowX + (cursor.x - anchor.cursorX),
    anchor.windowY + (cursor.y - anchor.cursorY),
    0,
    0,
    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
  )
}

/**
 * Ask Windows to close the window gracefully. GPUI treats it like the user
 * clicking the native close button: the frame loop ends and the process exits.
 */
export function closeWindow(title: string): void {
  const u = lib()
  const target = hwnd(title)
  if (!u || !target) {
    process.exit(0)
    return
  }
  u.symbols.PostMessageW(target, WM_CLOSE, 0n, 0n)
}
