# Reddit post — r/Ghostty

**Status:** Draft  
**Post type:** Short screen recording or split-pane image post  
**Disclosure:** Post from the TFormula creator  
**Relationship to the previous post:** Follow-up showing the new document-reader
workflow rather than repeating the formula-rendering announcement  
**Publishing note:** Use new split-pane media and leave a few days between the
two posts so this reads as a substantial workflow update, not a repost

## Recommended title

My current Ghostty study setup: rendered notes on the left, any CLI agent on the right

## Alternative titles

- I added a document reader to TFormula—now my Ghostty panes form one learning workspace
- The formula renderer was only half of it: my new split-pane study workflow in Ghostty

## Body

Recently I shared TFormula rendering LaTeX from terminal programs
directly inside Ghostty. Formula rendering turned out to be only half of the
workflow I wanted.

I learn new technical material by reading until I reach the first thing I cannot
explain, then asking a very specific question and adding the answer back to my
notes. I now do that with two Ghostty panes:

```bash
# Left pane: read the evolving document
tformula maxwell-equations.md

# Right pane: ask questions and work on the document
tformula codex
```

Codex is just the command in this example. The right pane can use Claude Code,
Gemini CLI, OpenCode, Aider, or another terminal tool. TFormula does not depend
on any particular agent.

The left pane is TFormula’s new full-screen document reader. It parses the local
Markdown and lays it out again for the current pane width, including headings,
lists, tables, code, links, scientific formulas, and local images. It also has a
table of contents, search, heading navigation, and a source-view toggle.

The part that made this setup click for me is live reload. The reader watches
the document and its local images. If I edit the note—or ask the agent in the
right pane to expand a derivation, add an example, or clarify a section—the left
pane refreshes after the file is saved. It keeps my reading position and image
zoom, so I do not have to close the reader or find my place again.

My loop is now:

1. Read the structured note on the left.
2. Stop at the exact sentence or equation I do not understand.
3. Discuss that point with whichever CLI tool is useful on the right.
4. Check the explanation, units, assumptions, and sources.
5. Update the Markdown and continue reading from the same place.

The conversation helps me explore, but the Markdown file becomes the durable
result. That distinction matters to me: TFormula makes the material easier to
work with, but it does not make an agent’s answer correct.

You can also wrap the entire shell instead of individual commands:

```bash
tformula --shell
```

Install:

```bash
npm install -g tformula --allow-scripts=node-pty --allow-scripts=sharp
```

Ghostty remains the primary development and test target. Kitty and WezTerm are
also supported through the Kitty graphics protocol.

GitHub: https://github.com/mikewang817/TFormula  
npm: https://www.npmjs.com/package/tformula

Does anyone else use Ghostty panes this way for learning or research? I’d be
interested in what would make the handoff between the document pane and the
conversation pane feel even more natural.

## Media plan — not part of the Reddit body

### Recommended: 8–12 second screen recording

1. Open one Ghostty window with a vertical split.
2. In the left pane, run `tformula maxwell-equations.md` and stop at the Lorentz
   force section or another visually strong equation.
3. In the right pane, run `tformula codex` or another agent and ask it to add a
   short clarification or worked example to that section.
4. Show the file being saved and the left reader refreshing automatically
   without jumping back to the top.
5. End with both panes visible long enough to read their roles.

### Static-image fallback

- Use a real Ghostty vertical split rather than compositing two unrelated
  screenshots.
- Keep the left pane slightly wider so the rendered document remains legible.
- Show the same topic in both panes: the document on the left and a focused
  follow-up question on the right.
- Avoid displaying installation output; the visual should communicate the
  learning workflow immediately.
- Capture at a high enough resolution that the formula and the conversation can
  both be read in Reddit’s image viewer.
