export interface RenderContext {
    width: number
    height: number
}

export class Renderer {
    private readonly context: RenderContext

    constructor(context: RenderContext) {
        this.context = context
    }

    resize(width: number, height: number): void {
        this.context.width = width
        this.context.height = height
    }

    render(): void {
        // Rendering is intentionally deferred to the renderer implementation.
    }
}
