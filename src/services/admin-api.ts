import reduct = require('reduct')
import Ajv = require('ajv')
import { mapValues as pluck } from 'lodash'
import Accounts from './accounts'
import Config from './config'
import RoutingTable from './routing-table'
import RouteBroadcaster from './route-broadcaster'
import Stats from './stats'
import RateBackend from './rate-backend'
import { formatRoutingTableAsJson } from '../routing/utils'
import { Server, IncomingMessage, ServerResponse } from 'http'
import { create as createLogger } from '../common/log'
import * as Prometheus from 'prom-client'
import AlertMiddleware from '../middlewares/alert'
import BalanceMiddleware from '../middlewares/balance'
import InvalidJsonBodyError from '../errors/invalid-json-body-error'
import { BalanceUpdate } from '../schemas/BalanceUpdate'
import WrapperAccount from '../accounts/wrapper'
const log = createLogger('admin-api')
const ajv = new Ajv()
const validateBalanceUpdate = ajv.compile(require('../schemas/BalanceUpdate.json'))

interface Route {
  method: 'GET' | 'POST' | 'DELETE'
  match: string
  fn: (url: string, body: object) => Promise<object | string | void>
  responseType?: string
}

export default class AdminApi {
  private accounts: Accounts
  private config: Config
  private routingTable: RoutingTable
  private routeBroadcaster: RouteBroadcaster
  private rateBackend: RateBackend
  private stats: Stats

  private server?: Server
  private routes: Route[]

  constructor (deps: reduct.Injector) {
    this.accounts = deps(Accounts)
    this.config = deps(Config)
    this.routingTable = deps(RoutingTable)
    this.routeBroadcaster = deps(RouteBroadcaster)
    this.rateBackend = deps(RateBackend)
    this.stats = deps(Stats)

    this.routes = [
      { method: 'GET', match: '/status$', fn: this.getStatus },
      { method: 'GET', match: '/routing$', fn: this.getRoutingStatus },
      { method: 'GET', match: '/accounts$', fn: this.getAccountStatus },
      { method: 'GET', match: '/accounts/', fn: this.getAccountAdminInfo },
      { method: 'POST', match: '/accounts/', fn: this.sendAccountAdminInfo },
      { method: 'GET', match: '/balance$', fn: this.getBalanceStatus },
      { method: 'POST', match: '/balance$', fn: this.postBalance },
      { method: 'GET', match: '/rates$', fn: this.getBackendStatus },
      { method: 'GET', match: '/stats$', fn: this.getStats },
      { method: 'GET', match: '/alerts$', fn: this.getAlerts },
      { method: 'DELETE', match: '/alerts/', fn: this.deleteAlert },
      { method: 'GET', match: '/metrics$', fn: this.getMetrics, responseType: Prometheus.register.contentType }
    ]
  }

  listen () {
    const {
      adminApi = false,
      adminApiHost = '127.0.0.1',
      adminApiPort = 7780
    } = this.config

    log.info('listen called')

    if (adminApi) {
      log.info('admin api listening. host=%s port=%s', adminApiHost, adminApiPort)
      this.server = new Server()
      this.server.listen(adminApiPort, adminApiHost)
      this.server.on('request', (req, res) => {
        this.handleRequest(req, res).catch((e) => {
          let err = e
          if (!e || typeof e !== 'object') {
            err = new Error('non-object thrown. error=' + e)
          }

          log.warn('error in admin api request handler. error=%s', err.stack ? err.stack : err)
          res.statusCode = e.httpErrorCode || 500
          res.setHeader('Content-Type', 'text/plain')
          res.end(String(err))
        })
      })
    }
  }

  private async handleRequest (req: IncomingMessage, res: ServerResponse) {
    req.setEncoding('utf8')
    let body = ''
    await new Promise((resolve, reject) => {
      req.on('data', data => body += data)
      req.once('end', resolve)
      req.once('error', reject)
    })

    const urlPrefix = (req.url || '').split('?')[0] + '$'
    const route = this.routes.find((route) =>
      route.method === req.method && urlPrefix.startsWith(route.match))
    if (!route) {
      res.statusCode = 404
      res.setHeader('Content-Type', 'text/plain')
      res.end('Not Found')
      return
    }

    const resBody = await route.fn.call(this, req.url!, body && JSON.parse(body))
    if (resBody) {
      res.statusCode = 200
      if (route.responseType) {
        res.setHeader('Content-Type', route.responseType)
        res.end(resBody)
      } else {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(resBody))
      }
    } else {
      res.statusCode = 204
      res.end()
    }
  }

  private async getStatus () {
    const balanceStatus = await this.getBalanceStatus()
    const accountStatus = await this.getAccountStatus()
    return {
      balances: pluck(balanceStatus['accounts'], 'balance'),
      connected: pluck(accountStatus['accounts'], 'connected'),
      localRoutingTable: formatRoutingTableAsJson(this.routingTable)
    }
  }

  private async getRoutingStatus () {
    return this.routeBroadcaster.getStatus()
  }

  private async getAccountStatus () {
    return this.accounts.getStatus()
  }

  private async getBalanceStatus () {
    const middleware = this.accounts.getMiddleware('balance')
    if (!middleware) return {}
    const balanceMiddleware = middleware as BalanceMiddleware
    return balanceMiddleware.getStatus()
  }

  private async postBalance (url: string, _data: object) {
    try {
      validateBalanceUpdate(_data)
    } catch (err) {
      const firstError = (validateBalanceUpdate.errors &&
        validateBalanceUpdate.errors[0]) ||
        { message: 'unknown validation error', dataPath: '' }
      throw new InvalidJsonBodyError('invalid balance update: error=' + firstError.message + ' dataPath=' + firstError.dataPath, validateBalanceUpdate.errors || [])
    }

    const data = _data as BalanceUpdate
    const middleware = this.accounts.getMiddleware('balance')
    if (!middleware) return
    const balanceMiddleware = middleware as BalanceMiddleware
    const account = this.accounts.get(data.accountId)
    balanceMiddleware.modifyBalance(account, data.amountDiff)
  }

  private getBackendStatus (): Promise<{ [s: string]: any }> {
    return this.rateBackend.getStatus()
  }

  private async getStats () {
    return this.stats.getStatus()
  }

  private async getAlerts () {
    const middleware = this.accounts.getMiddleware('alert')
    if (!middleware) return {}
    const alertMiddleware = middleware as AlertMiddleware
    return {
      alerts: alertMiddleware.getAlerts()
    }
  }

  private async deleteAlert (url: string) {
    const middleware = this.accounts.getMiddleware('alert')
    if (!middleware) return {}
    const alertMiddleware = middleware as AlertMiddleware
    const match = /^\/alerts\/(\d+)$/.exec(url.split('?')[0])
    if (!match) throw new Error('invalid alert id')
    alertMiddleware.dismissAlert(+match[1])
  }

  private async getMetrics () {
    return Prometheus.register.metrics()
  }

  private _getPlugin (url: string) {
    const match = /^\/accounts\/([A-Za-z0-9_.\-~]+)$/.exec(url.split('?')[0])
    if (!match) throw new Error('invalid account.')
    const accountId = match[1]
    const account = this.accounts.get(accountId)
    const plugin = (account as WrapperAccount).getPlugin()

    return {
      account: accountId,
      info: account.info,
      plugin
    }
  }

  private async getAccountAdminInfo (url: string) {
    const { account, info, plugin } = this._getPlugin(url)
    if (!plugin.getAdminInfo) throw new Error('plugin has no admin info. account=' + account)
    return {
      account,
      plugin: info.plugin,
      info: (await plugin.getAdminInfo())
    }
  }

  private async sendAccountAdminInfo (url: string, body?: object) {
    if (!body) throw new Error('no json body provided to set admin info.')
    const { account, info, plugin } = this._getPlugin(url)
    if (!plugin.sendAdminInfo) throw new Error('plugin does not support sending admin info. account=' + account)
    return {
      account,
      plugin: info.plugin,
      result: (await plugin.sendAdminInfo(body))
    }
  }
}
