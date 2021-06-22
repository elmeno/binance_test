const https = require('https')
const crypto = require('crypto')

const { key, secret } = require('./config.json')

// ************************************************************

async function pub (method, hostname, path, params) {
  const query = makeQueryString(params)
  const options = {
    hostname,
    port: 443,
    path: path + '?' + query,
    method
  }
  return baseRequest(options)
}

async function secure (method, hostname, path, params) {
  const query = makeQueryString(params)

  const options = {
    method,
    hostname,
    port: 443,
    path: path + '?' + query,
    headers: {
      'X-MBX-APIKEY': key // API-Key
    }
  }
  return baseRequest(options)
}

async function signed (method, hostname, path, params) {
  const timestamp = Date.now() // timing security
  const query = { ...params, timestamp }
  // totalParams is defined as the query string concatenated with the request body.
  const totalParams = makeQueryString(query)
  const signature = crypto
    .createHmac('sha256', secret)
    .update(totalParams)
    .digest('hex')
  const signedQS = makeQueryString({ ...query, signature })

  const options = {
    method,
    hostname,
    port: 443,
    path: path + '?' + signedQS,
    headers: {
      'X-MBX-APIKEY': key // API-Key
    }
  }
  return baseRequest(options)
}

// ************************************************************
// utils
// ************************************************************

function makeQueryString (q) {
  return q
    ? ''.concat(
        Object.keys(q)
          .map(function (k) {
            return ''
              .concat(encodeURIComponent(k), '=')
              .concat(encodeURIComponent(q[k]))
          })
          .join('&')
      )
    : ''
}

async function baseRequest (options) {
  return new Promise((resolve, reject) => {
    let data = ''
    const req = https.request(options, res => {
      res.on('data', d => {
        data += d
      })
      res.on('end', () => {
        const parsed = JSON.parse(data)
        if (res.statusCode !== 200) {
          reject(parsed)
        } else {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: parsed
          })
        }
      })
    })
    req.on('error', e => {
      reject(e)
    })
    req.end()
  })
}

// ************************************************************

module.exports = {
  pub,
  secure,
  signed,
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  DELETE: 'DELETE'
}
