/**
 * A BYOA agent must be able to tell that a message carried a file.
 *
 * A user sent a 626KB zip and asked "这个能看到么". The agent answered, truthfully,
 * that it saw only the text — the attachment was in `messages.attachment`, was
 * selected by `loadInbox`, and reached the daemon, and then `snapshotUnread`
 * built each digest line from `row.body` alone. `daemon.ts` contained no
 * reference to `attachment` at all. The cloud path (turn.ts) always surfaced
 * them; only the BYOA path dropped them.
 *
 * The URL rendering alone is not enough: the secure engine's sandbox
 * allowlist is empty and WebFetch is denied, so the agent can never fetch
 * the CDN URL the digest hands it. The daemon must stage the file into the
 * agent home and render the local path instead (issue #350).
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-attachment-visibility.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'

const { attachmentNote, materializeInboxAttachment, sanitizeAttachmentFilename } = await import('../agents/computer/daemon.js')

/** Stub fetch returning `bytes` as a real Response body. */
function stubFetch(bytes: Uint8Array, status = 200) {
  let calls = 0
  const fn = (async () => {
    calls++
    return new Response(bytes, { status, headers: { 'content-length': String(bytes.length) } })
  }) as unknown as typeof fetch
  return { fn, calls: () => calls }
}

test('the reported zip is now visible to the agent', () => {
  const note = attachmentNote({
    name: 'talking-head-visual-director-v1.0.zip',
    kind: 'file',
    mime: 'application/zip',
    size: 626 * 1024,
    url: 'https://cdn.cumora.ai/a/abc?sig=1',
  })
  assert.match(note, /talking-head-visual-director-v1\.0\.zip/)
  assert.match(note, /application\/zip/)
  assert.match(note, /626KB/)
  // The agent has to be able to actually fetch it, not just know it exists.
  assert.match(note, /https:\/\/cdn\.cumora\.ai\/a\/abc\?sig=1/)
})

test('a message with no attachment gains nothing', () => {
  assert.equal(attachmentNote(null), '')
  assert.equal(attachmentNote(undefined), '')
  assert.equal(attachmentNote({}), '  [attachment: file]')
})

test('megabyte sizes read as megabytes', () => {
  assert.match(attachmentNote({ name: 'a.mov', size: 5 * 1024 * 1024 }), /5\.0MB/)
  // Never report a real file as "0KB".
  assert.match(attachmentNote({ name: 'tiny.txt', size: 12 }), /1KB/)
})

test('hostile fields cannot run away with the digest line', () => {
  const note = attachmentNote({
    name: 'x'.repeat(5000),
    mime: 'y'.repeat(5000),
    size: Number.NaN,
    // Not http(s): must not be offered to the agent as something to fetch.
    url: 'file:///etc/passwd',
  })
  assert.ok(note.length < 260, `digest line must stay bounded, got ${note.length}`)
  assert.equal(note.includes('file:///etc/passwd'), false, 'only http(s) urls are surfaced')
  assert.equal(note.includes('NaN'), false)
})

test('a staged attachment renders its local path, not the URL', () => {
  const note = attachmentNote({
    name: 'data.csv',
    kind: 'file',
    mime: 'text/csv',
    size: 12 * 1024,
    url: 'https://cdn.cumora.ai/a/abc?sig=1',
    localPath: 'attachments/m-1/data.csv',
  })
  assert.match(note, /attachments\/m-1\/data\.csv/)
  assert.equal(note.includes('cdn.cumora.ai'), false, 'the sandboxed agent must not be handed a URL it can never fetch')
})

test('a failed download renders the failure, not the URL', () => {
  const note = attachmentNote({
    name: 'data.csv',
    mime: 'text/csv',
    size: 12 * 1024,
    url: 'https://cdn.cumora.ai/a/abc?sig=1',
    downloadError: 'timed out',
  })
  assert.match(note, /download failed: timed out/)
  assert.equal(note.includes('cdn.cumora.ai'), false)
})

test('hostile filenames are reduced to a safe basename', () => {
  assert.equal(sanitizeAttachmentFilename('../../etc/passwd'), 'passwd')
  assert.equal(sanitizeAttachmentFilename('a/b/c.txt'), 'c.txt')
  assert.equal(sanitizeAttachmentFilename('C:\\Windows\\evil.exe'), 'evil.exe')
  assert.equal(sanitizeAttachmentFilename(''), 'file')
  assert.equal(sanitizeAttachmentFilename(undefined), 'file')
  assert.equal(sanitizeAttachmentFilename('x'.repeat(500)), 'x'.repeat(120))
})

test('materialize stages the file under home/attachments/<messageId>/', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'cumora-attach-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const bytes = new TextEncoder().encode('a,b\n1,2\n')
  const { fn } = stubFetch(bytes)
  const result = await materializeInboxAttachment(home, 'm-1', {
    name: 'data.csv', mime: 'text/csv', size: bytes.length, url: 'https://cdn.cumora.ai/a/abc?sig=1',
  }, fn)
  assert.deepEqual(result, { ok: true, relativePath: 'attachments/m-1/data.csv', bytes: bytes.length })
  assert.deepEqual(await readFile(join(home, 'attachments', 'm-1', 'data.csv')), Buffer.from(bytes))
})

test('materialize neutralizes a hostile filename', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'cumora-attach-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const { fn } = stubFetch(new TextEncoder().encode('x'))
  const result = await materializeInboxAttachment(home, 'm-1', {
    name: '../../evil.txt', size: 1, url: 'https://cdn.cumora.ai/a/abc?sig=1',
  }, fn)
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.relativePath, 'attachments/m-1/evil.txt')
  await assert.rejects(stat(join(home, 'evil.txt')))
  await assert.rejects(stat(join(tmpdir(), 'evil.txt')))
})

test('materialize refuses an oversized file without fetching', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'cumora-attach-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const { fn, calls } = stubFetch(new TextEncoder().encode('x'))
  const result = await materializeInboxAttachment(home, 'm-1', {
    name: 'big.bin', size: 26 * 1024 * 1024, url: 'https://cdn.cumora.ai/a/abc?sig=1',
  }, fn)
  assert.deepEqual(result, { ok: false, reason: 'file too large' })
  assert.equal(calls(), 0)
})

test('materialize aborts a body that grows past the cap', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'cumora-attach-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  // Declared size is small, but the body keeps coming: the streaming cap
  // must stop it. Fake reader, no 26MB allocation.
  let sent = 0
  const lyingFetch = (async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          if (sent >= 26) return { done: true, value: undefined }
          sent++
          return { done: false, value: new Uint8Array(1024 * 1024) }
        },
        releaseLock: () => {},
        cancel: async () => {},
      }),
    },
  })) as unknown as typeof fetch
  const result = await materializeInboxAttachment(home, 'm-1', {
    name: 'big.bin', size: 1024, url: 'https://cdn.cumora.ai/a/abc?sig=1',
  }, lyingFetch)
  assert.deepEqual(result, { ok: false, reason: 'file too large' })
  await assert.rejects(stat(join(home, 'attachments', 'm-1', 'big.bin')), 'no partial file is left behind')
})

test('materialize reports download failures without staging anything', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'cumora-attach-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const { fn } = stubFetch(new TextEncoder().encode(''), 403)
  const result = await materializeInboxAttachment(home, 'm-1', {
    name: 'data.csv', size: 12, url: 'https://cdn.cumora.ai/a/abc?sig=1',
  }, fn)
  assert.deepEqual(result, { ok: false, reason: 'HTTP 403' })
  await assert.rejects(stat(join(home, 'attachments', 'm-1', 'data.csv')))
  assert.deepEqual(await materializeInboxAttachment(home, 'm-1', {
    name: 'data.csv', size: 12, url: 'file:///etc/passwd',
  }, fn), { ok: false, reason: 'no downloadable url' })
  assert.deepEqual(await materializeInboxAttachment(home, '../../etc', {
    name: 'data.csv', size: 12, url: 'https://cdn.cumora.ai/a/abc?sig=1',
  }, fn), { ok: false, reason: 'invalid message id' })
})

test('materialize is idempotent: a staged file is not re-downloaded', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'cumora-attach-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const bytes = new TextEncoder().encode('hello')
  const { fn, calls } = stubFetch(bytes)
  const att = { name: 'a.txt', size: bytes.length, url: 'https://cdn.cumora.ai/a/abc?sig=1' }
  assert.equal((await materializeInboxAttachment(home, 'm-1', att, fn)).ok, true)
  const second = await materializeInboxAttachment(home, 'm-1', att, fn)
  assert.equal(second.ok, true)
  assert.equal(calls(), 1, 'second call reuses the staged file')
})
