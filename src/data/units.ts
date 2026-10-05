export interface UnitDefinition {
    id: string
    name: string
    cost: readonly number[]
}

export const units: readonly UnitDefinition[] = []
