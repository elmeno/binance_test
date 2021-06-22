// const { key, secret } = require('./config.json')
const logger = require('./logger')
const request = require('./request')
const Socket = require('./socket')

const mainAPIURL = 'api.binance.com'
const mainWSURL = 'wss://stream.binance.com:9443'
const testnetAPIURL = 'testnet.binance.vision'
const testnetWSURL = 'wss://testnet.binance.vision'

// User data streams will close after 60 minutes.
// It's recommended to send a ping about every 30 minutes.
const listenKeyExpireInterval = 30 * 60 * 1000
const listenKeyRetryInterval = 60 * 1000
const topTradeSocketsNumber = 10
const logLateciesInterval = 60 * 1000

// ************************************************************
let listenKey
let userDataSocket
let tickers
let allMiniTickersSocket
const balances = {}
const symbolsRanks = {}
const tradesWS = {}
let topVolTickers = new Set()
let latencies = []

// ************************************************************

async function runTasks () {
  // - Log to console current non 0 asset balances
  // available on the SPOT account(testnet)
  // ************************************
  await getBalances(testnetAPIURL)
  logNonZero()
  // ************************************
  // - Open a single userData websocket
  // (with all the requirement logic to keep the listenKey active)
  // - Keep your local asset balances state up to date
  // based on the data coming from userData
  // - Log the asset balances again on every balance change
  // ************************************
  const onBalanceChange = getOnBalanceChangeHandler(logNonZero)
  userDataTasks({
    apiUrl: testnetAPIURL,
    wsUrl: testnetWSURL,
    onEvent: onBalanceChange
  })
  // ************************************
  // - Open 10 *@trade websockets for the 10 pairs with the highest volume
  // in the last 24h on the SPOT exchange(mainnet)
  // - Determinate the 10 pairs dynamically (no hard-coded pairs)
  // - Measure event time => client receive time latency
  // and log(min / mean / max) to console every 1 minute
  tradeWebsockets()
}

runTasks()

// ************************************************************

async function logNonZero () {
  try {
    logger.info('non zero assets:')
    const nonZero = {}
    for (const asset in balances) {
      const assetBalance = balances[asset]
      const total = assetBalance.free + assetBalance.locked
      if (total > 0) {
        nonZero[asset] = assetBalance
        logger.info(
          asset,
          'free:',
          assetBalance.free,
          'locked:',
          assetBalance.locked
        )
      }
    }
  } catch (error) {
    logger.info('log non zero assets failed', error)
  }
}

async function userDataTasks ({ apiUrl, wsUrl, onEvent }) {
  try {
    const res = await request.secure(
      request.POST,
      apiUrl,
      '/api/v3/userDataStream'
    )
    listenKey = res.body.listenKey
    // Keep-alive a ListenKey
    setInterval(async () => {
      keepAliveListenKey(apiUrl, listenKey)
    }, listenKeyExpireInterval)

    userDataSocket = new Socket({
      url: `${wsUrl}/ws/${listenKey}`,
      onMessage: onEvent
    })
  } catch (error) {
    logger.info('request listenKey failed', error)
  }
}

// ************************************************************
// utils
// ************************************************************
async function getOnBalanceChangeHandler (cb) {
  return async function userDataEventHandler (ev) {
    const event = JSON.parse(ev)
    switch (event.e) {
      case 'outboundAccountPosition':
        logger.log('onUserDataEvent', event)
        event.B.forEach(s => {
          balances[s.a] = { free: s.f, locked: s.l }
        })
        break
      case 'balanceUpdate':
        logger.log('onUserDataEvent', event)
        balances[event.a].free = balances[event.a].free + event.d
        break
      default:
        // Order Updates
        return
    }

    if (cb) cb()
  }
}

async function getBalances (apiUrl) {
  try {
    const res = await request.signed(request.GET, apiUrl, '/api/v3/account')
    res.body.balances.forEach(el => {
      const assetBalance = {
        free: parseFloat(el.free),
        locked: parseFloat(el.locked)
      }
      balances[el.asset] = assetBalance
    })
  } catch (error) {
    logger.info('request assets failed', error)
  }
}

async function keepAliveListenKey (apiUrl, listenKey) {
  try {
    await request.secure(request.PUT, apiUrl, '/api/v3/userDataStream', {
      listenKey
    })
  } catch (error) {
    setTimeout(() => {
      keepAliveListenKey(listenKey)
    }, listenKeyRetryInterval)
  }
}

async function tradeWebsockets () {
  // Open 10 *@trade websockets for the 10 pairs
  // with the highest volume in the last 24h on the SPOT exchange
  tickers = await get24hrTicker()
  updateTickersRanks()
  allMiniTickersStream(updateTickersRanks)

  for (let i = 0; i < topTradeSocketsNumber; i++) {
    // all symbols for streams are lowercase
    const symbol = tickers[i].symbol.toLowerCase()
    const stream = `${symbol}@trade`

    const tws = new Socket({
      url: mainWSURL + `/ws/${stream}`,
      onMessage: event => {
        const now = Date.now()
        const parsed = JSON.parse(event)
        // Measure event time => client receive time latency
        // naive variant (synchronized clocks)
        const latency = now - parsed.E
        latencies.push(latency)
      }
    })

    tradesWS[tickers[i].symbol] = tws
  }
  // log latency (min/mean/max) to console every 1 minute
  setInterval(logLatencyStats, logLateciesInterval)
}

function logLatencyStats () {
  let sum = 0
  let min = Infinity
  let max = -Infinity
  for (const lat of latencies) {
    if (lat < min) min = lat
    if (lat > max) max = lat
    sum += lat
  }
  const avg = Math.ceil(sum / latencies.length)
  logger.info(`latency stats: ${min}/${avg}/${max} (min/mean/max)`)
  // flush latencies
  latencies = []
}

// ************************************************************

async function get24hrTicker () {
  try {
    const res = await request.pub(
      request.GET,
      mainAPIURL,
      '/api/v3/ticker/24hr'
    )
    logger.log('get24hrTicker', res.body)
    return res.body // tickers
  } catch (error) {
    logger.info('request get24hrTicker failed', error)
    throw error
  }
}

function updateTickersRanks () {
  // todo? order by USD (or other) volume equivalent
  tickers.sort((a, b) => {
    return parseFloat(b.volume) - parseFloat(a.volume)
  })

  tickers.forEach((ticker, index) => {
    symbolsRanks[ticker.symbol] = index
  })

  const topN = tickers.slice(0, topTradeSocketsNumber)
  const newTopVolTickers = new Set()
  topN.forEach(t => {
    newTopVolTickers.add(t.symbol)
  })
  // initial fill top tickers set
  if (!topVolTickers.size) topVolTickers = newTopVolTickers

  // check top10 pairs changes for *@trade socket connections
  const unsub = setDifference(topVolTickers, newTopVolTickers) // tickers to unsub
  const sub = setDifference(newTopVolTickers, topVolTickers) // tickers to subscribe

  if (unsub.size || sub.size) {
    logger.log('top tickers changed', unsub, sub)
  }

  if (unsub.size) {
    // update socket connections to new top10 pairs
    const subscribeIter = sub.values()
    unsub.forEach(symbol => {
      const replaceSymbol = subscribeIter.next().value
      const tws = tradesWS[symbol]
      const stream = `${symbol}@trade`
      tws.unsubscribe(stream)
      const newStream = `${replaceSymbol}@trade`
      tws.subscribe(newStream)
      tradesWS[replaceSymbol] = tws
      delete tradesWS[symbol]
    })
  }

  return tickers
}

async function allMiniTickersStream (cb) {
  allMiniTickersSocket = new Socket({
    url: mainWSURL + '/ws/!miniTicker@arr',
    onMessage: event => {
      const miniTickers = JSON.parse(event)
      for (const ticker of miniTickers) {
        const symbolIndex = symbolsRanks[ticker.s]
        // update pair volume
        tickers[symbolIndex].volume = ticker.v
      }
      if (cb) cb()
    }
  })
}

function setDifference (setA, setB) {
  const difference = new Set(setA)
  for (const elem of setB) {
    difference.delete(elem)
  }
  return difference
}

// ************************************************************
// graceful shutdown
// ************************************************************
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

async function shutdown () {
  console.info('shutdown signal received')
  try {
    // ************************************
    // close user data stream
    if (userDataSocket) {
      userDataSocket.close()
    }
    // Close a ListenKey (USER_STREAM)
    if (listenKey) {
      await request.secure(
        request.DELETE,
        testnetAPIURL,
        '/api/v3/userDataStream',
        { listenKey }
      )
    }
    // ************************************
    // close All Market Mini Tickers Stream
    if (allMiniTickersSocket) {
      allMiniTickersSocket.close()
    }
    // close trade streams
    for (const tws in tradesWS) {
      tradesWS[tws].close()
    }
  } catch (error) {}
  // ************************************
  process.exit()
}
