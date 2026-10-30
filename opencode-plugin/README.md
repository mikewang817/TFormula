# TFormula OpenCode TUI Plugin

This package is the OpenCode-side image selection board for TFormula. It is
kept separate from the terminal PTY wrapper because OpenCode plugins do not own
the raw terminal stream or Kitty placement lifecycle.

## Current Behavior

- Registers `Ctrl-\` and `/tformula-images` inside an OpenCode session.
- Reads local image candidates from current-session `file` parts and Markdown
  image references in text parts.
- Opens an OpenCode `DialogSelect` board.
- Stores the selected image as `tformula.image-selection.v1` under the TUI KV
  key `tformula.last-image-selection`.
- Atomically writes the same record to
  `/tmp/tformula-opencode-image-selection.json`, which the TFormula PTY wrapper
  watches and routes through its existing Kitty focus renderer.

## Loading

For a TUI-only local plugin, add the directory to OpenCode's `cli.json` plugin
list using an absolute path or symlinked package directory. The plugin package
exports `./tui` and targets OpenCode v2.2.x's installed
`@opencode-ai/plugin` API.

## TFormula Bridge Contract

The selector and TFormula deliberately communicate through this versioned
record rather than sharing internal classes:

```ts
interface TFormulaImageSelection {
  protocol: "tformula.image-selection.v1";
  sessionID: string;
  path: string;
  partID?: string;
  messageID?: string;
  selectedAt: number;
}
```

The current PTY wrapper remains authoritative for Kitty rendering, image
validation, focus placement, cursor restoration, and alternate-screen safety.
The shared file contains no PNG data; the wrapper revalidates the path before
rendering. The plugin must not write Kitty APC sequences directly.

## API Basis

Validated against the local OpenCode v2.2.2 installation and
`@opencode-ai/plugin` 1.18.30:

- `api.state.session.messages(sessionID)`
- `api.state.part(messageID)`
- `api.ui.DialogSelect`
- `api.ui.dialog.replace()` / `clear()`
- `api.command.register()` for the currently compatible keyboard command layer
- `api.kv.set()`

The installed declaration documents newer `api.keymap.registerLayer` methods
but does not expose them on its `TuiKeymap` type. This implementation uses the
runtime-compatible command registration until that API mismatch is resolved.
