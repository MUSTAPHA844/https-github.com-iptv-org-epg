const dayjs = require('dayjs')
const debug = require('debug')('site:tv.yandex.ru')

// enable to fetch guide description but its take a longer time
const detailedGuide = true

// update this data by heading to https://tv.yandex.ru and change the values accordingly
const cookies = {
  cycada: '3w11iWu+2+o6iIIiI/S1/k9lFIb6y+G6SW6hsbLoPJg=',
  i: '0nUBW1d6GpFmpLRIuHYGulEA4alIC2j4WS+WYGcusydL7lcrG9loWX8qrFEBOqg54KZxGwCVaZhZ1THYgoIo0T69iCY=',
  spravka: 'dD0xNzAxMjI3MTk1O2k9MzYuODQuOTguMTcxO0Q9Njk4NDQwRkRDODk5QUEzMDJCNzI5NTJBMTM4RTY2ODNEMzQyNkM1MjI5QTkyNDI3NUJGMzMzQUJEMUZFQjMyQzczM0I2QzE0QTRDQkJFODY5Nzk0MjhGNkEzQjQ5NDJBMzcxQzIzMjE3RTRENkVDOUU1NEE1RDVFNDg0RUQ1RTI3OUNGNzlCMEYzNzUyMDcyNDhGQkVCNkIyMDg5NTMwMzc1QkZEQTlGNEU7dT0xNzAxMjI3MTk1NDg5NDIyODkzO2g9OTRmN2FiNTMxZmJjNDg5MjM4ZDk4Y2ZkN2E0ZmY0YmI=',
  yandexuid: '7536067781700842414',
  yashr: '7271154091700842416',
  user_display: 696
}
const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36 OPR/104.0.0.0',
}
const caches = {}

module.exports = {
  site: 'tv.yandex.ru',
  days: 2,
  url({ date }) {
    return getUrl(date)
  },
  request: {
    cache: {
      ttl: 3600000 // 1 hour
    },
    headers: getHeaders()
  },
  async parser({ content, date, channel }) {
    const programs = []
    const events = []

    if (content && parseContent(content, date, true)) {
      const cacheid = date.format('YYYY-MM-DD')
      if (!caches[cacheid]) {
        debug(`Please wait while fetching schedules for ${cacheid}`)
        caches[cacheid] = await fetchSchedules({ date, content })
      }
      if (detailedGuide) {
        await fetchPrograms({ schedules: caches[cacheid], date, channel })
      }
      caches[cacheid].forEach(schedule => {
        schedule.events
          .filter(event => event.channelFamilyId == channel.site_id && date.isSame(event.start, 'day'))
          .forEach(event => {
            if (events.indexOf(event.id) < 0) {
              events.push(event.id)
              programs.push({
                title: event.title,
                description: event.program.description,
                category: event.program.type.name,
                start: dayjs(event.start),
                stop: dayjs(event.finish)
              })
            }
          })
      })
    }

    return programs
  },
  async channels() {
    const channels = []
    const included = []
    const schedules = await fetchSchedules({ date: dayjs() })
    schedules.forEach(schedule => {
      if (schedule.channel && included.indexOf(schedule.channel.familyId) < 0) {
        included.push(schedule.channel.familyId)
        channels.push({
          lang: 'ru',
          site_id: schedule.channel.familyId.toString(),
          name: schedule.channel.title
        })
      }
    })

    return channels
  }
}

async function fetchSchedules({ date, content = null }) {
  const schedules = []
  const queues = []
  const url = getUrl(date)

  let mainApi
  // parse content as schedules and add to queue if more requests is needed
  const f = data => {
    const [q, s] = parseContent(data, date)
    if (!mainApi) {
      mainApi = true
      if (caches.region) {
        queues.push(`https://tv.yandex.ru/api/${caches.region}?date=${date.format('YYYY-MM-DD')}&grid=all&period=all-day`)
      }
    }
    queues.push(...q)
    schedules.push(...s)
  }
  // is main html already fetched?
  if (content) {
    f(content)
  } else {
    queues.push(url)
  }
  // fetch all queues
  await doFetch(queues, url, f)

  return schedules
}

async function fetchPrograms({ schedules, date, channel }) {
  const queues = []
  schedules
    .filter(schedule => schedule.channel.familyId == channel.site_id)
    .forEach(schedule => {
      queues.push(
        ...schedule.events
          .filter(event => date.isSame(event.start, 'day'))
          .map(event => `https://tv.yandex.ru/api/${caches.region}/event?eventId=${event.id}&programCoId=`)
      )
    })
  await doFetch(queues, getUrl(date), content => {
    // is it a program?
    if (content?.program) {
      let updated = false
      schedules.forEach(schedule => {
        schedule.events.forEach(event => {
          if (event.channelFamilyId === content.channelFamilyId && event.id === content.id) {
            Object.assign(event, content)
            updated = true
            return true
          }
        })
        if (updated) {
          return true
        }
      })
    }
  })
}

async function doFetch(queues, referer, cb) {
  const axios = require('axios')
  while (true) {
    if (!queues.length) {
      break
    }
    const url = queues.shift()
    debug(`Fetching ${url}`)
    const data = url.indexOf('api') > 0 ? {
      'Referer': referer,
      'Origin': 'https://tv.yandex.ru',
      'X-Requested-With': 'XMLHttpRequest'
    } : {}
    const params = { headers: getHeaders(data) }
    const content = await axios
      .get(url, params)
      .then(response => {
        parseCookies(response.headers)
        return response.data
      })
      .catch(err => console.error(err.message))

    cb(content)
  }
}

function parseContent(content, date, checkOnly = false) {
  const queues = []
  const schedules = []
  let valid = false
  if (content) {
    if (Buffer.isBuffer(content)) {
      content = content.toString()
    }
    // got captcha, its look like our cookies has expired
    if (content?.type === 'captcha' || (typeof content === 'string' && content.match(/SmartCaptcha/))) {
      throw new Error('Got captcha, please goto https://tv.yandex.ru and update cookies!')
    }
    if (typeof content === 'object') {
      let items
      if (content.schedule) {
        // fetch next request based on schedule map
        if (Array.isArray(content.schedule.scheduleMap)) {
          queues.push(...content.schedule.scheduleMap.map(m => `https://tv.yandex.ru/api/${caches.region}/main/chunk?page=${m.id}&date=${date.format('YYYY-MM-DD')}&period=all-day&offset=${m.offset}&limit=${m.limit}`))
        }
        // find some schedules?
        if (Array.isArray(content.schedule.schedules)) {
          items = content.schedule.schedules
        }
      }
      // find another schedules?
      if (Array.isArray(content.schedules)) {
        items = content.schedules
      }
      // add programs
      if (items && items.length) {
        schedules.push(...getSchedules(items))
      }
    } else {
      // prepare headers for next http request
      const [, region] = content.match(/region: '(\d+)'/i) || [null, null]
      const [, initialSk] = content.match(/window.__INITIAL_SK__ = (.*);/i) || [null, null]
      const [, sessionId] = content.match(/window.__USER_SESSION_ID__ = "(.*)";/i) || [null, null]
      const tvSk = initialSk ? JSON.parse(initialSk) : {}
      if (region) {
        caches.region = region
      }
      if (tvSk.key) {
        headers['X-Tv-Sk'] = tvSk.key
      }
      if (sessionId) {
        headers['X-User-Session-Id'] = sessionId
      }
      if (checkOnly && region && tvSk.key && sessionId) {
        valid = true;
      }
    }
  }

  return checkOnly ? valid :  [queues, schedules]
}

function parseCookies(headers) {
  if (Array.isArray(headers['set-cookie'])) {
    headers['set-cookie']
      .forEach(cookie => {
        const [key, value] = cookie.split('; ')[0].split('=')
        if (cookies[key] !== value) {
          cookies[key] = value
          debug(`Update cookie ${key}=${value}`)
        }
      })
  }
}

function getSchedules(schedules) {
  return schedules.filter(schedule => schedule.events.length);
}

function getHeaders(data = {}) {
  return Object.assign({}, headers, {
    'Cookie': Object.keys(cookies).map(cookie => `${cookie}=${cookies[cookie]}`).join('; ')
  }, data)
}

function getUrl(date) {
  return `https://tv.yandex.ru/?date=${date.format('YYYY-MM-DD')}&grid=all&period=all-day`
}