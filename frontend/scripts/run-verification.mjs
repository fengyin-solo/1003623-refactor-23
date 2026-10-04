/**
 * 验证脚本运行器：用 esbuild 解析 @ 路径别名后在 Node 中执行。
 * 用法：node scripts/run-verification.mjs <domain|store>（默认 domain）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const target = process.argv[2] ?? 'domain'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.join(root, 'scripts', `verify-${target}.ts`)
const outfile = path.join(root, 'scripts', `.verify-${target}.cjs`)

try {
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    alias: { '@': path.join(root, 'src') },
    logLevel: 'silent',
  })
  await import(pathToFileURL(outfile).href)
} finally {
  fs.rmSync(outfile, { force: true })
}
