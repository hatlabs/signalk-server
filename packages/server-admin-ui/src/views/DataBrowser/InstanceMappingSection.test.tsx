import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import InstanceMappingSection from './InstanceMappingSection'
import type { DiscoveredInstance, InstanceScan } from './n2kInstances'
import { useStore, type N2kInstanceRule } from '../../store'
import type { N2kDeviceEntry } from '../../utils/sourceLabels'

// Manufacturer code 137, unique number 656598 in the NAME's low word.
const DEVICE_KEY = '137:656598'
const CAN_NAME =
  'c0788c00' + (((137 << 21) | 656598) >>> 0).toString(16).padStart(8, '0')

const DEVICE: N2kDeviceEntry = {
  sourceRef: `can0.${CAN_NAME}`,
  connection: 'can0',
  srcAddr: '50',
  src: '50',
  canName: CAN_NAME,
  pgns: { '127488': 'Engine Parameters, Rapid Update' }
}

const ENGINE_0: DiscoveredInstance[] = [127488, 127489].map((pgn) => ({
  pgn,
  instance: 0,
  sourceLabel: '',
  group: 'engine',
  defaultPrefix: 'propulsion.port'
}))

const ENGINE_ROOM = 'environment.inside.engineRoom.temperature'
const ENGINE_ROOM_TEMPERATURES: DiscoveredInstance[] = [0, 1].map(
  (instance) => ({
    pgn: 130312,
    instance,
    sourceLabel: 'Engine Room Temperature',
    sourceEnum: 3,
    group: 'temperature',
    discriminator: 3,
    defaultPrefix: ENGINE_ROOM
  })
)

const BATTERIES: DiscoveredInstance[] = [0, 1].map((instance) => ({
  pgn: 127508,
  instance,
  sourceLabel: '',
  group: 'battery',
  defaultPrefix: `electrical.batteries.${instance}`
}))

interface FetchCall {
  url: string
  init?: RequestInit
}

interface ServerStub {
  stored?: N2kInstanceRule[]
  getStatus?: number
  putStatus?: number
  putBody?: unknown
}

function stubServer({
  stored = [],
  getStatus = 200,
  putStatus = 200,
  putBody = { state: 'COMPLETED', statusCode: 200 }
}: ServerStub = {}): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      const status = init?.method === 'PUT' ? putStatus : getStatus
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => (init?.method === 'PUT' ? putBody : stored)
      }
    })
  )
  return calls
}

function scanOf(instances: DiscoveredInstance[]): InstanceScan {
  return { instances, loading: false, error: null, rescan: vi.fn() }
}

function renderSection(
  instances: DiscoveredInstance[],
  device: N2kDeviceEntry = DEVICE
) {
  return render(
    <InstanceMappingSection device={device} scan={scanOf(instances)} />
  )
}

function puts(calls: FetchCall[]) {
  return calls
    .filter((call) => call.init?.method === 'PUT')
    .map((call) => ({
      url: call.url,
      body: JSON.parse(String(call.init?.body)) as unknown
    }))
}

async function save() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  })
}

function edit(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

describe('InstanceMappingSection', () => {
  beforeEach(() => {
    useStore.setState({ n2kInstanceMappings: {}, loginStatus: {} })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('saves an edited engine target for the device key', async () => {
    const calls = stubServer()
    renderSection(ENGINE_0)
    const input = await screen.findByLabelText('Path for Engine instance 0')
    expect(input).toHaveValue('propulsion.port')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    // The two engine PGNs collapse into one row.
    expect(screen.getAllByRole('textbox')).toHaveLength(1)

    edit('Path for Engine instance 0', 'propulsion.main')
    expect(screen.getByText('e.g. propulsion.main.revolutions')).toBeTruthy()
    await save()

    expect(puts(calls)).toEqual([
      {
        url: expect.stringMatching(/\/n2kInstanceMappings\/137%3A656598$/),
        body: [{ group: 'engine', instance: 0, target: 'propulsion.main' }]
      }
    ])
    expect(screen.getByText('Path mappings saved')).toBeTruthy()
    expect(useStore.getState().n2kInstanceMappings[DEVICE_KEY]).toEqual([
      { group: 'engine', instance: 0, target: 'propulsion.main' }
    ])
  })

  it('saves a temperature source as its code with a full leaf target', async () => {
    const calls = stubServer()
    renderSection(ENGINE_ROOM_TEMPERATURES)
    const label = 'Path for Temperature Engine Room Temperature instance 1'
    await screen.findByLabelText(label)

    edit(label, 'environment.inside.engineRoomAft.temperature')
    await save()

    expect(puts(calls)[0].body).toEqual([
      {
        group: 'temperature',
        discriminator: 3,
        instance: 1,
        target: 'environment.inside.engineRoomAft.temperature'
      }
    ])
  })

  it('removes the rule of a target reset to its default', async () => {
    const calls = stubServer({
      stored: [{ group: 'engine', instance: 0, target: 'propulsion.main' }]
    })
    renderSection(ENGINE_0)
    expect(
      await screen.findByLabelText('Path for Engine instance 0')
    ).toHaveValue('propulsion.main')

    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }))
    expect(screen.getByLabelText('Path for Engine instance 0')).toHaveValue(
      'propulsion.port'
    )
    await save()

    expect(puts(calls)[0].body).toEqual([])
  })

  it('lists a stored rule that was not observed and deletes it', async () => {
    const calls = stubServer({
      stored: [
        { group: 'battery', instance: 3, target: 'electrical.batteries.house' }
      ]
    })
    renderSection([])
    expect(await screen.findByText('not currently observed')).toBeTruthy()
    expect(screen.getByLabelText('Path for Battery instance 3')).toHaveValue(
      'electrical.batteries.house'
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'Delete rule for Battery instance 3' })
    )
    expect(screen.getByText(/Rule removed on save/)).toBeTruthy()
    await save()

    expect(puts(calls)[0].body).toEqual([])
  })

  it('shows a row error for an invalid target and keeps Save disabled', async () => {
    stubServer()
    renderSection(ENGINE_0)
    await screen.findByLabelText('Path for Engine instance 0')

    edit('Path for Engine instance 0', 'propulsion/main')

    expect(screen.getByText(/dot-separated segments/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    edit('Path for Engine instance 0', 'notifications.engine')
    expect(screen.getByText('Must not be under notifications')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('rejects target segments that reach the object prototype', async () => {
    stubServer()
    renderSection(ENGINE_0)
    await screen.findByLabelText('Path for Engine instance 0')

    for (const segment of ['constructor', 'prototype']) {
      edit('Path for Engine instance 0', `propulsion.${segment}.main`)
      expect(
        screen.getByText(`Must not contain the segment ${segment}`)
      ).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    }
  })

  it('rejects a target on the default of an unmapped instance of the group', async () => {
    stubServer()
    renderSection(BATTERIES)
    await screen.findByLabelText('Path for Battery instance 0')

    edit('Path for Battery instance 0', 'electrical.batteries.1')
    expect(
      screen.getByText(
        'Overlaps the default path of Battery instance 1, which has no rule'
      )
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    // Moving battery 1 away as well frees its default.
    edit('Path for Battery instance 1', 'electrical.batteries.house')
    expect(screen.queryByText(/Overlaps/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('rejects nested targets within the device', async () => {
    stubServer()
    renderSection(BATTERIES)
    await screen.findByLabelText('Path for Battery instance 0')

    edit('Path for Battery instance 0', 'electrical.batteries.house')
    edit('Path for Battery instance 1', 'electrical.batteries.house.aft')

    expect(
      screen.getAllByText(/^Overlaps the path of Battery instance/)
    ).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('warns about a zone deeper than one segment under environment.inside', async () => {
    stubServer()
    renderSection(ENGINE_ROOM_TEMPERATURES)
    const label = 'Path for Temperature Engine Room Temperature instance 1'
    await screen.findByLabelText(label)

    edit(label, 'environment.inside.engineRoom.aft.temperature')

    expect(screen.getByText(/gives it no units/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('shows a server rejection inline and keeps the edits', async () => {
    stubServer({
      putStatus: 400,
      putBody: {
        state: 'FAILED',
        statusCode: 400,
        message: 'rules[0]: target propulsion.main overlaps something'
      }
    })
    renderSection(ENGINE_0)
    await screen.findByLabelText('Path for Engine instance 0')

    edit('Path for Engine instance 0', 'propulsion.main')
    await save()

    expect(screen.getByRole('alert').textContent).toBe(
      'rules[0]: target propulsion.main overlaps something'
    )
    expect(screen.getByLabelText('Path for Engine instance 0')).toHaveValue(
      'propulsion.main'
    )
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    expect(useStore.getState().n2kInstanceMappings[DEVICE_KEY]).toEqual([])
  })

  it('shows the unavailable notice and no editor without a canName', () => {
    const calls = stubServer()
    renderSection(ENGINE_0, { ...DEVICE, canName: undefined })

    expect(
      screen.getByText(
        "Mapping unavailable until the device's address claim is received."
      )
    ).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('follows a mappings event while it has no edits', async () => {
    stubServer()
    renderSection(ENGINE_0)
    const input = await screen.findByLabelText('Path for Engine instance 0')
    expect(input).toHaveValue('propulsion.port')

    act(() =>
      useStore.getState().setN2kInstanceMappings({
        [DEVICE_KEY]: [
          { group: 'engine', instance: 0, target: 'propulsion.main' }
        ]
      })
    )
    expect(screen.getByLabelText('Path for Engine instance 0')).toHaveValue(
      'propulsion.main'
    )

    // A device the event omits has no rules left.
    act(() => useStore.getState().setN2kInstanceMappings({}))
    expect(screen.getByLabelText('Path for Engine instance 0')).toHaveValue(
      'propulsion.port'
    )
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('keeps an edit when a mappings event arrives', async () => {
    stubServer()
    renderSection(ENGINE_0)
    await screen.findByLabelText('Path for Engine instance 0')
    edit('Path for Engine instance 0', 'propulsion.main')

    act(() =>
      useStore.getState().setN2kInstanceMappings({
        [DEVICE_KEY]: [
          { group: 'engine', instance: 0, target: 'propulsion.genset' }
        ]
      })
    )

    expect(screen.getByLabelText('Path for Engine instance 0')).toHaveValue(
      'propulsion.main'
    )
  })

  it('is hidden from a user who is not an admin', () => {
    const calls = stubServer()
    useStore.setState({
      loginStatus: { authenticationRequired: true, userLevel: 'readonly' }
    })
    const { container } = renderSection(ENGINE_0)

    expect(container.firstChild).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('is hidden when the server refuses the mappings', async () => {
    const calls = stubServer({ getStatus: 401 })
    const { container } = renderSection(ENGINE_0)

    await act(async () => {})
    expect(calls).toHaveLength(1)
    expect(container.firstChild).toBeNull()
  })
})
