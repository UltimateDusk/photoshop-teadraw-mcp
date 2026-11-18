const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CollabRuntime } = require('./collab-runtime.cjs');

function raw(value) {
  return {
    isError: false,
    content: [{ type: 'text', text: `Custom script executed\nResult: ${JSON.stringify(value)}` }],
  };
}

function snapshot(overrides = {}) {
  return {
    ok: true,
    document_id: 1,
    name: 'test.psd',
    path: 'C:\\Temp\\test.psd',
    width: 800,
    height: 600,
    color_mode: 'DocumentMode.RGB',
    saved: false,
    history: { index: 1, count: 2, name: 'Open' },
    histogram_hash: '10:20',
    active_layer: {
      id: 3,
      name: 'Paint',
      typename: 'ArtLayer',
      kind: 'LayerKind.NORMAL',
      bounds: [100, 100, 200, 200],
    },
    layers: [{
      id: 3,
      name: 'Paint',
      typename: 'ArtLayer',
      kind: 'LayerKind.NORMAL',
      visible: true,
      opacity: 100,
      blend_mode: 'BlendMode.NORMAL',
      bounds: [100, 100, 200, 200],
      text_fingerprint: null,
    }],
    ...overrides,
  };
}

test('revision engine is monotonic, deduplicates snapshots, and infers paint bounds', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-collab-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let current = snapshot();
  const runtime = new CollabRuntime({
    root: directory,
    callTool: async () => raw(current),
  });

  const initial = await runtime.observe(1, false);
  assert.equal(initial.revision, 1);
  assert.equal(initial.change.initial, true);

  const duplicate = await runtime.observe(1, false);
  assert.equal(duplicate.revision, 1);
  assert.equal(duplicate.changed, false);

  current = snapshot({
    history: { index: 2, count: 3, name: 'Brush Tool' },
    histogram_hash: '11:21',
    active_layer: { ...current.active_layer, bounds: [90, 80, 240, 230] },
    layers: [{ ...current.layers[0], bounds: [90, 80, 240, 230] }],
  });
  const painted = await runtime.observe(1, false);
  assert.equal(painted.revision, 2);
  assert.equal(painted.change.change_type, 'paint');
  assert.deepEqual(painted.change.dirty_bounds, { left: 90, top: 80, right: 240, bottom: 230 });

  const conflict = await runtime.beforeMutation(1, 1);
  assert.equal(conflict.ok, false);
  assert.match(conflict.result.content[0].text, /revision_conflict/);

  const timeout = await runtime.waitForCanvasChange({ document_id: 1, since_revision: 2, timeout_seconds: 0, poll_interval_ms: 1 });
  assert.equal(JSON.parse(timeout.content[0].text).timeout, true);
});

test('inactive document state returns a structured suggested next tool', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-collab-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runtime = new CollabRuntime({
    root: directory,
    callTool: async () => raw({
      ok: false,
      code: 'document_not_active',
      message: 'The monitored document is not active',
      active_document_id: 2,
      requested_document_id: 1,
    }),
  });
  const observed = await runtime.observe(1, false);
  assert.equal(observed.error.isError, true);
  const error = JSON.parse(observed.error.content[0].text);
  assert.equal(error.code, 'document_not_active');
  assert.equal(error.suggested_next_tool, 'photoshop_activate_document');
});
