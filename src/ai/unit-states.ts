export type UnitState = 'idle' | 'moving' | 'attacking' | 'gathering' | 'producing'

export interface UnitStateMachine {
    state: UnitState
    transition(next: UnitState): void
}

export class UnitStateMachineImpl implements UnitStateMachine {
    state: UnitState = 'idle'

    transition(next: UnitState): void {
        this.state = next
    }
}
