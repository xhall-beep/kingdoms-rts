/** Game feel: haptics + Web Audio sound effects. No assets needed. */

/** Vibrate if the device supports it. */
export function buzz(pattern: number | number[]): void {
  try {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate(pattern)
    }
  } catch {
    /* noop */
  }
}

let audioCtx: AudioContext | null = null

function ctx(): AudioContext | null {
  try {
    if (typeof window === 'undefined') return null
    if (!audioCtx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (!AC) return null
      audioCtx = new AC()
    }
    if (audioCtx.state === 'suspended') void audioCtx.resume()
    return audioCtx
  } catch {
    return null
  }
}

/** Play a short beep. Frequency in Hz, duration in ms. */
function beep(freq: number, durMs: number, type: OscillatorType = 'sine', vol = 0.08): void {
  const ac = ctx()
  if (!ac) return
  try {
    const osc = ac.createOscillator()
    const gain = ac.createGain()
    osc.type = type
    osc.frequency.value = freq
    gain.gain.setValueAtTime(vol, ac.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + durMs / 1000)
    osc.connect(gain)
    gain.connect(ac.destination)
    osc.start()
    osc.stop(ac.currentTime + durMs / 1000)
  } catch {
    /* noop */
  }
}

export const sfx = {
  select(): void {
    buzz(10)
    beep(660, 60)
  },
  deselect(): void {
    beep(440, 40)
  },
  move(): void {
    buzz(15)
    beep(520, 70)
  },
  attack(): void {
    buzz([20, 30, 20])
    beep(180, 120, 'sawtooth', 0.06)
  },
  gather(): void {
    buzz(10)
    beep(740, 50)
  },
  build(): void {
    buzz(25)
    beep(330, 100, 'triangle')
  },
  train(): void {
    buzz(15)
    beep(590, 80, 'triangle')
  },
  buildComplete(): void {
    buzz([30, 40, 30])
    beep(523, 100, 'sine')
    setTimeout(() => beep(784, 150, 'sine'), 100)
  },
  error(): void {
    buzz(50)
    beep(160, 150, 'square', 0.05)
  },
}
