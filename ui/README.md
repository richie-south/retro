# Retro frontend

SvelteKit 3 / Svelte 5 with TypeScript, compiled as a static site served by Go.

See the [project README](../README.md) for setup, architecture, configuration, and testing.

- `src/lib/state.ts`: mergeable registers, logical timestamps, ordering, and ballots.
- `src/lib/url.ts`: compressed URL snapshots and revision-safe URL updates.
- `src/lib/realtime.ts`: encrypted state exchange through the Go WebSocket relay.
- `src/lib/dnd.ts`: Pragmatic Drag and Drop actions, insertion targets, and auto-scrolling.
- `src/routes/+page.svelte`: landing page and collaborative kanban interface.

Drag cards by their grip. The destination column and insertion line show where the card will land. **Move card** provides keyboard and touch controls, with focus restoration and screen-reader announcements. Deleting a card or column requires **OK** in a confirmation dialog; deleting a column also removes its cards.
