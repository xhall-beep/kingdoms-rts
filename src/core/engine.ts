import { World } from './world.ts'

export interface EngineOptions {
    fixedStepSeconds?: number
    stepHandler?: () => void
}

export class Engine {
    readonly world = new World()
    private readonly fixedStepSeconds: number
    private readonly stepHandler: () => void
    private accumulator = 0
    private running = false
    private lastTime: number | undefined

    constructor(options: EngineOptions = {}) {
        this.fixedStepSeconds = options.fixedStepSeconds ?? 1 / 60
        this.stepHandler = options.stepHandler ?? (() => undefined)
    }

    start(): void {
        if (this.running) return
        this.running = true
        this.lastTime = performance.now()
        requestAnimationFrame((time) => this.tick(time))
    }

    stop(): void {
        this.running = false
    }

    advance(deltaSeconds: number): void {
        if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
            return
        }

        this.accumulator += deltaSeconds
        while (this.accumulator >= this.fixedStepSeconds) {
            this.stepHandler()
            this.accumulator -= this.fixedStepSeconds
        }
    }

    private tick(time: number): void {
        if (!this.running) return

        const deltaSeconds = Math.max(0, (time - (this.lastTime ?? time)) / 1000)
        this.lastTime = time
        this.advance(deltaSeconds)
        requestAnimationFrame((nextTime) => this.tick(nextTime))
    }
}
