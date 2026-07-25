# Agent output corpus

This directory contains terminal-output fixtures used by TFormula's formula-layout golden tests.

## Provenance states

- `captured`: copied from an actual Agent terminal response and then minimally anonymized.
- `session-derived`: reconstructed from an identified local Agent session while preserving the formula and terminal layout pattern.
- `pending`: metadata placeholder only; never loaded as golden evidence.

A fixture must not be labelled `captured` merely because it resembles an Agent's style.

## Redaction rules

Remove or replace all user names, home paths, repository names, session IDs, API keys, account identifiers, URLs containing private tokens, and proprietary prose. Preserve:

- ANSI/CSI control bytes that affect terminal geometry;
- terminal columns and rows;
- line wrapping and blank rows;
- formula delimiters and exact LaTeX;
- generic status/input-bar text when it affects borrowing safety.

Redactions use stable placeholders such as `<USER>`, `<REPO>`, and `<SESSION>`. Never change string length inside a line unless the fixture's expected terminal-cell snapshot is regenerated and reviewed.

## Schema

Captured `.json` files contain:

- `version`, `id`, `agent`;
- `provenance.kind` and an auditable note;
- fixed `geometry`;
- the exact `ansi` stream;
- `expected` semantic formulas, mapped physical source, placement plans, and Kitty cell geometry.

Files ending in `.pending.json` document missing collection work and are excluded from tests.
