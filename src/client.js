/**
 * dsh-lunar-boot — 浏览器半边（client half）。
 *
 * 两个界面：
 *
 *   开机遮罩   命令式挂到 document.body 上（不走 shell.overlay 槽位 ——
 *              槽位要等 shell 渲染后才存在，那时的 DSH 开机卡片早就画上去了，
 *              详见 docs 与 lib/index.js 的时序说明）。播放逐月计划开场视频，
 *              播完定格在尾帧，图标下方浮出「加入逐月计划」按钮，点击才淡出
 *              交接给 DSH 主界面。
 *   设置行     设置 → 通用 →「逐月计划开机动画」：开 / 关 + 预览按钮。
 *
 * 遮罩是 shadow root 里的纯 DOM + <video>，样式全部内联在 shadow 内，
 * 不污染 DSH 自己的界面；宿主文档里只留一份几何/拖拽声明（HOST_SHEET_CSS，
 * 带 !important，第三方样式表抢不走）。
 *
 * 每条退出路径 —— 播完点按钮、视频加载失败走静态兜底、看门狗超时 —— 都汇到
 * 同一个 finish()：坏掉的动画永远不能把人关在黑屏后面。
 *
 * 本文件即发布产物（ CommonJS，客户端加载器提供 require，react 是它解析的
 * 外部依赖之一），无需构建。
 */

const React = require('react')

const MODE_KEY = 'dsh-lunar-boot:mode'
const DEFAULT_MODE = 'on'
/** 资产路由前缀：与 lib/index.js ASSET_PREFIX 保持一致。 */
const ASSET_PREFIX = '/dsh-lunar-boot'
const VIDEO_URL = ASSET_PREFIX + '/lunar-boot.mp4'
const LASTFRAME_URL = ASSET_PREFIX + '/lunar-lastframe.png'
/** 与宿主半边首帧的握手（见 endFirstFrame / lib/index.js）。 */
const FIRST_FRAME_GLOBAL = '__lunarBootFirstFrame'
/** 遮罩淡出总时长；同时是移除元素的定时器。 */
const FADE_MS = 550
/** 视频播完到按钮浮现之间的停顿（ms）：让定格先立住。 */
const GATE_DELAY_MS = 350
/** 元数据 8 秒还出不来 → 静态兜底（直接显示定格尾帧 + 按钮）。 */
const METADATA_TIMEOUT_MS = 8000
/** 绝对看门狗（ms）：视频 12.5s，留足余量；超时无条件放行，绝不锁死用户。 */
const WATCHDOG_MS = 60000
/** 视频天然尺寸（设计坐标），按钮落点按它换算。 */
const VIDEO_W = 1920
const VIDEO_H = 1080
/**
 * 「加入逐月计划」按钮落点：尾帧里鲸鱼图标 bbox 为 x 1201–1488 / y 434–628
 * （1920×1080 设计坐标，PIL 实测），按钮水平居中于图标中心、位于图标下方。
 */
const GATE_LEFT_PCT = ((1201 + 1488) / 2 / VIDEO_W) * 100 // 70.03%
const GATE_TOP_PCT = ((628 + 72) / VIDEO_H) * 100 // 64.63%
const ROW_STYLE_ID = 'dsh-lunar-boot-row-style'
const HOST_SHEET_ID = 'dsh-lunar-boot-host'
const CAPTION_STYLE_ID = 'dsh-lunar-boot-caption'

/** 唯一的活动遮罩：开机播放和设置页预览共用。 */
let liveOverlay = null
/** 插件被拆除中置位，避免 teardown 又把遮罩拉起来。 */
let pluginTornDown = false

function readMode() {
  try {
    const raw = window.localStorage.getItem(MODE_KEY)
    return raw === 'off' ? 'off' : DEFAULT_MODE
  } catch (error) {
    return DEFAULT_MODE
  }
}

function writeMode(mode) {
  try {
    window.localStorage.setItem(MODE_KEY, mode)
  } catch (error) {
    /* 隐私模式：选择 simply 不持久 */
  }
}

/** 设置行样式：跟随 DSH 明暗主题的设计令牌。 */
const ROW_CSS = `
.dshlunar-row{display:flex;align-items:center;gap:16px;padding:10px 0;flex-wrap:wrap;min-width:0;max-width:100%}
.dshlunar-row-text{flex:1;min-width:220px;min-width:0}
.dshlunar-row-title{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,#191919)}
.dshlunar-row-desc{margin-top:2px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#666)}
.dshlunar-row-ctrl{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.dshlunar-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-radius:8px;overflow:hidden}
.dshlunar-seg button{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#666);font-family:inherit;font-size:12.5px;line-height:1.4;padding:5px 14px;cursor:pointer}
.dshlunar-seg button+button{border-left:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35))}
.dshlunar-seg button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dshlunar-seg button.on{background:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-brand-text,#fff)}
.dshlunar-preview{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));background:transparent;color:var(--dsw-alias-label-primary,#191919);font-family:inherit;font-size:12.5px;line-height:1.4;padding:5px 14px;border-radius:8px;cursor:pointer}
.dshlunar-preview:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dshlunar-preview[disabled]{opacity:.55;cursor:default}
.dshlunar-note{margin-top:6px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#666)}
`

function ensureRowStyle() {
  if (document.getElementById(ROW_STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = ROW_STYLE_ID
  style.textContent = ROW_CSS
  document.head.appendChild(style)
}

/**
 * 宿主元素自己的几何 / 拖拽声明，放在文档里而不是 shadow root 里。
 *
 * 两个原因（都是从 dsh-550c-boot 的真机实测里学来的）：
 *
 *   几何   文档级规则会压过 :host 声明（shadow root 没法从外面保护宿主），
 *          所以这里用 !important 钉死遮罩的位置、层级和背景。
 *   拖拽   DSH 官方基础样式把 darwin 上每个 body 直接子元素变成
 *          -webkit-app-region:no-drag，视口级遮罩会把整个窗口从可拖拽区里
 *          扣掉；pointer-events:none 不能豁免这个计算，只有元素自己的声明能。
 *          initial（即 none）把元素拿出计算，而不是把遮罩变成拖拽手柄。
 *          顶部 40px 单独放一条 dragband，播放期间窗口仍可拖动。
 */
const HOST_SHEET_CSS = `
body>.dshlunar-host{position:fixed;inset:0;display:block;box-sizing:border-box;z-index:2147483000 !important;background:#000;pointer-events:auto !important}
body>.dshlunar-host.dshlunar-out{opacity:0;transition:opacity ${String(FADE_MS)}ms cubic-bezier(.4,0,.2,1) !important}
html[data-platform="darwin"] body>.dshlunar-host{-webkit-app-region:initial !important}
body>.dshlunar-dragband{position:fixed;top:0;left:0;right:0;height:40px;z-index:2147483001;-webkit-app-region:drag}
`

function ensureHostSheet() {
  if (document.getElementById(HOST_SHEET_ID) !== null) return
  const style = document.createElement('style')
  style.id = HOST_SHEET_ID
  style.textContent = HOST_SHEET_CSS
  document.head.appendChild(style)
}

/**
 * 退役宿主半边的首帧。
 *
 * lib/index.js 通过 index-inject 在 shell 存在之前就把全屏黑底盖上了 —— 这是
 * 唯一能让 DSH 开机卡片不上屏的办法。遮罩画的是同一片黑，所以在挂载的同一
 * 任务里调用 end()，两者在同一帧里交接：无缝、无闪、无残留。注入脚本自带
 * 卡片监看和 20s 超时，客户端半边永远不来也不会留下黑窗口。
 */
function endFirstFrame() {
  const handle = window[FIRST_FRAME_GLOBAL]
  if (handle === undefined || handle === null) return
  delete window[FIRST_FRAME_GLOBAL]
  try {
    handle.end()
  } catch (error) {
    console.error('[dsh-lunar-boot] first frame refused to end', error)
  }
}

/**
 * 桌面端标题栏适配：播放期间把原生最小化/最大化/关闭所在的标题条变透明，
 * 按钮浮在动画上，符号用动画的强调色，而不是灰条压顶。
 *
 * 桌面预加载会测量一个探针元素的计算背景色/文字色并推给 setTitleBarOverlay，
 * 这里把探针改成透明 + 白符。改 <head> 本身就是重新测量的触发器；遮罩拆除时
 * 移除样式表，应用自己的颜色随之回来。浏览器标签页没有这套机制，全是无操作。
 *
 * @returns a disposer, or null when there is nothing to adapt
 */
function adaptCaption() {
  const platform = document.documentElement.dataset.platform
  if (platform === undefined || platform === '') return null
  if (platform === 'darwin') return () => {}
  const style = document.createElement('style')
  style.id = CAPTION_STYLE_ID
  const probe = 'body>span[style*="dsw-specific-sidebar-fill"]'
  style.textContent = probe + '{background-color:transparent !important;color:#ffffff !important}'
  document.head.appendChild(style)
  return () => {
    style.remove()
  }
}

/** shadow root 内部样式：几何、视频/尾帧、按钮、声音开关。 */
const SHADOW_CSS = `
:host{position:fixed;inset:0;display:block;box-sizing:border-box;background:#000;overflow:hidden}
/* 居中且恰好等于 16:9 含纳矩形的盒子：视频与尾帧都按设计坐标 1:1 落位，
   任何窗口比例下按钮与图标的相对位置都不漂移。盒子尺寸由 JS 计算。 */
.fitbox{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:100%;height:100%}
.reel,.lastframe{position:absolute;inset:0;width:100%;height:100%;display:block;background:#000}
.lastframe{opacity:1}
.reel{z-index:2}
/* 「加入逐月计划」：尾帧图标正下方，白线框极简风，与画面同一套语言。 */
.gate{position:absolute;left:${GATE_LEFT_PCT.toFixed(2)}%;top:${GATE_TOP_PCT.toFixed(2)}%;transform:translate(-50%,0);
  z-index:3;border:1px solid rgba(255,255,255,.92);background:rgba(0,0,0,.32);color:#fff;
  font-family:"PingFang SC","HarmonyOS Sans SC","Source Han Sans SC","Noto Sans CJK SC","Microsoft YaHei","Segoe UI",system-ui,sans-serif;
  font-weight:500;letter-spacing:.42em;text-indent:.42em;white-space:nowrap;
  padding:.62em 1.5em .62em 1.92em;border-radius:2px;cursor:pointer;
  opacity:0;pointer-events:none;
  transition:opacity .7s ease,background-color .25s ease,color .25s ease,box-shadow .25s ease}
.gate.show{opacity:1;pointer-events:auto}
.gate:hover{background:#fff;color:#000;box-shadow:0 0 24px rgba(255,255,255,.28)}
.gate:active{transform:translate(-50%,0) scale(.985)}
/* 自动播放被策略拦下、静音降级时的声音开关；默认隐藏。 */
.sound{position:absolute;top:56px;right:24px;z-index:4;
  border:1px solid rgba(255,255,255,.45);background:rgba(0,0,0,.45);color:rgba(255,255,255,.92);
  font-family:inherit;font-size:12.5px;line-height:1.4;padding:6px 14px;border-radius:8px;cursor:pointer;
  opacity:0;pointer-events:none;transition:opacity .4s ease}
.sound.show{opacity:1;pointer-events:auto}
.sound:hover{background:rgba(255,255,255,.16)}
`

/**
 * 把含纳矩形算出来并应用到 fitbox / 按钮字号。
 *
 * 视频是 16:9 设计稿；contain 含纳在任何窗口比例下都不裁切内容（黑边不可见，
 * 因为设计稿底色就是纯黑），于是「视频末帧 → 定格尾帧」的过渡像素级一致，
 * 按钮相对图标的落点也恒定。
 */
function layoutFitbox(fitbox, gate) {
  const vw = window.innerWidth || VIDEO_W
  const vh = window.innerHeight || VIDEO_H
  const scale = Math.min(vw / VIDEO_W, vh / VIDEO_H)
  const w = Math.max(1, Math.round(VIDEO_W * scale))
  const h = Math.max(1, Math.round(VIDEO_H * scale))
  fitbox.style.width = w + 'px'
  fitbox.style.height = h + 'px'
  // 设计稿里按钮文字约 22px（1080 高），按比例缩放，下限 12px。
  gate.style.fontSize = Math.max(12, Math.round((h * 22) / VIDEO_H)) + 'px'
}

/**
 * 挂载开机遮罩。
 *
 * 不走槽位、不走 React：客户端模块求值的那一刻就直接命令式挂到 body 上 ——
 * 这是一个客户端插件能画的最早时刻。生命周期仍归插件所有（apply() 里注册
 * ctx.effect 负责卸载）。
 *
 * @param force - true 时无视关闭档播放（设置页的预览按钮）
 * @returns the live overlay record, or null when nothing was mounted
 */
function mountOverlay(force) {
  if (force !== true) {
    // 每个文档只自动放一次：思考/流式输出期间客户端会重渲染，
    // 不设防会把片头反复拉起来。
    if (window.__lunarBootPlayed === true) return null
    window.__lunarBootPlayed = true
  }
  if (liveOverlay !== null) return liveOverlay

  if (!force && readMode() === 'off') return null

  if (document.body === null) {
    // 模块可能在文档解析期间求值；遮罩需要 body，那就等一个。
    document.addEventListener('DOMContentLoaded', () => mountOverlay(force), { once: true })
    return null
  }

  const host = document.createElement('div')
  host.className = 'dshlunar-host'
  // 自己的标记 + aria-hidden（拿到 darwin 拖拽豁免的标准属性，不借私有名）。
  host.dataset.dshLunarBoot = ''
  host.setAttribute('aria-hidden', 'true')
  ensureHostSheet()

  const dragBand = document.createElement('div')
  dragBand.className = 'dshlunar-dragband'
  dragBand.setAttribute('data-window-drag', '')

  document.body.appendChild(host)
  document.body.appendChild(dragBand)

  const record = {
    host: host,
    dragBand: dragBand,
    video: null,
    gate: null,
    sound: null,
    finished: false,
    staticMode: false,
    fadeTimer: null,
    watchdog: null,
    metaTimer: null,
    resizeHandler: null,
    caption: null,
    dispose: null,
  }

  const clearTimers = () => {
    if (record.fadeTimer !== null) window.clearTimeout(record.fadeTimer)
    if (record.watchdog !== null) window.clearTimeout(record.watchdog)
    if (record.metaTimer !== null) window.clearTimeout(record.metaTimer)
    record.fadeTimer = null
    record.watchdog = null
    record.metaTimer = null
  }

  const dispose = () => {
    clearTimers()
    if (record.resizeHandler !== null) window.removeEventListener('resize', record.resizeHandler)
    if (record.caption !== null) record.caption()
    if (record.video !== null) {
      // 停掉并释放：load() 会抛 error 事件，先摘监听再动元素。
      try {
        record.video.pause()
        record.video.removeAttribute('src')
        record.video.load()
      } catch (error) {
        /* 元素已经没了 */
      }
    }
    dragBand.remove()
    host.remove()
    if (liveOverlay === record) liveOverlay = null
  }

  const finish = () => {
    if (record.finished) return
    record.finished = true
    clearTimers()
    host.classList.add('dshlunar-out')
    record.fadeTimer = window.setTimeout(dispose, FADE_MS + 40)
  }
  record.dispose = dispose

  // 绝对看门狗：日常装机上，坏掉的动画永远不能把人锁在设置页外面 ——
  // 而设置页正是关掉它的地方。超时无条件放行。
  record.watchdog = window.setTimeout(() => {
    console.error('[dsh-lunar-boot] watchdog fired; dismissing the splash')
    finish()
  }, WATCHDOG_MS)

  try {
    const shadow = host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = SHADOW_CSS
    shadow.appendChild(style)

    const fitbox = document.createElement('div')
    fitbox.className = 'fitbox'

    // 定格尾帧：一开始就在视频下面（同源同尺寸），视频藏掉即无缝定格。
    const lastframe = document.createElement('img')
    lastframe.className = 'lastframe'
    lastframe.alt = ''
    lastframe.decoding = 'async'
    lastframe.src = LASTFRAME_URL
    fitbox.appendChild(lastframe)

    const video = document.createElement('video')
    video.className = 'reel'
    video.src = VIDEO_URL
    video.playsInline = true
    video.preload = 'auto'
    video.disablePictureInPicture = true
    fitbox.appendChild(video)
    record.video = video

    const gate = document.createElement('button')
    gate.type = 'button'
    gate.className = 'gate'
    gate.textContent = '加入逐月计划'
    fitbox.appendChild(gate)
    record.gate = gate

    const sound = document.createElement('button')
    sound.type = 'button'
    sound.className = 'sound'
    sound.textContent = '🔊 开启声音'
    shadow.appendChild(sound)
    record.sound = sound

    shadow.appendChild(fitbox)

    layoutFitbox(fitbox, gate)
    record.resizeHandler = () => layoutFitbox(fitbox, gate)
    window.addEventListener('resize', record.resizeHandler)

    record.caption = adaptCaption()

    /** 静态兜底：视频任何一步失败，直接显示定格尾帧 + 按钮。 */
    const fallbackToStatic = () => {
      if (record.finished || record.staticMode) return
      record.staticMode = true
      if (record.metaTimer !== null) {
        window.clearTimeout(record.metaTimer)
        record.metaTimer = null
      }
      console.error('[dsh-lunar-boot] video unavailable; showing the frozen last frame')
      try {
        video.pause()
      } catch (error) {
        /* 没起来就不用停 */
      }
      video.style.display = 'none'
      // 尾帧图可能还没解码完：等它一下再亮按钮，避免按钮漂在纯黑上。
      const reveal = () => window.setTimeout(() => gate.classList.add('show'), 150)
      if (lastframe.complete) reveal()
      else lastframe.addEventListener('load', reveal, { once: true })
    }

    const showGate = () => {
      video.style.display = 'none'
      window.setTimeout(() => gate.classList.add('show'), GATE_DELAY_MS)
    }

    video.addEventListener('ended', showGate)
    video.addEventListener('error', fallbackToStatic)
    // 元数据超时：既不 error 也不出数据的异常态，不能干等。
    record.metaTimer = window.setTimeout(() => {
      if (video.readyState < 1) fallbackToStatic()
    }, METADATA_TIMEOUT_MS)

    gate.addEventListener('click', () => {
      // 门禁：只有这一下能进 DSH。
      finish()
    })

    sound.addEventListener('click', () => {
      try {
        video.muted = false
        video.volume = 1
        if (video.paused) {
          const retry = video.play()
          if (retry && typeof retry.catch === 'function') retry.catch(() => {})
        }
      } catch (error) {
        /* 开启失败就保持静音，不挡门禁 */
      }
      sound.classList.remove('show')
    })

    // 起播：先试带声；被自动播放策略拦下就静音降级 + 给声音开关。
    let started = null
    try {
      video.muted = false
      video.volume = 1
      started = video.play()
    } catch (error) {
      started = null
    }
    if (started !== null && typeof started.catch === 'function') {
      started.catch(() => {
        try {
          video.muted = true
          const retry = video.play()
          if (retry !== null && typeof retry.catch === 'function') {
            retry.catch(() => fallbackToStatic())
          }
        } catch (error) {
          fallbackToStatic()
        }
        sound.classList.add('show')
      })
    }

    // 挂载同一任务的最后一句：宿主首帧与这个 shadow root 同帧交接。
    endFirstFrame()
  } catch (error) {
    console.error('[dsh-lunar-boot] splash failed to start', error)
    finish()
  }

  liveOverlay = record
  return record
}

/**
 * 设置行：开 / 关 + 预览。
 *
 * 普通 React 元素（createElement，无 JSX：客户端加载器给本模块 require，
 * react 是它解析的外部依赖）。预览按钮命令式放一遍遮罩 —— 和开机共用同
 * 一个 liveOverlay，放的时候再点不会叠一份。
 */
function SettingsRow() {
  const [mode, setMode] = React.useState(readMode)
  const [live, setLive] = React.useState(() => liveOverlay !== null)

  React.useEffect(() => {
    ensureRowStyle()
  }, [])

  // 遮罩活着的时候预览按钮要点不动：轮询比订阅一套事件轻，也更难坏。
  React.useEffect(() => {
    const timer = window.setInterval(() => setLive(liveOverlay !== null), 300)
    return () => window.clearInterval(timer)
  }, [])

  const choose = (next) => {
    writeMode(next)
    setMode(next)
  }

  const preview = () => {
    if (liveOverlay !== null) return
    mountOverlay(true)
    setLive(true)
  }

  return React.createElement(
    'div',
    { className: 'dshlunar-row' },
    React.createElement(
      'div',
      { className: 'dshlunar-row-text' },
      React.createElement('div', { className: 'dshlunar-row-title' }, '逐月计划开机动画'),
      React.createElement(
        'div',
        { className: 'dshlunar-row-desc' },
        '启动时播放逐月计划开场影片，结束后定格在尾帧，点击「加入逐月计划」按钮才会进入。',
      ),
    ),
    React.createElement(
      'div',
      { className: 'dshlunar-row-ctrl' },
      React.createElement(
        'div',
        { className: 'dshlunar-seg' },
        [
          { value: 'on', label: '开启' },
          { value: 'off', label: '关闭' },
        ].map((option) =>
          React.createElement(
            'button',
            {
              key: option.value,
              type: 'button',
              className: mode === option.value ? 'on' : '',
              onClick: () => choose(option.value),
            },
            option.label,
          ),
        ),
      ),
      React.createElement(
        'button',
        { type: 'button', className: 'dshlunar-preview', onClick: preview, disabled: live },
        '预览',
      ),
    ),
    React.createElement(
      'div',
      { className: 'dshlunar-note' },
      '影片约 12.5 秒。浏览器可能拦截带声音的自动播放，被拦截时动画静音播放，可用画面右上角的开关开启声音。',
    ),
  )
}

function apply(ctx) {
  // 客户端重连 / 热重挂载会再次调用 apply：重复 register 同一个 slot id 会抛错。
  if (window.__lunarBootApplied === true) {
    console.info('[dsh-lunar-boot] apply 已执行过，跳过重复注册')
    return
  }
  window.__lunarBootApplied = true

  // 设置行是普通的槽位贡献：注册进通用页，随页面生死。
  ctx.slots.inject('settings.general.item', () => {
    const placed = ctx.slots.register(
      { name: 'settings.general.item', id: 'boot-lunar', order: 40 },
      SettingsRow,
    )
    return () => {
      placed()
    }
  })

  // 遮罩不是槽位贡献（mountOverlay 解释了为什么），注册成 effect，
  // 这样禁用插件会把遮罩一起拆掉。
  ctx.effect(
    () => () => {
      pluginTornDown = true
      if (liveOverlay !== null) liveOverlay.dispose()
    },
    'dsh-lunar-boot: splash teardown',
  )
}

/**
 * 模块求值时挂载开机遮罩 —— 这是一个客户端插件能画的最早时刻。
 * 生命周期仍归插件所有：apply() 注册了 teardown effect。
 */
let bootSplash = null
try {
  bootSplash = mountOverlay(false)
} catch (error) {
  console.error('[dsh-lunar-boot] boot splash mount failed', error)
}

exports.name = 'boot-lunar'
exports.inject = ['slots']
exports.apply = apply
