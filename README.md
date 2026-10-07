# Retro

An anonymous retrospective built with Go and SvelteKit. Create a room, share its link, and reflect together on a kanban board. Everyone can edit; no accounts, admins, or database.

## Run locally

Requires Go 1.24.5+ and Node 22.17+ (Node 24 recommended).

```sh
cd ui
npm ci
npm run dev
```

In a second terminal:

```sh
cd backend
go run .
```

Open http://localhost:5173. Vite proxies API requests and WebSockets to Go on port 8080. Browsers synchronize through the Go WebSocket server; there is no direct peer connection or STUN/TURN configuration.

## Production

### Docker Compose

From the repository root:

```sh
docker compose up --build -d
```

Open http://localhost:4120 (or `http://<server-ip>:4120`). The image builds the UI and Go service, then runs a single Go process serving both the built UI and `/api/socket`. Port 4120 is published on all host interfaces. Node is only used during the build; the running container contains the Go binary and static UI files.

Point your home server's existing HTTPS reverse proxy at port 4120 and forward WebSocket upgrades for `/api/socket`. The Compose setup includes no proxy or additional services. Run the same command again to rebuild after pulling updates; stop it with `docker compose down`.

### Without Docker

```sh
cd ui
npm ci
npm run build
cd ../backend
go build -o ../dist/retro .
STATIC_DIR=../ui/build ../dist/retro
```

`go build` creates the output directory. Go serves the static frontend and APIs on port 8080. Deploy the binary and `ui/build` together, and set `STATIC_DIR` to the build directory. Put an HTTPS reverse proxy in front of Go and forward WebSocket upgrades for `/api/socket`.

| Environment variable | Default / purpose |
| --- | --- |
| `ADDR` | `:8080`, HTTP listen address |
| `STATIC_DIR` | `../ui/build`, relative to the process working directory |
| `ALLOWED_ORIGINS` | Empty: same-origin WebSockets only. Comma-separated additional origin host patterns, such as `localhost:5173` |

The initial release supports 20 simultaneous connections per retrospective. Run one Go instance: room membership is in memory, so independent instances do not share broadcasts. During server outages, browsers keep editing locally and reconnect automatically with exponential backoff. All rooms are removed after their last connection leaves.

## State and synchronization

A link has the form `/#v=1&r=<room>&k=<secret>&s=<compressed-snapshot>`. The fragment contains a complete gzip-compressed snapshot plus a random session ID and secret. The fragment is never sent with HTTP requests. The server receives a room ID and encrypted state messages. It relays those messages to the other connected browsers and does not save or decrypt the retrospective.

Browsers exchange state through `/api/socket`. On joining or reconnecting, each browser sends its complete snapshot, and existing participants send theirs to the newcomer; afterward Go broadcasts changed registers to everyone else in the room. Periodic snapshots repair missed updates. Each browser automatically replaces its own URL with its latest merged snapshot. **Copy link** waits for the latest encoding before copying it. Browser storage holds only a random voting identity for each room.

Merging preserves concurrent additions. Editable fields use hybrid logical clocks (browser milliseconds, a logical counter, and a random actor ID); the latest field wins. A card's location and order are one field. Deleted items carry permanent deletion markers so older snapshots cannot restore them. Deleting a column deletes its known cards and hides concurrently added cards still assigned to it. Offline conflicts use client clocks, so substantially incorrect clocks can affect which conflicting edit wins.

Each person gets five votes by default and can stack them on one card. The allowance can be changed to 0–100. Ballots occupy numbered slots: lowering the allowance hides slots beyond the limit, and raising it can restore them. Deleting a card releases its slots. Separate tabs sharing the same voting identity merge each slot independently and cannot create extra counted slots.

The **Export** dropdown offers **Markdown (.md)** and **CSV (.csv)** downloads of the current board and action items. Markdown includes the retrospective title, voting allowance, total votes, and a table preserving column and card order, including empty columns. Each card shows its current vote count. Action items follow the table as a checklist showing completion status in creation order. Multiline text and special characters are escaped to keep the output intact. CSV exports one row per card or action with `Card`, `Column`, `Votes`, `Order`, `Type`, and `Completed`, preserving multiline text and Unicode. Card rows use `Type=Card` and leave `Completed` blank. Action rows put their title in `Card`, use `Column=Action items` and `Type=Action`, leave `Votes` blank, and set `Completed` to `true` or `false`. `Order` starts at 1 within each column or the action list. Deleted cards and actions are omitted. To recreate a board in Notion, import the CSV, set `Column` and `Type` to Select and `Votes` and `Order` to Number, then add a board view grouped by `Column` and sorted by `Order`. Filter by `Type=Card` to show only cards. Empty columns have no CSV rows and need adding manually. Exports contain anonymous totals and board content; use **Copy link** to save a session you can reopen and edit.

The **Action items** list beneath the board lets everyone write next steps after voting, check or uncheck them, and remove actions using the × button. Actions, completion status, and removals synchronize with participants and are included in saved links. Actions stay in creation order, including concurrent additions, and are independent of the board columns and voting.

The room has a shared countdown, initially set to three minutes. Click the countdown to set minutes and seconds, then start a fresh round. The stop button freezes the remaining time for everyone and changes to a start button that resumes from that remaining time. Click outside the popover or press Escape to close it. Timer state syncs with the room and saved links, so joining or reloading continues the same countdown. It stays at `00:00` when finished, with no automatic action or restriction on editing or voting. Countdown accuracy depends on participants' device clocks.

A saved link is a snapshot, not a permanently updated address. An old link recovers newer changes only from a connected browser holding them. Once everyone leaves, the server retains nothing. Save the latest link before closing the last tab. Links get longer as content and deletion markers accumulate; the app warns after 8 KiB and never truncates them. Some messaging tools may truncate long links. Incoming snapshots are limited to 8 MiB after decompression.

Anonymity is in the interface: no names or creator labels. Technical identifiers and voting slots are visible to someone inspecting shared state. Everyone with the full link can participate. The allowance applies to browser identities; another browser or clearing local storage creates a new identity.

## Verification

```sh
cd backend
go test -race ./...
cd ../ui
npm run check
npm test
npm run build
npm exec -- playwright install chromium
npm run test:e2e
npm run lint
```

Unit tests cover merge laws, field conflicts, deletions, ordering, voting, URL restoration, invalid links, and encoding races. Go tests cover WebSocket relaying, room isolation, broadcasts, capacity, and cleanup. Browser integration tests start their own Go process on port 18080 and use separate Chromium contexts to test stale links, bidirectional sync, voting, card movement, creator departure, standalone restoration, offline merging, and remembered voting identities. Screenshots are saved in the system temporary directory.

The browser suite also verifies synchronization when WebRTC is unavailable. It runs without external services or network configuration. URL links created by the earlier WebRTC version remain compatible; restart Go and reload existing tabs to use the WebSocket transport.
