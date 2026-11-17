#!/usr/bin/env node
// Build the npm package @molamaker/mstack: the `mola` CLI with its workspace packages bundled in, plus the skills,
// hooks and agents. The @mola/* packages are not published one by one; they travel inside this tarball as
// bundleDependencies, so `npm i -g @molamaker/mstack` needs nothing else from the registry.
//
//   cd cli && pnpm install && pnpm -r build && cd ..
//   node scripts/pack-npm.mjs            # stage into cli/.npm-pack and `npm pack` there
//   node scripts/pack-npm.mjs --stage    # stage only
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)))
const cli = join(repo, 'cli')
const stage = join(cli, '.npm-pack')
const NAME = '@molamaker/mstack'
const version = JSON.parse(readFileSync(join(repo, '.claude-plugin', 'plugin.json'), 'utf8')).version

const pkgDirs = [
  join(cli, 'packages', 'core'),
  join(cli, 'packages', 'plugin-sdk'),
  join(cli, 'packages', 'rpc'),
  join(cli, 'packages', 'mola'),
  ...readdirSync(join(cli, 'packages', 'plugins')).map((d) => join(cli, 'packages', 'plugins', d)),
].filter((d) => existsSync(join(d, 'package.json')))

const read = (d) => JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'))
const versions = new Map(pkgDirs.map((d) => [read(d).name, read(d).version]))

rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

const bundled = []
for (const dir of pkgDirs) {
  const pkg = read(dir)
  if (!existsSync(join(dir, 'dist'))) throw new Error(`${pkg.name}: no dist/ (run pnpm -r build first)`)
  const out = join(stage, 'node_modules', ...pkg.name.split('/'))
  mkdirSync(out, { recursive: true })
  // compiled code without the compiled tests
  cpSync(join(dir, 'dist'), join(out, 'dist'), { recursive: true, filter: (src) => !/[\\/]dist[\\/]test([\\/]|$)/.test(src) && !src.endsWith('.tsbuildinfo') })
  if (existsSync(join(dir, 'mola-plugin.json'))) cpSync(join(dir, 'mola-plugin.json'), join(out, 'mola-plugin.json'))
  // workspace:* → the exact version that travels with it; dev-only fields go
  const deps = {}
  for (const [k, v] of Object.entries(pkg.dependencies ?? {})) deps[k] = String(v).startsWith('workspace:') ? versions.get(k) : v
  const { devDependencies: _d, scripts: _s, ...rest } = pkg
  // the CLI reports its own package.json version: give the staged `mola` the release version
  const own = pkg.name === 'mola' ? { version } : {}
  writeFileSync(join(out, 'package.json'), JSON.stringify({ ...rest, ...own, dependencies: deps }, null, 2) + '\n')
  bundled.push(pkg.name)
}

for (const d of ['skills', 'hooks', 'agents', 'commands', '.claude-plugin']) {
  if (existsSync(join(repo, d))) cpSync(join(repo, d), join(stage, d), { recursive: true, filter: (src) => !/[\\/](node_modules|\.omc)([\\/]|$)/.test(src) })
}
for (const f of ['README.md', 'LICENSE', 'NOTICE.md', 'CHANGELOG.md']) if (existsSync(join(repo, f))) cpSync(join(repo, f), join(stage, f))

mkdirSync(join(stage, 'bin'))
writeFileSync(join(stage, 'bin', 'mola.js'), '#!/usr/bin/env node\n// the mola CLI bundled in this package; it finds the skills shipped beside it by walking up from its own files\nawait import("../node_modules/mola/dist/bin.js");\n')

const dependencies = Object.fromEntries(bundled.map((n) => [n, versions.get(n)]))
writeFileSync(join(stage, 'package.json'), JSON.stringify({
  name: NAME,
  version,
  description: 'mstack: workflow skills for coding agents (think, plan, dispatch, verify, review, ship) and the mola CLI that runs them: unattended runs, a web console, a terminal console, model routing.',
  type: 'module',
  bin: { mola: 'bin/mola.js' },
  engines: { node: '>=22' },
  license: 'MIT',
  repository: { type: 'git', url: 'git+https://github.com/Mola-maker/mstack.git' },
  homepage: 'https://github.com/Mola-maker/mstack#readme',
  keywords: ['agents', 'claude-code', 'deepseek-harness', 'codex', 'skills', 'workflow', 'cli'],
  files: ['bin', 'skills', 'hooks', 'agents', 'commands', '.claude-plugin', 'README.md', 'LICENSE', 'NOTICE.md', 'CHANGELOG.md'],
  dependencies,
  bundleDependencies: bundled,
  publishConfig: { access: 'public' },
}, null, 2) + '\n')

console.log(`staged ${NAME}@${version}: ${bundled.length} bundled packages, in ${stage}`)
if (!process.argv.includes('--stage')) {
  const out = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--json'], { cwd: stage, encoding: 'utf8', shell: process.platform === 'win32' })
  // npm 10 prints an array, npm 11 an object keyed by package name
  const parsed = JSON.parse(out.slice(out.search(/[[{]/)))
  const info = Array.isArray(parsed) ? parsed[0] : (parsed.filename ? parsed : Object.values(parsed)[0])
  console.log(`packed ${join(stage, info.filename)}: ${info.entryCount} files, ${(info.size / 1024).toFixed(0)} KiB`)
}
