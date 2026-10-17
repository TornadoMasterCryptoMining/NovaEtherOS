# NovaEtherOS design

The contract for every screen of the dashboard. Change it here first, then in code.

## Brief

- **Audience:** the owner of a personal home server that runs a Bitcoin node, a solo mining pool, Bitaxe-class miners and a local AI. Technical, checks in from a laptop or phone on the home network.
- **First ten seconds:** is the node synced, are the miners hashing to my pool, is anything broken.
- **Category:** infrastructure / operations console. Dense, quiet, trustworthy.

## Direction: Precision

| Decision | Value |
| --- | --- |
| Accent | teal, OKLCH hue 185, chroma 0.12 (generated, `palette.mjs --hue 185 --chroma 0.12 --neutral-chroma 0.006`) |
| Neutrals | cool, chroma 0.006 |
| Type | Geist (UI) + Geist Mono (labels, figures, addresses, code) |
| Scale | 1.200 app scale; body 14px, small 13px, label 11px mono caps +0.06em |
| Radius | 4 / 6 / 10 (controls 6, cards 10) |
| Density | controls 36px (32px dense), table rows 40px |
| Mode | dark-first; light and automatic supported |
| Elevation | 1px hairlines; shadows only on floating layers (mobile menu) |

## Layout: mission control

- No sidebar. One sticky header: brand and live status (node, fleet hashrate, chain tip, theme) on top, a tab bar for the eight sections below it. On phones the tab bar scrolls sideways.
- The Overview is a single operations screen, top to bottom: the chain timeline (the block being built, then the latest blocks, bar height = how full each block is), three instruments in one hairline-divided strip (fleet hashrate with a 24 h chart, node, machine), the live miner table, then activity log beside Nova AI and apps.
- Other sections keep a page title and panels; data views use tables with mono caps headers and right-aligned figures.

## Signature: block height is the clock

The top bar has no wall clock. It shows the chain tip from the owner's own node (`#971,171 · 4 min`) and a 2px hairline under the bar that fills over the ten minutes a block takes on average and resets when a new block arrives. Everything in NovaEtherOS is timed by blocks, so the interface is too.

Supporting moves: monospace caps micro-labels, status as a small dot plus words, figures always in tabular mono.

## Rules

- The accent marks the primary action, links, selection, focus and the chain-tip hairline. Nothing else.
- Status colours (`success`, `warning`, `danger`) mean status only. Bitcoin orange is not used.
- No gradients, glows, glass, emoji or pulse loops. Icons: one line set, 16 / 20px, stroke 1.75.
- Apps without a real logo get a neutral monogram tile.
- Spacing only from 4, 8, 12, 16, 24, 32, 48, 64 (2 and 6 allowed inside controls).
- Every data view has loading (skeleton), empty and error states.
- Copy: sentence case, buttons start with a verb, no exclamation marks.

## Open items

- `{{needs: real app logos}}`: App Store apps use monogram tiles until official marks are added.
