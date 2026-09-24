import { expect } from 'chai'
import type { EventEmitter } from 'events'
import { FromPgn, pgnToActisenseSerialFormat } from '@canboat/canboatjs'
import { N2kMapper } from '@signalk/n2k-signalk'
import {
  N2K_INSTANCE_GROUPS,
  classifyN2kInstance,
  defaultPrefixes,
  deviceKeyFromCanName,
  instanceRuleKey,
  isAtOrUnder,
  ruleShapeError,
  type N2kFrame,
  type N2kInstanceGroupId
} from './n2k-instance-groups'

const SRC = 42
const ABSENT_8BIT = 255
const ABSENT_4BIT = 15

const parser = new FromPgn({})

// Frames go through the real canboat encoder and decoder so the classifier sees
// the same field shapes as in production: lookup names for known codes,
// numbers for unknown ones, and absent fields for the wire's "no data" value.
function decode(pgn: number, fields: Record<string, unknown>): N2kFrame {
  const encoded = pgnToActisenseSerialFormat({
    pgn,
    src: SRC,
    dst: 255,
    prio: 2,
    fields
  } as unknown as Parameters<typeof pgnToActisenseSerialFormat>[0])
  const frame = parser.parseString(encoded!) as unknown as N2kFrame | undefined
  if (!frame) throw new Error(`canboat could not decode PGN ${pgn}`)
  return frame
}

function withoutUndefined(
  fields: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined)
  )
}

const ENGINE_VALUES = {
  127488: { speed: 1000, boostPressure: 100, tiltTrim: 5 },
  127489: {
    oilPressure: 100,
    oilTemperature: 300,
    temperature: 350,
    alternatorPotential: 14,
    fuelRate: 5,
    totalEngineHours: 3600,
    coolantPressure: 1,
    fuelPressure: 1,
    engineLoad: 50,
    engineTorque: 50,
    discreteStatus1: ['Over Temperature'],
    discreteStatus2: ['Warning Level 1']
  },
  127493: {
    transmissionGear: 0,
    oilPressure: 100,
    oilTemperature: 300,
    discreteStatus1: 1
  },
  127497: {
    tripFuelUsed: 10,
    fuelRateAverage: 1,
    fuelRateEconomy: 1,
    instantaneousFuelEconomy: 1
  }
}

const INSTANCE_VALUES = {
  127506: {
    sid: 0,
    dcType: 0,
    stateOfCharge: 80,
    stateOfHealth: 90,
    timeRemaining: 3600
  },
  127508: { sid: 0, voltage: 12.5, current: 1, temperature: 300 },
  127513: {
    batteryType: 0,
    supportsEqualization: 0,
    nominalVoltage: 1,
    chemistry: 0,
    capacity: 360000,
    temperatureCoefficient: 5,
    chargeEfficiencyFactor: 90
  },
  127507: {
    batteryInstance: 0,
    operatingState: 1,
    chargeMode: 0,
    enabled: 1,
    equalizationPending: 0
  },
  127510: {
    batteryInstance: 0,
    chargerEnableDisable: 1,
    chargeCurrentLimit: 20,
    chargingAlgorithm: 0,
    chargerMode: 0
  },
  127504: {
    numberOfLines: 2,
    list: [
      { line: 0, voltage: 230, current: 1 },
      { line: 1, voltage: 231, current: 1 }
    ]
  },
  127509: {
    acInstance: 0,
    dcInstance: 0,
    operatingState: 1,
    inverterEnable: 1
  },
  127511: {
    acInstance: 0,
    dcInstance: 0,
    inverterEnableDisable: 1,
    inverterMode: 0
  },
  127503: {
    numberOfLines: 1,
    list: [{ line: 0, acceptability: 0, voltage: 230, current: 2 }]
  },
  127245: { directionOrder: 0, angleOrder: 0.1, position: 0.1 }
}

const CONNECTION_VALUES = {
  127744: { sid: 0, acRmsCurrent: 3, power: 500 },
  127745: { sid: 0, acRmsCurrent: 3, power: 500 },
  127746: { sid: 0, acRmsCurrent: 3, power: 500 },
  127750: { operatingState: 1, temperatureState: 0, overloadState: 0 },
  127751: { sid: 0, dcVoltage: 12, dcCurrent: 1 }
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i)

// Every PGN in the table, crossed with the instance and discriminator codes
// whose paths the mapper derives differently: port/starboard, unknown lookup
// codes, and the "no data" wire value that decodes to an absent field.
function tableFrames(): N2kFrame[] {
  const frames: N2kFrame[] = []
  for (const [pgn, values] of Object.entries(ENGINE_VALUES)) {
    for (const instance of [0, 1, 2, 254, ABSENT_8BIT]) {
      frames.push(decode(Number(pgn), { instance, ...values }))
    }
  }
  for (const [pgn, values] of Object.entries(INSTANCE_VALUES)) {
    for (const instance of [0, 3, ABSENT_8BIT]) {
      frames.push(decode(Number(pgn), { instance, ...values }))
    }
  }
  for (const [pgn, values] of Object.entries(CONNECTION_VALUES)) {
    for (const connectionNumber of [0, 2, ABSENT_8BIT]) {
      frames.push(decode(Number(pgn), { connectionNumber, ...values }))
    }
  }
  for (const type of [...range(0, 7), ABSENT_4BIT]) {
    for (const instance of [1, ABSENT_4BIT]) {
      frames.push(decode(127505, { instance, type, level: 50, capacity: 100 }))
    }
  }
  for (const source of [...range(0, 16), 200, 253, ABSENT_8BIT]) {
    for (const instance of [0, 1, ABSENT_8BIT]) {
      frames.push(
        decode(130312, { sid: 0, instance, source, actualTemperature: 300 })
      )
      frames.push(
        decode(130316, { sid: 0, instance, source, temperature: 300 })
      )
    }
  }
  for (const source of [0, 1, 9, ABSENT_8BIT]) {
    for (const instance of [0, 2, ABSENT_8BIT]) {
      frames.push(
        decode(130313, { sid: 0, instance, source, actualHumidity: 50 })
      )
    }
  }
  for (const source of [...range(0, 9), ABSENT_8BIT]) {
    for (const instance of [1, ABSENT_8BIT]) {
      frames.push(decode(130314, { sid: 0, instance, source, pressure: 1000 }))
    }
  }
  return frames
}

// For a source it cannot place, the mapper still emits the value, with a null
// or missing path.
function mapperPaths(frame: N2kFrame): string[] {
  const delta = new N2kMapper({}).toDelta(frame) as
    | { updates?: Array<{ values?: Array<{ path?: string | null }> }> }
    | undefined
  return (delta?.updates ?? []).flatMap((u) =>
    (u.values ?? []).flatMap((v) =>
      typeof v.path === 'string' ? [v.path] : []
    )
  )
}

const NOTIFICATIONS = 'notifications.'

// The rewrite moves both the data paths and their notifications.
function isUnderPrefix(path: string, prefix: string): boolean {
  const bare = path.startsWith(NOTIFICATIONS)
    ? path.slice(NOTIFICATIONS.length)
    : path
  return bare === prefix || bare.startsWith(prefix + '.')
}

function engineFrame(instance: number): N2kFrame {
  return decode(127488, { instance, speed: 1000 })
}

describe('n2k-instance-groups', () => {
  describe('agreement with n2k-signalk', () => {
    const frames = tableFrames()

    it('exercises every PGN in the group table', () => {
      const tablePgns = N2K_INSTANCE_GROUPS.flatMap((g) => g.pgns)
      const exercised = new Set(frames.map((f) => Number(f.pgn)))
      expect([...exercised].sort()).to.deep.equal([...tablePgns].sort())
    })

    const singleLeafGroups = new Set(
      N2K_INSTANCE_GROUPS.filter((g) => g.singleLeaf).map((g) => g.id)
    )

    it('the default prefix is a segment prefix of every mapper path', () => {
      const failures: string[] = []
      for (const frame of frames) {
        const paths = mapperPaths(frame)
        const classified = classifyN2kInstance(frame)
        const label = `${frame.pgn} ${JSON.stringify(frame.fields)}`
        if (!classified) {
          if (paths.length > 0) {
            failures.push(`${label}: unclassified but mapped to ${paths}`)
          }
          continue
        }
        if (paths.length === 0) {
          failures.push(`${label}: classified but the mapper emits no paths`)
        }
        const singleLeaf = singleLeafGroups.has(classified.group)
        for (const path of paths) {
          if (singleLeaf && path !== classified.defaultPrefix) {
            failures.push(
              `${label}: single-leaf ${path} is not ${classified.defaultPrefix}`
            )
          } else if (!isUnderPrefix(path, classified.defaultPrefix)) {
            failures.push(
              `${label}: ${path} not under ${classified.defaultPrefix}`
            )
          }
        }
      }
      expect(failures).to.deep.equal([])
    })

    it('the tuple-derived default prefixes include the frame-derived one', () => {
      for (const frame of frames) {
        const classified = classifyN2kInstance(frame)
        if (!classified) continue
        expect(
          defaultPrefixes(
            classified.group,
            classified.discriminator,
            classified.instance,
            SRC
          ),
          `${frame.pgn} ${JSON.stringify(frame.fields)}`
        ).to.include(classified.defaultPrefix)
      }
    })

    it('every classified discriminator is permitted by its group', () => {
      for (const frame of frames) {
        const classified = classifyN2kInstance(frame)
        if (!classified || classified.discriminator === undefined) continue
        const group = N2K_INSTANCE_GROUPS.find(
          (g) => g.id === classified.group
        )!
        expect(
          group.discriminatorCodes?.has(classified.discriminator),
          `${frame.pgn} ${JSON.stringify(frame.fields)}`
        ).to.equal(true)
      }
    })
  })

  describe('classifyN2kInstance', () => {
    it('maps engine 0 to propulsion.port', () => {
      expect(classifyN2kInstance(engineFrame(0))).to.deep.equal({
        group: 'engine',
        discriminator: undefined,
        instance: 0,
        defaultPrefix: 'propulsion.port'
      })
    })

    it('maps engine 1 to propulsion.starboard', () => {
      expect(classifyN2kInstance(engineFrame(1))).to.include({
        instance: 1,
        defaultPrefix: 'propulsion.starboard'
      })
    })

    it('maps engine 2 to propulsion.2', () => {
      expect(classifyN2kInstance(engineFrame(2))).to.include({
        instance: 2,
        defaultPrefix: 'propulsion.2'
      })
    })

    it('maps an engine without instance to code 255 and propulsion.starboard', () => {
      const frame = engineFrame(ABSENT_8BIT)
      expect(frame.fields?.instance).to.equal(undefined)
      expect(classifyN2kInstance(frame)).to.include({
        instance: 255,
        defaultPrefix: 'propulsion.starboard'
      })
    })

    it('maps battery 3 to electrical.batteries.3', () => {
      const frame = decode(127508, { instance: 3, voltage: 12.5 })
      expect(classifyN2kInstance(frame)).to.deep.equal({
        group: 'battery',
        discriminator: undefined,
        instance: 3,
        defaultPrefix: 'electrical.batteries.3'
      })
    })

    it('maps a Fuel tank by type code', () => {
      const frame = decode(127505, { instance: 1, type: 0, level: 50 })
      expect(classifyN2kInstance(frame)).to.deep.equal({
        group: 'tank',
        discriminator: 0,
        instance: 1,
        defaultPrefix: 'tanks.fuel.1'
      })
    })

    it('keeps Engine Room instances apart under one fixed prefix', () => {
      const [first, second] = [0, 1].map((instance) =>
        classifyN2kInstance(
          decode(130312, {
            sid: 0,
            instance,
            source: 3,
            actualTemperature: 300
          })
        )
      )
      expect(first).to.deep.equal({
        group: 'temperature',
        discriminator: 3,
        instance: 0,
        defaultPrefix: 'environment.inside.engineRoom.temperature'
      })
      expect(second).to.deep.equal({
        group: 'temperature',
        discriminator: 3,
        instance: 1,
        defaultPrefix: 'environment.inside.engineRoom.temperature'
      })
    })

    it('keeps indexed inside temperature and humidity leaves apart', () => {
      const temperature = classifyN2kInstance(
        decode(130312, {
          sid: 0,
          instance: 2,
          source: 2,
          actualTemperature: 300
        })
      )
      const humidity = classifyN2kInstance(
        decode(130313, { sid: 0, instance: 2, source: 0, actualHumidity: 50 })
      )
      expect(temperature?.defaultPrefix).to.equal(
        'environment.inside.2.temperature'
      )
      expect(humidity?.defaultPrefix).to.equal(
        'environment.inside.2.relativeHumidity'
      )
    })

    it('passes an unknown temperature source through as its code', () => {
      const frame = decode(130312, {
        sid: 0,
        instance: 2,
        source: 200,
        actualTemperature: 300
      })
      expect(classifyN2kInstance(frame)).to.include({
        discriminator: 200,
        defaultPrefix: 'generic.temperatures.userDefined200.2.temperature'
      })
    })

    it('includes the bus address for DC connections', () => {
      const frame = decode(127751, {
        sid: 0,
        connectionNumber: 2,
        dcVoltage: 12
      })
      expect(classifyN2kInstance(frame)).to.deep.equal({
        group: 'dcConnection',
        discriminator: undefined,
        instance: 2,
        defaultPrefix: `electrical.dc.${SRC}.2`
      })
    })

    it('maps the rudder to its one leaf', () => {
      const frame = decode(127245, { instance: 0, position: 0.1 })
      expect(classifyN2kInstance(frame)).to.include({
        group: 'rudder',
        instance: 0,
        defaultPrefix: 'steering.rudderAngle'
      })
    })

    it('accepts string pgn and src', () => {
      const frame = decode(127751, {
        sid: 0,
        connectionNumber: 2,
        dcVoltage: 12
      })
      const stringly = { ...frame, pgn: '127751', src: String(SRC) }
      expect(classifyN2kInstance(stringly)?.defaultPrefix).to.equal(
        `electrical.dc.${SRC}.2`
      )
    })

    it('returns undefined for PGNs outside the table', () => {
      expect(
        classifyN2kInstance(decode(129025, { latitude: 60.1, longitude: 24.9 }))
      ).to.equal(undefined)
    })

    it('returns undefined for switch banks', () => {
      expect(
        classifyN2kInstance(decode(127501, { instance: 0, indicator1: 1 }))
      ).to.equal(undefined)
    })
  })

  describe('defaultPrefixes', () => {
    const cases: Array<
      [N2kInstanceGroupId, number | undefined, number, string]
    > = [
      ['engine', undefined, 0, 'propulsion.port'],
      ['engine', undefined, 255, 'propulsion.starboard'],
      ['battery', undefined, 3, 'electrical.batteries.3'],
      ['tank', 0, 1, 'tanks.fuel.1'],
      ['temperature', 3, 1, 'environment.inside.engineRoom.temperature'],
      ['temperature', 1, 0, 'environment.outside.temperature'],
      ['temperature', 2, 1, 'environment.inside.1.temperature'],
      ['temperature', 5, 1, 'tanks.liveWell.1.temperature'],
      ['temperature', 14, 2, 'propulsion.2.exhaustTemperature'],
      ['humidity', 0, 2, 'environment.inside.2.relativeHumidity'],
      ['pressure', 1, 1, 'water.1.pressure'],
      ['pressure', 0, 1, 'environment.outside.pressure'],
      ['acConnection', undefined, 1, `electrical.ac.${SRC}.1`],
      ['converter', undefined, 1, `electrical.converter.${SRC}.1`],
      ['rudder', undefined, 0, 'steering.rudderAngle']
    ]
    for (const [group, discriminator, instance, expected] of cases) {
      it(`${group} ${discriminator ?? '-'} ${instance} → ${expected}`, () => {
        expect(
          defaultPrefixes(group, discriminator, instance, SRC)
        ).to.deep.equal([expected])
      })
    }

    it('lists both spellings a group can produce for one tuple', () => {
      expect(defaultPrefixes('temperature', 15, 1, SRC)).to.have.members([
        'generic.temperatures.userDefinedShaft_Seal_Temperature.1.temperature',
        'generic.temperatures.userDefinedShaft Seal Temperature.1.temperature'
      ])
    })

    it('is empty for a pressure source the mapper does not map', () => {
      expect(defaultPrefixes('pressure', 9, 1, SRC)).to.deep.equal([])
    })
  })

  describe('N2K_INSTANCE_GROUPS', () => {
    const singleLeafIds = () =>
      N2K_INSTANCE_GROUPS.filter((g) => g.singleLeaf).map((g) => g.id)

    it('marks only the groups that write one leaf per instance', () => {
      expect([...singleLeafIds()].sort()).to.deep.equal([
        'humidity',
        'pressure',
        'rudder',
        'temperature'
      ])
    })

    it('lists each PGN in exactly one group', () => {
      const pgns = N2K_INSTANCE_GROUPS.flatMap((g) => g.pgns)
      expect(new Set(pgns).size).to.equal(pgns.length)
      expect(pgns).to.not.include(127501)
    })

    it('permits tank types and pressure sources the mapper can place', () => {
      const tank = N2K_INSTANCE_GROUPS.find((g) => g.id === 'tank')!
      const pressure = N2K_INSTANCE_GROUPS.find((g) => g.id === 'pressure')!
      const engine = N2K_INSTANCE_GROUPS.find((g) => g.id === 'engine')!
      expect([...pressure.discriminatorCodes!]).to.deep.equal(range(0, 8))
      expect(tank.discriminatorCodes!.has(0)).to.equal(true)
      expect(tank.discriminatorCodes!.has(16)).to.equal(false)
      expect(engine.discriminatorCodes).to.equal(undefined)
    })
  })

  describe('deviceKeyFromCanName', () => {
    function canNameFromAddressClaim(fields: Record<string, unknown>): string {
      const mapper = new N2kMapper({}) as N2kMapper & EventEmitter
      let canName: string | undefined
      mapper.on(
        'n2kSourceMetadata',
        (_n2k: unknown, meta: { canName?: string }) => {
          canName = meta.canName
        }
      )
      mapper.toDelta(decode(60928, withoutUndefined(fields)))
      if (!canName) throw new Error('mapper did not report a canName')
      return canName
    }

    const claim = {
      uniqueNumber: 656598,
      deviceInstanceLower: 0,
      deviceInstanceUpper: 0,
      deviceFunction: 130,
      spare: 0,
      deviceClass: 25,
      systemInstance: 0,
      industryGroup: 4,
      arbitraryAddressCapable: 1
    }

    it('decodes a known manufacturer from the mapper-produced NAME', () => {
      const canName = canNameFromAddressClaim({
        ...claim,
        manufacturerCode: 137
      })
      expect(deviceKeyFromCanName(canName)).to.equal('137:656598')
    })

    it('decodes an unknown manufacturer code the same way', () => {
      const canName = canNameFromAddressClaim({
        ...claim,
        manufacturerCode: 2000
      })
      expect(deviceKeyFromCanName(canName)).to.equal('2000:656598')
    })

    it('ignores instance fields, so instance edits keep the key', () => {
      const a = canNameFromAddressClaim({ ...claim, manufacturerCode: 137 })
      const b = canNameFromAddressClaim({
        ...claim,
        manufacturerCode: 137,
        deviceInstanceLower: 3,
        systemInstance: 2
      })
      expect(a).to.not.equal(b)
      expect(deviceKeyFromCanName(b)).to.equal(deviceKeyFromCanName(a))
    })

    it('decodes a NAME with fewer than 16 hex digits', () => {
      const low = (BigInt(137) << 21n) | 656598n
      const canName = ((0x1234n << 32n) | low).toString(16)
      expect(canName.length).to.be.lessThan(16)
      expect(deviceKeyFromCanName(canName)).to.equal('137:656598')
    })

    it('decodes a NAME with only the low word set', () => {
      expect(deviceKeyFromCanName(0x1234n.toString(16))).to.equal('0:4660')
    })

    it('rejects strings that are not a hex NAME', () => {
      expect(deviceKeyFromCanName('')).to.equal(undefined)
      expect(deviceKeyFromCanName('xyz')).to.equal(undefined)
      expect(deviceKeyFromCanName('1'.repeat(17))).to.equal(undefined)
    })
  })

  describe('instanceRuleKey', () => {
    it('keys a rule identity, with or without a discriminator', () => {
      expect(instanceRuleKey('engine', undefined, 0)).to.equal(
        instanceRuleKey('engine', undefined, 0)
      )
      expect(instanceRuleKey('tank', 1, 2)).to.not.equal(
        instanceRuleKey('tank', 2, 1)
      )
      expect(instanceRuleKey('battery', undefined, 12)).to.not.equal(
        instanceRuleKey('battery', 1, 2)
      )
    })
  })

  describe('isAtOrUnder', () => {
    it('matches the prefix itself and paths below it', () => {
      expect(isAtOrUnder('propulsion.main', 'propulsion.main')).to.equal(true)
      expect(
        isAtOrUnder('propulsion.main.revolutions', 'propulsion.main')
      ).to.equal(true)
    })

    it('matches on segment boundaries only', () => {
      expect(isAtOrUnder('propulsion.mainAft', 'propulsion.main')).to.equal(
        false
      )
      expect(isAtOrUnder('propulsion', 'propulsion.main')).to.equal(false)
    })
  })

  describe('ruleShapeError', () => {
    it('accepts well-formed rules', () => {
      expect(
        ruleShapeError({ group: 'engine', instance: 0, target: 'a.b' })
      ).to.equal(undefined)
      expect(
        ruleShapeError({
          group: 'tank',
          discriminator: 1,
          instance: 15,
          target: 'tanks.day'
        })
      ).to.equal(undefined)
    })

    it('rejects values that are not rules', () => {
      for (const value of [null, 'x', 1, []]) {
        expect(ruleShapeError(value), String(value)).to.be.a('string')
      }
    })

    it('rejects an unknown group', () => {
      expect(
        ruleShapeError({ group: 'switchBank', instance: 0, target: 'a' })
      ).to.match(/group/)
    })

    it('requires a discriminator exactly where the group has one', () => {
      expect(
        ruleShapeError({ group: 'tank', instance: 0, target: 'a' })
      ).to.match(/discriminator/)
      expect(
        ruleShapeError({
          group: 'engine',
          discriminator: 0,
          instance: 0,
          target: 'a'
        })
      ).to.match(/discriminator/)
      expect(
        ruleShapeError({
          group: 'tank',
          discriminator: 99,
          instance: 0,
          target: 'a'
        })
      ).to.match(/discriminator/)
    })

    it('requires an integer instance within the group range', () => {
      for (const instance of [-1, 0.5, 256, '1', undefined]) {
        expect(
          ruleShapeError({ group: 'battery', instance, target: 'a' }),
          String(instance)
        ).to.match(/instance/)
      }
      expect(
        ruleShapeError({
          group: 'tank',
          discriminator: 0,
          instance: 16,
          target: 'a'
        })
      ).to.match(/instance/)
    })

    it('requires a string target', () => {
      expect(
        ruleShapeError({ group: 'engine', instance: 0, target: 42 })
      ).to.match(/target/)
    })
  })
})
