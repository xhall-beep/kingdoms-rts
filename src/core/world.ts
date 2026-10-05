export interface WorldEntity {
    id: number
}

export class World {
    private nextEntityId = 1
    readonly entities = new Map<number, WorldEntity>()

    createEntity(): WorldEntity {
        const entity = { id: this.nextEntityId++ }
        this.entities.set(entity.id, entity)
        return entity
    }

    removeEntity(id: number): void {
        this.entities.delete(id)
    }
}
