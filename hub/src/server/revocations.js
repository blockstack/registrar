/* @flow */

import LRUCache from 'lru-cache'
import type { DriverModel } from './driverModel'
import fetch from 'node-fetch'
import logger from 'winston'
import { Readable } from 'stream'
import * as errors from './errors'

const MAX_AUTH_FILE_BYTES = 1024
const AUTH_TIMESTAMP_FILE_NAME = 'authTimestamp'

export class AuthTimestampCache {

  cache: LRUCache<string, number>
  driver: DriverModel
  currentCacheEvictions: number
  readUrlPrefix: string

  constructor(readUrlPrefix: string, driver: DriverModel, maxCacheSize: number) {
    this.currentCacheEvictions = 0
    this.cache = new LRUCache<string, number>({ 
      max: maxCacheSize, 
      dispose: () => {
        this.currentCacheEvictions++
      }
    })
    this.readUrlPrefix = readUrlPrefix
    this.driver = driver

    // Check cache evictions every 10 minutes
    const tenMinutes = 1000 * 60 * 10
    this.setupCacheEvictionLogger(tenMinutes)
  }

  setupCacheEvictionLogger(timerInterval: number) {
    const evictionLogTimeout: any = setInterval(() => this.handleCacheEvictions(), timerInterval)
    evictionLogTimeout.unref()
  }

  handleCacheEvictions() {
    if (this.currentCacheEvictions > 0) {
      logger.warn(`Gaia authentication token timestamp cache evicted ${this.currentCacheEvictions} entries in the last 10 minutes. Consider increasing 'authTimestampCacheSize'.`)
      this.currentCacheEvictions = 0
    }
  }

  getAuthTimestampFileDir(bucketAddress: string) {
    return `${bucketAddress}-auth`
  }

  async readAuthTimestamp(bucketAddress: string): Promise<number> {

    const authTimestampDir = this.getAuthTimestampFileDir(bucketAddress)
    
    let fetchResponse
    let authNumberText
    try {
      const authNumberFileUrl = `${this.readUrlPrefix}${authTimestampDir}/${AUTH_TIMESTAMP_FILE_NAME}`
      fetchResponse = await fetch(authNumberFileUrl, {
        redirect: 'manual'
      })
      authNumberText = await fetchResponse.text()
    } catch (err) {
      // Catch any errors that may occur from network issues during `fetch` and `.text()` async operations..
      const errMsg = (err instanceof Error) ? err.message : err
      throw new errors.ValidationError(`Error trying to fetch bucket authentication revocation timestamp: ${errMsg}`)
    }

    if (fetchResponse.ok) {
      const authNumber = parseInt(authNumberText)
      if (Number.isFinite(authNumber)) {
        return authNumber
      } else {
        throw new errors.ValidationError(`Bucket contained an invalid authentication revocation timestamp: ${authNumberText}`)
      }
    } else if (fetchResponse.status === 404) {
      // 404 incidates no revocation file has been created.
      return 0
    } else {
      throw new errors.ValidationError(`Error trying to fetch bucket authentication revocation timestamp: server returned ${fetchResponse.status} - ${fetchResponse.statusText}`)
    }

  }

  async getAuthTimestamp(bucketAddress: string): Promise<number> {
    // First perform fast check if auth number exists in cache..
    let authTimestamp = this.cache.get(bucketAddress)
    if (authTimestamp) {
      return authTimestamp
    }

    // Nothing in cache, perform slower driver read.
    authTimestamp = await this.readAuthTimestamp(bucketAddress)

    // Recheck cache for a larger timestamp to avoid race conditions from slow storage.
    const cachedTimestamp = this.cache.get(bucketAddress)
    if (cachedTimestamp && cachedTimestamp > authTimestamp) {
      authTimestamp = cachedTimestamp
    }

    // Cache result for fast lookup later.
    this.cache.set(bucketAddress, authTimestamp)

    return authTimestamp
  }

  async writeAuthTimestamp(bucketAddress: string, timestamp: number) : Promise<void> {

    // Recheck cache for a larger timestamp to avoid race conditions from slow storage.
    const cachedTimestamp = this.cache.get(bucketAddress)
    if (cachedTimestamp && cachedTimestamp > timestamp) {
      timestamp = cachedTimestamp
    }

    this.cache.set(bucketAddress, timestamp)
    const authTimestampFileDir = this.getAuthTimestampFileDir(bucketAddress)
    
    // Convert our number to a Buffer.
    const contentBuffer = Buffer.from(timestamp.toString(), 'utf8')

    // Wrap the buffer in a stream for driver consumption.
    const contentStream = new Readable()
    contentStream.push(contentBuffer, 'utf8')
    contentStream.push(null) // Mark EOF

    const contentLength = contentBuffer.length

    // Content size sanity check.
    if (contentLength > MAX_AUTH_FILE_BYTES) {
      throw new errors.ValidationError(`Auth number file content size is ${contentLength}, it should never be greater than ${MAX_AUTH_FILE_BYTES}`)
    }
    
    await this.driver.performWrite({
      storageTopLevel: authTimestampFileDir, 
      path: AUTH_TIMESTAMP_FILE_NAME,
      stream: contentStream,
      contentLength: contentBuffer.length,
      contentType: 'text/plain; charset=UTF-8'
    })
  }

  async setAuthTimestamp(bucketAddress: string, timestamp: number): Promise<void> {
    await this.writeAuthTimestamp(bucketAddress, (timestamp | 0))
  }

}
