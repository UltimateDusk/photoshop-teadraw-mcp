import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker/index.js';

class Bucket {
  items = new Map();
  async get(key) {
    const value = this.items.get(key);
    return value ? { json: async () => JSON.parse(value.value) } : null;
  }
  async put(key, value) {
    this.items.set(key, { value, uploaded: new Date() });
  }
  async delete(key) {
    this.items.delete(key);
  }
  async list({ prefix }) {
    return {
      objects: [...this.items]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, uploaded: value.uploaded })),
    };
  }
}

const call = (bucket, method, params) => worker.fetch(new Request('https://example.com/mcp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
}), { BUCKET: bucket }).then(response => response.json());

const bridge = (bucket, route, body = {}) => worker.fetch(new Request(`https://example.com${route}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}), { BUCKET: bucket });

test('curated collaboration toolbox is exposed without arbitrary script or file-open tools', async () => {
  const bucket = new Bucket();
  const listed = await call(bucket, 'tools/list', {});
  const names = listed.result.tools.map(item => item.name);
  assert.equal(names.length, 49);
  for (const expected of [
    'photoshop_draw_brush_strokes', 'photoshop_erase_strokes', 'photoshop_wait_for_canvas_change',
    'photoshop_get_region_preview', 'photoshop_save', 'photoshop_save_as', 'photoshop_export',
    'photoshop_list_documents', 'photoshop_activate_document', 'photoshop_create_text_layer',
    'photoshop_delete_layer', 'photoshop_create_group', 'photoshop_resize_canvas',
    'photoshop_start_collab_session',
  ]) assert(names.includes(expected));
  for (const forbidden of ['photoshop_execute_script', 'photoshop_open_image', 'photoshop_save_document']) assert(!names.includes(forbidden));
  assert.equal(listed.result.tools.find(item => item.name === 'photoshop_get_state').annotations.readOnlyHint, true);
  const brush = listed.result.tools.find(item => item.name === 'photoshop_draw_brush_strokes');
  assert.equal(brush.annotations.destructiveHint, true);
  assert.match(brush.description, /native pixel fill/);
  assert(brush.inputSchema.properties.opacity);
  assert(brush.inputSchema.properties.flow);
  assert(brush.inputSchema.properties.strokes.items.properties.points.items.properties.pressure);
  const saveAs = listed.result.tools.find(item => item.name === 'photoshop_save_as');
  assert(saveAs.inputSchema.required.includes('overwrite'));
  assert.deepEqual(saveAs.inputSchema.properties.format.enum, ['PSD', 'PNG', 'JPG']);
});

test('editing tools require an exact document id and reject extra input', async () => {
  const bucket = new Bucket();
  const missing = await call(bucket, 'tools/call', {
    name: 'photoshop_fill_layer',
    arguments: { red: 1, green: 2, blue: 3 },
  });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /document_id is required/);
  const extra = await call(bucket, 'tools/call', {
    name: 'photoshop_create_layer',
    arguments: { document_id: 42, name: 'Paint', code: 'malicious' },
  });
  assert.equal(extra.result.isError, true);
  assert.match(extra.result.content[0].text, /code is not allowed/);
  assert.equal(bucket.items.size, 0);
});

test('brush paths enforce bounded nested input', async () => {
  const bucket = new Bucket();
  const invalid = await call(bucket, 'tools/call', {
    name: 'photoshop_draw_brush_strokes',
    arguments: {
      document_id: 7,
      red: 0,
      green: 0,
      blue: 0,
      size: 20,
      hardness: 100,
      strokes: [{ points: [{ x: 1, y: 1 }] }],
    },
  });
  assert.equal(invalid.result.isError, true);
  assert.match(invalid.result.content[0].text, /too few items/);
});

test('revision cursors and explicit overwrite flags are validated before queuing', async () => {
  const bucket = new Bucket();
  const invalidRevision = await call(bucket, 'tools/call', {
    name: 'photoshop_fill_layer',
    arguments: { document_id: 7, red: 1, green: 2, blue: 3, expected_revision: -1 },
  });
  assert.equal(invalidRevision.result.isError, true);
  assert.match(invalidRevision.result.content[0].text, /below the minimum/);

  const missingOverwrite = await call(bucket, 'tools/call', {
    name: 'photoshop_save_as',
    arguments: { document_id: 7, path: 'C:\\Temp\\x.psd', format: 'PSD' },
  });
  assert.equal(missingOverwrite.result.isError, true);
  assert.match(missingOverwrite.result.content[0].text, /overwrite is required/);
  assert.equal(bucket.items.size, 0);
});

test('offline is explicit and does not create jobs', async () => {
  const bucket = new Bucket();
  const result = await call(bucket, 'tools/call', { name: 'photoshop_ping', arguments: {} });
  assert.equal(result.result.isError, true);
  assert.equal(bucket.items.size, 0);
});

test('job relay preserves validated arguments, returns image, and removes temporary state', async () => {
  const bucket = new Bucket();
  await bucket.put('heartbeat', JSON.stringify({ at: Date.now() }));
  const pending = call(bucket, 'tools/call', {
    name: 'photoshop_get_preview',
    arguments: { document_id: 17, max_dimension_px: 900, quality: 8 },
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  const poll = await bridge(bucket, '/bridge/poll');
  const job = await poll.json();
  assert.equal(job.name, 'photoshop_get_preview');
  assert.deepEqual(job.arguments, { document_id: 17, max_dimension_px: 900, quality: 8 });
  await bridge(bucket, '/bridge/result', {
    id: job.id,
    result: { content: [{ type: 'image', mimeType: 'image/jpeg', data: 'test' }] },
  });
  assert.equal((await pending).result.content[0].type, 'image');
  assert.equal(bucket.items.size, 1);
});

test('initialization advertises the Photoshop name and current server version', async () => {
  const bucket = new Bucket();
  const initialized = await call(bucket, 'initialize', { protocolVersion: '2024-11-05' });
  assert.equal(initialized.result.serverInfo.name, 'photoshop');
  assert.equal(initialized.result.serverInfo.version, '0.3.0');
});
