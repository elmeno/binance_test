const WebSocket = require('ws')
const logger = require('./logger')

// The websocket server will send a ping frame every 3 minutes.
// If the websocket server does not receive a pong frame back
// from the connection within a 10 minute period,
// the connection will be disconnected.
const keepAliveTime = 10 * 60 * 1000
const reconnectTimeout = 1000

class Socket {
  constructor ({ url, ticker, onMessage, onOpen }) {
    this.ws = null
    this.url = url
    this.ticker = ticker
    this.onMessage = onMessage
    this.onOpen = onOpen
    this.pingTimeout = null
    this.requestId = 0
    this.connect(url, onMessage)
  }

  setHandlers () {
    this.ws.on('open', e => {
      logger.log('ws open', this.url)
      if (this.onOpen) this.onOpen()
      this.heartbeat()
    })

    this.ws.on('message', data => {
      this.heartbeat()
      logger.log('ws message', data)
      if (this.onMessage) this.onMessage(data)
    })

    this.ws.on('ping', e => {
      logger.log('ws ping', e)
      this.heartbeat()
    })

    this.ws.on('close', e => {
      logger.log('ws close', this.url, e)
      this.ws.terminate()
      clearTimeout(this.pingTimeout)
      // this.connect()
    })

    this.ws.on('error', e => {
      logger.log('ws error', e)
    })
  }

  heartbeat () {
    clearTimeout(this.pingTimeout)
    this.pingTimeout = setTimeout(() => {
      this.ws.terminate()
      setTimeout(() => {
        this.connect()
      }, reconnectTimeout)
    }, keepAliveTime)
  }

  connect () {
    this.ws = new WebSocket(this.url)
    this.setHandlers()
  }

  subscribe (stream) {
    // update url for market streams auto reconnect (/ws/<stream>)
    const urlparts = this.url.split('/')
    urlparts[urlparts.length - 1] = stream
    this.url = urlparts.join('/')

    this.send({
      method: 'SUBSCRIBE',
      params: [stream],
      id: this.requestId++
    })
  }

  unsubscribe (stream) {
    this.send({
      method: 'UNSUBSCRIBE',
      params: [stream],
      id: this.requestId++
    })
  }

  send (params) {
    logger.log('ws send', params)
    this.ws.send(JSON.stringify(params))
  }

  close () {
    clearTimeout(this.pingTimeout)
    this.ws.close()
  }
}

module.exports = Socket
