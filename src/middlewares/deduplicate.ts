import { create as createLogger } from '../common/log'
import { createHash } from 'crypto'
import { IlpPrepare, IlpReply } from 'ilp-packet'
import Middleware, { MiddlewareCallback, Pipelines } from '../types/middleware'
import Account from '../types/account'
import BigNumber from 'bignumber.js'

// Where in the ILP packet does the static data begin (i.e. the data that is not modified hop-to-hop)
// Used by previous algorithm which hashed the raw bytes of the packet
// const STATIC_DATA_OFFSET = 25 // 8 byte amount + 17 byte expiry date

const DEFAULT_CLEANUP_INTERVAL = 30000
const DEFAULT_PACKET_LIFETIME = 30000

interface CachedPacket {
  amount: string,
  expiresAt: Date,
  promise: Promise<IlpReply>
}

export default class DeduplicateMiddleware implements Middleware {
  private packetCache: Map<string, CachedPacket> = new Map()

  async applyToPipelines (pipelines: Pipelines, account: Account) {
    const log = createLogger(`deduplicate-middleware[${account.id}]`)

    const {
      cleanupInterval,
      packetLifetime
    } = account.info.deduplicate || {
      cleanupInterval: DEFAULT_CLEANUP_INTERVAL,
      packetLifetime: DEFAULT_PACKET_LIFETIME
    }

    let interval: NodeJS.Timeout
    pipelines.startup.insertLast({
      name: 'deduplicate',
      method: async (dummy: void, next: MiddlewareCallback<void, void>) => {
        interval = setInterval(() => this.cleanupCache(packetLifetime), cleanupInterval)
        return next(dummy)
      }
    })

    pipelines.shutdown.insertLast({
      name: 'deduplicate',
      method: async (dummy: void, next: MiddlewareCallback<void, void>) => {
        clearInterval(interval)
        return next(dummy)
      }
    })

    pipelines.outgoingData.insertLast({
      name: 'deduplicate',
      method: async (packet: IlpPrepare, next: MiddlewareCallback<IlpPrepare, IlpReply>) => {

        const index = createHash('sha256')
        // TODO - Review efficiency of new algorithm
          .update(packet.destination + packet.executionCondition.toString() + packet.data.toString())
          .digest()
          .slice(0, 16) // 128 bits is enough and saves some memory
          .toString('base64')

        const { amount, expiresAt } = packet

        const cachedPacket = this.packetCache.get(index)
        if (cachedPacket) {
          // We have seen this packet before, let's check if previous amount and expiresAt were larger
          log.warn('deduplicate packet cache hit. accountId=%s elapsed=%s amount=%s', account.id, cachedPacket.expiresAt.getTime() - Date.now(), amount)
          if (new BigNumber(cachedPacket.amount).gte(amount) && cachedPacket.expiresAt >= expiresAt) {
            return cachedPacket.promise
          }
        }

        const promise = next(packet)

        this.packetCache.set(index, {
          amount,
          expiresAt,
          promise
        })

        return promise
      }
    })
  }

  private cleanupCache (packetLifetime: number) {
    const now = Date.now()
    for (const index of this.packetCache.keys()) {
      const cachedPacket = this.packetCache.get(index)
      if (!cachedPacket) continue
      const packetExpiry = cachedPacket.expiresAt.getTime() + packetLifetime
      if (packetExpiry < now) {
        this.packetCache.delete(index)
      }
    }
  }
}
