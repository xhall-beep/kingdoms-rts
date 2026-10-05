export class Pool<T> {
    private readonly items: T[] = []
    private readonly available: T[] = []
    private readonly factory: () => T

    constructor(factory: () => T) {
        this.factory = factory
    }

    acquire(): T {
        const item = this.available.pop() ?? this.factory()
        this.items.push(item)
        return item
    }

    release(item: T): void {
        const index = this.items.indexOf(item)
        if (index >= 0) {
            this.items.splice(index, 1)
            this.available.push(item)
        }
    }

    clear(): void {
        this.items.length = 0
        this.available.length = 0
    }
}
