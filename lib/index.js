/**
 * dsh-lunar-boot — 宿主半边（host half）。
 *
 * 分工与 dsh-550c-boot 完全一致：动画在浏览器半边（lib/client.js），但它的
 * 第一帧来不了那么早 —— DSH 自己的开机卡片（[data-dsh-boot]，"HARNESS /
 * Loading plugins…"）由 shell 内核在客户端插件物料化之前就画上去了（550c 在
 * 真机上的实测：卡片 67ms 出现、客户端 bundle 338ms 才求值完）。所以首帧
 * 交给宿主半边：DSH 暴露的 `webserver/index-inject` 事件收集一张注入行表，
 * Web 载体把它渲染进 index.html 的 <head> 之后（早于 shell 的 module
 * script），桌面载体在 settle __DSH_BOOT_READY__ 之前逐行应用同一张表 ——
 * 两条路都赶在内核建卡片之前。于是一条 style 行加一条同步 script 行，
 * 在文档还在解析时就把全屏黑底盖住了，卡片从来没被画到屏幕上。
 *
 * 与 lib/client.js 的两个约定（改一边要改另一边）：
 *
 *   MODE_KEY            同一个 localStorage 键、同一个默认值；注入脚本自己
 *                       读它：关闭档直接不作画，一张黑屏都不会出现。
 *   FIRST_FRAME_GLOBAL  `window.__lunarBootFirstFrame.end()` 是遮罩退役首帧
 *                       的方式（同一任务、同一帧，无缝）。下面的开机卡片监
 *                       看和绝对超时都是兜底：客户端 bundle 加载失败也决不能
 *                       留下一个黑窗口。
 *
 * 另外注册一条静态资产路由 /dsh-lunar-boot/*，把开机视频（lunar-boot.mp4）
 * 和定格尾帧（lunar-lastframe.png）发出去，遮罩里的 <video>/<img> 都从这取。
 * 支持 Range —— 视频元素的拖动/seek 需要它；不支持时 Chrome 也能播完整
 * 200，但有了更稳。
 *
 * @module dsh-lunar-boot
 */

import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, resolve, sep, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'boot-lunar'

/** src/client.js MODE_KEY / DEFAULT_MODE — keep in sync. */
const MODE_KEY = 'dsh-lunar-boot:mode'
/** src/client.js FIRST_FRAME_GLOBAL — keep in sync. */
const FIRST_FRAME_GLOBAL = '__lunarBootFirstFrame'
/** 首帧底色：视频第一帧就是近黑场（月亮淡入），纯黑盖子无缝。 */
const FIRST_FRAME_BG = '#000000'
/** 绝对上限（ms）：视频 12.5s，留足余量；过了就撤，页面必须能看能点。 */
const FIRST_FRAME_MAX_MS = 20000
/** 遮罩自己的 z-index（client.js HOST_CSS）减一。 */
const FIRST_FRAME_Z = 2147482000
/** 静态资产路由前缀。 */
const ASSET_PREFIX = '/dsh-lunar-boot'
/** 资产目录：本文件位于 <package>/lib/index.js，资产在 <package>/assets/。 */
const ASSET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets')

const ASSET_TYPES = {
  '.mp4': 'video/mp4',
  '.png': 'image/png',
}

/**
 * 首帧盖子：动画自己的底色，压住页面的一切绘制，位于将要取代它的遮罩之下。
 * pointer-events 保持关闭 —— 它盖住的开机卡片本来也不可交互。
 */
const FIRST_FRAME_CSS =
  'html.dshlunar-first::before{content:"";position:fixed;inset:0;background:' +
  FIRST_FRAME_BG +
  ';z-index:' +
  String(FIRST_FRAME_Z) +
  ';pointer-events:none}\n' +
  'html.dshlunar-first{background:' +
  FIRST_FRAME_BG +
  '}'

/**
 * 类标记 + 交接握手 + 开机卡片监看 + 绝对超时。
 *
 * 刻意做得小而同步：它在 <head> 解析期间运行，盖子在第一次绘制前就生效。
 * 关闭档直接 return —— 一张黑屏都不会出现。
 * 监看每 250ms 看一眼开机卡片：卡片消失（应用挂载）或卡片丢掉 spinner
 * （shell 自己的失败态）就自己撤；再加 20s 绝对上限。遮罩挂载时会同步调用
 * end() 退役它，无缝交接。
 */
const FIRST_FRAME_SCRIPT =
  '(function(){' +
  'var mode=null;' +
  'try{mode=window.localStorage.getItem(' +
  JSON.stringify(MODE_KEY) +
  ')}catch(error){}' +
  'if(mode==="off")return;' +
  'var root=document.documentElement;' +
  'var watch=null;' +
  'var end=function(){' +
  'if(watch!==null){window.clearInterval(watch);watch=null}' +
  'root.classList.remove("dshlunar-first")' +
  '};' +
  'window.' +
  FIRST_FRAME_GLOBAL +
  '={end:end};' +
  'root.classList.add("dshlunar-first");' +
  'var seen=false;' +
  'watch=window.setInterval(function(){' +
  'var card=document.querySelector("[data-dsh-boot]");' +
  'if(card===null){if(seen)end();return}' +
  'seen=true;' +
  'if(card.querySelector("[data-dsh-boot-spinner]")===null)end()' +
  '},250);' +
  'window.setTimeout(end,' +
  String(FIRST_FRAME_MAX_MS) +
  ');' +
  '})()'

/**
 * /dsh-lunar-boot/* 静态资产：开机视频 + 定格尾帧。
 *
 * 目录穿越防护：解析后的绝对路径必须仍落在 ASSET_ROOT 内。
 * Range：视频元素会发 `bytes=start-end`；单段 Range 足够，多段/后缀 Range
 * 一律按完整 200 应答（Chrome 对完整 200 也能播，只是不能 seek）。
 *
 * @param req - the incoming request. @param res - the response to fill.
 */
function assetHandler(req, res) {
  let file
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const clean = decodeURIComponent(url.pathname.slice(ASSET_PREFIX.length)).replace(/^\/+/, '')
    file = resolve(ASSET_ROOT, clean)
  } catch (error) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('bad request')
    return
  }
  const root = resolve(ASSET_ROOT)
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('forbidden')
    return
  }
  let size = 0
  try {
    const stat = statSync(file)
    if (!stat.isFile()) throw new Error('not a file')
    size = stat.size
  } catch (error) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  const type = ASSET_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
  const baseHeaders = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  }
  const range = req.headers?.range
  if (typeof range === 'string') {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (match !== null) {
      const start = match[1] === '' ? 0 : Number.parseInt(match[1], 10)
      const end = match[2] === '' ? size - 1 : Math.min(Number.parseInt(match[2], 10), size - 1)
      if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start <= end && start < size) {
        res.writeHead(206, {
          ...baseHeaders,
          'content-length': end - start + 1,
          'content-range': `bytes ${String(start)}-${String(end)}/${String(size)}`,
        })
        const stream = createReadStream(file, { start, end })
        stream.on('error', () => res.destroy())
        stream.pipe(res)
        return
      }
    }
  }
  res.writeHead(200, { ...baseHeaders, 'content-length': size })
  const stream = createReadStream(file)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

/**
 * 给每个 index 响应贡献首帧。
 *
 * 不注入 service：`webserver/index-inject` 是载体每次响应时发出的普通组合
 * 事件，只有真的伺服页面时才渲染行表 —— 没人请求时就多一行定义，零成本。
 *
 * 资产路由通过可选注入注册（ctx.inject(['webServer'], …）：没有 HTTP 载体
 * 的 profile 仍然能拿到首帧注入，只是遮罩取不到视频（客户端有静态兜底：
 * 视频加载失败会直接显示定格尾帧 + 按钮，不会把人锁死）。
 *
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'style', text: FIRST_FRAME_CSS })
    table.push({ kind: 'script', placement: 'head', text: FIRST_FRAME_SCRIPT })
  })

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      try {
        return webCtx.webServer.register({
          kind: 'prefix',
          path: ASSET_PREFIX,
          handler: assetHandler,
        })
      } catch (error) {
        // 路由注册失败（比如桌面端 webServer 不支持 prefix）只少一个资产通道，
        // 绝不能把一个可选路由的失败升级成插件整体崩掉。
        console.error('[dsh-lunar-boot] asset route registration failed', error)
        return () => {}
      }
    }, `boot-lunar: GET ${ASSET_PREFIX}/*`)
  })
}

/** 供测试/自省：资产目录是否存在（安装残缺时能看出来）。 */
export function assetsPresent() {
  return existsSync(resolve(ASSET_ROOT, 'lunar-boot.mp4'))
}
