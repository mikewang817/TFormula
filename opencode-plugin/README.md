# TFormula OpenCode V2 image board

This TUI-only plugin lets OpenCode users select a local image referenced in
the active conversation. TFormula remains responsible for image validation,
Kitty graphics, cursor restoration, and focus lifecycle.

## Install and run

Build the plugin using the OpenCode V2.2.2 SDK pinned in `package.json`:

```sh
npm install --prefix opencode-plugin --ignore-scripts --legacy-peer-deps
npm run build --prefix opencode-plugin
npm run build
OPENCODE_CLI_CONFIG_CONTENT='{"plugins":["/home/green_gdut/GR_tools/TFormula/opencode-plugin"]}' \
  node dist/cli.js --image-focus-key none -- opencode --standalone
```

The plugin package exports `./tui` and uses `@opencode/plugin/tui`'s
`Plugin.define({ id, setup })`. `--image-focus-key none` allows OpenCode to
receive Ctrl-\\; otherwise the outer TFormula proxy consumes it first.
The pinned V2 SDK requires OpenTUI 0.7.0 peers. These peers may warn about
Node 22 engine support; the real OpenCode V2.2.2 PTY test below passed on
Node 22, but test again when changing either dependency version.

Inside a session, press Ctrl-\\ or run `/tformula-images`. The board lists
local image paths found in user attachments, assistant text, and completed
tool output in the active session. Selecting an entry sends it to this
TFormula proxy instance's focus renderer. Network URLs are not fetched.

## Bridge contract

The proxy generates a unique `TFORMULA_IMAGE_SELECTION_PATH` for each child
process. The plugin atomically writes a JSON record there on selection:

```ts
interface TFormulaImageSelection {
  protocol: "tformula.image-selection.v1";
  sessionID: string;
  path: string;
  messageID?: string;
  selectedAt: number;
}
```

The proxy validates the protocol and timestamp and calls
`FormulaScreen.focusImagePath(path)`. That method performs local file checks
before uploading via Kitty. The proxy removes its selection file on exit.
Do not make the plugin write Kitty APC packets or use a global fixed
selection file: either breaks ownership or allows one TFormula instance to
preview another instance's selection.

## Verification

Against a real OpenCode V2.2.2 standalone TUI in a PTY:

- The plugin loaded without a `Plugin failed` warning.
- Sending Ctrl-\\ (`0x1c`) inside a session with images displayed a
  `TFormula images` board with three local image candidates.
- Selecting `test0.jpg` wrote a `tformula.image-selection.v1` record with
  the active session ID and the selected absolute path. A separate PTY proxy
  test confirms the record produces a Kitty focus placement and is removed
  when the proxy exits.

`npx vitest run opencode-plugin/test/tui.integration.test.ts` covers command
registration, candidate collection and record writing. A final visual check
in a graphics-capable terminal is still needed for placement appearance.
