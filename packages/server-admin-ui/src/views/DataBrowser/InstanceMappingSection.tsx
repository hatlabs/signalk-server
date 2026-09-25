import React, { useEffect, useMemo, useState } from 'react'
import Badge from 'react-bootstrap/Badge'
import Button from 'react-bootstrap/Button'
import Spinner from 'react-bootstrap/Spinner'
import Table from 'react-bootstrap/Table'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faInfoCircle } from '@fortawesome/free-solid-svg-icons/faInfoCircle'
import { faTriangleExclamation } from '@fortawesome/free-solid-svg-icons/faTriangleExclamation'
import type { N2kDeviceEntry } from '../../utils/sourceLabels'
import { deviceKeyFromCanName } from '../../utils/n2kDeviceKey'
import {
  useLoginStatus,
  useN2kInstanceRules,
  useStore,
  type N2kInstanceRule
} from '../../store'
import {
  buildMappingRows,
  describeMappingRow,
  discriminatorLabel,
  evaluateMappings,
  groupLabel,
  hasMappingRule,
  type InstanceScan,
  type MappingDrafts,
  type MappingRowState
} from './n2kInstances'

const DOCS_URL =
  '/admin/#/documentation/Configuration/NMEA_2000_Device_Management.html#instance-path-mapping'

const labelStyle = {
  fontWeight: 500 as const,
  color: 'var(--bs-secondary-color, #6c757d)'
}

const helpStyle = {
  fontSize: '0.8rem',
  color: 'var(--bs-secondary-color, #6c757d)',
  margin: '2px 0'
}

const DIRTY_ROW_STYLE = {
  backgroundColor: 'var(--bs-warning-bg-subtle, #fff3cd)'
}

function deviceKeyOf(device: N2kDeviceEntry): string | undefined {
  return device.canName ? deviceKeyFromCanName(device.canName) : undefined
}

function useIsAdmin(): boolean {
  const loginStatus = useLoginStatus()
  return (
    !loginStatus.authenticationRequired || loginStatus.userLevel === 'admin'
  )
}

/**
 * Tells an instance editor that a path mapping is keyed on the instance
 * number it edits, and whether the server moves the mapping along when the
 * editor renumbers the instance.
 */
export const MappedInstanceNotice: React.FC<{
  device: N2kDeviceEntry
  group: string
  discriminator?: number
  instance: number
  followsRenumber?: boolean
}> = ({ device, group, discriminator, instance, followsRenumber }) => {
  const rules = useN2kInstanceRules(deviceKeyOf(device))
  if (!hasMappingRule(rules, { group, discriminator, instance })) return null
  return (
    <div style={{ ...helpStyle, marginLeft: '12px' }}>
      <FontAwesomeIcon icon={faInfoCircle} /> A Signal K path mapping exists for
      this instance;{' '}
      {followsRenumber
        ? 'renumbering it here moves the mapping to the new instance.'
        : 'it stops applying if the instance changes.'}
    </div>
  )
}

type LoadState = 'loading' | 'loaded' | 'forbidden' | 'failed'

function useStoredRules(deviceKey: string | undefined, enabled: boolean) {
  const rules = useN2kInstanceRules(deviceKey)
  const setDeviceRules = useStore((s) => s.setN2kDeviceInstanceMappings)
  const [failure, setFailure] = useState<'forbidden' | 'failed' | null>(null)

  useEffect(() => {
    if (!enabled || deviceKey === undefined || rules !== undefined) return
    let cancelled = false
    fetch(
      `${window.serverRoutesPrefix}/n2kInstanceMappings/${encodeURIComponent(deviceKey)}`,
      { credentials: 'include' }
    )
      .then(async (res) => {
        if (cancelled) return
        if (res.status === 401 || res.status === 403) {
          setFailure('forbidden')
        } else if (!res.ok) {
          setFailure('failed')
        } else {
          setDeviceRules(deviceKey, (await res.json()) as N2kInstanceRule[])
        }
      })
      .catch(() => {
        if (!cancelled) setFailure('failed')
      })
    return () => {
      cancelled = true
    }
  }, [enabled, deviceKey, rules, setDeviceRules])

  const state: LoadState =
    rules !== undefined ? 'loaded' : (failure ?? 'loading')
  return { rules, state }
}

async function putRules(
  deviceKey: string,
  rules: N2kInstanceRule[]
): Promise<void> {
  const res = await fetch(
    `${window.serverRoutesPrefix}/n2kInstanceMappings/${encodeURIComponent(deviceKey)}`,
    {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rules)
    }
  )
  if (res.ok) return
  const body = (await res.json().catch(() => undefined)) as
    { message?: string } | undefined
  throw new Error(body?.message ?? `HTTP ${res.status}`)
}

const NO_RULES: N2kInstanceRule[] = []

/**
 * Edits where the device's data instances land in the Signal K tree.
 * Rows are the mappable instances the scan heard, merged with the stored
 * rules; one Save sends the device's complete rule list.
 */
const InstanceMappingSection: React.FC<{
  device: N2kDeviceEntry
  /** The device's instance scan; undefined when it sends no mappable PGN. */
  scan?: InstanceScan
}> = ({ device, scan }) => {
  const isAdmin = useIsAdmin()
  const deviceKey = deviceKeyOf(device)
  const { rules: storedRules, state } = useStoredRules(deviceKey, isAdmin)
  const stored = storedRules ?? NO_RULES
  const setDeviceRules = useStore((s) => s.setN2kDeviceInstanceMappings)
  const [drafts, setDrafts] = useState<MappingDrafts>({})
  const [saving, setSaving] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const evaluation = useMemo(
    () =>
      evaluateMappings(
        buildMappingRows(scan?.instances ?? [], stored),
        stored,
        drafts
      ),
    [scan?.instances, stored, drafts]
  )

  if (!isAdmin || state === 'forbidden') return null
  if (!scan && (deviceKey === undefined || stored.length === 0)) return null

  const header = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        marginTop: '8px'
      }}
    >
      <span style={{ ...labelStyle, fontWeight: 600 }}>
        Signal K path mapping
      </span>
      {scan && deviceKey !== undefined && !scan.loading && (
        <Button
          size="sm"
          variant="outline-secondary"
          style={{ fontSize: '0.8em', padding: '1px 6px' }}
          onClick={scan.rescan}
        >
          Re-scan
        </Button>
      )}
    </div>
  )

  const help = (
    <>
      <p style={helpStyle}>
        The path is where this device writes an instance&apos;s data in the
        Signal K tree. Every path under it moves, notifications included;
        temperature, humidity, pressure and rudder take the full path of their
        one value. This is separate from the Data Instances label, which is
        metadata stored in the device and does not change any path. Rules belong
        to the device and apply on every connection it is seen on.
      </p>
      <p style={helpStyle}>
        Not moved with a new path: recorded history, source priority path
        overrides, metadata edits, and PUT handling and NMEA 2000 output, which
        keep using the default paths.{' '}
        <a href={DOCS_URL} target="_blank" rel="noreferrer">
          Documentation
        </a>
      </p>
    </>
  )

  if (deviceKey === undefined) {
    return (
      <div style={{ gridColumn: '1 / -1' }}>
        {header}
        <p style={helpStyle}>
          Mapping unavailable until the device&apos;s address claim is received.
        </p>
      </div>
    )
  }

  if (state === 'failed') {
    return (
      <div style={{ gridColumn: '1 / -1' }}>
        {header}
        <span style={{ color: 'var(--bs-danger, #f86c6b)' }}>
          Failed to load the path mappings
        </span>
      </div>
    )
  }

  if (state === 'loading' || scan?.loading) {
    return (
      <div style={{ gridColumn: '1 / -1' }}>
        {header}
        <Spinner size="sm" animation="border" />{' '}
        <span style={{ fontSize: '0.85em', color: '#888' }}>
          {scan?.loading
            ? 'Listening to N2K bus (~6s)...'
            : 'Loading path mappings...'}
        </span>
      </div>
    )
  }

  const edit = (key: string, value: string | null | undefined) => {
    setDrafts((prev) => {
      const next = { ...prev }
      if (value === undefined) delete next[key]
      else next[key] = value
      return next
    })
    setSaved(false)
  }

  const revert = () => {
    setDrafts({})
    setServerError(null)
    setSaved(false)
  }

  const save = () => {
    const rules = evaluation.rules
    setSaving(true)
    setServerError(null)
    putRules(deviceKey, rules)
      .then(() => {
        setDeviceRules(deviceKey, rules)
        setDrafts({})
        setSaved(true)
      })
      .catch((err: Error) => setServerError(err.message))
      .finally(() => setSaving(false))
  }

  return (
    <div style={{ gridColumn: '1 / -1' }}>
      {header}
      {help}
      {scan?.error && (
        <div style={{ color: 'var(--bs-danger, #f86c6b)' }}>
          Scan failed: {scan.error}
        </div>
      )}
      {evaluation.rows.length === 0 && (
        <p style={{ ...helpStyle, color: '#888' }}>
          No mappable instances detected
        </p>
      )}
      {evaluation.rows.length > 0 && (
        <>
          <Table size="sm" bordered responsive style={{ marginBottom: '4px' }}>
            <thead>
              <tr>
                <th>Group</th>
                <th>Type / source</th>
                <th>Instance</th>
                <th>Default path</th>
                <th>Signal K path</th>
              </tr>
            </thead>
            <tbody>
              {evaluation.rows.map((rowState) => (
                <MappingRowView
                  key={rowState.row.key}
                  state={rowState}
                  disabled={saving}
                  onEdit={edit}
                />
              ))}
            </tbody>
          </Table>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Button
              size="sm"
              variant="primary"
              disabled={!evaluation.dirty || !evaluation.valid || saving}
              onClick={save}
            >
              {saving ? 'Saving...' : 'Save'}
            </Button>
            <Button
              size="sm"
              variant="outline-secondary"
              disabled={!evaluation.dirty || saving}
              onClick={revert}
            >
              Revert
            </Button>
            {saved && (
              <span style={{ color: 'var(--bs-success, #4dbd74)' }}>
                Path mappings saved
              </span>
            )}
            {serverError && (
              <span role="alert" style={{ color: 'var(--bs-danger, #f86c6b)' }}>
                {serverError}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}

const MappingRowView: React.FC<{
  state: MappingRowState
  disabled: boolean
  /** undefined drops the row's edit. */
  onEdit: (key: string, value: string | null | undefined) => void
}> = ({ state, disabled, onEdit }) => {
  const { row, target, rule, dirty, examplePath, error, warning } = state
  const observed = row.defaultPrefix !== undefined
  const description = describeMappingRow(row)
  return (
    <tr style={dirty ? DIRTY_ROW_STYLE : undefined}>
      <td style={dirty ? DIRTY_ROW_STYLE : undefined}>
        {groupLabel(row.group)}
      </td>
      <td style={dirty ? DIRTY_ROW_STYLE : undefined}>
        {discriminatorLabel(row.group, row.discriminator) ?? ''}
      </td>
      <td style={dirty ? DIRTY_ROW_STYLE : undefined}>{row.instance}</td>
      <td
        style={{
          ...(dirty ? DIRTY_ROW_STYLE : {}),
          fontFamily: 'monospace',
          fontSize: '0.8rem'
        }}
      >
        {observed ? (
          row.defaultPrefix
        ) : (
          <Badge bg="secondary">not currently observed</Badge>
        )}
      </td>
      <td style={dirty ? DIRTY_ROW_STYLE : undefined}>
        {target === null ? (
          <span style={{ color: '#888' }}>
            Rule removed on save{' '}
            <Button
              size="sm"
              variant="link"
              style={{ padding: 0, fontSize: 'inherit' }}
              onClick={() => onEdit(row.key, undefined)}
              disabled={disabled}
            >
              Undo
            </Button>
          </span>
        ) : (
          <>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <input
                type="text"
                aria-label={`Path for ${description}`}
                aria-invalid={error !== undefined}
                value={target}
                disabled={disabled}
                onChange={(e) => onEdit(row.key, e.target.value)}
                style={{
                  flex: 1,
                  minWidth: '14em',
                  fontFamily: 'monospace',
                  fontSize: '0.8rem',
                  padding: '1px 4px',
                  border: `1px solid ${error ? 'var(--bs-danger, #f86c6b)' : 'var(--bs-border-color, #dee2e6)'}`,
                  borderRadius: '3px'
                }}
              />
              {observed && rule && (
                <Button
                  size="sm"
                  variant="outline-secondary"
                  style={{ fontSize: '0.8em', padding: '1px 6px' }}
                  disabled={disabled}
                  onClick={() => onEdit(row.key, row.defaultPrefix ?? '')}
                >
                  Reset to default
                </Button>
              )}
              {!observed && (
                <Button
                  size="sm"
                  variant="outline-danger"
                  style={{ fontSize: '0.8em', padding: '1px 6px' }}
                  disabled={disabled}
                  onClick={() => onEdit(row.key, null)}
                  aria-label={`Delete rule for ${description}`}
                >
                  Delete
                </Button>
              )}
            </div>
            {examplePath && !error && (
              <div style={{ ...helpStyle, fontFamily: 'monospace' }}>
                e.g. {examplePath}
              </div>
            )}
            {error && (
              <div
                style={{
                  fontSize: '0.8rem',
                  color: 'var(--bs-danger, #f86c6b)'
                }}
              >
                {error}
              </div>
            )}
            {warning && (
              <div
                style={{
                  fontSize: '0.8rem',
                  color: 'var(--bs-warning-text-emphasis, #997404)'
                }}
              >
                <FontAwesomeIcon icon={faTriangleExclamation} /> {warning}
              </div>
            )}
          </>
        )}
      </td>
    </tr>
  )
}

export default InstanceMappingSection
