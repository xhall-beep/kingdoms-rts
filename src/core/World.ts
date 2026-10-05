export interface Entity {
  readonly id: number
}

export interface System {
  update(world: World, deltaSeconds: number): void
}

export interface WorldOptions {
  capacity?: number
}

export class World {
  readonly positionX: Float32Array
  readonly positionY: Float32Array
  readonly positionZ: Float32Array
  readonly velocityX: Float32Array
  readonly velocityY: Float32Array
  readonly velocityZ: Float32Array
  readonly entities = new Map<number, Entity>()
  readonly systems: System[] = []

  private nextEntityId = 1
  private readonly capacity: number

  constructor(options: WorldOptions = {}) {
    this.capacity = options.capacity ?? 1_024
    const length = this.capacity
    this.positionX = new Float32Array(length)
    this.positionY = new Float32Array(length)
    this.positionZ = new Float32Array(length)
    this.velocityX = new Float32Array(length)
    this.velocityY = new Float32Array(length)
    this.velocityZ = new Float32Array(length)
  }

  createEntity(): Entity {
    if (this.nextEntityId > this.capacity) {
      throw new Error('World capacity exceeded')
    }

    const entity = { id: this.nextEntityId++ } as Entity
    this.entities.set(entity.id, entity)
    return entity
  }

  removeEntity(entity: Entity): void {
    this.entities.delete(entity.id)
  }

  registerSystem(system: System): void {
    this.systems.push(system)
  }

  update(deltaSeconds: number): void {
    for (const system of this.systems) {
      system.update(this, deltaSeconds)
    }
  }

  setPosition(entity: Entity, x: number, y: number, z: number): void {
    this.positionX[entity.id] = x
    this.positionY[entity.id] = y
    this.positionZ[entity.id] = z
  }

  setVelocity(entity: Entity, x: number, y: number, z: number): void {
    this.velocityX[entity.id] = x
    this.velocityY[entity.id] = y
    this.velocityZ[entity.id] = z
  }

  getEntityCount(): number {
    return this.entities.size
  }

  snapshotSpatialState(): Float32Array[] {
    return [
      this.positionX.slice(),
      this.positionY.slice(),
      this.positionZ.slice(),
      this.velocityX.slice(),
      this.velocityY.slice(),
      this.velocityZ.slice(),
    ]
  }
}
