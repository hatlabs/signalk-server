/*
 * Instance-bearing NMEA 2000 PGNs grouped by what their instance numbers
 * identify (an engine, a battery, a tank of one type...), with the Signal K
 * path prefix n2k-signalk writes each instance under. The prefix functions
 * mirror @signalk/n2k-signalk's path logic; n2k-instance-groups.test.ts runs
 * every PGN here through the real mapper so drift fails a test.
 *
 * Groups whose PGNs write several leaves per instance (engine, battery, tank,
 * ...) use the instance's parent path as the prefix. Single-leaf groups
 * (temperature, humidity, pressure, rudder) use the full leaf path: their
 * parents are shared with unrelated data (environment.outside, steering,
 * propulsion.<n>, environment.inside.<n>), so a parent prefix would rewrite
 * or prune that data too.
 */

import {
  lookupEnumerationName,
  lookupEnumerationValue
} from '@canboat/canboatjs'

export type N2kInstanceGroupId =
  | 'engine'
  | 'battery'
  | 'charger'
  | 'inverter'
  | 'acInput'
  | 'tank'
  | 'temperature'
  | 'humidity'
  | 'pressure'
  | 'acConnection'
  | 'converter'
  | 'dcConnection'
  | 'rudder'

export interface N2kFrame {
  pgn: number | string
  src: number | string
  fields?: Record<string, unknown>
}

export interface N2kInstanceGroup {
  readonly id: N2kInstanceGroupId
  readonly pgns: readonly number[]
  /** Instance codes run from 0 to this, the field's "no data" value included. */
  readonly maxInstance: number
  /** True when the default prefix is the one leaf path the group writes. */
  readonly singleLeaf: boolean
  /** Tank type or source codes; undefined when the group has no discriminator. */
  readonly discriminatorCodes?: ReadonlySet<number>
}

export interface N2kInstanceClassification {
  readonly group: N2kInstanceGroupId
  readonly discriminator: number | undefined
  readonly instance: number
  readonly defaultPrefix: string
}

// canboat omits a field whose wire value is the "no data" value, so an absent
// field is represented by that value's code.
const ABSENT_8BIT = 255
const ABSENT_4BIT = 15

type PrefixFn = (
  discriminator: number | undefined,
  instance: number,
  src: number
) => string | undefined

interface GroupSpec {
  readonly id: N2kInstanceGroupId
  readonly instanceField: 'instance' | 'connectionNumber'
  readonly absentInstance: number
  readonly singleLeaf: boolean
  readonly instanceEnum?: string
  readonly discriminator?: {
    readonly field: 'type' | 'source'
    readonly enumName: string
    readonly absent: number
  }
  readonly prefixes: Readonly<Record<number, PrefixFn>>
}

// n2k-signalk interpolates the raw field, so an absent one reads "undefined".
function instanceSegment(instance: number): string {
  return instance === ABSENT_8BIT ? 'undefined' : String(instance)
}

const instanceUnder =
  (base: string): PrefixFn =>
  (_discriminator, instance) =>
    `${base}.${instanceSegment(instance)}`

const connectionUnder =
  (base: string): PrefixFn =>
  (_discriminator, connection, src) =>
    `${base}.${src}.${instanceSegment(connection)}`

const ENGINE_PORT = 0
const ENGINE_STARBOARD = 1

// skEngineId: the port lookup name becomes port, every other name and an
// absent instance become starboard, and numbers pass through.
const enginePrefix: PrefixFn = (_discriminator, instance) =>
  instance === ENGINE_PORT
    ? 'propulsion.port'
    : instance === ENGINE_STARBOARD || instance === ABSENT_8BIT
      ? 'propulsion.starboard'
      : `propulsion.${instance}`

const TANK_SEGMENTS: Readonly<Record<number, string>> = {
  0: 'fuel',
  1: 'freshWater',
  2: 'wasteWater',
  3: 'liveWell',
  4: 'lubrication',
  5: 'blackWater'
}

const tankPrefix: PrefixFn = (type, instance) =>
  `tanks.${TANK_SEGMENTS[type ?? ABSENT_4BIT] ?? 'undefined'}.${
    instance === ABSENT_4BIT ? 'undefined' : instance
  }`

const INDEX = '<index>'

// Keyed by canboat code; n2k-signalk keys the same paths by lookup name.
const TEMPERATURE_PATHS: Readonly<Record<number, string>> = {
  0: 'environment.water.temperature',
  1: 'environment.outside.temperature',
  2: 'environment.inside.<index>.temperature',
  3: 'environment.inside.engineRoom.temperature',
  4: 'environment.inside.mainCabin.temperature',
  5: 'tanks.liveWell.<index>.temperature',
  6: 'tanks.baitWell.<index>.temperature',
  7: 'environment.inside.refrigerator.temperature',
  8: 'environment.inside.heating.temperature',
  9: 'environment.outside.dewPointTemperature',
  10: 'environment.outside.apparentWindChillTemperature',
  11: 'environment.outside.theoreticalWindChillTemperature',
  12: 'environment.outside.heatIndexTemperature',
  13: 'environment.inside.freezer.temperature',
  14: 'propulsion.<index>.exhaustTemperature'
}

const HUMIDITY_PATHS: Readonly<Record<number, string>> = {
  0: 'environment.inside.<index>.relativeHumidity',
  1: 'environment.outside.humidity'
}

// n2k-signalk prefers pathWithIndex, so every source but Atmospheric is indexed.
const PRESSURE_PATHS: Readonly<Record<number, string>> = {
  0: 'environment.outside.pressure',
  1: 'water.<index>.pressure',
  2: 'steam.<index>.pressure',
  3: 'compressedAir.<index>.pressure',
  4: 'hydraulic.<index>.pressure',
  5: 'filter.<index>.pressure',
  6: 'altimetersetting.<index>.pressure',
  7: 'oil.<index>.pressure',
  8: 'fuel.<index>.pressure'
}

// The mapper's view of a lookup field: its name, the number when canboat has
// no name for it, or undefined when absent.
function lookupView(
  enumName: string,
  code: number | undefined
): string | number | undefined {
  if (code === undefined || code === ABSENT_8BIT) return undefined
  return lookupEnumerationName(enumName, code) ?? code
}

const SPACES = / /g

// 130312 defaults a missing instance to 0 and replaces spaces in the source
// name; 130316 interpolates both fields as they are.
const temperaturePath: PrefixFn = (source, instance) => {
  if (source === undefined || source === ABSENT_8BIT) return undefined
  const segment = instance === ABSENT_8BIT ? '0' : String(instance)
  const path = TEMPERATURE_PATHS[source]
  if (path) return path.replace(INDEX, segment)
  const name = String(lookupView('TEMPERATURE_SOURCE', source))
  return `generic.temperatures.userDefined${name.replace(SPACES, '_')}.${segment}.temperature`
}

const temperatureExtendedPath: PrefixFn = (source, instance) => {
  const segment = instanceSegment(instance)
  const path = source === undefined ? undefined : TEMPERATURE_PATHS[source]
  if (path) return path.replace(INDEX, segment)
  return `generic.temperatures.userDefined${lookupView('TEMPERATURE_SOURCE', source)}.${segment}.temperature`
}

const humidityPath: PrefixFn = (source, instance) => {
  const segment = instanceSegment(instance)
  const path = source === undefined ? undefined : HUMIDITY_PATHS[source]
  if (path) return path.replace(INDEX, segment)
  return `environment.userDefined${lookupView('HUMIDITY_SOURCE', source)}.${segment}.relativeHumidity`
}

const pressurePath: PrefixFn = (source, instance) => {
  const path = source === undefined ? undefined : PRESSURE_PATHS[source]
  return path?.replace(INDEX, instanceSegment(instance))
}

const byInstance = (
  id: N2kInstanceGroupId,
  prefixes: Record<number, PrefixFn>
): GroupSpec => ({
  id,
  instanceField: 'instance',
  absentInstance: ABSENT_8BIT,
  singleLeaf: false,
  prefixes
})

const bySource = (
  id: N2kInstanceGroupId,
  enumName: string,
  prefixes: Record<number, PrefixFn>
): GroupSpec => ({
  id,
  instanceField: 'instance',
  absentInstance: ABSENT_8BIT,
  singleLeaf: true,
  discriminator: { field: 'source', enumName, absent: ABSENT_8BIT },
  prefixes
})

const byConnection = (
  id: N2kInstanceGroupId,
  prefixes: Record<number, PrefixFn>
): GroupSpec => ({
  id,
  instanceField: 'connectionNumber',
  absentInstance: ABSENT_8BIT,
  singleLeaf: false,
  prefixes
})

const batteries = instanceUnder('electrical.batteries')
const chargers = instanceUnder('electrical.chargers')
const inverters = instanceUnder('electrical.inverters')
const acConnections = connectionUnder('electrical.ac')

// Switch banks (127501) are left out: PUT handlers and NMEA 2000 output key
// on their default paths, so a renamed bank could not be switched.
const GROUP_SPECS: readonly GroupSpec[] = [
  {
    id: 'engine',
    instanceField: 'instance',
    absentInstance: ABSENT_8BIT,
    singleLeaf: false,
    instanceEnum: 'ENGINE_INSTANCE',
    prefixes: {
      127488: enginePrefix,
      127489: enginePrefix,
      127493: enginePrefix,
      127497: enginePrefix
    }
  },
  byInstance('battery', {
    127506: batteries,
    127508: batteries,
    127513: batteries
  }),
  byInstance('charger', { 127507: chargers, 127510: chargers }),
  byInstance('inverter', {
    127504: inverters,
    127509: inverters,
    127511: inverters
  }),
  byInstance('acInput', { 127503: instanceUnder('electrical.ac') }),
  {
    id: 'tank',
    instanceField: 'instance',
    absentInstance: ABSENT_4BIT,
    singleLeaf: false,
    discriminator: {
      field: 'type',
      enumName: 'TANK_TYPE',
      absent: ABSENT_4BIT
    },
    prefixes: { 127505: tankPrefix }
  },
  bySource('temperature', 'TEMPERATURE_SOURCE', {
    130312: temperaturePath,
    130316: temperatureExtendedPath
  }),
  bySource('humidity', 'HUMIDITY_SOURCE', { 130313: humidityPath }),
  bySource('pressure', 'PRESSURE_SOURCE', { 130314: pressurePath }),
  byConnection('acConnection', {
    127744: acConnections,
    127745: acConnections,
    127746: acConnections
  }),
  byConnection('converter', {
    127750: connectionUnder('electrical.converter')
  }),
  byConnection('dcConnection', { 127751: connectionUnder('electrical.dc') }),
  {
    id: 'rudder',
    instanceField: 'instance',
    absentInstance: ABSENT_8BIT,
    singleLeaf: true,
    prefixes: { 127245: () => 'steering.rudderAngle' }
  }
]

interface PgnEntry {
  readonly group: GroupSpec
  readonly prefix: PrefixFn
}

const PGN_INDEX = new Map<number, PgnEntry>()
const GROUPS_BY_ID = new Map<N2kInstanceGroupId, GroupSpec>()
for (const group of GROUP_SPECS) {
  GROUPS_BY_ID.set(group.id, group)
  for (const [pgn, prefix] of Object.entries(group.prefixes)) {
    PGN_INDEX.set(Number(pgn), { group, prefix })
  }
}

/**
 * Every Signal K path prefix the group's PGNs write this instance under.
 * Usually one; 130312 and 130316 spell some temperature sources differently.
 */
export function defaultPrefixes(
  groupId: N2kInstanceGroupId,
  discriminator: number | undefined,
  instance: number,
  src: number
): string[] {
  const group = GROUPS_BY_ID.get(groupId)
  if (
    !group ||
    (group.discriminator === undefined) !== (discriminator === undefined)
  ) {
    return []
  }
  const prefixes: string[] = []
  for (const prefixFn of Object.values(group.prefixes)) {
    const prefix = prefixFn(discriminator, instance, src)
    if (prefix !== undefined && !prefixes.includes(prefix)) {
      prefixes.push(prefix)
    }
  }
  return prefixes
}

function permittedDiscriminators(
  group: GroupSpec
): ReadonlySet<number> | undefined {
  if (!group.discriminator) return undefined
  const codes = new Set<number>()
  for (let code = 0; code <= group.discriminator.absent; code++) {
    if (defaultPrefixes(group.id, code, 0, 0).length > 0) codes.add(code)
  }
  return codes
}

export const N2K_INSTANCE_GROUPS: readonly N2kInstanceGroup[] = GROUP_SPECS.map(
  (group) => ({
    id: group.id,
    pgns: Object.keys(group.prefixes).map(Number),
    maxInstance: group.absentInstance,
    singleLeaf: group.singleLeaf,
    discriminatorCodes: permittedDiscriminators(group)
  })
)

const INSTANCE_GROUPS_BY_ID: ReadonlyMap<string, N2kInstanceGroup> = new Map(
  N2K_INSTANCE_GROUPS.map((group) => [group.id, group])
)

/** One key per rule identity: (group, discriminator, instance). */
export function instanceRuleKey(
  group: N2kInstanceGroupId,
  discriminator: number | undefined,
  instance: number
): string {
  return `${group}/${discriminator ?? ''}/${instance}`
}

const DOT = 46

/** True when path is prefix or lies under it on a segment boundary. */
export function isAtOrUnder(path: string, prefix: string): boolean {
  return (
    path.startsWith(prefix) &&
    (path.length === prefix.length || path.charCodeAt(prefix.length) === DOT)
  )
}

/**
 * Why a value is not a rule the group table can apply, or undefined when
 * it is one. Covers the rule's shape only; target placement is the
 * server's to check.
 */
export function ruleShapeError(rule: unknown): string | undefined {
  if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
    return 'rule must be an object'
  }
  const {
    group: groupId,
    discriminator,
    instance,
    target
  } = rule as Record<string, unknown>
  const group =
    typeof groupId === 'string' ? INSTANCE_GROUPS_BY_ID.get(groupId) : undefined
  if (!group) return `unknown group ${String(groupId)}`
  if (group.discriminatorCodes === undefined) {
    if (discriminator !== undefined) {
      return `group ${group.id} takes no discriminator`
    }
  } else if (discriminator === undefined) {
    return `group ${group.id} requires a discriminator`
  } else if (
    typeof discriminator !== 'number' ||
    !group.discriminatorCodes.has(discriminator)
  ) {
    return `discriminator ${String(discriminator)} is not valid for group ${group.id}`
  }
  if (
    typeof instance !== 'number' ||
    !Number.isInteger(instance) ||
    instance < 0 ||
    instance > group.maxInstance
  ) {
    return `instance must be an integer 0..${group.maxInstance} for group ${group.id}`
  }
  if (typeof target !== 'string') return 'target must be a string'
  return undefined
}

function fieldCode(
  value: unknown,
  enumName: string | undefined,
  absent: number
): number | undefined {
  if (value === undefined || value === null) return absent
  if (typeof value === 'number') return value
  if (typeof value === 'string' && enumName !== undefined) {
    return lookupEnumerationValue(enumName, value)
  }
  return undefined
}

const NO_FIELDS: Record<string, unknown> = {}

/**
 * Classify a decoded canboat frame as n2k-signalk receives it. Undefined for
 * PGNs outside the group table and for frames the mapper writes no path for.
 */
export function classifyN2kInstance(
  frame: N2kFrame
): N2kInstanceClassification | undefined {
  const entry = PGN_INDEX.get(Number(frame.pgn))
  if (!entry) return undefined
  const { group, prefix } = entry
  const fields = frame.fields ?? NO_FIELDS

  const instance = fieldCode(
    fields[group.instanceField],
    group.instanceEnum,
    group.absentInstance
  )
  if (instance === undefined) return undefined

  let discriminator: number | undefined
  if (group.discriminator) {
    discriminator = fieldCode(
      fields[group.discriminator.field],
      group.discriminator.enumName,
      group.discriminator.absent
    )
    if (discriminator === undefined) return undefined
  }

  const defaultPrefix = prefix(discriminator, instance, Number(frame.src))
  if (defaultPrefix === undefined) return undefined
  return { group: group.id, discriminator, instance, defaultPrefix }
}

// ISO 11783 NAME: bits 0-20 unique number, bits 21-31 manufacturer code.
const CAN_NAME_PATTERN = /^[0-9a-f]{1,16}$/i
const LOW_WORD_HEX_DIGITS = 8
const UNIQUE_NUMBER_BITS = 21
const UNIQUE_NUMBER_MASK = 0x1fffff
const MANUFACTURER_CODE_MASK = 0x7ff

/**
 * `<manufacturer code>:<unique number>` from a canName hex string. The key
 * survives device and system instance edits and bus address changes.
 */
export function deviceKeyFromCanName(canName: string): string | undefined {
  if (!CAN_NAME_PATTERN.test(canName)) return undefined
  const lowWord = parseInt(canName.slice(-LOW_WORD_HEX_DIGITS), 16)
  const manufacturerCode =
    (lowWord >>> UNIQUE_NUMBER_BITS) & MANUFACTURER_CODE_MASK
  return `${manufacturerCode}:${lowWord & UNIQUE_NUMBER_MASK}`
}

/**
 * Moves one data instance of a device to another Signal K path. For a
 * single-leaf group the target is the full leaf path, otherwise it replaces
 * the instance's default prefix. `discriminator` is present exactly when the
 * group has one (tank type, sensor source).
 */
export interface N2kInstanceRule {
  group: N2kInstanceGroupId
  discriminator?: number
  instance: number
  target: string
}

/** Rules keyed by device key, `<manufacturer code>:<unique number>`. */
export type N2kInstanceMappings = Record<string, readonly N2kInstanceRule[]>

/** Grammar of a rule target, shared by server validation and the admin UI. */
export const MAX_TARGET_LENGTH = 128
export const MAX_TARGET_SEGMENTS = 8
export const NOTIFICATIONS_ROOT = 'notifications'
/**
 * Path segments the server drops from every delta (FORBIDDEN_PATH_KEYS in
 * @signalk/server-api); a target containing one would silently lose its data.
 */
export const FORBIDDEN_TARGET_SEGMENTS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype'
])
