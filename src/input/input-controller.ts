export type InputMode = 'selection' | 'move' | 'attack' | 'gather'

export interface InputController {
    setMode(mode: InputMode): void
    getMode(): InputMode
    handlePointer(position: readonly [number, number]): void
}

export class InputControllerImpl implements InputController {
    private mode: InputMode = 'selection'

    setMode(mode: InputMode): void {
        this.mode = mode
    }

    getMode(): InputMode {
        return this.mode
    }

    handlePointer(_position: readonly [number, number]): void {
        // Convert pointer input into a FSM-driven unit command.
    }
}
