#!/usr/bin/env node
/**
 * 构建 lib/client.js —— 客户端加载器期望的那一个浏览器模块。
 *
 * 刻意不用打包器、零构建依赖（与 dsh-550c-boot 一致）：加载器的 factory 会给
 * 模块递一个 require，用来解析插件可用的外部依赖（react、react/jsx-runtime），
 * 插件自己的源码拼进 factory 体里。这正是已发布客户端插件的 lib/client.js
 * 的形状（$DSH_HOME/profiles/*\/node_modules 下任何一个都是）。
 *
 * 包在 factory 里有两个硬道理（都是真机撞出来的）：
 *   1. require 是 factory 的参数 —— 裸 CJS 的 require 在页面里不存在，
 *      直接 ReferenceError。
 *   2. 每个插件的 client 会被拼进同一个 bundle 当 ESM 求值 —— 顶层声明
 *      （const React 等）不包函数会互相撞，SyntaxError 把整条 bundle 带崩。
 *
 * 用法：node scripts/build.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PLUGIN_ID = 'dsh-lunar-boot'
const PART = 'src/client.js'

// 行尾归一化：Windows 检出 CRLF，空行读出来是 "\r"（长度 1），会被缩进逻辑
// 当成非空行补上 \t；Linux 检出 LF，空行是 ""（长度 0），不补。不归一化的话
// 同一份源码在两个平台会构建出不同的 bundle。
const read = (file) => readFileSync(resolve(root, file), 'utf8').replace(/\r\n/g, '\n')
const body = `//#region ${PART}\n${read(PART).trimEnd()}\n//#endregion`

const out = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(PLUGIN_ID)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${body
  .split('\n')
  .map((line) => (line.length > 0 ? `\t\t${line}` : line))
  .join('\n')}
\t\treturn module.exports;
\t}
});
`

const target = resolve(root, 'lib/client.js')
writeFileSync(target, out)
process.stdout.write(`built ${target} (${String(out.length)} bytes)\n`)
