export interface BuildingDefinition {
    id: string
    name: string
    cost: readonly number[]
}

export const buildings: readonly BuildingDefinition[] = []
