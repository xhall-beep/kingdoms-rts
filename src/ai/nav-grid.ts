export interface NavGrid {
    findPath(start: readonly [number, number], target: readonly [number, number]): number[][]
}

export class NavGridImpl implements NavGrid {
    findPath(
        _start: readonly [number, number],
        _target: readonly [number, number],
    ): number[][] {
        return []
    }
}
