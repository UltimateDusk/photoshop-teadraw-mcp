# Tool surface

TeaDraw MCP 0.3.0 exposes 49 curated tools.

## State and previews

- `photoshop_ping`
- `photoshop_get_state`
- `photoshop_get_preview`
- `photoshop_get_region_preview`
- `photoshop_get_layers`
- `photoshop_get_history`
- `photoshop_wait_for_canvas_change`

## Documents and files

- `photoshop_create_document`
- `photoshop_list_documents`
- `photoshop_activate_document`
- `photoshop_close_document`
- `photoshop_save`
- `photoshop_save_as`
- `photoshop_export`

## Layers, groups, and text

- `photoshop_create_layer`
- `photoshop_duplicate_layer`
- `photoshop_delete_layer`
- `photoshop_select_layer_by_name`
- `photoshop_rename_layer`
- `photoshop_set_layer_opacity`
- `photoshop_set_layer_blend_mode`
- `photoshop_set_layer_visibility`
- `photoshop_create_group`
- `photoshop_move_layer_into_group`
- `photoshop_create_text_layer`
- `photoshop_edit_text_layer`

## Painting and selection

- `photoshop_draw_brush_strokes`
- `photoshop_erase_strokes`
- `photoshop_fill_layer`
- `photoshop_fill_gradient`
- `photoshop_select_rectangle`
- `photoshop_select_ellipse`
- `photoshop_select_all`
- `photoshop_deselect`
- `photoshop_invert_selection`
- `photoshop_feather_selection`
- `photoshop_expand_selection`
- `photoshop_contract_selection`

## Transforms and history

- `photoshop_move_layer`
- `photoshop_scale_layer`
- `photoshop_rotate_layer`
- `photoshop_resize_canvas`
- `photoshop_resize_image`
- `photoshop_crop`
- `photoshop_rotate_canvas`
- `photoshop_undo`
- `photoshop_redo`

## Collaboration context

- `photoshop_start_collab_session`
- `photoshop_end_collab_session`

Every document edit requires a positive `document_id`. Revision-aware operations accept optional `expected_revision`; a mismatch returns `revision_conflict` and recommends `photoshop_get_state`.
