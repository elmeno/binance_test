const { loglevel } = require('./config.json')
if (loglevel === 'info') {
  module.exports = {
    log: () => { },
    info: console.log
  }
}
if (loglevel === 'debug') {
  module.exports = {
    log: console.log,
    info: console.log
  }
}
