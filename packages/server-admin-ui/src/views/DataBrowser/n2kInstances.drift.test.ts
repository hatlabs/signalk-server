import { describe, it, expect } from 'vitest'
import * as streams from '../../../../streams/src/n2k-instance-groups'
import {
  FORBIDDEN_TARGET_SEGMENTS,
  GROUP_LABELS,
  MAPPABLE_PGNS,
  MAX_TARGET_LENGTH,
  MAX_TARGET_SEGMENTS,
  NOTIFICATIONS_ROOT,
  SINGLE_LEAF_GROUPS
} from './n2kInstances'

// The admin UI keeps its own copy of the instance group table and target
// grammar so it does not bundle canboat; these tests fail when the copies
// drift from the server's.
describe('n2kInstances agrees with the server', () => {
  it('lists every PGN of the group table as mappable', () => {
    const pgns = streams.N2K_INSTANCE_GROUPS.flatMap((group) => group.pgns).map(
      String
    )
    expect([...MAPPABLE_PGNS].sort()).toEqual([...new Set(pgns)].sort())
  })

  it('labels exactly the server groups', () => {
    expect(Object.keys(GROUP_LABELS).sort()).toEqual(
      streams.N2K_INSTANCE_GROUPS.map((group) => group.id).sort()
    )
  })

  it('marks the same groups single-leaf', () => {
    expect([...SINGLE_LEAF_GROUPS].sort()).toEqual(
      streams.N2K_INSTANCE_GROUPS.filter((group) => group.singleLeaf)
        .map((group) => group.id)
        .sort()
    )
  })

  it('uses the server target grammar', () => {
    expect({
      MAX_TARGET_LENGTH,
      MAX_TARGET_SEGMENTS,
      NOTIFICATIONS_ROOT
    }).toEqual({
      MAX_TARGET_LENGTH: streams.MAX_TARGET_LENGTH,
      MAX_TARGET_SEGMENTS: streams.MAX_TARGET_SEGMENTS,
      NOTIFICATIONS_ROOT: streams.NOTIFICATIONS_ROOT
    })
  })

  it('forbids the same target segments', () => {
    expect([...FORBIDDEN_TARGET_SEGMENTS].sort()).toEqual(
      [...streams.FORBIDDEN_TARGET_SEGMENTS].sort()
    )
  })
})
