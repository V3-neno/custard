# Mock widget plugins

Test fixtures for the widget host (docs/plugins/WIDGETS.md). They are copied
into the plugin folder by `test/e2e/widgets.mjs` and are not shipped.

- `tally`: a list-style counter. Reads its count with a read tool, adds with
  a write tool (needs a click, then the usual approval), refreshes while
  visible.
- `gauge`: a canvas meter drawn only from the assistant's input. No tool
  calls; compact and expanded presentations.
- `broken`: one widget that throws on mount and one that never finishes
  mounting, to check that failures stay inside the widget's area.
