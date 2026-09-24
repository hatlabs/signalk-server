import chai, { expect } from 'chai'
import _ from 'lodash'
import { Request, Response } from 'express'
import {
  findDeviceSourceRefs,
  isDeviceKey,
  N2kInstanceMappingsApp,
  prunePrefixes,
  registerN2kInstanceMappingRoutes,
  validateInstanceMappings
} from '../src/n2k-instance-mappings'
import type {
  N2kInstanceMappings,
  N2kInstanceRule
} from '@signalk/streams/n2k-instance-groups'
import { freeport } from './ts-servertestutilities'
import { FORBIDDEN_PATH_KEYS } from '@signalk/server-api'
import { FORBIDDEN_TARGET_SEGMENTS } from '@signalk/streams/n2k-instance-groups'
import {
  startServerP,
  getAdminToken,
  getReadOnlyToken
} from './servertestutilities'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(chai as any).Should()

// Low 32 bits of the NAME carry the manufacturer code and unique number.
const CAN_NAME_A = 'c0788c00112a04d6' // 137:656598
const CAN_NAME_B = 'c0788c0022603039' // 275:12345
const DEVICE_A = '137:656598'
const DEVICE_B = '275:12345'

function expectRejected(body: unknown, messagePart?: RegExp) {
  const result = validateInstanceMappings(body)
  expect(result.ok, JSON.stringify(body)).to.equal(false)
  if (!result.ok && messagePart) {
    expect(result.error).to.match(messagePart)
  }
}

function expectAccepted(body: unknown): N2kInstanceRule[] {
  const result = validateInstanceMappings(body)
  if (!result.ok) {
    throw new Error(`expected acceptance, got: ${result.error}`)
  }
  return result.value
}

describe('n2k instance mappings', function () {
  describe('isDeviceKey', function () {
    it('accepts <manufacturer code>:<unique number>', function () {
      isDeviceKey(DEVICE_A).should.equal(true)
    })

    it('rejects anything else, including __proto__', function () {
      for (const key of ['__proto__', 'abc', '', '1:2:3', '1:', ':1', '1']) {
        isDeviceKey(key).should.equal(false, key)
      }
    })
  })

  describe('validateInstanceMappings', function () {
    it('accepts a valid rule', function () {
      expectAccepted([
        { group: 'engine', instance: 0, target: 'propulsion.main' }
      ]).should.deep.equal([
        { group: 'engine', instance: 0, target: 'propulsion.main' }
      ])
    })

    it('rejects a body that is not an array of rules', function () {
      expectRejected({ group: 'engine', instance: 0, target: 'a' })
      expectRejected([{ group: 'engine', instance: 0 }])
      expectRejected([
        { group: 'engine', instance: 0, target: 'propulsion.main', extra: 1 }
      ])
    })

    it('rejects targets outside the path grammar', function () {
      for (const target of [
        'propulsion/main',
        'propulsion..main',
        '.propulsion',
        'propulsion.',
        '',
        'propulsion.ma-in',
        'a.b.c.d.e.f.g.h.i',
        'a'.repeat(129)
      ]) {
        expectRejected([{ group: 'engine', instance: 0, target }])
      }
    })

    it('rejects a target under notifications', function () {
      expectRejected(
        [{ group: 'engine', instance: 0, target: 'notifications.engine' }],
        /notifications/
      )
    })

    it('rejects target segments that reach the object prototype', function () {
      for (const target of [
        'constructor.x',
        'propulsion.prototype',
        'a.constructor.b'
      ]) {
        expectRejected([{ group: 'engine', instance: 0, target }], /target/)
      }
    })

    it('rejects a target that equals its own default prefix', function () {
      expectRejected(
        [{ group: 'engine', instance: 0, target: 'propulsion.port' }],
        /default/
      )
    })

    it('rejects an unknown group', function () {
      expectRejected(
        [{ group: 'switchBank', instance: 0, target: 'electrical.main' }],
        /group/
      )
    })

    it('rejects a discriminator code outside the group', function () {
      expectRejected(
        [
          {
            group: 'pressure',
            discriminator: 20,
            instance: 0,
            target: 'environment.foo.pressure'
          }
        ],
        /discriminator/
      )
    })

    it('requires a discriminator exactly where the group has one', function () {
      expectRejected(
        [{ group: 'tank', instance: 0, target: 'tanks.fuel.day' }],
        /discriminator/
      )
      expectRejected(
        [
          {
            group: 'battery',
            discriminator: 0,
            instance: 0,
            target: 'electrical.batteries.house'
          }
        ],
        /discriminator/
      )
    })

    it('rejects an instance outside the group range', function () {
      expectRejected([
        { group: 'battery', instance: 256, target: 'electrical.batteries.x' }
      ])
      expectRejected([
        { group: 'tank', discriminator: 0, instance: 16, target: 'tanks.x' }
      ])
      expectRejected([
        { group: 'battery', instance: 1.5, target: 'electrical.batteries.x' }
      ])
    })

    it('rejects two rules for the same instance', function () {
      expectRejected(
        [
          { group: 'engine', instance: 0, target: 'propulsion.main' },
          { group: 'engine', instance: 0, target: 'propulsion.aux' }
        ],
        /more than one rule/
      )
    })

    it('rejects equal targets within a device', function () {
      expectRejected(
        [
          { group: 'engine', instance: 0, target: 'propulsion.main' },
          { group: 'engine', instance: 1, target: 'propulsion.main' }
        ],
        /overlaps/
      )
    })

    it('rejects nested targets within a device, across groups', function () {
      expectRejected(
        [
          { group: 'engine', instance: 0, target: 'propulsion.main' },
          {
            group: 'battery',
            instance: 0,
            target: 'propulsion.main.battery'
          }
        ],
        /overlaps/
      )
    })

    it('treats nesting on segment boundaries only', function () {
      expectAccepted([
        { group: 'engine', instance: 0, target: 'propulsion.main' },
        { group: 'engine', instance: 1, target: 'propulsion.mainAux' }
      ])
    })

    it("rejects a target on another unmapped instance's default", function () {
      expectRejected(
        [{ group: 'battery', instance: 0, target: 'electrical.batteries.1' }],
        /instance 1/
      )
    })

    it("rejects a target nested under another unmapped instance's default", function () {
      expectRejected([
        {
          group: 'battery',
          instance: 0,
          target: 'electrical.batteries.1.house'
        }
      ])
    })

    it('accepts a swap when the displaced instance is mapped too', function () {
      expectAccepted([
        { group: 'battery', instance: 0, target: 'electrical.batteries.1' },
        { group: 'battery', instance: 1, target: 'electrical.batteries.house' }
      ])
    })

    it('accepts a single-leaf target next to the shared default', function () {
      expectAccepted([
        {
          group: 'temperature',
          discriminator: 3,
          instance: 1,
          target: 'environment.inside.engineRoomAft.temperature'
        }
      ])
    })

    it('rejects a single-leaf target equal to its own default', function () {
      expectRejected(
        [
          {
            group: 'temperature',
            discriminator: 3,
            instance: 1,
            target: 'environment.inside.engineRoom.temperature'
          }
        ],
        /default/
      )
    })

    it('rejects a single-leaf target under another instance leaf', function () {
      expectRejected([
        {
          group: 'temperature',
          discriminator: 3,
          instance: 1,
          target: 'environment.inside.engineRoom.temperature.aft'
        }
      ])
    })

    it('checks address-bearing defaults at any bus address', function () {
      // electrical.dc.<src>.<connection>: the device may sit at address 7.
      expectRejected([
        { group: 'dcConnection', instance: 1, target: 'electrical.dc.7.1' }
      ])
      expectRejected([
        { group: 'dcConnection', instance: 1, target: 'electrical.dc.7.2' }
      ])
      expectAccepted([
        { group: 'dcConnection', instance: 1, target: 'electrical.dc.house' }
      ])
    })

    it('rejects more than 64 rules', function () {
      const rules = Array.from({ length: 65 }, (_unused, i) => ({
        group: 'battery',
        instance: i,
        target: `electrical.batteries.bank${i}`
      }))
      expectRejected(rules)
      expectAccepted(rules.slice(0, 64))
    })
  })

  describe('prunePrefixes', function () {
    const engineMain: N2kInstanceRule = {
      group: 'engine',
      instance: 0,
      target: 'propulsion.main'
    }

    it("prunes an added rule's default prefixes", function () {
      prunePrefixes([], [engineMain], 5).should.deep.equal([
        'propulsion.port',
        'notifications.propulsion.port'
      ])
    })

    it('prunes the old target of a changed rule', function () {
      prunePrefixes(
        [engineMain],
        [{ ...engineMain, target: 'propulsion.aux' }],
        5
      ).should.deep.equal(['propulsion.main', 'notifications.propulsion.main'])
    })

    it('prunes the old target of a removed rule', function () {
      prunePrefixes([engineMain], [], 5).should.deep.equal([
        'propulsion.main',
        'notifications.propulsion.main'
      ])
    })

    it('prunes nothing for unchanged rules', function () {
      prunePrefixes([engineMain], [{ ...engineMain }], 5).should.deep.equal([])
    })

    it('keeps a target that a rule for another instance still writes', function () {
      prunePrefixes(
        [engineMain],
        [{ ...engineMain, instance: 1 }],
        5
      ).should.deep.equal([
        'propulsion.starboard',
        'notifications.propulsion.starboard'
      ])
    })

    it("uses the source's address for address-bearing defaults", function () {
      prunePrefixes(
        [],
        [{ group: 'dcConnection', instance: 1, target: 'electrical.dc.house' }],
        7
      ).should.deep.equal([
        'electrical.dc.7.1',
        'notifications.electrical.dc.7.1'
      ])
    })
  })

  describe('findDeviceSourceRefs', function () {
    const sources = {
      can0: {
        label: 'can0',
        type: 'NMEA2000',
        '5': { n2k: { src: '5', canName: CAN_NAME_A } },
        '6': { n2k: { src: '6', canName: CAN_NAME_B } }
      },
      can1: {
        '9': { n2k: { src: '9', canName: CAN_NAME_A } }
      }
    }

    it('lists canName and address refs of the device on every connection', function () {
      _.sortBy(
        findDeviceSourceRefs(DEVICE_A, sources, {}),
        'ref'
      ).should.deep.equal([
        { ref: 'can0.5', src: 5 },
        { ref: `can0.${CAN_NAME_A}`, src: 5 },
        { ref: 'can1.9', src: 9 },
        { ref: `can1.${CAN_NAME_A}`, src: 9 }
      ])
    })

    it('falls back to source deltas when the sources tree lacks the device', function () {
      findDeviceSourceRefs(DEVICE_B, undefined, {
        'can0.6': {
          updates: [
            { source: { label: 'can0', src: '6', canName: CAN_NAME_B } }
          ]
        }
      }).should.deep.equal([
        { ref: `can0.${CAN_NAME_B}`, src: 6 },
        { ref: 'can0.6', src: 6 }
      ])
    })

    it('returns nothing for a device that is not present', function () {
      findDeviceSourceRefs('1:1', sources, {}).should.deep.equal([])
    })
  })

  describe('route handlers', function () {
    type Handler = (req: Request, res: Response) => void

    interface FakeResponse {
      statusCode: number
      body: unknown
    }

    function fakeApp(writeError?: Error) {
      const handlers: Record<string, Handler> = {}
      const events: Array<{ type: string; data: unknown }> = []
      const removed: Array<{ ref: string; prefixes?: readonly string[] }> = []
      const app: N2kInstanceMappingsApp = {
        config: { settings: {} },
        securityStrategy: { addAdminMiddleware: () => undefined },
        get: (path: string, handler: Handler) => {
          handlers[`GET ${path}`] = handler
        },
        put: (path: string, handler: Handler) => {
          handlers[`PUT ${path}`] = handler
        },
        emit: (_event: string, ...args: unknown[]) => {
          events.push(args[0] as { type: string; data: unknown })
          return true
        },
        signalk: {
          sources: {
            can0: { '5': { n2k: { src: '5', canName: CAN_NAME_A } } }
          }
        },
        deltaCache: {
          sourceDeltas: {},
          removeSource: (ref: string, prefixes?: readonly string[]) => {
            removed.push({ ref, prefixes })
          }
        }
      }
      registerN2kInstanceMappingRoutes(app, (_settings, cb) => cb(writeError))
      const call = (method: 'GET' | 'PUT', deviceKey: string, body?: unknown) =>
        new Promise<FakeResponse>((resolve) => {
          const out: FakeResponse = { statusCode: 200, body: undefined }
          const res = {
            status(code: number) {
              out.statusCode = code
              return res
            },
            json(payload: unknown) {
              out.body = payload
              resolve(out)
              return res
            }
          }
          handlers[`${method} /skServer/n2kInstanceMappings/:deviceKey`](
            { params: { deviceKey }, body } as unknown as Request,
            res as unknown as Response
          )
        })
      return { app, events, removed, call }
    }

    const rules = [{ group: 'engine', instance: 0, target: 'propulsion.main' }]

    it('stores rules, emits the full mappings, then prunes', async function () {
      const { app, events, removed, call } = fakeApp()
      const res = await call('PUT', DEVICE_A, rules)
      res.statusCode.should.equal(200)
      const stored = app.config.settings
        .n2kInstanceMappings as N2kInstanceMappings
      stored.should.deep.equal({ [DEVICE_A]: rules })
      events.should.deep.equal([
        { type: 'N2KINSTANCEMAPPINGS', data: { [DEVICE_A]: rules } }
      ])
      _.sortBy(removed, 'ref').should.deep.equal([
        {
          ref: 'can0.5',
          prefixes: ['propulsion.port', 'notifications.propulsion.port']
        },
        {
          ref: `can0.${CAN_NAME_A}`,
          prefixes: ['propulsion.port', 'notifications.propulsion.port']
        }
      ])
      ;(await call('GET', DEVICE_A)).body!.should.deep.equal(rules)
    })

    it('drops the device entry when its list becomes empty', async function () {
      const { app, call } = fakeApp()
      await call('PUT', DEVICE_A, rules)
      ;(await call('PUT', DEVICE_A, [])).statusCode.should.equal(200)
      app.config.settings.n2kInstanceMappings!.should.deep.equal({})
      ;(await call('GET', DEVICE_A)).body!.should.deep.equal([])
    })

    it('leaves settings unchanged and emits nothing when the write fails', async function () {
      const { app, events, removed, call } = fakeApp(new Error('disk full'))
      const before = app.config.settings
      const res = await call('PUT', DEVICE_A, rules)
      res.statusCode.should.equal(500)
      app.config.settings.should.equal(before)
      expect(app.config.settings.n2kInstanceMappings).to.equal(undefined)
      events.should.deep.equal([])
      removed.should.deep.equal([])
    })

    it('stores rules as an object when the stored mappings are an array', async function () {
      const { app, call } = fakeApp()
      app.config.settings.n2kInstanceMappings =
        [] as unknown as N2kInstanceMappings
      ;(await call('PUT', DEVICE_A, rules)).statusCode.should.equal(200)
      const persisted = JSON.parse(JSON.stringify(app.config.settings))
      persisted.n2kInstanceMappings.should.deep.equal({ [DEVICE_A]: rules })
    })

    it('answers 400 for a target segment that reaches the object prototype', async function () {
      const { call } = fakeApp()
      const res = await call('PUT', DEVICE_A, [
        { group: 'engine', instance: 0, target: 'constructor.x' }
      ])
      res.statusCode.should.equal(400)
    })

    it('rejects an invalid device key on GET and PUT', async function () {
      const { call } = fakeApp()
      ;(await call('GET', '__proto__')).statusCode.should.equal(400)
      ;(await call('PUT', '__proto__', rules)).statusCode.should.equal(400)
      ;(await call('PUT', 'abc', rules)).statusCode.should.equal(400)
    })
  })

  describe('REST routes on a running server', function () {
    let url: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let server: any
    let adminToken: string
    let readToken: string
    const PROVIDER = 'mappingTestN2k'

    before(async function () {
      const port = await freeport()
      url = `http://0.0.0.0:${port}`
      server = await startServerP(port, true)
      adminToken = await getAdminToken(server)
      readToken = await getReadOnlyToken(server)
    })

    after(async function () {
      await server.stop()
    })

    function request(
      method: string,
      deviceKey: string,
      token?: string,
      body?: unknown
    ) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      }
      if (token) headers.Cookie = `JAUTHENTICATION=${token}`
      return fetch(`${url}/skServer/n2kInstanceMappings/${deviceKey}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      })
    }

    const rules = [{ group: 'engine', instance: 0, target: 'propulsion.main' }]

    it('rejects unauthenticated and read-only users', async function () {
      for (const token of [undefined, readToken]) {
        ;(await request('GET', DEVICE_A, token)).status.should.equal(401)
        ;(await request('PUT', DEVICE_A, token, rules)).status.should.equal(401)
      }
    })

    it('persists a PUT, emits N2KINSTANCEMAPPINGS and serves it on GET', async function () {
      const events: Array<{ type: string; data: unknown }> = []
      const onEvent = (e: { type: string; data: unknown }) => events.push(e)
      server.app.on('serverAdminEvent', onEvent)
      try {
        const res = await request('PUT', DEVICE_B, adminToken, rules)
        res.status.should.equal(200)
      } finally {
        server.app.removeListener('serverAdminEvent', onEvent)
      }
      const event = events.find((e) => e.type === 'N2KINSTANCEMAPPINGS')
      expect(event, 'N2KINSTANCEMAPPINGS emitted').to.not.equal(undefined)
      ;(event!.data as N2kInstanceMappings)[DEVICE_B].should.deep.equal(rules)
      server.app.config.settings.n2kInstanceMappings[
        DEVICE_B
      ].should.deep.equal(rules)
      const get = await request('GET', DEVICE_B, adminToken)
      get.status.should.equal(200)
      ;(await get.json()).should.deep.equal(rules)
    })

    it('returns an empty list for a device without rules', async function () {
      const get = await request('GET', '1:1', adminToken)
      get.status.should.equal(200)
      ;(await get.json()).should.deep.equal([])
    })

    it('accepts rules for a device that is not on the bus', async function () {
      ;(await request('PUT', '999:42', adminToken, rules)).status.should.equal(
        200
      )
    })

    it('answers 400 with a FAILED body for invalid input', async function () {
      const badKey = await request('PUT', 'abc', adminToken, rules)
      badKey.status.should.equal(400)
      const badBody = await request('PUT', DEVICE_A, adminToken, [
        { group: 'engine', instance: 0, target: 'propulsion.port' }
      ])
      badBody.status.should.equal(400)
      ;(await badBody.json()).should.have.property('state', 'FAILED')
    })

    it("prunes the device's cached default-path leaves but not another device's", async function () {
      const selfParts = server.app.selfContext.split('.')
      const refA = `${PROVIDER}.${CAN_NAME_A}`
      const refB = `${PROVIDER}.${CAN_NAME_B}`
      const sendEngine = (src: string, canName: string) =>
        server.app.handleMessage(PROVIDER, {
          context: server.app.selfContext,
          updates: [
            {
              source: {
                label: PROVIDER,
                type: 'NMEA2000',
                pgn: 127488,
                src,
                canName
              },
              timestamp: new Date().toISOString(),
              values: [{ path: 'propulsion.port.revolutions', value: 20 }]
            }
          ]
        })
      const cacheHas = (ref: string) =>
        _.get(server.app.deltaCache.cache, [
          ...selfParts,
          'propulsion',
          'port',
          'revolutions',
          ref
        ]) !== undefined
      sendEngine('5', CAN_NAME_A)
      sendEngine('6', CAN_NAME_B)
      const deadline = Date.now() + 2000
      while (!(cacheHas(refA) && cacheHas(refB))) {
        if (Date.now() > deadline) throw new Error('deltas never cached')
        await new Promise((resolve) => setTimeout(resolve, 25))
      }

      ;(await request('PUT', DEVICE_A, adminToken, rules)).status.should.equal(
        200
      )

      cacheHas(refA).should.equal(false)
      cacheHas(refB).should.equal(true)
    })
  })
})

describe('N2K instance mapping target grammar', () => {
  it('forbids exactly the path segments the server drops from deltas', () => {
    expect([...FORBIDDEN_TARGET_SEGMENTS].sort()).to.deep.equal(
      [...FORBIDDEN_PATH_KEYS].sort()
    )
  })
})
