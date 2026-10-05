import assert from 'node:assert/strict'
import test from 'node:test'

import { Engine } from '../src/core/Engine.ts'
import {
    FIXED_POINT_SCALE,
    addFixedPoint,
    fromFixedPoint,
    toFixedPoint,
} from '../src/core/Math.ts'

test('fixed-point helpers keep deterministic values at a common scale', () => {
    const fixed = toFixedPoint(1.23456789)

    assert.equal(FIXED_POINT_SCALE, 1_000_000)
    assert.equal(fixed, 1_234_568)
    assert.equal(fromFixedPoint(fixed), 1.234568)
    assert.equal(addFixedPoint(fixed, 1), 1_234_569)
})

test('engine advances exactly once per fixed 60Hz step', () => {
    let steps = 0
    const engine = new Engine({
        fixedStepSeconds: 1 / 60,
        stepHandler: () => steps++,
    })
    engine.advance(1 / 60)
    assert.equal(steps, 1)

    engine.advance(1 / 60 * 2)
    assert.equal(steps, 3)
})
