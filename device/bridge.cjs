const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const {
  CollabRuntime,
  EXTRA_TOOL_NAMES,
  MUTATING_TOOL_NAMES,
} = require('./collab-runtime.cjs');

const root = __dirname;
const secretFile = path.join(root, 'device-credential.dpapi');
const decrypt = `$s=Get-Content -LiteralPath '${secretFile.replace(/'/g, "''")}' -Raw;$s=ConvertTo-SecureString ($s.Trim());$b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);try{[Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)}`;
const config = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', decrypt], {
  encoding: 'utf8',
  windowsHide: true,
  env: { ...process.env, PSModulePath: 'C:/Windows/System32/WindowsPowerShell/v1.0/Modules' },
}));
const origin = new URL(config.url);
const expectedHostname = typeof config.expected_hostname === 'string' ? config.expected_hostname.trim().toLowerCase() : origin.hostname.toLowerCase();
if (origin.protocol !== 'https:' || origin.hostname.toLowerCase() !== expectedHostname) throw Error('Unexpected service origin');
if (typeof config.token !== 'string' || config.token.length < 16) throw Error('Missing or invalid device credential');

const lock = path.join(root, 'bridge.pid');
if (fs.existsSync(lock)) {
  const pid = Number(fs.readFileSync(lock, 'utf8'));
  try {
    process.kill(pid, 0);
    console.error('Bridge is already running.');
    process.exit(1);
  } catch {}
}
fs.writeFileSync(lock, String(process.pid));
const stopFile = path.join(root, 'stop.request');
if (fs.existsSync(stopFile)) fs.unlinkSync(stopFile);

let child = null;
let sequence = 0;
let buffer = '';
const pending = new Map();
let closing = false;
const log = message => fs.appendFileSync(path.join(root, 'bridge.log'), `${new Date().toISOString()} ${message}\n`);

function finish() {
  if (closing) return;
  closing = true;
  if (child) {
    child.stdin.end();
    child.kill();
  }
  try { fs.unlinkSync(lock); } catch {}
  process.exit(0);
}
process.on('SIGINT', finish);
process.on('SIGTERM', finish);

function request(method, params, timeout = 65000) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error('Photoshop request timed out'));
    }, timeout);
    pending.set(id, {
      resolve: response => {
        clearTimeout(timer);
        resolve(response);
      },
      reject,
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

async function boot() {
  child = spawn('cmd.exe', ['/d', '/s', '/c', 'npx -y @alisaitteke/photoshop-mcp@1.7.38'], {
    windowsHide: true,
    env: { ...process.env, ANALYTICS_DISABLED: '1', PSMCP_FEEDBACK: '0', PSMCP_UPDATE_CHECK: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
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
  child.stderr.on('data', data => {
    const line = String(data).trim();
    if (line) log(`Local MCP: ${line.slice(0, 500)}`);
  });
  child.on('exit', () => {
    child = null;
    for (const item of pending.values()) item.reject(Error('MCP stopped'));
    pending.clear();
  });
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'photoshop-private-bridge', version: '0.3.0' },
  }, 120000);
  if (init.error) throw Error('MCP initialization failed');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  log('Local MCP ready; curated read and editing tools enabled');
}

const allowed = new Set([
  'photoshop_ping',
  'photoshop_get_state',
  'photoshop_get_preview',
  'photoshop_get_layers',
  'photoshop_get_history',
  'photoshop_create_document',
  'photoshop_create_layer',
  'photoshop_duplicate_layer',
  'photoshop_select_layer_by_name',
  'photoshop_rename_layer',
  'photoshop_set_layer_opacity',
  'photoshop_set_layer_blend_mode',
  'photoshop_set_layer_visibility',
  'photoshop_select_rectangle',
  'photoshop_select_ellipse',
  'photoshop_select_all',
  'photoshop_deselect',
  'photoshop_invert_selection',
  'photoshop_feather_selection',
  'photoshop_expand_selection',
  'photoshop_contract_selection',
  'photoshop_fill_layer',
  'photoshop_fill_gradient',
  'photoshop_draw_brush_strokes',
  'photoshop_move_layer',
  'photoshop_scale_layer',
  'photoshop_rotate_layer',
  'photoshop_undo',
  'photoshop_redo',
  ...EXTRA_TOOL_NAMES,
]);

const finiteIn = (value, minimum, maximum) => typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;

function normalizeBrushArguments(value, erase = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid brush arguments');
  if (!Number.isInteger(value.document_id) || value.document_id < 1) throw Error('A positive document_id is required');
  if (!erase) for (const channel of ['red', 'green', 'blue']) if (!finiteIn(value[channel], 0, 255)) throw Error(`Invalid ${channel} channel`);
  if (!finiteIn(value.size, 1, 1000)) throw Error('Invalid brush size');
  if (!finiteIn(value.hardness, 0, 100)) throw Error('Invalid brush hardness');
  const opacity = value.opacity ?? 100;
  const flow = value.flow ?? 100;
  const spacing = value.spacing ?? 25;
  const smoothing = value.smoothing ?? 0;
  const roundness = value.roundness ?? 100;
  if (!finiteIn(opacity, 0.1, 100)) throw Error('Invalid brush opacity');
  if (!finiteIn(flow, 0.1, 100)) throw Error('Invalid brush flow');
  if (!finiteIn(spacing, 5, 500)) throw Error('Invalid brush spacing');
  if (!finiteIn(smoothing, 0, 100)) throw Error('Invalid brush smoothing');
  if (!finiteIn(roundness, 1, 100)) throw Error('Invalid brush roundness');
  if (!Array.isArray(value.strokes) || value.strokes.length < 1 || value.strokes.length > 32) throw Error('Invalid brush stroke count');
  let totalPoints = 0;
  const strokes = value.strokes.map(stroke => {
    if (!stroke || !Array.isArray(stroke.points) || stroke.points.length < 2 || stroke.points.length > 256) throw Error('Each stroke needs 2-256 points');
    totalPoints += stroke.points.length;
    if (totalPoints > 4096) throw Error('Too many brush points');
    return {
      points: stroke.points.map(point => {
        if (!point || !finiteIn(point.x, -100000, 100000) || !finiteIn(point.y, -100000, 100000)) throw Error('Invalid brush point');
        if (point.pressure !== undefined && !finiteIn(point.pressure, 0.01, 1)) throw Error('Invalid point pressure');
        return {
          x: Number(point.x),
          y: Number(point.y),
          ...(point.pressure === undefined ? {} : { pressure: Number(point.pressure) }),
        };
      }),
    };
  });
  return {
    document_id: value.document_id,
    red: erase ? 0 : Number(value.red),
    green: erase ? 0 : Number(value.green),
    blue: erase ? 0 : Number(value.blue),
    size: Number(value.size),
    hardness: Number(value.hardness),
    opacity: Number(opacity),
    flow: Number(flow),
    spacing: Number(spacing),
    smoothing: Number(smoothing),
    roundness: Number(roundness),
    simulate_pressure: value.simulate_pressure === true,
    use_current_brush_preset: value.use_current_brush_preset === true,
    erase,
    strokes,
  };
}

function brushScript(argumentsValue, erase = false) {
  const configValue = normalizeBrushArguments(argumentsValue, erase);
  const configJson = JSON.stringify({
    red: configValue.red,
    green: configValue.green,
    blue: configValue.blue,
    size: configValue.size,
    hardness: configValue.hardness,
    opacity: configValue.opacity,
    flow: configValue.flow,
    spacing: configValue.spacing,
    smoothing: configValue.smoothing,
    roundness: configValue.roundness,
    simulatePressure: configValue.simulate_pressure,
    useCurrentBrushPreset: configValue.use_current_brush_preset,
    erase: configValue.erase,
    strokes: configValue.strokes,
  });
  return {
    document_id: configValue.document_id,
    timeout_ms: 60000,
    code: `
var cfg = ${configJson};
if (app.documents.length === 0) throw new Error('No active Photoshop document');
var doc = app.activeDocument;
var layer = doc.activeLayer;
if (!layer || layer.typename !== 'ArtLayer' || layer.kind !== LayerKind.NORMAL) throw new Error('Select a normal pixel layer before drawing');
if (layer.allLocked || layer.pixelsLocked || layer.transparentPixelsLocked) throw new Error('The active pixel layer is locked');
if (!layer.visible || layer.opacity <= 0) throw new Error('The active pixel layer must be visible with opacity above zero');
function px(value) {
  try { return value.as('px'); } catch (error) { return Number(value); }
}
function layerBounds(target) {
  try {
    var bounds = target.bounds;
    return [px(bounds[0]), px(bounds[1]), px(bounds[2]), px(bounds[3])];
  } catch (error) { return [0, 0, 0, 0]; }
}
function hasPixels(bounds) {
  return bounds[2] > bounds[0] && bounds[3] > bounds[1];
}
function histogramHash(targetDocument) {
  var first = 0;
  var second = 0;
  try {
    var histogram = targetDocument.histogram;
    for (var histogramIndex = 0; histogramIndex < histogram.length; histogramIndex += 1) {
      var value = Number(histogram[histogramIndex]);
      first = (first + ((histogramIndex + 1) * (value % 2147483647))) % 2147483647;
      second = (second + ((histogramIndex + 17) * (histogramIndex + 31) * (value % 2147483629))) % 2147483629;
    }
  } catch (histogramError) {}
  return String(first) + ':' + String(second);
}
function cleanPoints(source) {
  var clean = [];
  for (var index = 0; index < source.length; index += 1) {
    var point = source[index];
    if (!clean.length || clean[clean.length - 1].x !== point.x || clean[clean.length - 1].y !== point.y) clean.push(point);
  }
  return clean;
}
function smoothPoints(source, amount) {
  var points = cleanPoints(source);
  if (amount <= 0 || points.length < 3) return points;
  var factor = Math.min(0.95, amount / 105);
  var output = [points[0]];
  for (var index = 1; index < points.length - 1; index += 1) {
    var previous = output[output.length - 1];
    var current = points[index];
    output.push({
      x: current.x * (1 - factor) + previous.x * factor,
      y: current.y * (1 - factor) + previous.y * factor,
      pressure: current.pressure
    });
  }
  output.push(points[points.length - 1]);
  return output;
}
function resamplePoints(source, step) {
  if (source.length < 2 || step <= 0) return source;
  var output = [source[0]];
  for (var index = 0; index < source.length - 1; index += 1) {
    var from = source[index];
    var to = source[index + 1];
    var dx = to.x - from.x;
    var dy = to.y - from.y;
    var distance = Math.sqrt(dx * dx + dy * dy);
    var count = Math.max(1, Math.ceil(distance / step));
    for (var segment = 1; segment <= count; segment += 1) {
      var ratio = segment / count;
      var hasPressure = from.pressure !== undefined || to.pressure !== undefined;
      var fromPressure = from.pressure === undefined ? 1 : from.pressure;
      var toPressure = to.pressure === undefined ? fromPressure : to.pressure;
      var sampled = {
        x: from.x + dx * ratio,
        y: from.y + dy * ratio
      };
      if (hasPressure) sampled.pressure = fromPressure + (toPressure - fromPressure) * ratio;
      output.push(sampled);
      if (output.length > 4096) throw new Error('Brush spacing generated too many outline points; increase spacing or split the stroke');
    }
  }
  return output;
}
function unitTangent(from, to) {
  var dx = to.x - from.x;
  var dy = to.y - from.y;
  var length = Math.sqrt(dx * dx + dy * dy);
  if (length < 0.0001) return null;
  return { x: dx / length, y: dy / length };
}
function strokeOutline(source, diameter, taper, spacing, smoothing, roundness) {
  var smoothed = smoothPoints(source, smoothing);
  var points = resamplePoints(smoothed, Math.max(0.5, diameter * spacing / 100));
  if (points.length < 2) throw new Error('A brush stroke collapsed to fewer than two distinct points');
  var tangents = [];
  for (var tangentIndex = 0; tangentIndex < points.length - 1; tangentIndex += 1) {
    var tangent = unitTangent(points[tangentIndex], points[tangentIndex + 1]);
    if (!tangent) throw new Error('A brush stroke contains an invalid segment');
    tangents.push(tangent);
  }
  var left = [];
  var right = [];
  for (var pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
    var progress = pointIndex / (points.length - 1);
    var explicitPressure = points[pointIndex].pressure === undefined ? 1 : points[pointIndex].pressure;
    var pressure = explicitPressure;
    if (taper && points[pointIndex].pressure === undefined) pressure = 0.15 + 0.85 * Math.sin(Math.PI * progress);
    var radius = diameter * 0.5 * pressure;
    var tx;
    var ty;
    var nx;
    var ny;
    var scale = radius;
    if (pointIndex === 0) {
      tx = tangents[0].x;
      ty = tangents[0].y;
      nx = -ty;
      ny = tx;
    } else if (pointIndex === points.length - 1) {
      tx = tangents[tangents.length - 1].x;
      ty = tangents[tangents.length - 1].y;
      nx = -ty;
      ny = tx;
    } else {
      var previousNormal = { x: -tangents[pointIndex - 1].y, y: tangents[pointIndex - 1].x };
      var nextNormal = { x: -tangents[pointIndex].y, y: tangents[pointIndex].x };
      nx = previousNormal.x + nextNormal.x;
      ny = previousNormal.y + nextNormal.y;
      var normalLength = Math.sqrt(nx * nx + ny * ny);
      if (normalLength < 0.0001) {
        nx = nextNormal.x;
        ny = nextNormal.y;
      } else {
        nx /= normalLength;
        ny /= normalLength;
      }
      var denominator = Math.abs(nx * nextNormal.x + ny * nextNormal.y);
      if (denominator < 0.25) denominator = 0.25;
      scale = Math.min(radius / denominator, radius * 4);
      tx = tangents[pointIndex].x;
      ty = tangents[pointIndex].y;
    }
    var baseX = points[pointIndex].x;
    var baseY = points[pointIndex].y;
    if (pointIndex === 0) {
      baseX -= tx * radius;
      baseY -= ty * radius;
    } else if (pointIndex === points.length - 1) {
      baseX += tx * radius;
      baseY += ty * radius;
    }
    var yScale = roundness / 100;
    left.push([baseX + nx * scale, baseY + ny * scale * yScale]);
    right.push([baseX - nx * scale, baseY - ny * scale * yScale]);
  }
  right.reverse();
  return left.concat(right);
}
var beforeBounds = layerBounds(layer);
var beforeHistogram = histogramHash(doc);
var canvasWidth = px(doc.width);
var canvasHeight = px(doc.height);
var radiusLimit = cfg.size * 0.5;
var pointOnCanvas = false;
for (var scanStroke = 0; scanStroke < cfg.strokes.length && !pointOnCanvas; scanStroke += 1) {
  for (var scanPoint = 0; scanPoint < cfg.strokes[scanStroke].points.length; scanPoint += 1) {
    var candidate = cfg.strokes[scanStroke].points[scanPoint];
    if (candidate.x >= -radiusLimit && candidate.y >= -radiusLimit && candidate.x <= canvasWidth + radiusLimit && candidate.y <= canvasHeight + radiusLimit) {
      pointOnCanvas = true;
      break;
    }
  }
}
if (!pointOnCanvas) throw new Error('All brush points are outside the document canvas');
var savedSelection = null;
var originalChannels = null;
var fillOperations = 0;
try {
  try { originalChannels = doc.activeChannels; } catch (channelReadError) {}
  var color = new SolidColor();
  color.rgb.red = cfg.red;
  color.rgb.green = cfg.green;
  color.rgb.blue = cfg.blue;
  var feather = Math.min(250, Math.max(0, cfg.size * (100 - cfg.hardness) / 200));
  function paintRasterStrokes() {
    try {
      doc.selection.bounds;
      savedSelection = doc.channels.add();
      savedSelection.name = '__ChatGPT_saved_selection__';
      doc.selection.store(savedSelection);
    } catch (noSelection) {}
    try { doc.activeChannels = doc.componentChannels; } catch (channelTargetError) {}
    for (var strokeIndex = 0; strokeIndex < cfg.strokes.length; strokeIndex += 1) {
      var outline = strokeOutline(cfg.strokes[strokeIndex].points, cfg.size, cfg.simulatePressure, cfg.spacing, cfg.smoothing, cfg.roundness);
      doc.selection.select(outline, SelectionType.REPLACE, feather, true);
      var blendMode = cfg.erase ? ColorBlendMode.CLEAR : ColorBlendMode.NORMAL;
      doc.selection.fill(color, blendMode, Math.max(0.1, Math.min(100, cfg.opacity * cfg.flow / 100)), false);
      fillOperations += 1;
    }
    if (savedSelection) {
      doc.selection.load(savedSelection, SelectionType.REPLACE);
      savedSelection.remove();
      savedSelection = null;
    } else {
      doc.selection.deselect();
    }
  }
  paintRasterStrokes();
} finally {
  if (savedSelection) {
    try { doc.selection.load(savedSelection, SelectionType.REPLACE); } catch (restoreError) {}
    try { savedSelection.remove(); } catch (removeError) {}
  }
  if (originalChannels) {
    try { doc.activeChannels = originalChannels; } catch (channelRestoreError) {}
  }
}
var afterBounds = layerBounds(layer);
var afterHistogram = histogramHash(doc);
if (!cfg.erase && !hasPixels(afterBounds)) throw new Error('Brush verification failed: the active layer still has empty pixel bounds');
var boundsChanged = beforeBounds[0] !== afterBounds[0] || beforeBounds[1] !== afterBounds[1] || beforeBounds[2] !== afterBounds[2] || beforeBounds[3] !== afterBounds[3];
var histogramChanged = beforeHistogram !== afterHistogram;
if (cfg.erase && !hasPixels(beforeBounds)) throw new Error('Erase verification failed: the active layer had no pixels before erasing');
if (cfg.erase && !boundsChanged && !histogramChanged) throw new Error('Erase verification failed: no visible pixel or bounds change was detected');
return {
  ok: true,
  summary: cfg.erase ? 'Raster erase strokes applied and pixel change verified' : 'Raster brush strokes painted and pixel bounds verified',
  paint_method: cfg.erase ? 'selection_clear_raster' : 'selection_fill_raster',
  erase_mode: cfg.erase,
  verified_pixels: true,
  bounds_changed: boundsChanged,
  histogram_changed: histogramChanged,
  before_bounds: beforeBounds,
  after_bounds: afterBounds,
  fill_operations: fillOperations,
  opacity: cfg.opacity,
  flow: cfg.flow,
  spacing: cfg.spacing,
  smoothing: cfg.smoothing,
  roundness: cfg.roundness,
  current_brush_preset_requested: cfg.useCurrentBrushPreset,
  current_brush_preset_used: false,
  preset_fallback: cfg.useCurrentBrushPreset ? 'selection_raster_engine' : null,
  stroke_count: cfg.strokes.length,
  point_count: ${configValue.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0)}
};
`,
  };
}

function localArguments(name, args) {
  const { expected_revision: _expectedRevision, ...clean } = args;
  if (name === 'photoshop_ping') return {};
  if (name === 'photoshop_get_state') return { document_id: clean.document_id ?? null };
  if (name === 'photoshop_get_preview') return {
    document_id: clean.document_id ?? null,
    max_dimension_px: clean.max_dimension_px ?? 1024,
    quality: clean.quality ?? 7,
  };
  return clean;
}

async function callTool(name, args, timeout = 65000) {
  if (!child) await boot();
  const rpc = await request('tools/call', { name, arguments: args }, timeout);
  return rpc.result || { isError: true, content: [{ type: 'text', text: 'Local MCP request failed' }] };
}

const runtime = new CollabRuntime({ root, callTool, log });

async function http(route, body) {
  const response = await fetch(new URL(route, origin), {
    method: 'POST',
    redirect: 'error',
    headers: {
      'Content-Type': 'application/json',
      'OAI-Sites-Authorization': `Bearer ${config.token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw Error(`Service HTTP ${response.status}`);
  return response.json();
}

(async () => {
  await boot();
  setInterval(() => http('/bridge/heartbeat', {}).catch(() => {}), 5000).unref();
  console.log('Photoshop bridge ready; connecting to private service. Press Ctrl+C to stop.');
  log('Polling private service');
  while (!closing) {
    if (fs.existsSync(stopFile)) {
      fs.unlinkSync(stopFile);
      finish();
      return;
    }
    try {
      const job = await http('/bridge/poll', {});
      if (!job.id) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      if (!allowed.has(job.name) || job.expires < Date.now()) continue;
      if (!child) await boot();
      const jobArguments = job.arguments || {};
      let raw = null;
      let baseline = null;
      const documentId = jobArguments.document_id;
      if (MUTATING_TOOL_NAMES.has(job.name) && Number.isInteger(documentId) && documentId > 0) {
        baseline = await runtime.beforeMutation(documentId, jobArguments.expected_revision);
        if (!baseline.ok) raw = baseline.result;
      }
      if (!raw) raw = await runtime.handle(job.name, jobArguments);
      if (!raw) {
        const isPaint = job.name === 'photoshop_draw_brush_strokes' || job.name === 'photoshop_erase_strokes';
        const localName = isPaint ? 'photoshop_execute_script' : job.name;
        const args = isPaint
          ? brushScript(jobArguments, job.name === 'photoshop_erase_strokes')
          : localArguments(job.name, jobArguments);
        raw = await callTool(localName, args);
      }
      if (baseline?.ok && job.name !== 'photoshop_close_document') {
        const observed = await runtime.afterMutation(documentId);
        raw = runtime.augment(raw, observed);
      }
      const result = {
        content: (raw.content || []).filter(item => item.type === 'text' || item.type === 'image'),
        isError: !!raw.isError,
      };
      await http('/bridge/result', { id: job.id, result });
      log(`${job.name} completed${result.isError ? ' with tool error' : ''}`);
    } catch (error) {
      log(String(error.message).replace(/Bearer\s+\S+/g, 'Bearer [redacted]'));
      await new Promise(resolve => setTimeout(resolve, 4000));
    }
  }
})().catch(error => {
  log(error.message);
  finish();
});
