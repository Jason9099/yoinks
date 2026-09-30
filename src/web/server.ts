/**
 * yoinks 网页版 — 本地 HTTP 服务。
 *
 * 复用 src/lib/ytdlp.ts 的下载核心（解析 / 选清晰度 / 下载进度），
 * 把原来终端里的三步（粘贴链接 → 选清晰度 → 下载）搬到浏览器里。
 *
 *   npm run build        # 构建（含网页版）
 *   npm run web          # 启动：node dist/web/server.js
 *   PORT=3000 HOST=0.0.0.0 npm run web
 *
 * 默认监听 0.0.0.0，同一 Wi-Fi 下手机浏览器也能打开使用。
 */
import http from 'node:http'
import {readFile, stat} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {buildChoices, download, ensureYtDlp, findFfmpeg, probe} from '../lib/ytdlp.js'
import {formatBytes, formatEta, formatSpeed} from '../lib/format.js'

const PORT = Number(process.env.PORT ?? 3000)
const HOST = process.env.HOST ?? '0.0.0.0'
const OUT_DIR = path.join(os.homedir(), 'Downloads')
// 开发时（tsx）是 src/web/public，构建后（dist）是 dist/public，相对位置一致
const PUBLIC_DIR = new URL('./public/', import.meta.url)

let ytdlpPromise: Promise<string> | undefined
function getYtDlp(): Promise<string> {
  ytdlpPromise ??= ensureYtDlp(message => console.log(`[yoinks] ${message}`))
  return ytdlpPromise
}

let ffmpegPromise: Promise<string | undefined> | undefined
function getFfmpeg(): Promise<string | undefined> {
  ffmpegPromise ??= findFfmpeg()
  return ffmpegPromise
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const urlPath = new URL(req.url ?? '/', 'http://localhost').pathname
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.slice(1))
  // 防止路径穿越：只允许 public 目录内的文件
  const fileUrl = new URL(rel, PUBLIC_DIR)
  const filePath = new URL(fileUrl).pathname
  const publicPath = new URL(PUBLIC_DIR).pathname
  if (!filePath.startsWith(publicPath)) return false
  try {
    const st = await stat(filePath)
    if (!st.isFile()) return false
    const body = await readFile(filePath)
    res.writeHead(200, {'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream'})
    res.end(body)
    return true
  } catch {
    return false
  }
}

function readJsonBody(req: http.IncomingMessage, limit = 1_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        reject(new Error('请求格式错误'))
      }
    })
    req.on('error', reject)
  })
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'})
  res.end(JSON.stringify(data))
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^(https?:\/\/)/i.test(value.trim())
}

async function handleProbe(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (error) {
    json(res, 400, {ok: false, message: (error as Error).message})
    return
  }
  const url = (body as {url?: unknown}).url
  if (!isHttpUrl(url)) {
    json(res, 400, {ok: false, message: '请粘贴一个以 http 开头的视频链接'})
    return
  }
  try {
    const ytdlp = await getYtDlp()
    const {info, infoJsonPath} = await probe(ytdlp, url.trim())
    const choices = buildChoices(info)
    json(res, 200, {
      ok: true,
      title: info.title,
      uploader: info.uploader,
      duration: info.duration,
      thumbnail: (info as {thumbnail?: string}).thumbnail,
      webpageUrl: info.webpage_url,
      infoJsonPath,
      choices: choices.map(c => ({label: c.label, kind: c.kind})),
    })
  } catch (error) {
    json(res, 500, {ok: false, message: `解析失败：${(error as Error).message}`})
  }
}

/** POST /api/download —— SSE 推送下载进度 */
async function handleDownload(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (error) {
    json(res, 400, {ok: false, message: (error as Error).message})
    return
  }
  const {url, choiceIndex, infoJsonPath} = body as {url?: unknown; choiceIndex?: unknown; infoJsonPath?: unknown}
  if (!isHttpUrl(url)) {
    json(res, 400, {ok: false, message: '请粘贴一个以 http 开头的视频链接'})
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  const send = (data: unknown): void => {
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  const controller = new AbortController()
  req.on('close', () => controller.abort())

  try {
    const ytdlp = await getYtDlp()
    const {info} = await probe(ytdlp, url.trim(), controller.signal)
    const choices = buildChoices(info)
    const index = typeof choiceIndex === 'number' ? choiceIndex : -1
    const choice = choices[index]
    if (!choice) throw new Error('请选择一个清晰度')
    const ffmpegLocation = await getFfmpeg()

    const filepath = await download(
      {
        ytdlp,
        ffmpegLocation,
        url: url.trim(),
        infoJsonPath: typeof infoJsonPath === 'string' ? infoJsonPath : undefined,
        choice,
        outDir: OUT_DIR,
      },
      {
        onProgress: p => {
          const percent =
            p.totalBytes && p.totalBytes > 0 ? Math.min(100, (p.downloadedBytes / p.totalBytes) * 100) : undefined
          send({
            type: 'progress',
            downloaded: formatBytes(p.downloadedBytes),
            total: p.totalBytes ? formatBytes(p.totalBytes) : undefined,
            percent: percent === undefined ? undefined : Math.floor(percent * 10) / 10,
            speed: p.speed ? formatSpeed(p.speed) : undefined,
            eta: p.eta ? formatEta(p.eta) : undefined,
            part: p.part,
            totalParts: p.totalParts,
          })
        },
        onProcessing: () => send({type: 'processing'}),
      },
      controller.signal,
    )
    send({type: 'done', filepath, filename: path.basename(filepath)})
    res.end()
  } catch (error) {
    const message = (error as Error).message
    send({type: 'error', message: message === 'Download cancelled.' ? '已取消下载' : `下载失败：${message}`})
    res.end()
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (await serveStatic(req, res))) return
    if (req.method === 'GET' && req.url === '/api/health') {
      json(res, 200, {ok: true})
      return
    }
    if (req.method === 'POST' && req.url === '/api/probe') {
      await handleProbe(req, res)
      return
    }
    if (req.method === 'POST' && req.url === '/api/download') {
      await handleDownload(req, res)
      return
    }
    json(res, 404, {ok: false, message: 'Not found'})
  } catch (error) {
    console.error('[yoinks]', error)
    if (!res.headersSent) json(res, 500, {ok: false, message: '服务器开小差了，请重试'})
    else res.end()
  }
})

server.listen(PORT, HOST, async () => {
  const {networkInterfaces} = await import('node:os')
  const nets = Object.values(networkInterfaces()).flat() as unknown as {family: string; internal: boolean; address: string}[]
  const lan = nets.find(n => n.family === 'IPv4' && !n.internal)?.address
  console.log(`\nyoinks 网页版已启动`)
  console.log(`本机打开：http://localhost:${PORT}`)
  if (lan && HOST === '0.0.0.0') console.log(`手机打开（同一 Wi-Fi）：http://${lan}:${PORT}`)
  console.log(`下载保存到：${OUT_DIR}\n`)
})
