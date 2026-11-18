const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { CollabRuntime } = require('./collab-runtime.cjs');

const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoshop-teadraw-exports-'));
const runId = `${Date.now()}-${process.pid}`;
const psdPath = path.join(outputRoot, `photoshop-collab-smoke-${runId}.psd`);
const pngPath = path.join(outputRoot, `photoshop-collab-smoke-${runId}.png`);
const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoshop-collab-runtime-'));

if (!psdPath.startsWith(`${outputRoot}${path.sep}`) || !pngPath.startsWith(`${outputRoot}${path.sep}`)) throw new Error('Unsafe smoke-test output path');

function extractObject(result) {
  for (const item of result?.content || []) {
    if (item.type !== 'text') continue;
    const text = item.text.trim();
    try { return JSON.parse(text); } catch {}
    const marker = text.lastIndexOf('Result:');
    if (marker >= 0) {
      try { return JSON.parse(text.slice(marker + 7).trim()); } catch {}
    }
  }
  return null;
}

function loadBrushScript() {
  const source = fs.readFileSync(path.join(__dirname, 'bridge.cjs'), 'utf8');
  const start = source.indexOf('const finiteIn');
  const end = source.indexOf('function localArguments');
  if (start < 0 || end <= start) throw new Error('Could not locate brush engine in bridge.cjs');
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(`${source.slice(start, end)}\nmodule.exports = { brushScript };`, sandbox, { filename: 'bridge-brush-engine.cjs' });
  return sandbox.module.exports.brushScript;
}

const child = spawn('cmd.exe', ['/d', '/s', '/c', 'npx -y @alisaitteke/photoshop-mcp@1.7.38'], {
  windowsHide: true,
  env: { ...process.env, ANALYTICS_DISABLED: '1', PSMCP_FEEDBACK: '0', PSMCP_UPDATE_CHECK: '0' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let sequence = 0;
let buffer = '';
const pending = new Map();
child.stdout.on('data', data => {
  buffer += data;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    try {
      const response = JSON.parse(line);
      const waiting = pending.get(response.id);
      if (waiting) {
        pending.delete(response.id);
        waiting.resolve(response);
      }
    } catch {}
  }
});
child.on('exit', () => {
  for (const waiting of pending.values()) waiting.reject(new Error('Local MCP stopped'));
  pending.clear();
});

function request(method, params, timeout = 130000) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP request timed out: ${method}`));
    }, timeout);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

async function callTool(name, args, timeout = 130000) {
  const rpc = await request('tools/call', { name, arguments: args }, timeout);
  return rpc.result || { isError: true, content: [{ type: 'text', text: 'No local result' }] };
}

function requireSuccess(result, label) {
  if (result?.isError) throw new Error(`${label}: ${(result.content || []).map(item => item.text || '').join('\n')}`);
  return extractObject(result);
}

let originalDocumentId = null;
let temporaryDocumentId = null;
const report = {};

(async () => {
  const initialized = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'photoshop-collab-smoke', version: '0.3.0' },
  });
  if (initialized.error) throw new Error('MCP initialization failed');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  requireSuccess(await callTool('photoshop_ping', {}), 'ping');

  const initialDocuments = requireSuccess(await callTool('photoshop_list_documents', {}), 'initial list');
  originalDocumentId = initialDocuments?.details?.active_document_id ?? initialDocuments?.details?.documents?.find(item => item.is_active)?.id ?? null;

  requireSuccess(await callTool('photoshop_create_document', {
    width: 640,
    height: 480,
    resolution: 72,
    colorMode: 'RGB',
  }), 'create temporary document');
  const state = requireSuccess(await callTool('photoshop_get_state', { document_id: 0 }), 'temporary state');
  temporaryDocumentId = state.document.id;
  assert.notEqual(temporaryDocumentId, originalDocumentId);
  requireSuccess(await callTool('photoshop_create_layer', { document_id: temporaryDocumentId, name: 'ChatGPT Paint' }), 'create paint layer');

  const runtime = new CollabRuntime({ root: runtimeRoot, callTool });
  const baseline = await runtime.observe(temporaryDocumentId, false);
  assert.equal(baseline.error, undefined);
  report.initial_revision = baseline.revision;

  const brushScript = loadBrushScript();
  const paint = await callTool('photoshop_execute_script', brushScript({
    document_id: temporaryDocumentId,
    red: 40,
    green: 120,
    blue: 230,
    size: 52,
    hardness: 72,
    opacity: 68,
    flow: 82,
    spacing: 22,
    smoothing: 25,
    roundness: 78,
    strokes: [{ points: [
      { x: 70, y: 110, pressure: 0.35 },
      { x: 180, y: 170, pressure: 0.75 },
      { x: 330, y: 130, pressure: 1 },
      { x: 520, y: 300, pressure: 0.5 },
    ] }],
  }, false));
  const paintValue = requireSuccess(paint, 'enhanced brush');
  assert.equal(paintValue.verified_pixels, true);
  assert.equal(paintValue.opacity, 68);
  report.paint = { verified_pixels: paintValue.verified_pixels, bounds: paintValue.after_bounds };

  const erased = await callTool('photoshop_execute_script', brushScript({
    document_id: temporaryDocumentId,
    size: 34,
    hardness: 85,
    opacity: 100,
    flow: 100,
    spacing: 25,
    smoothing: 10,
    roundness: 100,
    strokes: [{ points: [{ x: 210, y: 165 }, { x: 360, y: 175 }] }],
  }, true));
  const eraseValue = requireSuccess(erased, 'erase strokes');
  assert.equal(eraseValue.erase_mode, true);
  assert.equal(eraseValue.verified_pixels, true);
  report.erase = { verified_pixels: eraseValue.verified_pixels, histogram_changed: eraseValue.histogram_changed };

  const changed = await runtime.observe(temporaryDocumentId, false);
  assert(changed.revision > baseline.revision);
  report.paint_revision = changed.revision;

  const region = await runtime.getRegionPreview({
    document_id: temporaryDocumentId,
    left: 40,
    top: 70,
    right: 580,
    bottom: 350,
    max_dimension_px: 600,
    quality: 7,
  });
  requireSuccess(region, 'region preview');
  assert(region.content.some(item => item.type === 'image' && item.data.length > 100));
  report.region_preview = true;

  requireSuccess(await runtime.createGroup({ document_id: temporaryDocumentId, group_name: 'AI' }), 'create group');
  requireSuccess(await runtime.createText({
    document_id: temporaryDocumentId,
    text: '共同绘画',
    x: 90,
    y: 90,
    font_size: 30,
    alignment: 'LEFT',
    red: 250,
    green: 80,
    blue: 90,
    opacity: 88,
    layer_name: 'Collab Text',
  }), 'create text');
  const editedText = requireSuccess(await runtime.editText({
    document_id: temporaryDocumentId,
    layer_name: 'Collab Text',
    text: 'User × AI',
    x: 120,
    y: 105,
    font_size: 34,
    alignment: 'CENTER',
    red: 255,
    green: 190,
    blue: 40,
    opacity: 92,
    new_layer_name: 'Collab Text Edited',
  }), 'edit text');
  assert.equal(editedText.layer.name, 'Collab Text Edited');
  requireSuccess(await callTool('photoshop_create_layer', { document_id: temporaryDocumentId, name: 'Move Me' }), 'create move layer');
  const moved = requireSuccess(await runtime.moveLayerIntoGroup({ document_id: temporaryDocumentId, layer_name: 'Move Me', group_name: 'AI' }), 'move layer into group');
  assert.equal(moved.verified_parent, 'AI');
  const deleted = requireSuccess(await runtime.deleteLayer({ document_id: temporaryDocumentId, layer_name: 'Collab Text Edited' }), 'delete text layer');
  assert.equal(deleted.verified_absent, true);
  report.layers_and_text = true;

  requireSuccess(await runtime.resizeCanvas({ document_id: temporaryDocumentId, width: 700, height: 520, anchor: 'center' }), 'resize canvas');
  requireSuccess(await callTool('photoshop_resize_image', { document_id: temporaryDocumentId, width: 350, height: 260 }), 'resize image');
  requireSuccess(await runtime.crop({ document_id: temporaryDocumentId, left: 10, top: 10, right: 330, bottom: 240 }), 'crop');
  const rotated = requireSuccess(await runtime.rotateCanvas({ document_id: temporaryDocumentId, degrees: 90 }), 'rotate canvas');
  assert.equal(Math.round(rotated.after.width), 230);
  assert.equal(Math.round(rotated.after.height), 320);
  report.canvas_operations = rotated.after;

  const preSave = await runtime.observe(temporaryDocumentId, false);
  const conflict = await runtime.beforeMutation(temporaryDocumentId, preSave.revision - 1);
  assert.equal(conflict.ok, false);
  assert.equal(extractObject(conflict.result).code, 'revision_conflict');
  report.revision_conflict = true;

  const sessionStarted = requireSuccess(await runtime.startSession({
    document_id: temporaryDocumentId,
    assistant_layer_or_group: 'AI',
    user_layer_or_group: 'User',
  }), 'start session');
  const sessionId = sessionStarted.session.session_id;
  requireSuccess(await runtime.endSession({ document_id: temporaryDocumentId, session_id: sessionId }), 'end session');
  report.collab_session = true;

  const savedAs = requireSuccess(await runtime.saveAs({
    document_id: temporaryDocumentId,
    path: psdPath,
    format: 'PSD',
    quality: 8,
    overwrite: false,
  }), 'save as PSD');
  assert(savedAs.verified_file_bytes > 0);
  requireSuccess(await runtime.save({ document_id: temporaryDocumentId }), 'save current');
  const exported = requireSuccess(await runtime.exportFile({
    document_id: temporaryDocumentId,
    path: pngPath,
    format: 'PNG',
    quality: 90,
    overwrite: false,
  }), 'export PNG');
  assert(exported.verified_file_bytes > 0);
  report.files = { psd_bytes: savedAs.verified_file_bytes, png_bytes: exported.verified_file_bytes };

  const documents = requireSuccess(await runtime.listDocuments(), 'document list');
  assert(documents.documents.some(item => item.id === temporaryDocumentId && item.path === psdPath));
  report.document_management = true;

  const beforeRename = await runtime.observe(temporaryDocumentId, false);
  requireSuccess(await callTool('photoshop_rename_layer', { document_id: temporaryDocumentId, name: 'Change Trigger' }), 'change trigger');
  const waited = requireSuccess(await runtime.waitForCanvasChange({
    document_id: temporaryDocumentId,
    since_revision: beforeRename.revision,
    timeout_seconds: 1,
    poll_interval_ms: 100,
  }), 'wait for canvas change');
  assert.equal(waited.changed, true);
  assert(waited.revision > beforeRename.revision);
  report.wait_change = { revision: waited.revision, change_type: waited.change_type, dirty_bounds: waited.dirty_bounds };

  const quiet = requireSuccess(await runtime.waitForCanvasChange({
    document_id: temporaryDocumentId,
    since_revision: waited.revision,
    timeout_seconds: 1,
    poll_interval_ms: 200,
  }), 'wait timeout');
  assert.equal(quiet.timeout, true);
  report.wait_timeout = true;

  requireSuccess(await runtime.closeDocument({ document_id: temporaryDocumentId, save_changes: false }), 'close temporary document');
  temporaryDocumentId = null;
  if (originalDocumentId) requireSuccess(await callTool('photoshop_set_active_document', { document_id: originalDocumentId }), 'restore original document');

  console.log(JSON.stringify({ ok: true, report }, null, 2));
})().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
}).finally(async () => {
  try {
    if (temporaryDocumentId) await callTool('photoshop_close_document', { document_id: temporaryDocumentId, save: false }, 30000);
  } catch {}
  try {
    if (originalDocumentId) await callTool('photoshop_set_active_document', { document_id: originalDocumentId }, 30000);
  } catch {}
  for (const file of [psdPath, pngPath]) {
    try {
      const resolved = path.resolve(file);
      if (resolved.startsWith(`${outputRoot}${path.sep}`) && fs.existsSync(resolved)) fs.unlinkSync(resolved);
    } catch {}
  }
  try { fs.rmSync(runtimeRoot, { recursive: true, force: true }); } catch {}
  try { fs.rmdirSync(outputRoot); } catch {}
  child.stdin.end();
  child.kill();
});
