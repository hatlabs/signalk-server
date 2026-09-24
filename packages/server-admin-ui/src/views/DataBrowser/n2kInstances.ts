import { useCallback, useEffect, useState } from 'react'
import type { N2kDeviceEntry } from '../../utils/sourceLabels'
import type { N2kInstanceRule } from '../../store'

// NMEA 2000 lookup labels (canboat TEMPERATURE_SOURCE, HUMIDITY_SOURCE,
// TANK_TYPE, PRESSURE_SOURCE).
export const TEMPERATURE_SOURCE_LABELS: Record<number, string> = {
  0: 'Sea Temperature',
  1: 'Outside Temperature',
  2: 'Inside Temperature',
  3: 'Engine Room Temperature',
  4: 'Main Cabin Temperature',
  5: 'Live Well Temperature',
  6: 'Bait Well Temperature',
  7: 'Refrigeration Temperature',
  8: 'Heating System Temperature',
  9: 'Dew Point Temperature',
  10: 'Apparent Wind Chill Temperature',
  11: 'Theoretical Wind Chill Temperature',
  12: 'Heat Index Temperature',
  13: 'Freezer Temperature',
  14: 'Exhaust Gas Temperature',
  15: 'Shaft Seal Temperature'
}

export const HUMIDITY_SOURCE_LABELS: Record<number, string> = {
  0: 'Inside',
  1: 'Outside'
}

const TANK_TYPE_LABELS: Record<number, string> = {
  0: 'Fuel',
  1: 'Water',
  2: 'Gray water',
  3: 'Live well',
  4: 'Oil',
  5: 'Black water'
}

const PRESSURE_SOURCE_LABELS: Record<number, string> = {
  0: 'Atmospheric',
  1: 'Water',
  2: 'Steam',
  3: 'Compressed Air',
  4: 'Hydraulic',
  5: 'Filter',
  6: 'Altimeter Setting',
  7: 'Oil',
  8: 'Fuel'
}

/** One instance the device was heard sending, from GET /n2kDiscoverInstances. */
export interface DiscoveredInstance {
  pgn: number
  instance: number
  sourceLabel: string
  sourceEnum?: number
  label?: string
  hardwareChannelId?: number
  group?: string
  discriminator?: number
  defaultPrefix?: string
}

interface ChannelLabel {
  hardwareChannelId: number
  pgn?: number
  instance?: number
  label: string
}

export interface DiscoverResult {
  instances: DiscoveredInstance[]
  channelLabels: ChannelLabel[]
}

export interface InstanceScan {
  instances: DiscoveredInstance[] | null
  loading: boolean
  error: string | null
  rescan: () => void
}

/**
 * The instances a device sends, from one ~6 s listen on the bus. Starts
 * scanning on mount when enabled; `rescan` listens again.
 */
export function useN2kInstanceScan(
  device: N2kDeviceEntry,
  enabled: boolean
): InstanceScan {
  const [instances, setInstances] = useState<DiscoveredInstance[] | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)
  const [scanCount, setScanCount] = useState(0)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    fetch(
      `${window.serverRoutesPrefix}/n2kDiscoverInstances?src=${device.src}&sourceRef=${encodeURIComponent(device.sourceRef)}`,
      { credentials: 'include' }
    )
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<DiscoverResult>
      })
      .then((data) => {
        if (cancelled) return
        setInstances(data.instances)
        setLoading(false)
      })
      .catch((err: Error) => {
        if (cancelled) return
        setError(err.message)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled, device.src, device.sourceRef, scanCount])

  const rescan = useCallback(() => {
    setLoading(true)
    setError(null)
    setScanCount((n) => n + 1)
  }, [])

  return { instances, loading, error, rescan }
}

// Mirrors the instance group table in @signalk/streams n2k-instance-groups.
export const GROUP_LABELS: Record<string, string> = {
  engine: 'Engine',
  battery: 'Battery',
  charger: 'Charger',
  inverter: 'Inverter',
  acInput: 'AC input',
  tank: 'Tank',
  temperature: 'Temperature',
  humidity: 'Humidity',
  pressure: 'Pressure',
  acConnection: 'AC connection',
  converter: 'Converter',
  dcConnection: 'DC connection',
  rudder: 'Rudder'
}

const GROUP_ORDER = Object.keys(GROUP_LABELS)

export const MAPPABLE_PGNS = new Set([
  '127488',
  '127489',
  '127493',
  '127497',
  '127506',
  '127508',
  '127513',
  '127507',
  '127510',
  '127504',
  '127509',
  '127511',
  '127503',
  '127505',
  '130312',
  '130316',
  '130313',
  '130314',
  '127744',
  '127745',
  '127746',
  '127750',
  '127751',
  '127245'
])

/** Groups whose target is the full path of their one leaf. */
export const SINGLE_LEAF_GROUPS = new Set([
  'temperature',
  'humidity',
  'pressure',
  'rudder'
])

// A leaf n2k-signalk writes under each multi-leaf group's prefix, to show
// what a target produces.
const EXAMPLE_LEAVES: Record<string, string> = {
  engine: 'revolutions',
  battery: 'voltage',
  charger: 'operatingState',
  inverter: 'operatingState',
  tank: 'currentLevel',
  converter: 'operatingState',
  dcConnection: 'voltage'
}

const DISCRIMINATOR_LABELS: Record<string, Record<number, string>> = {
  tank: TANK_TYPE_LABELS,
  temperature: TEMPERATURE_SOURCE_LABELS,
  humidity: HUMIDITY_SOURCE_LABELS,
  pressure: PRESSURE_SOURCE_LABELS
}

export function hasMappablePgn(device: N2kDeviceEntry): boolean {
  return Object.keys(device.pgns ?? {}).some((pgn) => MAPPABLE_PGNS.has(pgn))
}

export function groupLabel(group: string): string {
  return GROUP_LABELS[group] ?? group
}

export function discriminatorLabel(
  group: string,
  code: number | undefined
): string | undefined {
  if (code === undefined) return undefined
  return DISCRIMINATOR_LABELS[group]?.[code] ?? `Code ${code}`
}

type RuleIdentity = Pick<
  N2kInstanceRule,
  'group' | 'discriminator' | 'instance'
>

export function ruleKey(rule: RuleIdentity): string {
  return `${rule.group}:${rule.discriminator ?? ''}:${rule.instance}`
}

export function hasMappingRule(
  rules: readonly N2kInstanceRule[] | undefined,
  identity: RuleIdentity
): boolean {
  const key = ruleKey(identity)
  return rules?.some((rule) => ruleKey(rule) === key) ?? false
}

/** One mappable instance of a device: observed on the bus, stored, or both. */
export interface MappingRow {
  key: string
  group: string
  discriminator?: number
  instance: number
  /** Undefined when the scan did not see the instance. */
  defaultPrefix?: string
}

function compareRows(a: MappingRow, b: MappingRow): number {
  return (
    GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) ||
    (a.discriminator ?? -1) - (b.discriminator ?? -1) ||
    a.instance - b.instance
  )
}

/**
 * One row per (group, discriminator, instance): the PGNs of a group
 * collapse into one row, and stored rules the scan did not see get a row
 * without a default.
 */
export function buildMappingRows(
  instances: readonly DiscoveredInstance[],
  rules: readonly N2kInstanceRule[]
): MappingRow[] {
  const rows = new Map<string, MappingRow>()
  for (const inst of instances) {
    if (inst.group === undefined) continue
    const identity = {
      group: inst.group,
      discriminator: inst.discriminator,
      instance: inst.instance
    }
    const key = ruleKey(identity)
    if (!rows.has(key)) {
      rows.set(key, { key, ...identity, defaultPrefix: inst.defaultPrefix })
    }
  }
  for (const rule of rules) {
    const key = ruleKey(rule)
    if (!rows.has(key)) {
      rows.set(key, {
        key,
        group: rule.group,
        discriminator: rule.discriminator,
        instance: rule.instance
      })
    }
  }
  return [...rows.values()].sort(compareRows)
}

/** Edited targets by row key; null deletes the row's rule. */
export type MappingDrafts = Record<string, string | null>

export interface MappingRowState {
  row: MappingRow
  /** The target field's value; null when the rule is being deleted. */
  target: string | null
  /** The rule this row saves as; undefined when it keeps the default. */
  rule?: N2kInstanceRule
  dirty: boolean
  examplePath?: string
  error?: string
  warning?: string
}

export interface MappingEvaluation {
  rows: MappingRowState[]
  rules: N2kInstanceRule[]
  dirty: boolean
  valid: boolean
}

export const MAX_TARGET_LENGTH = 128
export const MAX_TARGET_SEGMENTS = 8
const TARGET_PATTERN = new RegExp(
  `^[A-Za-z0-9]+(?:\\.[A-Za-z0-9]+){0,${MAX_TARGET_SEGMENTS - 1}}$`
)
export const NOTIFICATIONS_ROOT = 'notifications'
// Segments that would reach the object prototype when the server builds the
// tree.
export const FORBIDDEN_TARGET_SEGMENTS = new Set([
  '__proto__',
  'constructor',
  'prototype'
])
const INSIDE_ROOT = ['environment', 'inside']

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(b + '.') || b.startsWith(a + '.')
}

function targetGrammarError(target: string): string | undefined {
  if (target === '') return 'Enter a path, or reset to the default'
  if (target.length > MAX_TARGET_LENGTH) {
    return `At most ${MAX_TARGET_LENGTH} characters`
  }
  if (!TARGET_PATTERN.test(target)) {
    return `Use 1–${MAX_TARGET_SEGMENTS} dot-separated segments of letters and digits`
  }
  const segments = target.split('.')
  if (segments[0] === NOTIFICATIONS_ROOT) {
    return `Must not be under ${NOTIFICATIONS_ROOT}`
  }
  const forbidden = segments.find((segment) =>
    FORBIDDEN_TARGET_SEGMENTS.has(segment)
  )
  if (forbidden !== undefined) {
    return `Must not contain the segment ${forbidden}`
  }
  return undefined
}

export function describeMappingRow(row: MappingRow): string {
  const discriminator = discriminatorLabel(row.group, row.discriminator)
  return [groupLabel(row.group), discriminator, `instance ${row.instance}`]
    .filter(Boolean)
    .join(' ')
}

function examplePath(group: string, target: string): string {
  const leaf = SINGLE_LEAF_GROUPS.has(group) ? undefined : EXAMPLE_LEAVES[group]
  return leaf ? `${target}.${leaf}` : target
}

// The schema defines units under environment.inside for one zone segment
// only (environment.inside.<zone>.<leaf>).
function insideDepthWarning(path: string): string | undefined {
  const segments = path.split('.')
  const underInside = INSIDE_ROOT.every((s, i) => segments[i] === s)
  if (underInside && segments.length - INSIDE_ROOT.length - 1 > 1) {
    return 'More than one segment between environment.inside and the value: the Signal K schema gives it no units. Use a single zone name such as engineRoomAft.'
  }
  return undefined
}

/**
 * The rule list the rows save as, with per-row validation mirroring the
 * server's: target grammar, no two targets of the device equal or nested,
 * and no target on the default path of an instance of the same group that
 * keeps its default.
 */
export function evaluateMappings(
  rows: readonly MappingRow[],
  stored: readonly N2kInstanceRule[],
  drafts: MappingDrafts
): MappingEvaluation {
  const storedByKey = new Map(stored.map((rule) => [ruleKey(rule), rule]))

  const states: MappingRowState[] = rows.map((row) => {
    const storedRule = storedByKey.get(row.key)
    const draft = drafts[row.key]
    const target =
      draft !== undefined
        ? draft
        : (storedRule?.target ?? row.defaultPrefix ?? '')
    let rule: N2kInstanceRule | undefined
    if (target !== null && target !== row.defaultPrefix) {
      rule = { group: row.group, instance: row.instance, target }
      if (row.discriminator !== undefined) {
        rule.discriminator = row.discriminator
      }
    }
    return {
      row,
      target,
      rule,
      dirty: (storedRule?.target ?? null) !== (rule?.target ?? null),
      examplePath:
        target === null || target === ''
          ? undefined
          : examplePath(row.group, target)
    }
  })

  for (const state of states) {
    const { rule } = state
    if (!rule) continue
    state.error = targetGrammarError(rule.target)
    if (state.error) continue
    for (const other of states) {
      if (other === state) continue
      if (other.rule) {
        if (overlaps(rule.target, other.rule.target)) {
          state.error = `Overlaps the path of ${describeMappingRow(other.row)}`
          break
        }
      } else if (
        other.row.group === state.row.group &&
        other.row.discriminator === state.row.discriminator &&
        other.row.defaultPrefix !== undefined &&
        overlaps(rule.target, other.row.defaultPrefix)
      ) {
        state.error = `Overlaps the default path of ${describeMappingRow(other.row)}, which has no rule`
        break
      }
    }
    if (!state.error && state.examplePath) {
      state.warning = insideDepthWarning(state.examplePath)
    }
  }

  return {
    rows: states,
    rules: states.flatMap((state) => (state.rule ? [state.rule] : [])),
    dirty: states.some((state) => state.dirty),
    valid: states.every((state) => state.error === undefined)
  }
}
