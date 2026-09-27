/*
 * Per-device rules that move an NMEA 2000 instance group's Signal K paths
 * to a user-chosen prefix: validation, the admin REST routes and the cache
 * prune that runs when a device's rules change. The NMEA 2000 conversion
 * stream applies the rules; it reloads them on N2KINSTANCEMAPPINGS.
 */

import { Request, Response } from 'express'
import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { createDebug } from './debug'
import {
  classifyN2kInstance,
  defaultPrefixes,
  deviceKeyFromCanName,
  instanceRuleKey,
  isAtOrUnder,
  N2K_INSTANCE_GROUPS,
  N2kFrame,
  N2kInstanceGroup,
  N2kInstanceGroupId,
  N2kInstanceMappings,
  N2kInstanceRule,
  ruleShapeError,
  FORBIDDEN_TARGET_SEGMENTS,
  MAX_TARGET_LENGTH,
  MAX_TARGET_SEGMENTS,
  NOTIFICATIONS_ROOT
} from '@signalk/streams/n2k-instance-groups'
import { SERVERROUTESPREFIX } from './constants'

const debug = createDebug('signalk-server:n2k-instance-mappings')

export const N2K_INSTANCE_MAPPINGS_EVENT = 'N2KINSTANCEMAPPINGS'

const MAX_RULES = 64
const TARGET_PATTERN = new RegExp(
  `^[A-Za-z0-9]+(?:\\.[A-Za-z0-9]+){0,${MAX_TARGET_SEGMENTS - 1}}$`
)
// Highest claimable NMEA 2000 source address.
const MAX_BUS_ADDRESS = 253
const DEVICE_KEY_PATTERN = /^\d+:\d+$/

const rulesSchema = Type.Array(
  Type.Object(
    {
      group: Type.String(),
      discriminator: Type.Optional(Type.Integer({ minimum: 0 })),
      instance: Type.Integer({ minimum: 0 }),
      target: Type.String({ maxLength: MAX_TARGET_LENGTH })
    },
    { additionalProperties: false }
  ),
  { maxItems: MAX_RULES }
)

const GROUPS = new Map<string, N2kInstanceGroup>(
  N2K_INSTANCE_GROUPS.map((group) => [group.id, group])
)

export function isDeviceKey(key: string): boolean {
  return DEVICE_KEY_PATTERN.test(key)
}

type RuleIdentity = Pick<
  N2kInstanceRule,
  'group' | 'discriminator' | 'instance'
>

function ruleKey(rule: RuleIdentity): string {
  return instanceRuleKey(rule.group, rule.discriminator, rule.instance)
}

function overlaps(a: string, b: string): boolean {
  return isAtOrUnder(a, b) || isAtOrUnder(b, a)
}

function describeRule(rule: RuleIdentity): string {
  const discriminator =
    rule.discriminator === undefined
      ? ''
      : ` discriminator ${rule.discriminator}`
  return `${rule.group}${discriminator} instance ${rule.instance}`
}

// A rule must hold wherever the device sits on the bus, so a default that
// embeds the bus address is checked at every address the target could name:
// its numeric segments, plus one address for defaults the target is shorter
// than. Defaults that do not embed the address need only one.
function candidateAddresses(rule: RuleIdentity, target: string): number[] {
  const at = (src: number) =>
    defaultPrefixes(rule.group, rule.discriminator, rule.instance, src).join()
  if (at(0) === at(1)) return [0]
  const addresses = new Set<number>([0])
  for (const segment of target.split('.')) {
    const n = Number(segment)
    if (/^\d+$/.test(segment) && n <= MAX_BUS_ADDRESS) addresses.add(n)
  }
  return [...addresses]
}

function checkRuleShape(raw: unknown, index: number): string | undefined {
  const error = ruleShapeError(raw)
  return error === undefined ? undefined : `rules[${index}]: ${error}`
}

function checkTargetGrammar(target: string, index: number): string | undefined {
  if (!TARGET_PATTERN.test(target)) {
    return `rules[${index}]: target must be 1-${MAX_TARGET_SEGMENTS} dot-separated alphanumeric segments`
  }
  const segments = target.split('.')
  if (segments[0] === NOTIFICATIONS_ROOT) {
    return `rules[${index}]: target must not be under ${NOTIFICATIONS_ROOT}`
  }
  const forbidden = segments.find((segment) =>
    FORBIDDEN_TARGET_SEGMENTS.has(segment)
  )
  if (forbidden !== undefined) {
    return `rules[${index}]: target must not contain the segment ${forbidden}`
  }
  return undefined
}

// The target must not land on, or next to, a path the same device still
// writes by default: its own default, or the default of another instance of
// the group that no rule moves away.
function checkAgainstDefaults(
  rule: N2kInstanceRule,
  index: number,
  mapped: ReadonlySet<string>
): string | undefined {
  const group = GROUPS.get(rule.group) as N2kInstanceGroup
  for (const src of candidateAddresses(rule, rule.target)) {
    const own = defaultPrefixes(
      rule.group,
      rule.discriminator,
      rule.instance,
      src
    )
    if (own.includes(rule.target)) {
      return `rules[${index}]: target ${rule.target} is the default path of ${describeRule(rule)}`
    }
    for (let instance = 0; instance <= group.maxInstance; instance++) {
      const other = { ...rule, instance }
      if (instance === rule.instance || mapped.has(ruleKey(other))) continue
      for (const prefix of defaultPrefixes(
        rule.group,
        rule.discriminator,
        instance,
        src
      )) {
        if (overlaps(rule.target, prefix)) {
          return `rules[${index}]: target ${rule.target} overlaps ${prefix}, the default path of ${describeRule(other)}, which has no rule`
        }
      }
    }
  }
  return undefined
}

export type N2kInstanceMappingsValidation =
  { ok: true; value: N2kInstanceRule[] } | { ok: false; error: string }

/** Validate one device's complete rule list. */
export function validateInstanceMappings(
  body: unknown
): N2kInstanceMappingsValidation {
  if (!Value.Check(rulesSchema, body)) {
    const first = Value.Errors(rulesSchema, body).First()
    return {
      ok: false,
      error: first
        ? `Invalid rules at ${first.path}: ${first.message}`
        : 'Invalid rules'
    }
  }

  const rules: N2kInstanceRule[] = []
  for (const [index, raw] of body.entries()) {
    const error =
      checkRuleShape(raw, index) ?? checkTargetGrammar(raw.target, index)
    if (error) return { ok: false, error }
    const rule: N2kInstanceRule = {
      group: raw.group as N2kInstanceGroupId,
      instance: raw.instance,
      target: raw.target
    }
    if (raw.discriminator !== undefined) rule.discriminator = raw.discriminator
    rules.push(rule)
  }

  const mapped = new Set<string>()
  for (const [index, rule] of rules.entries()) {
    const key = ruleKey(rule)
    if (mapped.has(key)) {
      return {
        ok: false,
        error: `rules[${index}]: more than one rule for ${describeRule(rule)}`
      }
    }
    mapped.add(key)
  }

  for (const [index, rule] of rules.entries()) {
    for (let other = index + 1; other < rules.length; other++) {
      if (overlaps(rule.target, rules[other].target)) {
        return {
          ok: false,
          error: `rules[${other}]: target ${rules[other].target} overlaps rules[${index}] target ${rule.target}`
        }
      }
    }
    const error = checkAgainstDefaults(rule, index, mapped)
    if (error) return { ok: false, error }
  }

  return { ok: true, value: rules }
}

/**
 * Path prefixes whose leaves one of the device's sources, at bus address
 * `src`, stops writing when its rules change from `oldRules` to `newRules`:
 * the default of an added rule and the old target of a changed or removed
 * one that no rule still targets, each with its notifications twin.
 */
export function prunePrefixes(
  oldRules: readonly N2kInstanceRule[],
  newRules: readonly N2kInstanceRule[],
  src: number
): string[] {
  const oldByKey = new Map(oldRules.map((rule) => [ruleKey(rule), rule]))
  const newByKey = new Map(newRules.map((rule) => [ruleKey(rule), rule]))
  // A target another rule of the device still writes keeps its live data.
  const newTargets = new Set(newRules.map((rule) => rule.target))
  const vacated: string[] = []
  const vacate = (target: string) => {
    if (!newTargets.has(target)) vacated.push(target)
  }
  for (const [key, rule] of newByKey) {
    const old = oldByKey.get(key)
    if (!old) {
      vacated.push(
        ...defaultPrefixes(rule.group, rule.discriminator, rule.instance, src)
      )
    } else if (old.target !== rule.target) {
      vacate(old.target)
    }
  }
  for (const [key, rule] of oldByKey) {
    if (!newByKey.has(key)) vacate(rule.target)
  }
  const prefixes: string[] = []
  for (const prefix of vacated) {
    for (const p of [prefix, `${NOTIFICATIONS_ROOT}.${prefix}`]) {
      if (!prefixes.includes(p)) prefixes.push(p)
    }
  }
  return prefixes
}

export interface DeviceSourceRef {
  ref: string
  src: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

type SourceRefVisitor = (ref: string, src: number, deviceKey: string) => void

// Every NMEA 2000 sourceRef with a known identity, in both the canName and
// the bus-address form, on every connection. Read from the sources tree and
// from the per-source identity deltas, which can know the canName before the
// tree does.
function forEachIdentifiedSourceRef(
  sources: unknown,
  sourceDeltas: Record<string, unknown>,
  visit: SourceRefVisitor
): void {
  const add = (provider: unknown, canName: unknown, src: unknown) => {
    if (typeof provider !== 'string' || typeof canName !== 'string') return
    const address = Number(src)
    if (src === undefined || src === null || !Number.isInteger(address)) return
    const deviceKey = deviceKeyFromCanName(canName)
    if (deviceKey === undefined) return
    visit(`${provider}.${canName}`, address, deviceKey)
    visit(`${provider}.${address}`, address, deviceKey)
  }

  if (isRecord(sources)) {
    for (const [provider, devices] of Object.entries(sources)) {
      if (!isRecord(devices)) continue
      for (const [subKey, device] of Object.entries(devices)) {
        const n2k = isRecord(device) ? device.n2k : undefined
        if (!isRecord(n2k)) continue
        add(provider, n2k.canName, n2k.src ?? subKey)
      }
    }
  }

  for (const delta of Object.values(sourceDeltas)) {
    const updates = isRecord(delta) ? delta.updates : undefined
    const first: unknown = Array.isArray(updates) ? updates[0] : undefined
    const source = isRecord(first) ? first.source : undefined
    if (isRecord(source)) add(source.label, source.canName, source.src)
  }
}

/** Every sourceRef the device currently publishes under. */
export function findDeviceSourceRefs(
  deviceKey: string,
  sources: unknown,
  sourceDeltas: Record<string, unknown>
): DeviceSourceRef[] {
  const refs = new Map<string, number>()
  forEachIdentifiedSourceRef(sources, sourceDeltas, (ref, src, key) => {
    if (key === deviceKey) refs.set(ref, src)
  })
  return [...refs].map(([ref, src]) => ({ ref, src }))
}

/** The rules of the device behind a sourceRef, and its bus address. */
export interface MappedSource {
  readonly rules: readonly N2kInstanceRule[]
  readonly src: number
}

export type MappedSources = ReadonlyMap<string, MappedSource>

const NO_MAPPED_SOURCES: MappedSources = new Map()

/** Every current sourceRef whose device has rules. */
export function mappedSourceRefs(
  mappings: N2kInstanceMappings | undefined,
  sources: unknown,
  sourceDeltas: Record<string, unknown>
): MappedSources {
  if (!mappings || Object.keys(mappings).length === 0) return NO_MAPPED_SOURCES
  const mapped = new Map<string, MappedSource>()
  forEachIdentifiedSourceRef(sources, sourceDeltas, (ref, src, deviceKey) => {
    const rules = storedRules(mappings, deviceKey)
    if (rules.length > 0) mapped.set(ref, { rules, src })
  })
  return mapped
}

type RouteHandler = (req: Request, res: Response) => void

export interface N2kInstanceMappingsApp {
  config: { settings: { n2kInstanceMappings?: N2kInstanceMappings } }
  securityStrategy: { addAdminMiddleware(path: string): void }
  get(path: string, handler: RouteHandler): void
  put(path: string, handler: RouteHandler): void
  emit(event: string, ...args: unknown[]): boolean
  signalk?: { sources?: unknown }
  deltaCache: {
    sourceDeltas: Record<string, unknown>
    removeSource(sourceRef: string, prefixes?: readonly string[]): void
  }
}

export type SettingsWriter = (
  settings: object,
  cb: (err?: unknown) => void
) => void

function storedRules(
  mappings: N2kInstanceMappings | undefined,
  deviceKey: string
): N2kInstanceRule[] {
  const rules = mappings?.[deviceKey]
  return Array.isArray(rules) ? rules : []
}

function fail(res: Response, statusCode: number, message: string): void {
  res.status(statusCode).json({ state: 'FAILED', statusCode, message })
}

/**
 * Store a device's complete, validated rule list, announce every device's
 * rules and prune the cached leaves the device stops writing.
 */
export function replaceDeviceRules(
  app: N2kInstanceMappingsApp,
  writeSettings: SettingsWriter,
  deviceKey: string,
  newRules: N2kInstanceRule[],
  done: (err?: unknown) => void
): void {
  const oldRules = storedRules(
    app.config.settings.n2kInstanceMappings,
    deviceKey
  )

  const updatedSettings = structuredClone(app.config.settings)
  const stored: unknown = updatedSettings.n2kInstanceMappings
  // settings.json is hand-editable; an array would drop the keyed rules
  // when serialised.
  const mappings: N2kInstanceMappings =
    isRecord(stored) && !Array.isArray(stored)
      ? (stored as N2kInstanceMappings)
      : {}
  if (newRules.length > 0) {
    mappings[deviceKey] = newRules
  } else {
    delete mappings[deviceKey]
  }
  updatedSettings.n2kInstanceMappings = mappings

  writeSettings(updatedSettings, (err) => {
    if (err) {
      done(err)
      return
    }
    app.config.settings = updatedSettings
    app.emit('serverAdminEvent', {
      type: N2K_INSTANCE_MAPPINGS_EVENT,
      data: mappings
    })
    for (const { ref, src } of findDeviceSourceRefs(
      deviceKey,
      app.signalk?.sources,
      app.deltaCache.sourceDeltas
    )) {
      const prefixes = prunePrefixes(oldRules, newRules, src)
      if (prefixes.length > 0) app.deltaCache.removeSource(ref, prefixes)
    }
    done()
  })
}

const INVALID_DEVICE_KEY =
  'deviceKey must be <manufacturer code>:<unique number>'

export function registerN2kInstanceMappingRoutes(
  app: N2kInstanceMappingsApp,
  writeSettings: SettingsWriter
): void {
  const basePath = `${SERVERROUTESPREFIX}/n2kInstanceMappings`
  const devicePath = `${basePath}/:deviceKey`
  app.securityStrategy.addAdminMiddleware(basePath)

  app.get(devicePath, (req: Request, res: Response) => {
    const { deviceKey } = req.params
    if (!isDeviceKey(deviceKey)) {
      fail(res, 400, INVALID_DEVICE_KEY)
      return
    }
    res.json(storedRules(app.config.settings.n2kInstanceMappings, deviceKey))
  })

  app.put(devicePath, (req: Request, res: Response) => {
    const { deviceKey } = req.params
    if (!isDeviceKey(deviceKey)) {
      fail(res, 400, INVALID_DEVICE_KEY)
      return
    }
    const validation = validateInstanceMappings(req.body)
    if (!validation.ok) {
      fail(res, 400, validation.error)
      return
    }
    replaceDeviceRules(
      app,
      writeSettings,
      deviceKey,
      validation.value,
      (err) => {
        if (err) {
          fail(res, 500, 'Unable to save n2kInstanceMappings in settings file')
          return
        }
        res.json({ state: 'COMPLETED', statusCode: 200 })
      }
    )
  })
}

/** An instance renumbering sent to a device through PGN 126208. */
export interface InstanceRenumber {
  dst: number
  pgn: number
  from: number
  to: number
}

interface PendingRenumber {
  readonly dst: number
  readonly pgn: number
  readonly deviceKey: string
  readonly group: N2kInstanceGroupId
  readonly from: number
  readonly to: number
  readonly expiresAt: number
}

// Longer than a device takes to apply a command and send the renumbered
// PGN at its slowest regular interval.
const RENUMBER_CONFIRM_MS = 30_000
// A device that sent an instance this recently still reports it.
const INSTANCE_SEEN_MS = 60_000

// The PGNs whose instances the NMEA Discovery page edits.
const FOLLOWED_PGNS: ReadonlySet<number> = new Set([127506, 127508])
const FOLLOWED_GROUPS = new Map<number, N2kInstanceGroup>(
  N2K_INSTANCE_GROUPS.flatMap((group) =>
    group.pgns
      .filter((pgn) => FOLLOWED_PGNS.has(pgn))
      .map((pgn): [number, N2kInstanceGroup] => [pgn, group])
  )
)
// Every PGN of those groups: renumbering one PGN moves the group's rule.
const TRACKED_PGNS: ReadonlySet<number> = new Set(
  [...FOLLOWED_GROUPS.values()].flatMap((group) => group.pgns)
)

type RekeyResult =
  | { kind: 'none' }
  | { kind: 'moved'; rules: N2kInstanceRule[] }
  | { kind: 'kept'; reason: string }

// The device's rules with the group's rule for `from` moved to `to`.
function rekeyRule(
  rules: readonly N2kInstanceRule[],
  group: N2kInstanceGroupId,
  from: number,
  to: number
): RekeyResult {
  const rule = rules.find((r) => r.group === group && r.instance === from)
  if (!rule || from === to) return { kind: 'none' }
  const moved = { ...rule, instance: to }
  if (rules.some((r) => ruleKey(r) === ruleKey(moved))) {
    return {
      kind: 'kept',
      reason: `${describeRule(moved)} already has a path mapping, so the mapping to ${rule.target} stays on instance ${from}`
    }
  }
  const validation = validateInstanceMappings(
    rules.map((r) => (r === rule ? moved : r))
  )
  if (!validation.ok) {
    return {
      kind: 'kept',
      reason: `The mapping to ${rule.target} stays on instance ${from}: ${validation.error}`
    }
  }
  return { kind: 'moved', rules: validation.value }
}

function deviceKeysAtAddress(
  address: number,
  sources: unknown,
  sourceDeltas: Record<string, unknown>
): Set<string> {
  const keys = new Set<string>()
  forEachIdentifiedSourceRef(sources, sourceDeltas, (_ref, src, deviceKey) => {
    if (src === address) keys.add(deviceKey)
  })
  return keys
}

/**
 * Moves a device's rule along when the Discovery page renumbers the instance
 * it is keyed on. The rule moves once the device sends the edited PGN with
 * the new instance: the device has then applied the command, and its frames
 * with the old instance, which would otherwise land at the default path,
 * have already arrived.
 */
export function createInstanceRuleFollower(
  app: N2kInstanceMappingsApp,
  writeSettings: SettingsWriter,
  now: () => number = Date.now
) {
  let pending: PendingRenumber[] = []
  // Moves are written one at a time, each from the rules the previous one
  // stored.
  const queue: PendingRenumber[] = []
  let writing = false
  // src -> pgn -> instance -> when it was last seen.
  const seen = new Map<number, Map<number, Map<number, number>>>()
  const rulesOf = (deviceKey: string) =>
    storedRules(app.config.settings.n2kInstanceMappings, deviceKey)

  function record(src: number, pgn: number, instance: number, at: number) {
    let byPgn = seen.get(src)
    if (!byPgn) {
      byPgn = new Map()
      seen.set(src, byPgn)
    }
    let byInstance = byPgn.get(pgn)
    if (!byInstance) {
      byInstance = new Map()
      byPgn.set(pgn, byInstance)
    }
    byInstance.set(instance, at)
  }

  function reports(src: number, pgn: number, instance: number): boolean {
    const at = seen.get(src)?.get(pgn)?.get(instance)
    return at !== undefined && now() - at <= INSTANCE_SEEN_MS
  }

  function drain(): void {
    if (writing) return
    const renumber = queue.shift()
    if (!renumber) return
    const { deviceKey, group, from, to } = renumber
    const result = rekeyRule(rulesOf(deviceKey), group, from, to)
    if (result.kind === 'kept') debug('%s: %s', deviceKey, result.reason)
    if (result.kind !== 'moved') {
      drain()
      return
    }
    writing = true
    replaceDeviceRules(app, writeSettings, deviceKey, result.rules, (err) => {
      if (err) debug('%s: could not save the moved mapping: %s', deviceKey, err)
      writing = false
      drain()
    })
  }

  return {
    /**
     * Arms the rule move for a renumbering the device was just sent.
     * Returns why the rule will not move, or what stays behind when it
     * does, when the device has a rule to move.
     */
    expectRenumber({
      dst,
      pgn,
      from,
      to
    }: InstanceRenumber): string | undefined {
      const group = FOLLOWED_GROUPS.get(pgn)
      if (group === undefined) return undefined
      const deviceKeys = deviceKeysAtAddress(
        dst,
        app.signalk?.sources,
        app.deltaCache.sourceDeltas
      )
      const affected = [...deviceKeys]
        .map((deviceKey) => ({
          deviceKey,
          result: rekeyRule(rulesOf(deviceKey), group.id, from, to)
        }))
        .filter(({ result }) => result.kind !== 'none')
      if (affected.length === 0) return undefined
      if (deviceKeys.size > 1) {
        return `More than one device uses bus address ${dst}, so a path mapping for instance ${from} was not moved to instance ${to}`
      }
      const { deviceKey, result } = affected[0]
      if (result.kind === 'kept') return result.reason
      // The device already sending the new instance would confirm a
      // command it may have rejected.
      if (reports(dst, pgn, to)) {
        return `${describeRule({ group: group.id, instance: to })} is already in use on this device; the path mapping stays on instance ${from}`
      }
      pending = pending.filter(
        (p) => !(p.dst === dst && p.pgn === pgn && p.from === from)
      )
      pending.push({
        dst,
        pgn,
        deviceKey,
        group: group.id,
        from,
        to,
        expiresAt: now() + RENUMBER_CONFIRM_MS
      })
      const stillOld = group.pgns.filter(
        (other) => other !== pgn && reports(dst, other, from)
      )
      if (stillOld.length === 0) return undefined
      const pgns =
        stillOld.length === 1
          ? `PGN ${stillOld[0]} still reports`
          : `PGNs ${stillOld.join(', ')} still report`
      return `${pgns} ${describeRule({ group: group.id, instance: from })}; after the path mapping moves to instance ${to}, its data goes to the default path until its instance is changed too`
    },

    /** Called for every decoded frame on the bus. */
    onFrame(frame: N2kFrame): void {
      const pgn = Number(frame.pgn)
      if (!TRACKED_PGNS.has(pgn)) return
      const instance = classifyN2kInstance(frame)?.instance
      if (instance === undefined) return
      const src = Number(frame.src)
      const at = now()
      record(src, pgn, instance, at)
      if (pending.length === 0) return
      const waiting: PendingRenumber[] = []
      for (const renumber of pending) {
        if (at > renumber.expiresAt) continue
        if (
          renumber.dst === src &&
          renumber.pgn === pgn &&
          renumber.to === instance
        ) {
          queue.push(renumber)
        } else {
          waiting.push(renumber)
        }
      }
      pending = waiting
      drain()
    }
  }
}
