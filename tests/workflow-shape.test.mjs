/**
 * The workflow files are checked by GitHub, and only by GitHub — which is the problem.
 *
 * A workflow that fails validation does not report a red step: the run dies at zero jobs, with no log,
 * no annotation and the run named after the file instead of the workflow. Nothing a local gate runs can
 * see that, because nothing locally reads `.github/workflows/`. It cost two frames on 2026-10-22: an
 * edit that removed a CI step left a duplicate `- name:` with no `run:` behind it, and every push on the
 * branch failed instantly while the local buckets — including the one that step had just run — stayed
 * green.
 *
 * So this file reads the workflows as data and asserts the three shapes that are silently fatal:
 *
 *   1. **every step runs something** — `run:` or `uses:`. A step with only a name is valid YAML and
 *      invalid Actions, which is exactly why a YAML parser alone would have passed the broken file.
 *   2. **every `npm run <script>` a step names exists in the manifest** — the other half of the same
 *      accident: deleting a script and leaving the step behind, or the reverse.
 *   3. **every check script the repository offers is accounted for** — either a workflow runs it, or it
 *      is in `MAINTAINER_ONLY` below with the reason it stays off CI. A gate nobody wired in is how
 *      coverage quietly becomes fiction.
 *
 * Static: no boot, no network, no host package (`js-yaml` is a declared dependency, read only).
 * Node ≥ 24.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Scripts a maintainer runs by hand, each with the reason it is not on CI. An unexplained orphan is the
 * finding this map exists to make loud; `test:docs-claims` is a row that is honest about not being wired.
 */
const MAINTAINER_ONLY = {
  'test:replay': 'plants defects into the working tree and reverts them; a tree with a planted defect is what a CI job must never be. Its recorded output is what CI checks (`test:readings`).',
  'test:shapes': 'the offline half is `test:world`; the real arm spawns `wsl.exe` per shape.',
  'test:node:fresh': 'a local convenience: build, then the node bucket, for when `lib/` may be stale.',
  'test:compat': 'boots a real installed host per release; `compat.yml` runs the same script weekly, not this command.',
  'test:docs-claims': 'NOT ON CI — the claims registry runs locally. The catalog row for it has claimed a CI home it does not have; wiring it into `lint-build` is an open decision, recorded here rather than assumed.',
  'test:rank': 'the same command runs inside `test:node` (`check-rank-parity.mjs --strict`); the bucket is the local spelling.',
  'lint:portability': 'the advisory scan; the enforceable subset runs in `test:unit` via `check-portable-spelling.test.mjs`.',
  'lint:portability:strict': 'the advisory pass with nothing waived.',
  'typecheck:gate': '`runtime-tests` runs the plain gate; this is the manual spelling.',
  'test:wsl': '`wsl-gate` runs the individual drivers directly with the plane and distribution in the environment; the bucket is the local one-command form.',
  'test:realm-probe': 'driven by `test:seams`, which is the CI home; the single-command form exists to re-measure one arm.',
  'test:confine-probe': 'driven by `test:seams`.',
  'test:rc2-consumers': 'driven by `test:seams`.',
}
const RUNS_INSIDE_A_BUCKET = {
  'typecheck': '`runtime-tests` runs `node scripts/typecheck-gate.mjs`, which is the same check against a recorded budget; the raw count is the local reading.',
  'release:readings': 'a pre-tag act by design: it runs the replay, which rewrites the working tree. What CI checks is its recorded output.',
}

/** Every npm script the manifest offers. */
function manifestScripts() {
  return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).scripts
}

/** The parsed workflows keyed by file name. */
function workflows() {
  const dir = join(repoRoot, '.github', 'workflows')
  return readdirSync(dir)
    .filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map(name => ({ name, doc: yaml.load(readFileSync(join(dir, name), 'utf8')) }))
}

/** Every step across jobs, as `{ workflow, job, step }`. */
function steps() {
  const out = []
  for (const { name, doc } of workflows()) {
    for (const [job, spec] of Object.entries(doc.jobs ?? {})) {
      for (const step of spec.steps ?? []) out.push({ workflow: name, job, step })
    }
  }
  return out
}

test('every CI step actually runs something', () => {
  const all = steps()
  assert.ok(all.length >= 20, `read ${all.length} steps across the workflows — the reader is not seeing them`)
  const hollow = all
    .filter(entry => entry.step.run === undefined && entry.step.uses === undefined)
    .map(entry => `${entry.workflow}#${entry.job}: "${entry.step.name ?? '(unnamed)'}"`)
  assert.deepEqual(hollow, [], `steps with a name but neither run: nor uses: — GitHub rejects the whole file:\n  ${hollow.join('\n  ')}`)
})

test('a step never names an npm script the manifest does not offer', () => {
  const offered = manifestScripts()
  const missing = []
  for (const { workflow, job, step } of steps()) {
    if (typeof step.run !== 'string') continue
    for (const match of step.run.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) {
      if (offered[match[1]] === undefined) missing.push(`${workflow}#${job}: npm run ${match[1]}`)
    }
  }
  assert.deepEqual(missing, [], `CI would die on a script that does not exist:\n  ${missing.join('\n  ')}`)
})

test('every check script is either on CI or declared as a maintainer act', () => {
  const inCi = new Set()
  for (const { step } of steps()) {
    if (typeof step.run === 'string') for (const m of step.run.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) inCi.add(m[1])
    if (typeof step.run === 'string') for (const m of step.run.matchAll(/node (?:--[\w=-]+ )*([\w./-]+\.(?:mjs|ts|sh))/g)) inCi.add(m[1])
  }
  const scriptText = name => `${manifestScripts()[name]}`
  const unaccounted = Object.keys(manifestScripts())
    .filter(name => /^(test|verify|lint|release|ci)[:_]/.test(name) || name === 'typecheck')
    .filter(name => !inCi.has(name))
    .filter(name => !inCi.has(scriptText(name).replace(/^node (?:--[\w=-]+ )*/, '')))
    .filter(name => MAINTAINER_ONLY[name] === undefined && RUNS_INSIDE_A_BUCKET[name] === undefined)
  assert.deepEqual(unaccounted, [], `scripts nothing runs and nothing explains:\n  ${unaccounted.join('\n  ')}`)
  const stale = Object.keys(MAINTAINER_ONLY).filter(name => manifestScripts()[name] === undefined)
  assert.deepEqual(stale, [], `MAINTAINER_ONLY declares scripts the manifest no longer offers: ${stale.join(', ')}`)
})

test('the workflow that publishes the package still gates on the two readings', () => {
  const release = workflows().find(entry => entry.name === 'release.yml')
  assert.ok(release !== undefined, 'release.yml disappeared — the readings gate has no home then')
  const body = JSON.stringify(release.doc)
  for (const needed of ['test:contract', 'test:readings', 'install-pinned.mjs']) {
    assert.ok(body.includes(needed), `the publish job no longer runs ${needed}`)
  }
})
