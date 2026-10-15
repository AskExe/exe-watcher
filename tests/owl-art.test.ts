import { describe, it, expect } from 'vitest'

import { OWL_FRAMES, OWL_LOOK, owlFrame, type OwlPose } from '../src/owl-art.js'

const POSES = Object.keys(OWL_FRAMES) as OwlPose[]
const width = (line: string) => [...line].length

describe('owl pixel art', () => {
  it.each(POSES)('%s frame has the same size as the center frame', pose => {
    const center = OWL_FRAMES.center
    const frame = OWL_FRAMES[pose]
    expect(frame.length).toBe(center.length)
    expect(frame.map(width)).toEqual(center.map(() => width(center[0]!)))
  })

  it('uses only half-block characters and spaces', () => {
    const chars = new Set(POSES.flatMap(p => OWL_FRAMES[p].flatMap(l => [...l])))
    expect([...chars].filter(c => !' █▀▄'.includes(c))).toEqual([])
  })

  it.each(['left', 'right', 'blink'] as const)('%s pose differs from the center pose', pose => {
    expect(OWL_FRAMES[pose]).not.toEqual(OWL_FRAMES.center)
  })

  it('look-around loop visits every pose', () => {
    expect(new Set(OWL_LOOK)).toEqual(new Set(POSES))
  })

  it('owlFrame cycles through the loop by tick', () => {
    expect(owlFrame(0)).toBe(OWL_FRAMES[OWL_LOOK[0]!])
    expect(owlFrame(OWL_LOOK.length + 2)).toBe(OWL_FRAMES[OWL_LOOK[2]!])
  })
})
