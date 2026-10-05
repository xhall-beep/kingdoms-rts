import { World } from './world'

export interface EngineOptions {
    fixedStepSeconds?: number
}

export class Engine {
    readonly world = new World()
    private readonly fixedStepSeconds: number
    private accumulator = 0
    private running = false

    constructor(options: EngineOptions = {}) {
        this.fixedStepSeconds = options.fixedStepSeconds ?? 1 / 60
    }

    start(): void {
        if (this.running) return
        this.running = true
        this.tick(performance.now())
    }

    stop(): void {
        this.running = false
    }

    private tick(time: number): void {
        if (!this.running) return
        this.accumulator += Math.max(0, time - (this.lastTime ?? time)) / 1000
        this.lastTime = time

        while (this.accumulator >= this.fixedStepSeconds) {
            this.step()
            this.accumulator -= this.fixedStepSeconds
        }

        requestAnimationFrame((nextTime) => this.tick(nextTime))
    }

    private lastTime: number | undefined

    private step(): void {
        // The engine-specific systems are composed by src/main.ts.
    }
}
