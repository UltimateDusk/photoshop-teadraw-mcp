const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const EXTRA_TOOL_NAMES = new Set([
  'photoshop_wait_for_canvas_change',
  'photoshop_get_region_preview',
  'photoshop_save',
  'photoshop_save_as',
  'photoshop_export',
  'photoshop_list_documents',
  'photoshop_activate_document',
  'photoshop_close_document',
  'photoshop_create_text_layer',
  'photoshop_edit_text_layer',
  'photoshop_erase_strokes',
  'photoshop_delete_layer',
  'photoshop_create_group',
  'photoshop_move_layer_into_group',
  'photoshop_resize_canvas',
  'photoshop_resize_image',
  'photoshop_crop',
  'photoshop_rotate_canvas',
  'photoshop_start_collab_session',
  'photoshop_end_collab_session',
]);

const MUTATING_TOOL_NAMES = new Set([
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
  'photoshop_erase_strokes',
  'photoshop_move_layer',
  'photoshop_scale_layer',
  'photoshop_rotate_layer',
  'photoshop_undo',
  'photoshop_redo',
  'photoshop_save',
  'photoshop_save_as',
  'photoshop_export',
  'photoshop_close_document',
  'photoshop_create_text_layer',
  'photoshop_edit_text_layer',
  'photoshop_delete_layer',
  'photoshop_create_group',
  'photoshop_move_layer_into_group',
  'photoshop_resize_canvas',
  'photoshop_resize_image',
  'photoshop_crop',
  'photoshop_rotate_canvas',
]);

const SPECIAL_TOOL_NAMES = new Set([
  'photoshop_get_state',
  'photoshop_wait_for_canvas_change',
  'photoshop_get_region_preview',
  'photoshop_save',
  'photoshop_save_as',
  'photoshop_export',
  'photoshop_list_documents',
  'photoshop_activate_document',
  'photoshop_close_document',
  'photoshop_create_text_layer',
  'photoshop_edit_text_layer',
  'photoshop_delete_layer',
  'photoshop_create_group',
  'photoshop_move_layer_into_group',
  'photoshop_resize_canvas',
  'photoshop_crop',
  'photoshop_rotate_canvas',
  'photoshop_start_collab_session',
  'photoshop_end_collab_session',
]);

function jsonResult(value, isError = false, extraContent = []) {
  return {
    isError,
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }, ...extraContent],
  };
}

function errorResult(code, message, suggestedNextTool, context) {
  return jsonResult({
    ok: false,
    code,
    message,
    ...(suggestedNextTool ? { suggested_next_tool: suggestedNextTool } : {}),
    ...(context ? { context } : {}),
  }, true);
}

function parseObjectText(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {}
  const marker = trimmed.lastIndexOf('Result:');
  if (marker >= 0) {
    const candidate = trimmed.slice(marker + 7).trim();
    try {
      const parsed = JSON.parse(candidate);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {}
  }
  return null;
}

function extractObject(result) {
  for (const item of result?.content || []) {
    if (item.type !== 'text') continue;
    const parsed = parseObjectText(item.text);
    if (parsed) return parsed;
  }
  return null;
}

function resultMessage(result) {
  return (result?.content || [])
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join('\n')
    .slice(0, 2000);
}

function augmentResult(result, metadata) {
  if (!metadata || Object.keys(metadata).length === 0) return result;
  const content = [...(result?.content || [])];
  if (content.length === 1 && content[0].type === 'text') {
    const parsed = parseObjectText(content[0].text);
    if (parsed) {
      content[0] = { type: 'text', text: JSON.stringify({ ...parsed, ...metadata }, null, 2) };
      return { ...result, content };
    }
  }
  content.push({ type: 'text', text: JSON.stringify({ metadata }, null, 2) });
  return { ...result, content };
}

function normalizedBounds(value) {
  if (!Array.isArray(value) || value.length !== 4 || value.some(item => typeof item !== 'number' || !Number.isFinite(item))) return null;
  const [left, top, right, bottom] = value;
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom };
}

function unionBounds(first, second) {
  if (!first) return second;
  if (!second) return first;
  return {
    left: Math.min(first.left, second.left),
    top: Math.min(first.top, second.top),
    right: Math.max(first.right, second.right),
    bottom: Math.max(first.bottom, second.bottom),
  };
}

function clampBounds(bounds, snapshot) {
  if (!bounds) return null;
  const value = {
    left: Math.max(0, Math.min(snapshot.width, Math.floor(bounds.left))),
    top: Math.max(0, Math.min(snapshot.height, Math.floor(bounds.top))),
    right: Math.max(0, Math.min(snapshot.width, Math.ceil(bounds.right))),
    bottom: Math.max(0, Math.min(snapshot.height, Math.ceil(bounds.bottom))),
  };
  return value.right > value.left && value.bottom > value.top ? value : null;
}

function flattenLayers(layers, prefix = '', output = new Map()) {
  for (let index = 0; index < (layers || []).length; index += 1) {
    const layer = layers[index];
    const key = String(layer.id ?? `${prefix}${index}:${layer.name}`);
    output.set(key, { ...layer, stack_path: `${prefix}${index}` });
    if (Array.isArray(layer.children)) flattenLayers(layer.children, `${prefix}${index}/`, output);
  }
  return output;
}

function approximateDirtyBounds(previous, current) {
  if (!previous || previous.width !== current.width || previous.height !== current.height) {
    return { left: 0, top: 0, right: current.width, bottom: current.height };
  }
  const before = flattenLayers(previous.layers);
  const after = flattenLayers(current.layers);
  let dirty = null;
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const oldLayer = before.get(key);
    const newLayer = after.get(key);
    const oldComparable = oldLayer && JSON.stringify({
      name: oldLayer.name,
      visible: oldLayer.visible,
      opacity: oldLayer.opacity,
      blend_mode: oldLayer.blend_mode,
      bounds: oldLayer.bounds,
      text_fingerprint: oldLayer.text_fingerprint,
      stack_path: oldLayer.stack_path,
    });
    const newComparable = newLayer && JSON.stringify({
      name: newLayer.name,
      visible: newLayer.visible,
      opacity: newLayer.opacity,
      blend_mode: newLayer.blend_mode,
      bounds: newLayer.bounds,
      text_fingerprint: newLayer.text_fingerprint,
      stack_path: newLayer.stack_path,
    });
    if (oldComparable !== newComparable) {
      dirty = unionBounds(dirty, normalizedBounds(oldLayer?.bounds));
      dirty = unionBounds(dirty, normalizedBounds(newLayer?.bounds));
    }
  }
  if (!dirty && previous.histogram_hash !== current.histogram_hash) {
    dirty = unionBounds(normalizedBounds(previous.active_layer?.bounds), normalizedBounds(current.active_layer?.bounds));
  }
  if (!dirty) dirty = normalizedBounds(current.active_layer?.bounds);
  if (!dirty) dirty = { left: 0, top: 0, right: current.width, bottom: current.height };
  return clampBounds(dirty, current);
}

function classifyChange(previous, current) {
  if (!previous) return 'initial';
  const history = String(current.history?.name || '').toLowerCase();
  if (/(brush|pencil|eraser|paint|stroke|smudge|fill|gradient|画笔|铅笔|橡皮|绘画|描边|涂抹|填充|渐变)/i.test(history)) return 'paint';
  if (/(type|text|character|paragraph|font|文字|文本|字符|字体)/i.test(history)) return 'text';
  if (/(transform|move|rotate|scale|crop|canvas size|image size|warp|移动|变换|旋转|缩放|裁剪|画布大小|图像大小|扭曲)/i.test(history)) return 'transform';
  if (/(layer|group|merge|flatten|duplicate|delete|opacity|blend|visibility|图层|组|合并|拼合|复制|删除|不透明度|混合模式)/i.test(history)) return 'layer';
  if (previous.width !== current.width || previous.height !== current.height) return 'transform';
  if (JSON.stringify(previous.layers) !== JSON.stringify(current.layers)) return 'layer';
  if (previous.histogram_hash !== current.histogram_hash) return 'paint';
  return 'unknown';
}

function snapshotSignature(snapshot) {
  return JSON.stringify({
    width: snapshot.width,
    height: snapshot.height,
    color_mode: snapshot.color_mode,
    history: snapshot.history,
    histogram_hash: snapshot.histogram_hash,
    layers: snapshot.layers,
  });
}

function snapshotScript(documentId) {
  return `
var __mcpTargetDocumentId = ${documentId};
function __mcpPx(value) { try { return value.as('px'); } catch (error) { return Number(value); } }
function __mcpBounds(target) {
  try {
    var value = target.bounds;
    return [__mcpPx(value[0]), __mcpPx(value[1]), __mcpPx(value[2]), __mcpPx(value[3])];
  } catch (error) { return null; }
}
function __mcpTextFingerprint(layer) {
  try {
    if (layer.typename !== 'ArtLayer' || layer.kind !== LayerKind.TEXT) return null;
    var text = String(layer.textItem.contents);
    var first = 0;
    var second = 0;
    for (var index = 0; index < text.length; index += 1) {
      var code = text.charCodeAt(index);
      first = (first + code * (index + 1)) % 2147483647;
      second = (second * 131 + code) % 2147483629;
    }
    return text.length + ':' + first + ':' + second;
  } catch (error) { return null; }
}
function __mcpLayerInfo(layer, includeChildren) {
  var info = {
    id: null,
    name: '',
    typename: '',
    kind: null,
    visible: null,
    opacity: null,
    blend_mode: null,
    bounds: null,
    text_fingerprint: null
  };
  try { info.id = layer.id; } catch (errorId) {}
  try { info.name = layer.name; } catch (errorName) {}
  try { info.typename = layer.typename; } catch (errorType) {}
  try { info.kind = String(layer.kind); } catch (errorKind) {}
  try { info.visible = !!layer.visible; } catch (errorVisible) {}
  try { info.opacity = Number(layer.opacity); } catch (errorOpacity) {}
  try { info.blend_mode = String(layer.blendMode); } catch (errorBlend) {}
  info.bounds = __mcpBounds(layer);
  info.text_fingerprint = __mcpTextFingerprint(layer);
  if (layer.typename === 'LayerSet' && includeChildren) {
    info.children = [];
    for (var childIndex = 0; childIndex < layer.layers.length; childIndex += 1) info.children.push(__mcpLayerInfo(layer.layers[childIndex], true));
  }
  return info;
}
if (app.documents.length === 0) return { ok: false, code: 'no_active_document', message: 'No Photoshop document is open' };
var __mcpDocument = app.activeDocument;
if (__mcpDocument.id !== __mcpTargetDocumentId) {
  return {
    ok: false,
    code: 'document_not_active',
    message: 'The monitored document is not the active Photoshop tab',
    active_document_id: __mcpDocument.id,
    requested_document_id: __mcpTargetDocumentId
  };
}
var __mcpHistoryIndex = -1;
var __mcpHistoryName = '';
var __mcpHistoryCount = 0;
try {
  __mcpHistoryCount = __mcpDocument.historyStates.length;
  __mcpHistoryName = __mcpDocument.activeHistoryState.name;
  for (var historyIndex = 0; historyIndex < __mcpHistoryCount; historyIndex += 1) {
    if (__mcpDocument.historyStates[historyIndex] === __mcpDocument.activeHistoryState) {
      __mcpHistoryIndex = historyIndex;
      break;
    }
  }
} catch (historyError) {}
var __mcpHistogramFirst = 0;
var __mcpHistogramSecond = 0;
try {
  var __mcpHistogram = __mcpDocument.histogram;
  for (var histogramIndex = 0; histogramIndex < __mcpHistogram.length; histogramIndex += 1) {
    var histogramValue = Number(__mcpHistogram[histogramIndex]);
    __mcpHistogramFirst = (__mcpHistogramFirst + ((histogramIndex + 1) * (histogramValue % 2147483647))) % 2147483647;
    __mcpHistogramSecond = (__mcpHistogramSecond + ((histogramIndex + 17) * (histogramIndex + 31) * (histogramValue % 2147483629))) % 2147483629;
  }
} catch (histogramError) {}
var __mcpLayers = [];
for (var layerIndex = 0; layerIndex < __mcpDocument.layers.length; layerIndex += 1) __mcpLayers.push(__mcpLayerInfo(__mcpDocument.layers[layerIndex], true));
var __mcpActiveLayer = null;
try { __mcpActiveLayer = __mcpLayerInfo(__mcpDocument.activeLayer, false); } catch (activeLayerError) {}
var __mcpPath = null;
try { __mcpPath = __mcpDocument.fullName.fsName; } catch (pathError) {}
return {
  ok: true,
  document_id: __mcpDocument.id,
  name: __mcpDocument.name,
  path: __mcpPath,
  width: __mcpPx(__mcpDocument.width),
  height: __mcpPx(__mcpDocument.height),
  color_mode: String(__mcpDocument.mode),
  saved: !!__mcpDocument.saved,
  history: { index: __mcpHistoryIndex, count: __mcpHistoryCount, name: __mcpHistoryName },
  histogram_hash: String(__mcpHistogramFirst) + ':' + String(__mcpHistogramSecond),
  active_layer: __mcpActiveLayer,
  layers: __mcpLayers
};
`;
}

function listDocumentsScript() {
  return `
var documents = [];
var activeId = null;
try { activeId = app.activeDocument.id; } catch (activeError) {}
function px(value) { try { return value.as('px'); } catch (error) { return Number(value); } }
for (var index = 0; index < app.documents.length; index += 1) {
  var doc = app.documents[index];
  var filePath = null;
  try { filePath = doc.fullName.fsName; } catch (pathError) {}
  documents.push({
    id: doc.id,
    name: doc.name,
    path: filePath,
    width: px(doc.width),
    height: px(doc.height),
    saved: !!doc.saved,
    dirty: !doc.saved,
    active: doc.id === activeId
  });
}
return { ok: true, count: documents.length, active_document_id: activeId, documents: documents };
`;
}

function regionPreviewScript(config) {
  return `
var cfg = ${JSON.stringify(config)};
if (app.documents.length === 0) throw new Error('No active Photoshop document');
var source = app.activeDocument;
function px(value) { try { return value.as('px'); } catch (error) { return Number(value); } }
var width = px(source.width);
var height = px(source.height);
if (cfg.left < 0 || cfg.top < 0 || cfg.right > width || cfg.bottom > height || cfg.right <= cfg.left || cfg.bottom <= cfg.top) throw new Error('invalid_region: preview bounds must be inside the document');
var duplicate = null;
var temporary = null;
try {
  duplicate = source.duplicate('__mcp_region_preview__', true);
  duplicate.crop([UnitValue(cfg.left, 'px'), UnitValue(cfg.top, 'px'), UnitValue(cfg.right, 'px'), UnitValue(cfg.bottom, 'px')]);
  var regionWidth = px(duplicate.width);
  var regionHeight = px(duplicate.height);
  var scale = Math.min(1, cfg.max_dimension_px / Math.max(regionWidth, regionHeight));
  if (scale < 1) duplicate.resizeImage(UnitValue(Math.max(1, Math.round(regionWidth * scale)), 'px'), UnitValue(Math.max(1, Math.round(regionHeight * scale)), 'px'), duplicate.resolution, ResampleMethod.BICUBIC);
  temporary = new File(Folder.temp.fsName + '/ps-region-' + (new Date().getTime()) + '-' + Math.floor(Math.random() * 1000000) + '.jpg');
  var options = new JPEGSaveOptions();
  options.quality = cfg.quality;
  options.embedColorProfile = true;
  options.formatOptions = FormatOptions.STANDARDBASELINE;
  duplicate.flatten();
  duplicate.saveAs(temporary, options, true);
  var result = {
    ok: true,
    path: temporary.fsName,
    mime_type: 'image/jpeg',
    document_id: source.id,
    region: { left: cfg.left, top: cfg.top, right: cfg.right, bottom: cfg.bottom },
    width: px(duplicate.width),
    height: px(duplicate.height)
  };
  duplicate.close(SaveOptions.DONOTSAVECHANGES);
  duplicate = null;
  return result;
} finally {
  if (duplicate) try { duplicate.close(SaveOptions.DONOTSAVECHANGES); } catch (closeError) {}
}
`;
}

function saveCurrentScript() {
  return `
if (app.documents.length === 0) throw new Error('No active Photoshop document');
var doc = app.activeDocument;
var currentPath = null;
try { currentPath = doc.fullName.fsName; } catch (pathError) {}
if (!currentPath) throw new Error('save_as_required: the active document has no existing file path');
doc.save();
return { ok: true, success: true, document_id: doc.id, path: doc.fullName.fsName, format: String(doc.fullName.name).split('.').pop().toUpperCase(), saved: !!doc.saved };
`;
}

function saveAsScript(config) {
  return `
var cfg = ${JSON.stringify(config)};
if (app.documents.length === 0) throw new Error('No active Photoshop document');
var doc = app.activeDocument;
var output = new File(cfg.path);
var workingDocumentRetargeted = false;
if (cfg.format === 'PSD') {
  var psd = new PhotoshopSaveOptions();
  psd.embedColorProfile = true;
  doc.saveAs(output, psd, false, Extension.LOWERCASE);
  workingDocumentRetargeted = true;
} else if (cfg.format === 'PNG') {
  var png = new PNGSaveOptions();
  png.compression = 9;
  doc.saveAs(output, png, true, Extension.LOWERCASE);
} else {
  var jpeg = new JPEGSaveOptions();
  jpeg.quality = cfg.quality;
  jpeg.embedColorProfile = true;
  jpeg.formatOptions = FormatOptions.STANDARDBASELINE;
  doc.saveAs(output, jpeg, true, Extension.LOWERCASE);
}
return { ok: true, success: true, document_id: doc.id, path: output.fsName, format: cfg.format, working_document_retargeted: workingDocumentRetargeted };
`;
}

function fontResolverScript() {
  return `
function resolveFontPostScriptName(name) {
  for (var fontIndex = 0; fontIndex < app.fonts.length; fontIndex += 1) {
    var font = app.fonts[fontIndex];
    try {
      if (font.postScriptName === name || font.name === name || font.family === name) return font.postScriptName;
    } catch (fontReadError) {}
  }
  return null;
}
`;
}

function textHelpersScript() {
  return `
function textPosition(textItem) {
  var position = textItem.position;
  function px(value) { try { return value.as('px'); } catch (error) { return Number(value); } }
  return { x: px(position[0]), y: px(position[1]) };
}
function justification(value) {
  if (value === 'CENTER') return Justification.CENTER;
  if (value === 'RIGHT') return Justification.RIGHT;
  if (value === 'LEFTJUSTIFIED') return Justification.LEFTJUSTIFIED;
  if (value === 'CENTERJUSTIFIED') return Justification.CENTERJUSTIFIED;
  if (value === 'RIGHTJUSTIFIED') return Justification.RIGHTJUSTIFIED;
  if (value === 'FULLYJUSTIFIED') return Justification.FULLYJUSTIFIED;
  return Justification.LEFT;
}
function rgbColor(red, green, blue) {
  var color = new SolidColor();
  color.rgb.red = red;
  color.rgb.green = green;
  color.rgb.blue = blue;
  return color;
}
`;
}

function createTextScript(config) {
  return `
var cfg = ${JSON.stringify(config)};
${fontResolverScript()}
${textHelpersScript()}
if (app.documents.length === 0) throw new Error('No active Photoshop document');
var resolvedFont = null;
if (cfg.font_family) {
  resolvedFont = resolveFontPostScriptName(cfg.font_family);
  if (!resolvedFont) throw new Error('font_not_found: ' + cfg.font_family);
}
var doc = app.activeDocument;
var layer = doc.artLayers.add();
layer.kind = LayerKind.TEXT;
layer.name = cfg.layer_name;
layer.opacity = cfg.opacity;
var item = layer.textItem;
item.contents = cfg.text;
item.position = [cfg.x, cfg.y];
item.size = cfg.font_size;
if (resolvedFont) item.font = resolvedFont;
item.justification = justification(cfg.alignment);
item.color = rgbColor(cfg.red, cfg.green, cfg.blue);
var verifiedPosition = textPosition(item);
return {
  ok: true,
  success: true,
  document_id: doc.id,
  layer: {
    id: layer.id,
    name: layer.name,
    text: String(item.contents),
    x: verifiedPosition.x,
    y: verifiedPosition.y,
    font_size: Number(item.size),
    font: String(item.font),
    alignment: cfg.alignment,
    color: { red: cfg.red, green: cfg.green, blue: cfg.blue },
    opacity: Number(layer.opacity)
  },
  font_fallback_used: false
};
`;
}

function layerLookupScript() {
  return `
function collectLayers(container, name, output) {
  for (var index = 0; index < container.layers.length; index += 1) {
    var layer = container.layers[index];
    if (layer.name === name) output.push(layer);
    if (layer.typename === 'LayerSet') collectLayers(layer, name, output);
  }
}
function findLayerById(container, id) {
  for (var index = 0; index < container.layers.length; index += 1) {
    var layer = container.layers[index];
    try { if (layer.id === id) return layer; } catch (idError) {}
    if (layer.typename === 'LayerSet') {
      var nested = findLayerById(layer, id);
      if (nested) return nested;
    }
  }
  return null;
}
`;
}

function editTextScript(config) {
  return `
var cfg = ${JSON.stringify(config)};
${fontResolverScript()}
${textHelpersScript()}
${layerLookupScript()}
if (app.documents.length === 0) throw new Error('No active Photoshop document');
var doc = app.activeDocument;
var matches = [];
collectLayers(doc, cfg.layer_name, matches);
if (matches.length === 0) throw new Error('layer_not_found: ' + cfg.layer_name);
if (matches.length > 1) throw new Error('layer_ambiguous: more than one layer is named ' + cfg.layer_name);
var layer = matches[0];
if (layer.typename !== 'ArtLayer' || layer.kind !== LayerKind.TEXT) throw new Error('not_text_layer: ' + cfg.layer_name);
var resolvedFont = null;
if (cfg.font_family !== undefined) {
  resolvedFont = resolveFontPostScriptName(cfg.font_family);
  if (!resolvedFont) throw new Error('font_not_found: ' + cfg.font_family);
}
doc.activeLayer = layer;
var item = layer.textItem;
if (cfg.text !== undefined) item.contents = cfg.text;
if (cfg.x !== undefined || cfg.y !== undefined) {
  var beforePosition = textPosition(item);
  item.position = [cfg.x !== undefined ? cfg.x : beforePosition.x, cfg.y !== undefined ? cfg.y : beforePosition.y];
}
if (cfg.font_size !== undefined) item.size = cfg.font_size;
if (resolvedFont) item.font = resolvedFont;
if (cfg.alignment !== undefined) item.justification = justification(cfg.alignment);
if (cfg.red !== undefined) item.color = rgbColor(cfg.red, cfg.green, cfg.blue);
if (cfg.opacity !== undefined) layer.opacity = cfg.opacity;
if (cfg.new_layer_name !== undefined) layer.name = cfg.new_layer_name;
var verifiedPosition = textPosition(item);
var color = item.color.rgb;
return {
  ok: true,
  success: true,
  document_id: doc.id,
  layer: {
    id: layer.id,
    name: layer.name,
    text: String(item.contents),
    x: verifiedPosition.x,
    y: verifiedPosition.y,
    font_size: Number(item.size),
    font: String(item.font),
    alignment: cfg.alignment !== undefined ? cfg.alignment : null,
    color: { red: Number(color.red), green: Number(color.green), blue: Number(color.blue) },
    opacity: Number(layer.opacity)
  },
  font_fallback_used: false
};
`;
}

function deleteLayerScript(config) {
  return `
var cfg = ${JSON.stringify(config)};
${layerLookupScript()}
if (app.documents.length === 0) throw new Error('No active Photoshop document');
var doc = app.activeDocument;
var matches = [];
collectLayers(doc, cfg.layer_name, matches);
if (matches.length === 0) throw new Error('layer_not_found: ' + cfg.layer_name);
if (matches.length > 1) throw new Error('layer_ambiguous: more than one layer is named ' + cfg.layer_name);
var layer = matches[0];
var removedId = layer.id;
var removedName = layer.name;
layer.remove();
if (findLayerById(doc, removedId)) throw new Error('delete_verification_failed: the layer still exists');
return { ok: true, success: true, document_id: doc.id, deleted_layer: { id: removedId, name: removedName }, verified_absent: true };
`;
}

function createGroupScript(config) {
  return `
var cfg = ${JSON.stringify(config)};
if (app.documents.length === 0) throw new Error('No active Photoshop document');
var doc = app.activeDocument;
var group = doc.layerSets.add();
group.name = cfg.group_name;
doc.activeLayer = group;
return { ok: true, success: true, document_id: doc.id, group: { id: group.id, name: group.name }, verified: group.typename === 'LayerSet' };
`;
}

function moveLayerIntoGroupScript(config) {
  return `
var cfg = ${JSON.stringify(config)};
${layerLookupScript()}
if (app.documents.length === 0) throw new Error('No active Photoshop document');
var doc = app.activeDocument;
var layerMatches = [];
var groupMatches = [];
collectLayers(doc, cfg.layer_name, layerMatches);
collectLayers(doc, cfg.group_name, groupMatches);
if (layerMatches.length === 0) throw new Error('layer_not_found: ' + cfg.layer_name);
if (layerMatches.length > 1) throw new Error('layer_ambiguous: more than one layer is named ' + cfg.layer_name);
if (groupMatches.length === 0) throw new Error('group_not_found: ' + cfg.group_name);
if (groupMatches.length > 1) throw new Error('group_ambiguous: more than one group is named ' + cfg.group_name);
var layer = layerMatches[0];
var group = groupMatches[0];
if (group.typename !== 'LayerSet') throw new Error('not_a_group: ' + cfg.group_name);
if (layer.id === group.id) throw new Error('invalid_group_move: a group cannot be moved into itself');
layer.move(group, ElementPlacement.INSIDE);
var parentName = null;
try { parentName = layer.parent.name; } catch (parentError) {}
if (parentName !== group.name) throw new Error('group_move_verification_failed: layer parent did not change');
doc.activeLayer = layer;
return { ok: true, success: true, document_id: doc.id, layer: { id: layer.id, name: layer.name }, group: { id: group.id, name: group.name }, verified_parent: parentName };
`;
}

function resizeCanvasScript(config) {
  return `
var cfg = ${JSON.stringify(config)};
if (app.documents.length === 0) throw new Error('No active Photoshop document');
var doc = app.activeDocument;
var anchors = {
  top_left: AnchorPosition.TOPLEFT,
  top_center: AnchorPosition.TOPCENTER,
  top_right: AnchorPosition.TOPRIGHT,
  middle_left: AnchorPosition.MIDDLELEFT,
  center: AnchorPosition.MIDDLECENTER,
  middle_right: AnchorPosition.MIDDLERIGHT,
  bottom_left: AnchorPosition.BOTTOMLEFT,
  bottom_center: AnchorPosition.BOTTOMCENTER,
  bottom_right: AnchorPosition.BOTTOMRIGHT
};
doc.resizeCanvas(UnitValue(cfg.width, 'px'), UnitValue(cfg.height, 'px'), anchors[cfg.anchor]);
var actualWidth = doc.width.as('px');
var actualHeight = doc.height.as('px');
if (Math.round(actualWidth) !== Math.round(cfg.width) || Math.round(actualHeight) !== Math.round(cfg.height)) throw new Error('resize_canvas_verification_failed');
return { ok: true, success: true, document_id: doc.id, width: actualWidth, height: actualHeight, anchor: cfg.anchor, verified: true };
`;
}

function rotateCanvasScript(config) {
  return `
var cfg = ${JSON.stringify(config)};
if (app.documents.length === 0) throw new Error('No active Photoshop document');
var doc = app.activeDocument;
var beforeWidth = doc.width.as('px');
var beforeHeight = doc.height.as('px');
doc.rotateCanvas(cfg.degrees);
return {
  ok: true,
  success: true,
  document_id: doc.id,
  degrees: cfg.degrees,
  before: { width: beforeWidth, height: beforeHeight },
  after: { width: doc.width.as('px'), height: doc.height.as('px') },
  verified: true
};
`;
}

function validateOutputPath(rawPath, format, overwrite) {
  if (typeof rawPath !== 'string' || rawPath.length < 3 || rawPath.length > 1000 || rawPath.includes('\0')) {
    return { error: errorResult('invalid_path', 'A valid absolute Windows output path is required') };
  }
  if (!path.win32.isAbsolute(rawPath)) return { error: errorResult('invalid_path', 'The output path must be absolute') };
  const outputPath = path.win32.normalize(rawPath);
  const extension = path.win32.extname(outputPath).toLowerCase();
  const expected = format === 'PSD' ? ['.psd'] : format === 'PNG' ? ['.png'] : ['.jpg', '.jpeg'];
  if (!expected.includes(extension)) {
    return { error: errorResult('format_extension_mismatch', `The ${format} format requires one of these extensions: ${expected.join(', ')}`) };
  }
  const parent = path.win32.dirname(outputPath);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    return { error: errorResult('parent_directory_not_found', 'The output directory does not exist', null, { parent }) };
  }
  if (fs.existsSync(outputPath)) {
    if (fs.statSync(outputPath).isDirectory()) return { error: errorResult('invalid_path', 'The output path points to a directory') };
    if (overwrite !== true) return { error: errorResult('file_exists', 'The output file already exists. Set overwrite=true only after confirming replacement.', null, { path: outputPath }) };
  }
  return { outputPath };
}

function structuredScriptError(result, fallbackTool) {
  const message = resultMessage(result);
  const mappings = [
    ['font_not_found:', 'font_not_found', 'The requested font is not installed in Photoshop'],
    ['layer_not_found:', 'layer_not_found', 'The requested layer was not found'],
    ['layer_ambiguous:', 'layer_ambiguous', 'More than one layer has that name'],
    ['group_not_found:', 'group_not_found', 'The requested group was not found'],
    ['group_ambiguous:', 'group_ambiguous', 'More than one group has that name'],
    ['not_text_layer:', 'not_text_layer', 'The requested layer is not a text layer'],
    ['save_as_required:', 'save_as_required', 'This document has no existing file path; use photoshop_save_as'],
    ['invalid_region:', 'invalid_region', 'The requested preview region is outside the document'],
    ['document_not_found', 'document_not_found', 'The Photoshop document is no longer open'],
  ];
  for (const [needle, code, friendly] of mappings) {
    if (message.includes(needle)) return errorResult(code, friendly, code === 'document_not_found' ? 'photoshop_list_documents' : fallbackTool, { local_error: message });
  }
  return result;
}

class CollabRuntime {
  constructor({ root, callTool, log }) {
    this.root = root;
    this.callTool = callTool;
    this.log = log || (() => {});
    this.stateFile = path.join(root, 'revision-state.json');
    this.state = this.loadState();
  }

  loadState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (parsed && parsed.version === 1 && Number.isInteger(parsed.counter) && parsed.documents && parsed.sessions) return parsed;
    } catch {}
    return { version: 1, counter: 0, documents: {}, sessions: {} };
  }

  persist() {
    try {
      const documentEntries = Object.entries(this.state.documents)
        .sort((left, right) => (right[1].last_seen || 0) - (left[1].last_seen || 0))
        .slice(0, 20);
      this.state.documents = Object.fromEntries(documentEntries);
      const temporary = `${this.stateFile}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(this.state));
      fs.renameSync(temporary, this.stateFile);
    } catch (error) {
      this.log(`Revision state persistence failed: ${error.message}`);
    }
  }

  async snapshot(documentId, activate = false) {
    if (!Number.isInteger(documentId) || documentId < 1) return { error: errorResult('invalid_document_id', 'A positive integer document_id is required') };
    const raw = await this.callTool('photoshop_execute_script', {
      document_id: activate ? documentId : 0,
      code: snapshotScript(documentId),
      timeout_ms: 30000,
    });
    if (raw?.isError) return { error: structuredScriptError(raw, 'photoshop_list_documents') };
    const snapshot = extractObject(raw);
    if (!snapshot) return { error: errorResult('state_parse_failed', 'Photoshop returned an unreadable canvas state') };
    if (snapshot.ok === false) {
      return {
        error: errorResult(
          snapshot.code || 'state_unavailable',
          snapshot.message || 'Photoshop state is unavailable',
          snapshot.code === 'document_not_active' ? 'photoshop_activate_document' : 'photoshop_list_documents',
          snapshot,
        ),
      };
    }
    return { snapshot };
  }

  async observe(documentId, activate = false) {
    const captured = await this.snapshot(documentId, activate);
    if (captured.error) return captured;
    const snapshot = captured.snapshot;
    const signature = snapshotSignature(snapshot);
    const previousRecord = this.state.documents[String(documentId)] || null;
    const changed = !previousRecord || previousRecord.signature !== signature;
    let revision = previousRecord?.revision || 0;
    let change = previousRecord?.last_change || null;
    if (changed) {
      const previousSnapshot = previousRecord?.snapshot || null;
      const previousRevision = revision;
      revision = ++this.state.counter;
      const dirtyBounds = approximateDirtyBounds(previousSnapshot, snapshot);
      change = {
        ok: true,
        changed: !!previousRecord,
        initial: !previousRecord,
        timeout: false,
        document_id: documentId,
        revision,
        previous_revision: previousRevision || null,
        history_state: snapshot.history,
        change_type: classifyChange(previousSnapshot, snapshot),
        dirty_bounds: dirtyBounds,
        dirty_bounds_approximate: true,
        active_layer: snapshot.active_layer,
        requires_preview: true,
        observed_at: new Date().toISOString(),
      };
      for (const session of Object.values(this.state.sessions)) {
        if (session.document_id === documentId) {
          session.revision = revision;
          session.last_dirty_bounds = dirtyBounds;
          session.updated_at = change.observed_at;
        }
      }
    }
    this.state.documents[String(documentId)] = {
      revision,
      signature,
      snapshot,
      last_change: change,
      last_seen: Date.now(),
    };
    this.persist();
    return { snapshot, revision, changed, change };
  }

  async beforeMutation(documentId, expectedRevision) {
    const observed = await this.observe(documentId, true);
    if (observed.error) return { ok: false, result: observed.error };
    if (expectedRevision !== undefined) {
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
        return { ok: false, result: errorResult('invalid_revision', 'expected_revision must be a non-negative integer') };
      }
      if (expectedRevision !== observed.revision) {
        return {
          ok: false,
          result: errorResult(
            'revision_conflict',
            'The Photoshop document changed after the caller last observed it. Refresh state or preview before editing.',
            'photoshop_get_state',
            { document_id: documentId, expected_revision: expectedRevision, current_revision: observed.revision },
          ),
        };
      }
    }
    return { ok: true, revision: observed.revision, snapshot: observed.snapshot };
  }

  async afterMutation(documentId) {
    const observed = await this.observe(documentId, false);
    return observed.error ? null : observed;
  }

  augment(result, observed) {
    if (!observed) return result;
    return augmentResult(result, {
      revision: observed.revision,
      revision_changed: observed.changed,
      ...(observed.change?.dirty_bounds ? { dirty_bounds: observed.change.dirty_bounds } : {}),
    });
  }

  async getState(args) {
    const documentId = args.document_id ?? null;
    const raw = await this.callTool('photoshop_get_state', { document_id: documentId });
    if (raw?.isError) return raw;
    const state = extractObject(raw);
    const resolvedId = Number.isInteger(documentId) && documentId > 0 ? documentId : state?.document?.id;
    if (!Number.isInteger(resolvedId) || resolvedId < 1) return raw;
    const observed = await this.observe(resolvedId, false);
    if (observed.error) return augmentResult(raw, { revision_unavailable: true });
    return augmentResult(raw, {
      revision: observed.revision,
      revision_model: 'monotonic observed canvas signature',
      revision_granularity: 'changes within one sampling interval may be coalesced',
    });
  }

  async waitForCanvasChange(args) {
    const timeoutSeconds = args.timeout_seconds ?? 30;
    const pollIntervalMs = args.poll_interval_ms ?? 1000;
    if (!Number.isInteger(args.document_id) || args.document_id < 1) return errorResult('invalid_document_id', 'A positive integer document_id is required');
    if (args.since_revision !== undefined && (!Number.isInteger(args.since_revision) || args.since_revision < 0)) return errorResult('invalid_revision', 'since_revision must be a non-negative integer');
    const initial = await this.observe(args.document_id, false);
    if (initial.error) return initial.error;
    const since = args.since_revision === undefined ? initial.revision : args.since_revision;
    if (since > initial.revision) {
      return errorResult('revision_cursor_ahead', 'since_revision is newer than the current document revision', 'photoshop_get_state', {
        since_revision: since,
        current_revision: initial.revision,
      });
    }
    if (initial.revision > since) return jsonResult(initial.change || {
      ok: true,
      changed: true,
      document_id: args.document_id,
      revision: initial.revision,
      change_type: 'unknown',
      active_layer: initial.snapshot.active_layer,
      requires_preview: true,
    });
    const started = Date.now();
    const deadline = started + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
      const observed = await this.observe(args.document_id, false);
      if (observed.error) return observed.error;
      if (observed.revision > since) return jsonResult(observed.change);
    }
    const current = this.state.documents[String(args.document_id)];
    return jsonResult({
      ok: true,
      changed: false,
      timeout: true,
      document_id: args.document_id,
      revision: current?.revision ?? initial.revision,
      active_layer: current?.snapshot?.active_layer ?? initial.snapshot.active_layer,
      requires_preview: false,
      waited_ms: Date.now() - started,
    });
  }

  async getRegionPreview(args) {
    if (args.right <= args.left || args.bottom <= args.top) return errorResult('invalid_region', 'right must exceed left and bottom must exceed top');
    const config = {
      left: args.left,
      top: args.top,
      right: args.right,
      bottom: args.bottom,
      max_dimension_px: args.max_dimension_px ?? 1024,
      quality: args.quality ?? 7,
    };
    const raw = await this.callTool('photoshop_execute_script', {
      document_id: args.document_id,
      code: regionPreviewScript(config),
      timeout_ms: 60000,
    }, 65000);
    if (raw?.isError) return structuredScriptError(raw, 'photoshop_get_preview');
    const metadata = extractObject(raw);
    if (!metadata?.path) return errorResult('preview_parse_failed', 'Photoshop did not return a region preview path');
    let data;
    try {
      data = fs.readFileSync(metadata.path);
      if (data.length > 1700000) return errorResult('preview_too_large', 'The region preview exceeded the private relay size limit; lower max_dimension_px or quality');
    } catch (error) {
      return errorResult('preview_read_failed', 'The local region preview could not be read', 'photoshop_get_region_preview', { local_error: error.message });
    } finally {
      try { fs.unlinkSync(metadata.path); } catch {}
    }
    const observed = await this.observe(args.document_id, false);
    return jsonResult({
      ...metadata,
      path: undefined,
      revision: observed.error ? null : observed.revision,
    }, false, [{ type: 'image', mimeType: 'image/jpeg', data: data.toString('base64') }]);
  }

  async listDocuments() {
    const raw = await this.callTool('photoshop_execute_script', { document_id: 0, code: listDocumentsScript(), timeout_ms: 30000 });
    if (raw?.isError) return raw;
    const value = extractObject(raw);
    return value ? jsonResult(value) : errorResult('document_list_parse_failed', 'Photoshop returned an unreadable document list');
  }

  async activateDocument(args) {
    const raw = await this.callTool('photoshop_set_active_document', { document_id: args.document_id });
    if (raw?.isError) return structuredScriptError(raw, 'photoshop_list_documents');
    const observed = await this.observe(args.document_id, false);
    return observed.error ? raw : jsonResult({
      ok: true,
      success: true,
      document_id: args.document_id,
      revision: observed.revision,
      active_layer: observed.snapshot.active_layer,
    });
  }

  async closeDocument(args) {
    const captured = await this.snapshot(args.document_id, true);
    if (captured.error) return captured.error;
    if (args.save_changes === true && !captured.snapshot.path) {
      return errorResult('save_as_required', 'The document has no existing path. Save it explicitly with photoshop_save_as before closing.', 'photoshop_save_as');
    }
    const revision = this.state.documents[String(args.document_id)]?.revision ?? null;
    const raw = await this.callTool('photoshop_close_document', { document_id: args.document_id, save: args.save_changes === true });
    if (raw?.isError) return structuredScriptError(raw, 'photoshop_list_documents');
    delete this.state.documents[String(args.document_id)];
    for (const [sessionId, session] of Object.entries(this.state.sessions)) if (session.document_id === args.document_id) delete this.state.sessions[sessionId];
    this.persist();
    return jsonResult({ ok: true, success: true, closed: true, document_id: args.document_id, save_changes: args.save_changes === true, last_revision: revision });
  }

  async save(args) {
    const raw = await this.callTool('photoshop_execute_script', { document_id: args.document_id, code: saveCurrentScript(), timeout_ms: 60000 }, 65000);
    return raw?.isError ? structuredScriptError(raw, 'photoshop_save_as') : jsonResult(extractObject(raw) || { ok: true, success: true, document_id: args.document_id });
  }

  async saveAs(args) {
    const format = args.format.toUpperCase() === 'JPG' ? 'JPEG' : args.format.toUpperCase();
    const pathFormat = format === 'JPEG' ? 'JPG' : format;
    const checked = validateOutputPath(args.path, pathFormat, args.overwrite);
    if (checked.error) return checked.error;
    const config = { path: checked.outputPath, format, quality: args.quality ?? 8 };
    const raw = await this.callTool('photoshop_execute_script', { document_id: args.document_id, code: saveAsScript(config), timeout_ms: 120000 }, 125000);
    if (raw?.isError) return structuredScriptError(raw, 'photoshop_save_as');
    if (!fs.existsSync(checked.outputPath) || fs.statSync(checked.outputPath).size < 1) return errorResult('save_verification_failed', 'Photoshop reported success but the destination file was not created');
    return jsonResult({
      ...(extractObject(raw) || {}),
      ok: true,
      success: true,
      path: checked.outputPath,
      format: pathFormat,
      overwrite: args.overwrite,
      verified_file_bytes: fs.statSync(checked.outputPath).size,
    });
  }

  async exportFile(args) {
    const format = args.format.toUpperCase() === 'JPG' ? 'JPEG' : args.format.toUpperCase();
    const pathFormat = format === 'JPEG' ? 'JPG' : format;
    const checked = validateOutputPath(args.path, pathFormat, args.overwrite);
    if (checked.error) return checked.error;
    const raw = await this.callTool('photoshop_export_as', {
      document_id: args.document_id,
      path: checked.outputPath,
      format,
      quality: args.quality ?? 90,
    }, 125000);
    if (raw?.isError) return structuredScriptError(raw, 'photoshop_export');
    if (!fs.existsSync(checked.outputPath) || fs.statSync(checked.outputPath).size < 1) return errorResult('export_verification_failed', 'Photoshop reported success but the exported file was not created');
    return jsonResult({
      ok: true,
      success: true,
      document_id: args.document_id,
      path: checked.outputPath,
      format: pathFormat,
      quality: args.quality ?? 90,
      overwrite: args.overwrite,
      verified_file_bytes: fs.statSync(checked.outputPath).size,
    });
  }

  async createText(args) {
    const config = {
      text: args.text,
      x: args.x,
      y: args.y,
      font_size: args.font_size,
      font_family: args.font_family,
      alignment: args.alignment ?? 'LEFT',
      red: args.red,
      green: args.green,
      blue: args.blue,
      opacity: args.opacity ?? 100,
      layer_name: args.layer_name ?? 'Text',
    };
    const raw = await this.callTool('photoshop_execute_script', { document_id: args.document_id, code: createTextScript(config), timeout_ms: 60000 });
    return raw?.isError ? structuredScriptError(raw, 'photoshop_create_text_layer') : jsonResult(extractObject(raw) || { ok: true, success: true });
  }

  async editText(args) {
    const editable = ['text', 'x', 'y', 'font_size', 'font_family', 'alignment', 'red', 'green', 'blue', 'opacity', 'new_layer_name'];
    if (!editable.some(key => args[key] !== undefined)) return errorResult('no_text_changes', 'At least one text property must be supplied');
    const colorCount = ['red', 'green', 'blue'].filter(key => args[key] !== undefined).length;
    if (colorCount !== 0 && colorCount !== 3) return errorResult('incomplete_color', 'red, green, and blue must be supplied together');
    const config = Object.fromEntries(Object.entries(args).filter(([key, value]) => !['document_id', 'expected_revision'].includes(key) && value !== undefined));
    const raw = await this.callTool('photoshop_execute_script', { document_id: args.document_id, code: editTextScript(config), timeout_ms: 60000 });
    return raw?.isError ? structuredScriptError(raw, 'photoshop_edit_text_layer') : jsonResult(extractObject(raw) || { ok: true, success: true });
  }

  async deleteLayer(args) {
    const raw = await this.callTool('photoshop_execute_script', {
      document_id: args.document_id,
      code: deleteLayerScript({ layer_name: args.layer_name }),
      timeout_ms: 60000,
    });
    return raw?.isError ? structuredScriptError(raw, 'photoshop_get_layers') : jsonResult(extractObject(raw) || { ok: true, success: true });
  }

  async createGroup(args) {
    const raw = await this.callTool('photoshop_execute_script', {
      document_id: args.document_id,
      code: createGroupScript({ group_name: args.group_name }),
      timeout_ms: 60000,
    });
    return raw?.isError ? structuredScriptError(raw, 'photoshop_create_group') : jsonResult(extractObject(raw) || { ok: true, success: true });
  }

  async moveLayerIntoGroup(args) {
    const raw = await this.callTool('photoshop_execute_script', {
      document_id: args.document_id,
      code: moveLayerIntoGroupScript({ layer_name: args.layer_name, group_name: args.group_name }),
      timeout_ms: 60000,
    });
    return raw?.isError ? structuredScriptError(raw, 'photoshop_get_layers') : jsonResult(extractObject(raw) || { ok: true, success: true });
  }

  async resizeCanvas(args) {
    const raw = await this.callTool('photoshop_execute_script', {
      document_id: args.document_id,
      code: resizeCanvasScript({ width: args.width, height: args.height, anchor: args.anchor ?? 'center' }),
      timeout_ms: 120000,
    }, 125000);
    return raw?.isError ? structuredScriptError(raw, 'photoshop_resize_canvas') : jsonResult(extractObject(raw) || { ok: true, success: true });
  }

  async crop(args) {
    const raw = await this.callTool('photoshop_crop_document', {
      document_id: args.document_id,
      left: args.left,
      top: args.top,
      right: args.right,
      bottom: args.bottom,
    }, 125000);
    return raw?.isError ? structuredScriptError(raw, 'photoshop_crop') : raw;
  }

  async rotateCanvas(args) {
    const raw = await this.callTool('photoshop_execute_script', {
      document_id: args.document_id,
      code: rotateCanvasScript({ degrees: args.degrees }),
      timeout_ms: 120000,
    }, 125000);
    return raw?.isError ? structuredScriptError(raw, 'photoshop_rotate_canvas') : jsonResult(extractObject(raw) || { ok: true, success: true });
  }

  async startSession(args) {
    const observed = await this.observe(args.document_id, false);
    if (observed.error) return observed.error;
    const sessionId = crypto.randomUUID();
    const now = new Date().toISOString();
    const session = {
      session_id: sessionId,
      document_id: args.document_id,
      revision: observed.revision,
      assistant_layer_or_group: args.assistant_layer_or_group ?? null,
      user_layer_or_group: args.user_layer_or_group ?? null,
      last_dirty_bounds: observed.change?.dirty_bounds ?? null,
      started_at: now,
      updated_at: now,
    };
    this.state.sessions[sessionId] = session;
    this.persist();
    return jsonResult({ ok: true, started: true, session });
  }

  async endSession(args) {
    const session = this.state.sessions[args.session_id];
    if (!session || session.document_id !== args.document_id) return errorResult('session_not_found', 'No matching collaboration session was found', 'photoshop_start_collab_session');
    delete this.state.sessions[args.session_id];
    this.persist();
    return jsonResult({ ok: true, ended: true, session: { ...session, ended_at: new Date().toISOString() } });
  }

  async handle(name, args) {
    if (!SPECIAL_TOOL_NAMES.has(name)) return null;
    if (name === 'photoshop_get_state') return this.getState(args);
    if (name === 'photoshop_wait_for_canvas_change') return this.waitForCanvasChange(args);
    if (name === 'photoshop_get_region_preview') return this.getRegionPreview(args);
    if (name === 'photoshop_list_documents') return this.listDocuments();
    if (name === 'photoshop_activate_document') return this.activateDocument(args);
    if (name === 'photoshop_close_document') return this.closeDocument(args);
    if (name === 'photoshop_save') return this.save(args);
    if (name === 'photoshop_save_as') return this.saveAs(args);
    if (name === 'photoshop_export') return this.exportFile(args);
    if (name === 'photoshop_create_text_layer') return this.createText(args);
    if (name === 'photoshop_edit_text_layer') return this.editText(args);
    if (name === 'photoshop_delete_layer') return this.deleteLayer(args);
    if (name === 'photoshop_create_group') return this.createGroup(args);
    if (name === 'photoshop_move_layer_into_group') return this.moveLayerIntoGroup(args);
    if (name === 'photoshop_resize_canvas') return this.resizeCanvas(args);
    if (name === 'photoshop_crop') return this.crop(args);
    if (name === 'photoshop_rotate_canvas') return this.rotateCanvas(args);
    if (name === 'photoshop_start_collab_session') return this.startSession(args);
    if (name === 'photoshop_end_collab_session') return this.endSession(args);
    return null;
  }
}

module.exports = {
  CollabRuntime,
  EXTRA_TOOL_NAMES,
  MUTATING_TOOL_NAMES,
  SPECIAL_TOOL_NAMES,
  errorResult,
};
