/**
 * lib/index.js 宿主半边自测：假 ctx 收集 index-inject 行、验证资产路由
 * （200 / 206 Range / 404 / 目录穿越防护）。不依赖 DSH，纯 Node 跑。
 */
import assert from 'node:assert'
import { EventEmitter } from 'node:events'

const mod = await import('./lib/index.js')

// ---- 假 ctx：收集 on() 注册的事件与 inject() 注册的回调 ----
const events = []
const injections = []
const ctx = {
  on(name, handler) {
    events.push({ name, handler })
  },
  inject(services, cb) {
    injections.push({ services, cb })
    return () => {}
  },
  effect(factory) {
    factory()
    return () => {}
  },
}

mod.apply(ctx)

// 1) index-inject 注册且行格式正确
assert.ok(events.some((e) => e.name === 'webserver/index-inject'), 'webserver/index-inject not registered')
const table = []
for (const e of events) if (e.name === 'webserver/index-inject') e.handler(table)
const styleRow = table.find((r) => r.kind === 'style')
const scriptRow = table.find((r) => r.kind === 'script')
assert.ok(styleRow, 'no style row')
assert.ok(styleRow.text.includes('html.dshlunar-first'), 'style row missing marker')
assert.ok(styleRow.text.includes('#000000'), 'style row missing black bg')
assert.ok(scriptRow, 'no script row')
assert.strictEqual(scriptRow.placement, 'head')
assert.ok(scriptRow.text.includes('dsh-lunar-boot:mode'), 'script row missing mode key')
assert.ok(scriptRow.text.includes('__lunarBootFirstFrame'), 'script row missing handshake')
assert.ok(scriptRow.text.includes('[data-dsh-boot]'), 'script row missing boot card watch')
assert.strictEqual(mod.name, 'boot-lunar')
console.log('ok  index-inject rows')

// 2) 资产路由：从 inject 里拿 handler
assert.ok(injections.length >= 1, 'webServer not injected')
const webCtx = {
  effect: (factory) => factory(),
  webServer: {
    register(route) {
      webCtx.route = route
      return () => {}
    },
  },
}
for (const inj of injections) inj.cb(webCtx)
assert.ok(webCtx.route, 'asset route not registered')
assert.strictEqual(webCtx.route.kind, 'prefix')
assert.strictEqual(webCtx.route.path, '/dsh-lunar-boot')
console.log('ok  asset route registered')

// ---- 假 res：实现 pipe 需要的 write/end ----
class FakeRes extends EventEmitter {
  constructor() {
    super()
    this.statusCode = 0
    this.headers = {}
    this.body = Buffer.alloc(0)
    this.finished = false
  }
  writeHead(code, headers) {
    this.statusCode = code
    this.headers = headers || {}
    return this
  }
  write(chunk) {
    this.body = Buffer.concat([this.body, chunk])
    return true
  }
  end(chunk) {
    if (chunk !== undefined) this.body = Buffer.concat([this.body, Buffer.from(chunk)])
    this.finished = true
    this.emit('done')
  }
  destroy() {
    this.finished = true
    this.emit('done')
  }
}

function request(path, headers = {}) {
  return new Promise((resolveP) => {
    const res = new FakeRes()
    res.on('done', () => resolveP(res))
    webCtx.route.handler({ method: 'GET', url: path, headers }, res)
    // 兜底：2 秒内没结束也算完（测试失败时能看到状态码）
    setTimeout(() => resolveP(res), 2000)
  })
}

// full file
let res = await request('/dsh-lunar-boot/lunar-boot.mp4')
assert.strictEqual(res.statusCode, 200, 'mp4 should be 200')
assert.strictEqual(res.headers['content-type'], 'video/mp4')
assert.strictEqual(res.body.length, Number(res.headers['content-length']), 'body length matches content-length')
assert.ok(res.body.length > 1000000, 'mp4 size')
console.log('ok  mp4 200', res.headers['content-length'])

res = await request('/dsh-lunar-boot/lunar-lastframe.png')
assert.strictEqual(res.statusCode, 200)
assert.strictEqual(res.headers['content-type'], 'image/png')
assert.ok(res.body.length > 100000, 'png size')
console.log('ok  png 200', res.headers['content-length'])

// range
res = await request('/dsh-lunar-boot/lunar-boot.mp4', { range: 'bytes=0-1023' })
assert.strictEqual(res.statusCode, 206, 'range should be 206')
assert.strictEqual(res.headers['content-range'], 'bytes 0-1023/11544641')
assert.strictEqual(res.body.length, 1024, 'range body length')
console.log('ok  mp4 206 range')

// open-ended range
res = await request('/dsh-lunar-boot/lunar-boot.mp4', { range: 'bytes=100-' })
assert.strictEqual(res.statusCode, 206)
assert.ok(res.headers['content-range'].endsWith('/11544641'), 'open range end')
console.log('ok  mp4 206 open range')

// 404 + traversal
res = await request('/dsh-lunar-boot/nope.png')
assert.strictEqual(res.statusCode, 404)
res = await request('/dsh-lunar-boot/../package.json')
assert.ok(res.statusCode === 403 || res.statusCode === 404, 'traversal blocked, got ' + res.statusCode)
res = await request('/dsh-lunar-boot/%2e%2e/package.json')
assert.ok(res.statusCode === 403 || res.statusCode === 404, 'encoded traversal blocked, got ' + res.statusCode)
console.log('ok  404 + traversal blocked')

// assetsPresent
assert.strictEqual(mod.assetsPresent(), true)
console.log('ok  assetsPresent')

console.log('ALL HOST-HALF TESTS PASSED')
