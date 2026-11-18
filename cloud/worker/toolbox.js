const docId = {
  type: 'number',
  minimum: 1,
  description: 'Exact Photoshop document id returned by photoshop_get_state. Required on every edit so the active tab cannot be changed accidentally.',
};

const nullableDocId = {
  type: ['number', 'null'],
  minimum: 0,
  description: 'Photoshop document id. Omit or send null to inspect the active document.',
};

const number = (description, minimum, maximum) => ({
  type: 'number',
  description,
  ...(minimum === undefined ? {} : { minimum }),
  ...(maximum === undefined ? {} : { maximum }),
});

const string = description => ({ type: 'string', description, minLength: 1, maxLength: 200 });
const longString = description => ({ type: 'string', description, minLength: 0, maxLength: 10000 });
const filePathString = description => ({ type: 'string', description, minLength: 3, maxLength: 1000 });
const expectedRevision = {
  type: 'number',
  minimum: 0,
  description: 'Optional revision returned by photoshop_get_state or photoshop_wait_for_canvas_change. The edit is rejected with revision_conflict if the document changed first.',
};

const objectSchema = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const tool = (name, description, inputSchema, options = {}) => ({
  name,
  description,
  inputSchema,
  annotations: {
    readOnlyHint: !!options.readOnly,
    destructiveHint: !!options.destructive,
    idempotentHint: !!options.idempotent,
    openWorldHint: false,
  },
});

const noArgs = objectSchema();
const docOnly = objectSchema({ document_id: docId }, ['document_id']);

export const tools = [
  tool(
    'photoshop_ping',
    'Check whether the owner\'s Windows Photoshop bridge and Photoshop scripting connection are responsive. Never launches Photoshop.',
    noArgs,
    { readOnly: true, idempotent: true },
  ),
  tool(
    'photoshop_get_state',
    'Read open documents, the active document id, active layer, canvas dimensions, and selection state. Call this before every edit and pass the returned document id to the editing tool.',
    objectSchema({ document_id: nullableDocId }),
    { readOnly: true, idempotent: true },
  ),
  tool(
    'photoshop_get_preview',
    'Return a fresh JPEG preview of a Photoshop document for visual verification. Does not modify or save the document.',
    objectSchema({
      document_id: nullableDocId,
      max_dimension_px: number('Maximum preview long edge in pixels.', 256, 1600),
      quality: number('JPEG quality from 1 to 12.', 1, 12),
    }),
    { readOnly: true, idempotent: true },
  ),
  tool(
    'photoshop_get_layers',
    'List layers in the selected document with names, kinds, visibility, opacity, and hierarchy.',
    docOnly,
    { readOnly: true, idempotent: true },
  ),
  tool(
    'photoshop_get_history',
    'Read the document history stack to decide how many undo or redo steps are appropriate.',
    docOnly,
    { readOnly: true, idempotent: true },
  ),
  tool(
    'photoshop_create_document',
    'Create a new unsaved Photoshop document. This does not open, overwrite, or save any existing file.',
    objectSchema({
      width: number('Width in pixels.', 1, 12000),
      height: number('Height in pixels.', 1, 12000),
      resolution: number('Resolution in DPI.', 1, 1200),
      colorMode: { type: 'string', enum: ['RGB', 'CMYK', 'Grayscale'] },
    }),
  ),
  tool(
    'photoshop_create_layer',
    'Create a new empty paint layer above the active layer.',
    objectSchema({ document_id: docId, name: string('Optional layer name.') }, ['document_id']),
  ),
  tool(
    'photoshop_duplicate_layer',
    'Duplicate the active layer. The duplicate becomes active.',
    objectSchema({ document_id: docId, newName: string('Optional name for the duplicate.') }, ['document_id']),
  ),
  tool(
    'photoshop_select_layer_by_name',
    'Select a layer by its exact case-sensitive name before painting, transforming, or changing its properties.',
    objectSchema({ document_id: docId, name: string('Exact layer name.') }, ['document_id', 'name']),
    { idempotent: true },
  ),
  tool(
    'photoshop_rename_layer',
    'Rename the active layer without changing pixels.',
    objectSchema({ document_id: docId, name: string('New layer name.') }, ['document_id', 'name']),
    { idempotent: true },
  ),
  tool(
    'photoshop_set_layer_opacity',
    'Set the active layer opacity to an absolute 0-100 value.',
    objectSchema({ document_id: docId, opacity: number('Opacity percentage.', 0, 100) }, ['document_id', 'opacity']),
    { idempotent: true },
  ),
  tool(
    'photoshop_set_layer_blend_mode',
    'Set the active layer blend mode.',
    objectSchema({
      document_id: docId,
      blendMode: {
        type: 'string',
        enum: ['NORMAL', 'DISSOLVE', 'DARKEN', 'MULTIPLY', 'COLORBURN', 'LINEARBURN', 'DARKERCOLOR', 'LIGHTEN', 'SCREEN', 'COLORDODGE', 'LINEARDODGE', 'LIGHTERCOLOR', 'OVERLAY', 'SOFTLIGHT', 'HARDLIGHT', 'VIVIDLIGHT', 'LINEARLIGHT', 'PINLIGHT', 'HARDMIX', 'DIFFERENCE', 'EXCLUSION', 'SUBTRACT', 'DIVIDE', 'HUE', 'SATURATION', 'COLOR', 'LUMINOSITY'],
      },
    }, ['document_id', 'blendMode']),
    { idempotent: true },
  ),
  tool(
    'photoshop_set_layer_visibility',
    'Show or hide the active layer.',
    objectSchema({ document_id: docId, visible: { type: 'boolean' } }, ['document_id', 'visible']),
    { idempotent: true },
  ),
  tool(
    'photoshop_select_rectangle',
    'Create or combine a rectangular pixel selection using document-pixel coordinates.',
    objectSchema({
      document_id: docId,
      left: number('Left edge in pixels.'),
      top: number('Top edge in pixels.'),
      right: number('Right edge in pixels.'),
      bottom: number('Bottom edge in pixels.'),
      mode: { type: 'string', enum: ['replace', 'add', 'subtract', 'intersect'] },
    }, ['document_id', 'left', 'top', 'right', 'bottom']),
  ),
  tool(
    'photoshop_select_ellipse',
    'Create an anti-aliased elliptical pixel selection inside a document-pixel bounding box.',
    objectSchema({
      document_id: docId,
      left: number('Left edge in pixels.'),
      top: number('Top edge in pixels.'),
      right: number('Right edge in pixels.'),
      bottom: number('Bottom edge in pixels.'),
    }, ['document_id', 'left', 'top', 'right', 'bottom']),
  ),
  tool('photoshop_select_all', 'Select the whole canvas without changing pixels.', docOnly, { idempotent: true }),
  tool('photoshop_deselect', 'Clear the current pixel selection without changing pixels.', docOnly, { idempotent: true }),
  tool('photoshop_invert_selection', 'Invert the current pixel selection without changing pixels.', docOnly),
  tool(
    'photoshop_feather_selection',
    'Soften the current selection edge by a pixel radius.',
    objectSchema({ document_id: docId, pixels: number('Feather radius in pixels.', 1, 1000) }, ['document_id', 'pixels']),
  ),
  tool(
    'photoshop_expand_selection',
    'Expand the current selection outward by a number of pixels.',
    objectSchema({ document_id: docId, pixels: number('Expansion in pixels.', 1, 10000) }, ['document_id', 'pixels']),
  ),
  tool(
    'photoshop_contract_selection',
    'Contract the current selection inward by a number of pixels.',
    objectSchema({ document_id: docId, pixels: number('Contraction in pixels.', 1, 10000) }, ['document_id', 'pixels']),
  ),
  tool(
    'photoshop_fill_layer',
    'Paint-bucket equivalent for reliable flat coloring: fill the current selection, or the whole active layer when no selection exists, with an RGB color. Reversible with Undo.',
    objectSchema({
      document_id: docId,
      red: number('Red channel.', 0, 255),
      green: number('Green channel.', 0, 255),
      blue: number('Blue channel.', 0, 255),
    }, ['document_id', 'red', 'green', 'blue']),
    { destructive: true, idempotent: true },
  ),
  tool(
    'photoshop_fill_gradient',
    'Paint a two-color linear gradient on the current selection or active layer. Reversible with Undo.',
    objectSchema({
      document_id: docId,
      fromRed: number('Start red channel.', 0, 255),
      fromGreen: number('Start green channel.', 0, 255),
      fromBlue: number('Start blue channel.', 0, 255),
      toRed: number('End red channel.', 0, 255),
      toGreen: number('End green channel.', 0, 255),
      toBlue: number('End blue channel.', 0, 255),
      direction: { type: 'string', enum: ['left_to_right', 'right_to_left', 'top_to_bottom', 'bottom_to_top'] },
    }, ['document_id', 'fromRed', 'fromGreen', 'fromBlue', 'toRed', 'toGreen', 'toBlue']),
    { destructive: true, idempotent: true },
  ),
  tool(
    'photoshop_draw_brush_strokes',
    'Draw one or more verified raster strokes along document-pixel paths. The local bridge converts each path to an anti-aliased Photoshop selection and uses native pixel fill, then verifies pixel bounds. Supports opacity, flow, spacing, smoothing, roundness, simulated or per-point pressure. A requested current-brush preset is reported as a transparent raster fallback because this bounded interface does not expose Photoshop\'s arbitrary native brush scripting. Reversible with Undo.',
    objectSchema({
      document_id: docId,
      red: number('Brush red channel.', 0, 255),
      green: number('Brush green channel.', 0, 255),
      blue: number('Brush blue channel.', 0, 255),
      size: number('Round brush diameter in pixels.', 1, 1000),
      hardness: number('Edge hardness percentage. Lower values feather the rasterized stroke.', 0, 100),
      opacity: number('Stroke opacity percentage. Default 100.', 0.1, 100),
      flow: number('Flow percentage multiplied into each raster fill. Default 100.', 0.1, 100),
      spacing: number('Path resampling spacing as a percentage of brush diameter. Default 25.', 5, 500),
      smoothing: number('Polyline smoothing percentage. Default 0.', 0, 100),
      roundness: number('Brush cross-section roundness percentage. Default 100.', 1, 100),
      simulate_pressure: { type: 'boolean', description: 'Taper the stroke like stylus pressure. Default false.' },
      use_current_brush_preset: { type: 'boolean', description: 'Request the current Photoshop preset when possible. The bounded raster engine reports an explicit fallback when it cannot use it.' },
      strokes: {
        type: 'array',
        minItems: 1,
        maxItems: 32,
        items: objectSchema({
          points: {
            type: 'array',
            minItems: 2,
            maxItems: 256,
            items: objectSchema({
              x: number('X coordinate in document pixels.', -100000, 100000),
              y: number('Y coordinate in document pixels.', -100000, 100000),
              pressure: number('Optional stylus pressure from 0.01 to 1.', 0.01, 1),
            }, ['x', 'y']),
          },
        }, ['points']),
      },
    }, ['document_id', 'red', 'green', 'blue', 'size', 'hardness', 'strokes']),
    { destructive: true },
  ),
  tool(
    'photoshop_move_layer',
    'Move the active layer by a pixel offset.',
    objectSchema({ document_id: docId, deltaX: number('Horizontal offset in pixels.'), deltaY: number('Vertical offset in pixels.') }, ['document_id', 'deltaX', 'deltaY']),
  ),
  tool(
    'photoshop_scale_layer',
    'Scale the active layer by a percentage around its center or top-left anchor.',
    objectSchema({
      document_id: docId,
      scalePercent: number('Scale percentage.', 1, 10000),
      centerAnchor: { type: 'boolean', description: 'True to scale from center; false for top-left.' },
    }, ['document_id', 'scalePercent']),
    { destructive: true },
  ),
  tool(
    'photoshop_rotate_layer',
    'Rotate the active layer around its center; positive degrees rotate clockwise.',
    objectSchema({ document_id: docId, degrees: number('Rotation angle in degrees.', -36000, 36000) }, ['document_id', 'degrees']),
    { destructive: true },
  ),
  tool(
    'photoshop_undo',
    'Undo one or more history steps in the selected document.',
    objectSchema({ document_id: docId, steps: number('Number of history steps.', 1, 100) }, ['document_id']),
    { destructive: true },
  ),
  tool(
    'photoshop_redo',
    'Redo one or more previously undone history steps in the selected document.',
    objectSchema({ document_id: docId, steps: number('Number of history steps.', 1, 100) }, ['document_id']),
    { destructive: true },
  ),
  tool(
    'photoshop_wait_for_canvas_change',
    'Long-poll the active Photoshop tab until the specified document canvas changes. Returns a monotonic revision, inferred change type, active layer, and approximate dirty bounds. Multiple changes inside one sampling interval may be coalesced. A quiet document returns timeout=true, not an error. This never blocks Photoshop with a sleeping script.',
    objectSchema({
      document_id: docId,
      since_revision: number('Cursor from photoshop_get_state or a prior wait result.', 0),
      timeout_seconds: number('Long-poll timeout in seconds. Default 30.', 20, 60),
      poll_interval_ms: number('Sampling interval in milliseconds. Default 1000.', 500, 5000),
    }, ['document_id']),
    { readOnly: true },
  ),
  tool(
    'photoshop_get_region_preview',
    'Return a fresh JPEG preview of only a document-pixel rectangle. Use dirty_bounds from photoshop_wait_for_canvas_change to avoid transferring the full canvas. The source document is not modified or saved.',
    objectSchema({
      document_id: docId,
      left: number('Left edge in document pixels.', 0),
      top: number('Top edge in document pixels.', 0),
      right: number('Right edge in document pixels.', 1),
      bottom: number('Bottom edge in document pixels.', 1),
      max_dimension_px: number('Maximum long edge of the returned region preview. Default 1024.', 128, 1600),
      quality: number('JPEG quality from 1 to 12. Default 7.', 1, 12),
    }, ['document_id', 'left', 'top', 'right', 'bottom']),
    { readOnly: true, idempotent: true },
  ),
  tool(
    'photoshop_save',
    'Save the selected document to its current existing file path. Unsaved documents are rejected with save_as_required. No path is inferred and no other document is saved.',
    docOnly,
    { idempotent: true },
  ),
  tool(
    'photoshop_save_as',
    'Write the selected document to an explicit absolute PSD, PNG, or JPG path. overwrite is mandatory and an existing file is rejected unless overwrite=true. PSD retargets the working document; PNG/JPG are written as copies so layers in the open document remain intact.',
    objectSchema({
      document_id: docId,
      path: filePathString('Explicit absolute Windows destination path with matching extension.'),
      format: { type: 'string', enum: ['PSD', 'PNG', 'JPG'] },
      quality: number('JPEG quality from 1 to 12. Default 8.', 1, 12),
      overwrite: { type: 'boolean', description: 'Must be true to replace an existing file; false is safe for new paths.' },
    }, ['document_id', 'path', 'format', 'overwrite']),
    { destructive: true },
  ),
  tool(
    'photoshop_export',
    'Export a rendered PNG or JPG copy to an explicit absolute path without changing the open working document. overwrite is mandatory; no existing file is silently replaced.',
    objectSchema({
      document_id: docId,
      path: filePathString('Explicit absolute Windows export path with matching extension.'),
      format: { type: 'string', enum: ['PNG', 'JPG'] },
      quality: number('Export quality from 0 to 100. Default 90.', 0, 100),
      overwrite: { type: 'boolean', description: 'Must be true to replace an existing file; false is safe for new paths.' },
    }, ['document_id', 'path', 'format', 'overwrite']),
    { destructive: true },
  ),
  tool(
    'photoshop_list_documents',
    'List every open Photoshop document with id, name, path when available, dimensions, saved/dirty state, and active status. Does not switch tabs.',
    noArgs,
    { readOnly: true, idempotent: true },
  ),
  tool(
    'photoshop_activate_document',
    'Activate an exact open Photoshop document by id. Does not edit pixels or save the file.',
    docOnly,
    { idempotent: true },
  ),
  tool(
    'photoshop_close_document',
    'Close an exact Photoshop document. save_changes is mandatory. Saving is refused for an unsaved document until photoshop_save_as supplies an explicit path.',
    objectSchema({
      document_id: docId,
      save_changes: { type: 'boolean', description: 'True saves to an existing path before closing; false explicitly discards unsaved changes.' },
    }, ['document_id', 'save_changes']),
    { destructive: true },
  ),
  tool(
    'photoshop_create_text_layer',
    'Create a text layer at an absolute document-pixel position with verified text, size, optional installed font, alignment, RGB color, opacity, and layer name. A missing requested font returns font_not_found before the layer is created.',
    objectSchema({
      document_id: docId,
      text: longString('Text contents.'),
      x: number('Text anchor X in document pixels.', -100000, 100000),
      y: number('Text anchor Y in document pixels.', -100000, 100000),
      font_size: number('Font size in points.', 1, 2000),
      font_family: string('Optional installed font display, family, or PostScript name.'),
      alignment: { type: 'string', enum: ['LEFT', 'CENTER', 'RIGHT', 'LEFTJUSTIFIED', 'CENTERJUSTIFIED', 'RIGHTJUSTIFIED', 'FULLYJUSTIFIED'] },
      red: number('Text red channel.', 0, 255),
      green: number('Text green channel.', 0, 255),
      blue: number('Text blue channel.', 0, 255),
      opacity: number('Layer opacity percentage. Default 100.', 0, 100),
      layer_name: string('Layer name. Default Text.'),
    }, ['document_id', 'text', 'x', 'y', 'font_size', 'red', 'green', 'blue']),
  ),
  tool(
    'photoshop_edit_text_layer',
    'Edit one uniquely named text layer: replace text, move its absolute anchor, change size/font/alignment/RGB color/opacity, or rename it. A missing font or duplicate layer name returns a structured error before edits begin.',
    objectSchema({
      document_id: docId,
      layer_name: string('Exact current text-layer name.'),
      text: longString('Replacement text contents.'),
      x: number('New absolute text anchor X.', -100000, 100000),
      y: number('New absolute text anchor Y.', -100000, 100000),
      font_size: number('New font size in points.', 1, 2000),
      font_family: string('Installed font display, family, or PostScript name.'),
      alignment: { type: 'string', enum: ['LEFT', 'CENTER', 'RIGHT', 'LEFTJUSTIFIED', 'CENTERJUSTIFIED', 'RIGHTJUSTIFIED', 'FULLYJUSTIFIED'] },
      red: number('Text red channel; supply all RGB channels together.', 0, 255),
      green: number('Text green channel; supply all RGB channels together.', 0, 255),
      blue: number('Text blue channel; supply all RGB channels together.', 0, 255),
      opacity: number('Layer opacity percentage.', 0, 100),
      new_layer_name: string('Optional replacement layer name.'),
    }, ['document_id', 'layer_name']),
  ),
  tool(
    'photoshop_erase_strokes',
    'Erase verified raster strokes from the active normal pixel layer along document-pixel paths. Supports opacity, flow, spacing, smoothing, roundness, simulated pressure, and per-point pressure. The call fails if no visible pixel or bounds change can be verified. Reversible with Undo.',
    objectSchema({
      document_id: docId,
      size: number('Eraser diameter in pixels.', 1, 1000),
      hardness: number('Edge hardness percentage.', 0, 100),
      opacity: number('Erase opacity percentage. Default 100.', 0.1, 100),
      flow: number('Erase flow percentage. Default 100.', 0.1, 100),
      spacing: number('Path resampling spacing percentage. Default 25.', 5, 500),
      smoothing: number('Polyline smoothing percentage. Default 0.', 0, 100),
      roundness: number('Eraser roundness percentage. Default 100.', 1, 100),
      simulate_pressure: { type: 'boolean' },
      use_current_brush_preset: { type: 'boolean' },
      strokes: {
        type: 'array', minItems: 1, maxItems: 32,
        items: objectSchema({
          points: {
            type: 'array', minItems: 2, maxItems: 256,
            items: objectSchema({
              x: number('X coordinate in document pixels.', -100000, 100000),
              y: number('Y coordinate in document pixels.', -100000, 100000),
              pressure: number('Optional stylus pressure from 0.01 to 1.', 0.01, 1),
            }, ['x', 'y']),
          },
        }, ['points']),
      },
    }, ['document_id', 'size', 'hardness', 'strokes']),
    { destructive: true },
  ),
  tool(
    'photoshop_delete_layer',
    'Delete one uniquely named layer or group and verify that its layer id is absent afterward. Duplicate names are rejected to prevent deleting the wrong layer. Reversible with Undo while history retains the state.',
    objectSchema({ document_id: docId, layer_name: string('Exact unique layer or group name.') }, ['document_id', 'layer_name']),
    { destructive: true },
  ),
  tool(
    'photoshop_create_group',
    'Create and activate a new Photoshop layer group. Useful for separate user and ChatGPT painting areas.',
    objectSchema({ document_id: docId, group_name: string('New group name, for example User or AI.') }, ['document_id', 'group_name']),
  ),
  tool(
    'photoshop_move_layer_into_group',
    'Move one uniquely named layer or group inside one uniquely named target group and verify its new parent. Duplicate names are rejected.',
    objectSchema({
      document_id: docId,
      layer_name: string('Exact unique layer or group to move.'),
      group_name: string('Exact unique destination group.'),
    }, ['document_id', 'layer_name', 'group_name']),
    { destructive: true },
  ),
  tool(
    'photoshop_resize_canvas',
    'Resize the Photoshop canvas to exact pixel dimensions without resampling layer pixels. Supports nine anchors and verifies the resulting dimensions. Reversible with Undo.',
    objectSchema({
      document_id: docId,
      width: number('New canvas width in pixels.', 1, 30000),
      height: number('New canvas height in pixels.', 1, 30000),
      anchor: { type: 'string', enum: ['top_left', 'top_center', 'top_right', 'middle_left', 'center', 'middle_right', 'bottom_left', 'bottom_center', 'bottom_right'] },
    }, ['document_id', 'width', 'height']),
    { destructive: true },
  ),
  tool(
    'photoshop_resize_image',
    'Resample the whole document and all layers to exact pixel dimensions using Photoshop bicubic resizing. Reversible with Undo.',
    objectSchema({ document_id: docId, width: number('New image width in pixels.', 1, 30000), height: number('New image height in pixels.', 1, 30000) }, ['document_id', 'width', 'height']),
    { destructive: true },
  ),
  tool(
    'photoshop_crop',
    'Crop the whole document to an explicit document-pixel rectangle. Pixels outside the rectangle are removed. Reversible with Undo.',
    objectSchema({
      document_id: docId,
      left: number('Left crop edge.', 0),
      top: number('Top crop edge.', 0),
      right: number('Right crop edge.', 1),
      bottom: number('Bottom crop edge.', 1),
    }, ['document_id', 'left', 'top', 'right', 'bottom']),
    { destructive: true },
  ),
  tool(
    'photoshop_rotate_canvas',
    'Rotate the full Photoshop canvas by an angle in degrees and report verified before/after dimensions. Reversible with Undo.',
    objectSchema({ document_id: docId, degrees: number('Rotation in degrees; positive follows Photoshop rotateCanvas convention.', -360, 360) }, ['document_id', 'degrees']),
    { destructive: true },
  ),
  tool(
    'photoshop_start_collab_session',
    'Start a lightweight local collaboration context for one document. Records revision, optional ChatGPT/user layer or group names, and last dirty bounds; it does not create a network sync session or edit Photoshop.',
    objectSchema({
      document_id: docId,
      assistant_layer_or_group: string('Optional ChatGPT-owned layer or group name.'),
      user_layer_or_group: string('Optional user-owned layer or group name.'),
    }, ['document_id']),
    { readOnly: true },
  ),
  tool(
    'photoshop_end_collab_session',
    'End one lightweight local collaboration context without changing Photoshop.',
    objectSchema({ document_id: docId, session_id: string('Session id returned by photoshop_start_collab_session.') }, ['document_id', 'session_id']),
    { readOnly: true, idempotent: true },
  ),
];

const revisionAwareTools = new Set([
  'photoshop_create_layer', 'photoshop_duplicate_layer', 'photoshop_select_layer_by_name',
  'photoshop_rename_layer', 'photoshop_set_layer_opacity', 'photoshop_set_layer_blend_mode',
  'photoshop_set_layer_visibility', 'photoshop_select_rectangle', 'photoshop_select_ellipse',
  'photoshop_select_all', 'photoshop_deselect', 'photoshop_invert_selection',
  'photoshop_feather_selection', 'photoshop_expand_selection', 'photoshop_contract_selection',
  'photoshop_fill_layer', 'photoshop_fill_gradient', 'photoshop_draw_brush_strokes',
  'photoshop_erase_strokes', 'photoshop_move_layer', 'photoshop_scale_layer',
  'photoshop_rotate_layer', 'photoshop_undo', 'photoshop_redo', 'photoshop_save',
  'photoshop_save_as', 'photoshop_export', 'photoshop_close_document',
  'photoshop_create_text_layer', 'photoshop_edit_text_layer', 'photoshop_delete_layer',
  'photoshop_create_group', 'photoshop_move_layer_into_group', 'photoshop_resize_canvas',
  'photoshop_resize_image', 'photoshop_crop', 'photoshop_rotate_canvas',
]);

for (const definition of tools) {
  if (revisionAwareTools.has(definition.name)) definition.inputSchema.properties.expected_revision = expectedRevision;
}

export const allowed = new Set(tools.map(item => item.name));

const typeMatches = (value, type) => {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
};

const validateValue = (value, schema, path) => {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.some(type => typeMatches(value, type))) return `${path} has the wrong type`;
  if (value === null) return null;
  if (schema.enum && !schema.enum.includes(value)) return `${path} is not an allowed value`;
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} is below the minimum`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} is above the maximum`;
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${path} is too short`;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${path} is too long`;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${path} has too few items`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} has too many items`;
    for (let i = 0; i < value.length; i += 1) {
      const error = validateValue(value[i], schema.items, `${path}[${i}]`);
      if (error) return error;
    }
  }
  if (types.includes('object') && value !== null && !Array.isArray(value)) {
    const properties = schema.properties || {};
    for (const key of schema.required || []) if (!(key in value)) return `${path}.${key} is required`;
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in properties)) return `${path}.${key} is not allowed`;
    }
    for (const [key, child] of Object.entries(value)) {
      if (properties[key]) {
        const error = validateValue(child, properties[key], `${path}.${key}`);
        if (error) return error;
      }
    }
  }
  return null;
};

export const validateArguments = (name, args) => {
  const definition = tools.find(item => item.name === name);
  if (!definition) return 'Tool not allowed';
  return validateValue(args, definition.inputSchema, 'arguments');
};
