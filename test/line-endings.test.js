import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw result.error
  assert.notEqual(result.status, null, `git ${args.join(' ')} did not run: ${result.stderr}`)
  return result
}

/**
 * Files git would treat as text that contain a carriage return.
 *
 * `git grep` exits 1 when nothing matches, which is the answer this project
 * wants. -I skips binaries, so an image that happens to hold a 0x0D byte is not
 * misreported as a line ending problem.
 */
function carriageReturnFiles(args) {
  const result = git(args)
  if (result.status === 0) return result.stdout.split('\n').filter(Boolean)
  assert.equal(result.status, 1, `git ${args.join(' ')} failed: ${result.stderr.trim()}`)
  return []
}

function listFiles(files) {
  return files.slice(0, 10).join('\n  ') + (files.length > 10 ? `\n  and ${files.length - 10} more` : '')
}

test('no text file stored in the index contains a carriage return', () => {
  // The index, not the working tree. A Windows checkout made before the line
  // ending policy existed still holds CRLF copies of files whose stored bytes
  // are LF, and git calls those unmodified because it normalizes on comparison,
  // so checking the working tree would go red on a state git considers clean.
  // What the policy governs is what a clone receives, and that is what is stored.
  const offenders = carriageReturnFiles(['grep', '-I', '-l', '-F', '-e', '\r', '--cached', '--', '.'])
  assert.deepEqual(
    offenders,
    [],
    `these files store CRLF and would be rewritten on every checkout:\n  ${listFiles(offenders)}\n\n.gitattributes pins LF for this tree, so renormalize with:\n  git add --renormalize .`,
  )
})

test('the line ending policy is declared for the whole tree', () => {
  const declared = git(['show', ':.gitattributes'])
  assert.equal(declared.status, 0, `.gitattributes is not in the index: ${declared.stderr.trim()}`)
  const text = declared.stdout.replace(/\r\n/g, '\n')
  assert.match(text, /^\* text=auto eol=lf$/m, 'every text file must be stored and checked out as LF')
  for (const dir of ['vendor', 'native']) {
    assert.match(
      text,
      new RegExp(`^/${dir}/\\*\\*\\s+text eol=lf$`, 'm'),
      `${dir} is compiled and executed exactly as it is, so its bytes must survive a checkout`,
    )
  }
})

test('a fresh clone checks out LF even where the platform asks for CRLF', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fbc-line-endings-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const clone = join(dir, 'clone')

  // core.autocrlf=true is what a Windows checkout and a Windows CI runner use,
  // and it is what previously wrote 1954 carriage returns into a clone of this
  // repository. The eol=lf attribute has to win over it.
  const cloned = git(['-c', 'core.autocrlf=true', 'clone', '--quiet', ROOT, clone])
  assert.equal(cloned.status, 0, `git clone failed: ${cloned.stderr.trim()}`)

  const paths = git(['-C', clone, 'ls-files', '-z']).stdout.split('\0').filter(Boolean)
  assert.ok(paths.length > 50, `expected the clone to contain the project, found ${paths.length} files`)

  const offenders = []
  for (const path of paths) {
    const bytes = readFileSync(join(clone, path))
    // Git's own binary heuristic: a NUL near the start means binary, and binary
    // formats are marked so they are never converted.
    if (bytes.subarray(0, 8000).includes(0)) continue
    if (bytes.includes(13)) offenders.push(path)
  }
  assert.deepEqual(
    offenders,
    [],
    `a clone on a CRLF platform produced CRLF in ${offenders.length} of ${paths.length} files:\n  ${listFiles(offenders)}`,
  )
})
