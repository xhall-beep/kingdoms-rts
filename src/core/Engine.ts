import { World } from './World.ts'

export interface EngineOptions {
  world?: World
  fixedStepSeconds?: number
  maxFrameTimeSeconds?: number
  stepHandler?: () => void
}

export class Engine {
  readonly world: World
  private readonly fixedStepSeconds: number
  private readonly maxFrameTimeSeconds: number
  private readonly stepHandler: (() => void) | undefined
  private accumulator = 0
  private simulationSteps = 0
  private interpolationAlpha = 0
  private previousSpatialState: Float32Array[]
  private running = false
  private paused = false
  private lastFrameTime: number | undefined

  constructor(options: EngineOptions = {}) {
    this.world = options.world ?? new World()
    this.fixedStepSeconds = options.fixedStepSeconds ?? 1 / 60
    this.maxFrameTimeSeconds = options.maxFrameTimeSeconds ?? 1
    this.stepHandler = options.stepHandler
    this.previousSpatialState = this.world.snapshotSpatialState()
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.lastFrameTime = performance.now()
    requestAnimationFrame((time) => this.tick(time))
  }

  stop(): void {
    this.running = false
  }

  /** Freeze simulation steps; rendering continues. */
  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
    // Drop the paused interval so time doesn't jump on resume.
    this.lastFrameTime = performance.now()
  }

  isPaused(): boolean {
    return this.paused
  }

  advance(deltaSeconds: number): void {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
      return
    }

    const clampedDelta = Math.min(deltaSeconds, this.maxFrameTimeSeconds)
    this.accumulator += clampedDelta
    this.previousSpatialState = this.world.snapshotSpatialState()

    const stepTolerance = 1e-9
    while (this.accumulator + stepTolerance >= this.fixedStepSeconds) {
      if (this.stepHandler) {
        this.stepHandler()
      } else {
        this.world.update(this.fixedStepSeconds)
      }
      this.simulationSteps++
      this.accumulator -= this.fixedStepSeconds
    }

    this.interpolationAlpha = this.accumulator / this.fixedStepSeconds
  }

  private tick(time: number): void {
    if (!this.running) return

    const deltaSeconds = Math.max(0, (time - (this.lastFrameTime ?? time)) / 1000)
    this.lastFrameTime = time
    if (!this.paused) this.advance(deltaSeconds)
    requestAnimationFrame((nextTime) => this.tick(nextTime))
  }

  getSimulationSteps(): number {
    return this.simulationSteps
  }

  getInterpolationAlpha(): number {
    return Math.min(1, Math.max(0, this.interpolationAlpha))
  }

  getPreviousSpatialState(): Float32Array[] {
    return this.previousSpatialState
  }
}
