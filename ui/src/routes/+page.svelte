<script lang="ts">
	import { onMount, tick } from 'svelte';
	import {
		announce,
		cleanup as cleanupAnnouncements
	} from '@atlaskit/pragmatic-drag-and-drop-live-region';
	import { cardDrag, columnDrop, boardScroll, watchCards, type Destination } from '#lib/dnd.js';
	import { createSnapshot, difference, Model, MAX_VOTES, type Snapshot } from '#lib/state.js';
	import { decodeSession, newRoom, newSecret, URLWriter, type Session } from '#lib/url.js';
	import { SocketNetwork, type ConnectionStatus } from '#lib/realtime.js';
	import { boardMarkdown } from '#lib/markdown.js';
	import { boardCSV } from '#lib/csv.js';
	import { exportFilename, type ExportFormat } from '#lib/export.js';
	import SharedTimer from '#lib/SharedTimer.svelte';

	let model = $state.raw<Model | null>(null);
	let revision = $state(0);
	let voter = '';
	let secret = '';
	let network: SocketNetwork | undefined;
	let writer: URLWriter | undefined;
	let loading = $state(true);
	let showLoading = $state(false);
	let error = $state('');
	let notice = $state('');
	let urlLength = $state(0);
	let connection = $state<ConnectionStatus>({
		status: 'Connecting',
		participants: 1,
		connected: false,
		error: ''
	});
	const connectionError = $derived(connection.error);
	let delayedConnectionError = $state('');
	let newColumn = $state('');
	let newAction = $state('');
	let drafts = $state<Record<string, string>>({});
	let dragged = $state('');
	let dragTarget = $state<Destination | null>(null);
	let deleteRequest = $state<{ kind: 'card' | 'column'; id: string; title: string } | null>(null);
	let shareDialog = $state(false);
	let shareURL = $state('');
	let exportOpen = $state(false);
	let exportMenu = $state<HTMLDetailsElement>();
	let exportToggle = $state<HTMLElement>();
	let generation = 0;
	let noticeTimer: ReturnType<typeof setTimeout>;

	$effect(() => {
		showLoading = false;
		if (!loading) return;
		const timer = setTimeout(() => (showLoading = true), 300);
		return () => clearTimeout(timer);
	});

	$effect(() => {
		delayedConnectionError = '';
		const message = connectionError;
		if (!message) return;
		const timer = setTimeout(() => (delayedConnectionError = message), 300);
		return () => clearTimeout(timer);
	});

	const view = $derived.by(() => {
		revision;
		if (!model) return null;
		return {
			title: model.title,
			limit: model.limit,
			timer: model.timer,
			remaining: model.remaining(voter),
			actions: model.actions(),
			columns: model.columns().map((column) => ({
				...column,
				cards: model!.cards(column.id).map((card) => ({
					...card,
					votes: model!.votes(card.id),
					mine: model!.votes(card.id, voter)
				}))
			}))
		};
	});

	function flash(message: string) {
		notice = message;
		clearTimeout(noticeTimer);
		noticeTimer = setTimeout(() => (notice = ''), 4000);
	}
	function showShare(dialog: HTMLDialogElement) {
		dialog.showModal();
	}
	// Incoming votes or unrelated edits must not overwrite a title being typed locally.
	function editable(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
		let latest = value;
		let focused = false;
		node.value = value;
		const focus = () => {
			focused = true;
		};
		const blur = () => {
			focused = false;
			node.value = latest;
		};
		node.addEventListener('focus', focus);
		node.addEventListener('blur', blur);
		return {
			update(value: string) {
				latest = value;
				if (!focused) node.value = value;
			},
			destroy() {
				node.removeEventListener('focus', focus);
				node.removeEventListener('blur', blur);
			}
		};
	}
	function autosize(node: HTMLTextAreaElement, _value: string | undefined) {
		let width = 0;
		const resize = () => {
			if (!node.isConnected) return;
			node.style.height = 'auto';
			const style = getComputedStyle(node);
			const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
			node.style.height = `${Math.ceil(node.scrollHeight + borders)}px`;
		};
		// Wait for editable values and bound drafts to update before measuring.
		const schedule = () => queueMicrotask(resize);
		const observer = new ResizeObserver(([entry]) => {
			if (entry.contentRect.width !== width) {
				width = entry.contentRect.width;
				resize();
			}
		});
		observer.observe(node);
		node.addEventListener('input', resize);
		node.addEventListener('blur', schedule);
		schedule();
		return {
			update: schedule,
			destroy() {
				observer.disconnect();
				node.removeEventListener('input', resize);
				node.removeEventListener('blur', schedule);
			}
		};
	}
	function edit(action: (model: Model) => void) {
		if (!model) return;
		const before = structuredClone(model.state);
		action(model);
		const delta = difference(model.state, before);
		if (!Object.keys(delta.registers).length) return;
		revision++;
		writer?.schedule({ state: model.state, secret });
		network?.broadcast(delta);
	}
	function receive(state: Snapshot): Snapshot {
		if (!model) throw new Error('No session is open.');
		const delta = model.receive(state);
		if (Object.keys(delta.registers).length) {
			revision++;
			writer?.schedule({ state: model.state, secret });
		}
		return delta;
	}
	function cleanup() {
		exportOpen = false;
		network?.stop();
		writer?.destroy();
		network = undefined;
		writer = undefined;
	}
	async function activate(session: Session) {
		cleanup();
		deleteRequest = null;
		dragged = '';
		dragTarget = null;
		error = '';
		notice = '';
		drafts = {};
		newColumn = '';
		newAction = '';
		model = new Model(session.state);
		secret = session.secret;
		const identityKey = `retro:voter:${session.state.room}`;
		try {
			voter = localStorage.getItem(identityKey) ?? '';
			if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(voter)) {
				voter = crypto.randomUUID();
				localStorage.setItem(identityKey, voter);
			}
		} catch {
			voter = crypto.randomUUID();
			flash('Browser storage is unavailable; your voting identity lasts for this visit.');
		}
		revision++;
		writer = new URLWriter(
			(hash) => {
				history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
				urlLength = location.href.length;
			},
			(message) => (error = message)
		);
		writer.schedule({ state: model.state, secret });
		network = new SocketNetwork(model.state.room, secret, {
			snapshot: () => model!.state,
			receive,
			status: (status) => (connection = status)
		});
		loading = false;
		void network.start();
		try {
			await writer.flush();
		} catch {
			/* The writer reports the recoverable URL error. */
		}
	}
	async function load() {
		const current = ++generation;
		if (!location.hash) {
			cleanup();
			model = null;
			loading = false;
			error = '';
			return;
		}
		loading = true;
		try {
			const session = await decodeSession(location.hash);
			if (current !== generation) return;
			if (model?.state.room === session.state.room && secret === session.secret) {
				receive(session.state);
				loading = false;
			} else await activate(session);
		} catch (cause) {
			if (current !== generation) return;
			cleanup();
			model = null;
			loading = false;
			error = cause instanceof Error ? cause.message : 'Could not open this link.';
		}
	}
	async function create() {
		generation++;
		loading = true;
		await activate({ state: createSnapshot(newRoom()), secret: newSecret() });
	}
	async function copy() {
		try {
			await writer!.flush();
			shareURL = location.href;
			try {
				await navigator.clipboard.writeText(shareURL);
				flash('Latest link copied. Anyone with it can join.');
			} catch {
				shareDialog = true;
			}
		} catch {
			/* URL failures are displayed by the writer. */
		}
	}
	function exportBoard(format: ExportFormat) {
		if (!model) return;
		const content = format === 'markdown' ? boardMarkdown(model) : boardCSV(model);
		const mime = format === 'markdown' ? 'text/markdown' : 'text/csv';
		const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
		const link = document.createElement('a');
		link.href = url;
		link.download = exportFilename(model.title, format);
		document.body.append(link);
		link.click();
		link.remove();
		// Give the browser time to begin reading the download before releasing its URL.
		setTimeout(() => URL.revokeObjectURL(url), 1000);
		exportOpen = false;
		exportToggle?.focus();
		flash(`${format === 'markdown' ? 'Markdown' : 'CSV'} exported.`);
	}
	function addCard(columnId: string) {
		const title = drafts[columnId]?.trim();
		if (!title) return;
		edit((m) => m.addCard(columnId, title));
		drafts[columnId] = '';
	}
	function sortByVotes() {
		edit((m) => m.sortCardsByVotes());
		announce('Sorted all columns by votes, most votes first.');
	}
	function addAction() {
		if (!newAction.trim()) return;
		edit((m) => m.addAction(newAction));
		newAction = '';
	}
	function deleteColumn(id: string) {
		const column = view?.columns.find((c) => c.id === id);
		if (column) deleteRequest = { kind: 'column', id, title: column.title };
	}
	function deleteCard(id: string, title: string) {
		deleteRequest = { kind: 'card', id, title };
	}
	function confirmDelete() {
		if (!deleteRequest) return;
		const { kind, id } = deleteRequest;
		edit((m) => (kind === 'column' ? m.deleteColumn(id) : m.deleteCard(id)));
		deleteRequest = null;
	}
	async function placeCard(id: string, columnId: string, beforeId?: string, restoreFocus = false) {
		const card = model?.cards().find((card) => card.id === id);
		const column = model?.columns().find((column) => column.id === columnId);
		if (!card || !column) return;
		const current = model!.cards(card.location.columnId);
		const index = current.findIndex((card) => card.id === id);
		if (card.location.columnId === columnId && current[index + 1]?.id === beforeId) return;
		edit((m) => m.moveCard(id, columnId, beforeId));
		const cards = model!.cards(columnId);
		announce(
			`Moved ${card.title} to ${column.title}, position ${cards.findIndex((card) => card.id === id) + 1} of ${cards.length}.`
		);
		if (restoreFocus) {
			await tick();
			const menu = document.querySelector<HTMLDetailsElement>(`[data-card-id="${id}"] .move-menu`);
			if (menu) {
				menu.open = true;
				menu.querySelector<HTMLElement>('summary')?.focus();
			}
		}
	}
	function moveCard(id: string, columnId: string, direction: -1 | 1) {
		const cards = model!.cards(columnId),
			index = cards.findIndex((c) => c.id === id),
			target = index + direction;
		if (target < 0 || target >= cards.length) return;
		const others = cards.filter((c) => c.id !== id);
		void placeCard(id, columnId, others[target]?.id, true);
	}
	onMount(() => {
		const stopWatching = watchCards({
			room: () => model?.state.room,
			cards: (columnId) => model?.cards(columnId) ?? [],
			preview: (id, target) => {
				dragged = id;
				dragTarget = target;
			},
			drop: (id, target) => {
				void placeCard(id, target.columnId, target.beforeId);
			}
		});
		void load();
		window.addEventListener('hashchange', load);
		return () => {
			generation++;
			cleanup();
			stopWatching();
			cleanupAnnouncements();
			clearTimeout(noticeTimer);
			window.removeEventListener('hashchange', load);
		};
	});
</script>

<svelte:window
	onclick={(event) => {
		if (exportOpen && event.target instanceof Node && !exportMenu?.contains(event.target))
			exportOpen = false;
	}}
	onkeydown={(event) => {
		if (exportOpen && event.key === 'Escape') {
			exportOpen = false;
			exportToggle?.focus();
		}
	}}
/>

<svelte:head>
	<title>{view ? `${view.title} · Retro` : 'Retro'}</title>
	<meta
		name="description"
		content="An anonymous retrospective, shared through a link, with no database."
	/>
</svelte:head>

<div class="app">
	<header class="topbar">
		<a class="brand" href="/" data-sveltekit-reload aria-label="Retro home"
			><span class="brand-icon">r</span> retro<span class="brand-dot">.</span></a
		>
		{#if !loading && view}
			<input
				class="retro-title"
				aria-label="Retrospective title"
				use:editable={view.title}
				maxlength="120"
				onchange={(e) => {
					edit((m) => m.setTitle(e.currentTarget.value));
					e.currentTarget.value = model!.title;
				}}
			/>
			<div class="workspace-actions">
				<details
					class="export-dropdown"
					bind:this={exportMenu}
					bind:open={exportOpen}
					onfocusout={(event) => {
						if (event.relatedTarget instanceof Node && !exportMenu?.contains(event.relatedTarget))
							exportOpen = false;
					}}
				>
					<summary class="button secondary" bind:this={exportToggle} aria-label="Export">
						Export <span aria-hidden="true">▾</span>
					</summary>
					<div class="export-options" role="group" aria-label="Export formats">
						<button onclick={() => exportBoard('markdown')}>Markdown (.md)</button>
						<button onclick={() => exportBoard('csv')}>CSV (.csv)</button>
					</div>
				</details>

				<button class="button primary" onclick={copy}>Copy link <span>↗</span></button>
			</div>
		{/if}
	</header>

	{#if loading}
		{#if showLoading}
			<main class="landing">
				<div class="eyebrow">ONE MOMENT</div>
				<h1>Opening your room…</h1>
			</main>
		{/if}
	{:else if !view}
		<main class="landing">
			<h1>Good teams<br />keep <em>reflecting.</em></h1>
			<p>
				A simple, anonymous space to share what worked,<br class="desktop" /> what could be better, and
				what comes next.
			</p>
			<button class="button primary start" onclick={create}>New retrospective <span>↗</span></button
			>
			<p class="footnote">No sign-up. No database. Just a link and your team.</p>
			{#if error}<div class="message error" role="alert">
					{error} Create a new retrospective or open another saved link.
				</div>{/if}
			<div class="preview" aria-hidden="true">
				{#each ['Went well', 'Could improve', 'Actions'] as title, i}
					<div class="preview-column">
						<div class="column-label"><span class="column-dot color-{i}"></span>{title}</div>
						<div class="preview-card">
							{['We helped each other out', 'Make more time for focus', 'Try a quieter morning'][
								i
							]}<span>＋ {3 - i}</span>
						</div>
					</div>
				{/each}
			</div>
		</main>
	{:else}
		<main class="workspace">
			<div class="session-bar">
				<div class="connection">
					{#if !connection.connected}
						<span>{connection.status}</span>
						<span class="divider">/</span>
					{/if}
					<span
						>{connection.participants}
						{connection.participants === 1 ? 'participant' : 'participants'}</span
					>
				</div>
				<div class="session-timer">
					{#key model!.state.room}
						<SharedTimer
							timer={view.timer}
							onstart={(duration) => edit((m) => m.startTimer(duration))}
							onstop={() => edit((m) => m.stopTimer())}
							onresume={() => edit((m) => m.resumeTimer())}
						/>
					{/key}
				</div>
				<div class="voting">
					<label for="vote-limit">Votes per person</label><input
						id="vote-limit"
						type="number"
						min="0"
						max={MAX_VOTES}
						value={view.limit}
						onchange={(e) => {
							edit((m) => m.setLimit(Number(e.currentTarget.value)));
							e.currentTarget.value = String(model!.limit);
						}}
					/><span class="vote-balance">{view.remaining} left for you</span>
				</div>
				<button
					class="button secondary small session-sort"
					title="Sort cards in all columns by most votes first"
					disabled={!view.columns.some((column) => column.cards.length > 1)}
					onclick={sortByVotes}>Sort by votes <span aria-hidden="true">↓</span></button
				>
			</div>
			{#if error}<div class="message error" role="alert">{error}</div>{/if}
			{#if delayedConnectionError}<div class="message" role="status">
					{delayedConnectionError}
				</div>{/if}
			{#if urlLength > 8192}<div class="message" role="status">
					This link is getting long. Some messaging apps may truncate it; make sure you share the
					complete link.
				</div>{/if}
			<div class="board" use:boardScroll>
				{#each view.columns as column, columnIndex (column.id)}
					<section
						class="column"
						class:drop-column={dragTarget?.columnId === column.id}
						data-column-id={column.id}
						aria-label={column.title}
						use:columnDrop={{ room: model!.state.room, columnId: column.id }}
					>
						<div class="column-heading">
							<span class="column-dot color-{columnIndex % 3}"></span><input
								class="column-title"
								aria-label="Column title"
								use:editable={column.title}
								maxlength="120"
								onchange={(e) => {
									edit((m) => m.renameColumn(column.id, e.currentTarget.value));
									if (!e.currentTarget.value.trim()) e.currentTarget.value = column.title;
								}}
							/><span class="count">{column.cards.length}</span>
						</div>
						<div class="column-controls">
							<button
								class="text-button"
								aria-label={`Move ${column.title} left`}
								disabled={columnIndex === 0}
								onclick={() => edit((m) => m.moveColumn(column.id, -1))}>←</button
							><button
								class="text-button"
								aria-label={`Move ${column.title} right`}
								disabled={columnIndex === view!.columns.length - 1}
								onclick={() => edit((m) => m.moveColumn(column.id, 1))}>→</button
							><button
								class="text-button delete-column"
								aria-label={`Delete ${column.title}`}
								onclick={() => deleteColumn(column.id)}>Delete column</button
							>
						</div>
						<div class="cards">
							{#each column.cards as card, cardIndex (card.id)}
								<article
									class="card"
									class:dragging={dragged === card.id}
									data-card-id={card.id}
									aria-label={card.title}
									use:cardDrag={{ room: model!.state.room, columnId: column.id, cardId: card.id }}
								>
									{#if dragTarget?.columnId === column.id && dragTarget.beforeId === card.id}
										<div class="drop-indicator" aria-hidden="true"></div>
									{/if}
									<span class="drag-handle" aria-hidden="true" title="Drag to move">⠿</span>
									<textarea
										class="card-title"
										aria-label="Card title"
										use:editable={card.title}
										use:autosize={card.title}
										maxlength="500"
										rows="1"
										onchange={(e) => {
											edit((m) => m.renameCard(card.id, e.currentTarget.value));
											if (!e.currentTarget.value.trim()) e.currentTarget.value = card.title;
										}}></textarea>
									<div class="card-bottom">
										<div class="vote-controls">
											<button
												class="vote-button"
												aria-label={`Add vote to ${card.title}`}
												disabled={view!.remaining === 0}
												onclick={() => edit((m) => m.vote(voter, card.id, 1))}>＋</button
											><span class="vote-total" aria-label={`${card.votes} votes`}
												>{card.votes}</span
											><button
												class="vote-button minus"
												aria-label={`Remove your vote from ${card.title}`}
												disabled={card.mine === 0}
												onclick={() => edit((m) => m.vote(voter, card.id, -1))}>−</button
											>{#if card.mine}<span class="mine">{card.mine} yours</span>{/if}
										</div>
										<details class="move-menu">
											<summary aria-label={`Move card ${card.title}`}>Move card</summary>
											<div class="move-controls">
												<button
													class="text-button"
													aria-label={`Move ${card.title} up`}
													disabled={cardIndex === 0}
													onclick={() => moveCard(card.id, column.id, -1)}>↑ Up</button
												><button
													class="text-button"
													aria-label={`Move ${card.title} down`}
													disabled={cardIndex === column.cards.length - 1}
													onclick={() => moveCard(card.id, column.id, 1)}>↓ Down</button
												><select
													aria-label={`Move ${card.title} to column`}
													value={column.id}
													onchange={(e) => {
														void placeCard(card.id, e.currentTarget.value, undefined, true);
													}}
													>{#each view!.columns as target}<option value={target.id}
															>{target.title}</option
														>{/each}</select
												>
											</div>
										</details>
										<button
											class="text-button"
											aria-label={`Delete card ${card.title}`}
											onclick={() => deleteCard(card.id, card.title)}>×</button
										>
									</div>
								</article>
							{/each}
							{#if dragTarget?.columnId === column.id && !dragTarget.beforeId}
								<div class="drop-end" aria-hidden="true"><div class="drop-indicator"></div></div>
							{/if}
							{#if column.cards.length === 0}<div class="empty-column">No cards yet</div>{/if}
						</div>
						<form
							class="add-card"
							onsubmit={(e) => {
								e.preventDefault();
								addCard(column.id);
							}}
						>
							<textarea
								aria-label={`New card in ${column.title}`}
								placeholder="What's on your mind?"
								maxlength="500"
								rows="1"
								use:autosize={drafts[column.id]}
								onkeydown={(event) => {
									if (
										event.key === 'Enter' &&
										(event.metaKey || event.ctrlKey) &&
										!event.isComposing
									) {
										event.preventDefault();
										if (!event.repeat) addCard(column.id);
									}
								}}
								bind:value={drafts[column.id]}></textarea><button
								class="button add-button"
								type="submit"
								disabled={!drafts[column.id]?.trim()}>＋ Add card</button
							>
						</form>
					</section>
				{/each}
				<form
					class="add-column"
					onsubmit={(e) => {
						e.preventDefault();
						if (newColumn.trim()) {
							edit((m) => m.addColumn(newColumn));
							newColumn = '';
						}
					}}
				>
					<label for="new-column">New column</label><input
						id="new-column"
						placeholder="Column title"
						maxlength="120"
						bind:value={newColumn}
					/><button class="button secondary" type="submit" disabled={!newColumn.trim()}
						>＋ Add column</button
					>
				</form>
			</div>
			<section class="actions" aria-labelledby="actions-title">
				<h2 id="actions-title">Action items</h2>
				{#if view.actions.length}
					<ul class="action-list">
						{#each view.actions as action (action.id)}
							<li>
								<label class="action-item" class:completed={action.completed}>
									<input
										type="checkbox"
										checked={action.completed}
										onchange={(e) =>
											edit((m) => m.setActionCompleted(action.id, e.currentTarget.checked))}
									/>
									<span>{action.title}</span>
								</label>
								<button
									class="text-button remove-action"
									aria-label={`Remove action ${action.title}`}
									title="Remove action"
									onclick={() => edit((m) => m.deleteAction(action.id))}>×</button
								>
							</li>
						{/each}
					</ul>
				{/if}
				<form
					class="add-action"
					onsubmit={(e) => {
						e.preventDefault();
						addAction();
					}}
				>
					<div class="add-action-controls">
						<input
							id="new-action"
							aria-label="New action"
							placeholder="New action"
							maxlength="500"
							bind:value={newAction}
						/>
						<button class="button primary" type="submit" disabled={!newAction.trim()}
							>＋ Add action</button
						>
					</div>
				</form>
			</section>
		</main>
	{/if}
	{#if notice}<div class="toast" role="status">{notice}</div>{/if}
	{#if deleteRequest}
		<dialog
			class="share-modal delete-modal"
			use:showShare
			oncancel={() => (deleteRequest = null)}
			aria-labelledby="delete-title"
			aria-describedby="delete-description"
		>
			<h2 id="delete-title">Delete {deleteRequest.kind}?</h2>
			<p id="delete-description">
				{#if deleteRequest.kind === 'column'}Deleting “{deleteRequest.title}” removes the column and
					all its cards for everyone.{:else}Deleting “{deleteRequest.title}” removes this card for
					everyone.{/if} This cannot be undone.
			</p>
			<div class="dialog-actions">
				<button class="button secondary" onclick={() => (deleteRequest = null)}>Cancel</button>
				<button class="button danger" onclick={confirmDelete}>OK</button>
			</div>
		</dialog>
	{/if}
	{#if shareDialog}<dialog
			class="share-modal"
			use:showShare
			oncancel={() => (shareDialog = false)}
			aria-label="Share retrospective"
		>
			<h2>Share your room</h2>
			<p>Copy this complete link to invite your team.</p>
			<textarea
				aria-label="Latest retrospective link"
				readonly
				value={shareURL}
				onfocus={(e) => e.currentTarget.select()}></textarea><button
				class="button primary"
				onclick={() => (shareDialog = false)}>Done</button
			>
		</dialog>{/if}
</div>

<style>
	:global(*) {
		box-sizing: border-box;
	}
	:global(body) {
		margin: 0;
		background: #f8f7f3;
		color: #253b34;
		font-family:
			Inter,
			ui-sans-serif,
			-apple-system,
			BlinkMacSystemFont,
			'Segoe UI',
			sans-serif;
		font-size: 14px;
	}
	:global(button),
	:global(input),
	:global(textarea),
	:global(select) {
		font: inherit;
	}
	:global(button) {
		cursor: pointer;
	}
	:global(button:disabled) {
		cursor: default;
		opacity: 0.38;
	}
	:global(input),
	:global(textarea),
	:global(select) {
		color: inherit;
	}
	:global(button:focus-visible),
	:global(input:focus-visible),
	:global(textarea:focus-visible),
	:global(select:focus-visible),
	:global(summary:focus-visible),
	:global(a:focus-visible) {
		outline: 2px solid #3e8065;
		outline-offset: 3px;
	}
	:global(textarea) {
		resize: vertical;
	}
	.topbar {
		min-height: 88px;
		border-bottom: 1px solid #e5e7df;
		display: grid;
		grid-template-columns: minmax(240px, 1fr) minmax(0, 2fr) minmax(240px, 1fr);
		align-items: center;
		gap: 16px 24px;
		padding: 16px 5vw;
	}
	.brand {
		display: flex;
		align-items: center;
		text-decoration: none;
		color: #253b34;
		font-size: 25px;
		letter-spacing: -1px;
		font-weight: 750;
		gap: 9px;
	}
	.brand-icon {
		background: #284f3e;
		color: #f9f6e9;
		border-radius: 9px;
		display: grid;
		place-items: center;
		width: 30px;
		height: 32px;
		font-family: Georgia, serif;
		font-style: italic;
		font-size: 29px;
	}
	.brand-dot {
		color: #698f5c;
		margin-left: -10px;
	}
	.button {
		border: 0;
		border-radius: 7px;
		padding: 12px 18px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 25px;
		font-weight: 600;
		transition: background 0.15s;
	}
	.primary {
		background: #284f3e;
		color: #fffdf3;
	}
	.primary:hover {
		background: #34664f;
	}
	.secondary {
		border: 1px solid #d5dbce;
		background: transparent;
		color: #385442;
	}
	.small {
		font-size: 12px;
		padding: 10px 14px;
	}
	.landing {
		max-width: 1030px;
		margin: 0 auto;
		text-align: center;
		padding: 75px 24px 40px;
	}
	.eyebrow {
		font-size: 10px;
		letter-spacing: 2px;
		color: #7c8771;
		font-weight: 650;
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.landing > .eyebrow {
		justify-content: center;
	}
	h1 {
		font-family: Georgia, 'Times New Roman', serif;
		font-size: clamp(48px, 6vw, 78px);
		font-weight: 400;
		line-height: 1.08;
		letter-spacing: -3px;
		margin: 25px 0;
	}
	h1 em {
		color: #739262;
		font-weight: 400;
	}
	.landing > p {
		font-size: 16px;
		color: #7c867c;
		line-height: 1.7;
	}
	.start {
		margin: 19px 0 2px;
		padding: 16px 23px;
	}
	.landing > .footnote {
		font-size: 11px;
		margin-top: 15px;
		color: #989f92;
	}
	.preview {
		display: flex;
		text-align: left;
		gap: 20px;
		margin: 60px auto 0;
		max-width: 800px;
		transform: rotate(-1deg);
	}
	.preview-column {
		padding: 17px;
		background: #f0f0e9;
		border: 1px solid #e7e8de;
		border-radius: 10px;
		flex: 1;
	}
	.column-label {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 12px;
		font-weight: 650;
	}
	.preview-card {
		background: #fffef9;
		padding: 20px 14px;
		border: 1px solid #e2e5da;
		border-radius: 7px;
		margin-top: 20px;
		font-size: 12px;
		box-shadow: 0 3px 3px #263e3210;
		line-height: 1.7;
	}
	.preview-card > span {
		display: block;
		color: #879774;
		font-size: 11px;
		margin-top: 15px;
	}
	.workspace {
		padding: 0 5vw 22px;
	}
	.workspace-actions {
		display: flex;
		justify-self: end;
		gap: 10px;
	}
	.export-dropdown {
		position: relative;
	}
	.export-dropdown summary {
		list-style: none;
		cursor: pointer;
	}
	.export-dropdown summary::-webkit-details-marker {
		display: none;
	}
	.export-options {
		position: absolute;
		top: calc(100% + 8px);
		left: 0;
		z-index: 10;
		min-width: 175px;
		padding: 5px;
		border: 1px solid #d8dfd1;
		border-radius: 8px;
		background: #fffef9;
		box-shadow: 0 5px 20px #1d3a3325;
	}
	.export-options button {
		display: block;
		width: 100%;
		border: 0;
		border-radius: 5px;
		padding: 11px 12px;
		background: transparent;
		color: #385442;
		text-align: left;
	}
	.export-options button:hover,
	.export-options button:focus-visible {
		background: #e8eddf;
	}
	.retro-title {
		min-width: 0;
		width: 100%;
		border: 0;
		border-radius: 5px;
		background: transparent;
		padding: 8px;
		font-size: 18px;
		font-weight: 500;
		color: #748070;
		text-align: center;
		text-overflow: ellipsis;
	}
	.retro-title:hover,
	.retro-title:focus {
		background: #eff0e9;
		color: #253b34;
	}
	.session-bar {
		display: grid;
		grid-template-columns: auto minmax(120px, 1fr) auto auto;
		align-items: center;
		gap: 20px;
		border-bottom: 1px solid #e2e5db;
		padding: 17px 0;
		margin: 0 0 28px;
		font-size: 11px;
		color: #748070;
	}
	.session-sort {
		justify-self: end;
		gap: 10px;
	}
	.session-timer {
		justify-self: center;
	}
	.connection,
	.voting {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.voting {
		flex-wrap: wrap;
		justify-self: end;
		justify-content: flex-end;
	}
	.divider {
		color: #ccd2c3;
		margin: 0 5px;
	}
	.voting input {
		width: 53px;
		border: 1px solid #d8dfd1;
		background: #fffef9;
		border-radius: 5px;
		padding: 6px;
	}
	.vote-balance {
		background: #e8eddf;
		color: #506841;
		border-radius: 20px;
		padding: 7px 13px;
		margin-left: 8px;
	}
	.board {
		display: flex;
		align-items: flex-start;
		gap: 22px;
		overflow-x: auto;
		padding-bottom: 20px;
		min-height: 430px;
	}
	.column {
		background: #eff0e9;
		border: 1px solid #e1e5d9;
		border-radius: 11px;
		padding: 19px 15px 15px;
		flex: 1 0 280px;
		min-width: 280px;
		max-width: 420px;
	}
	.column-heading {
		display: flex;
		align-items: center;
		gap: 9px;
	}
	.column-dot {
		height: 8px;
		width: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}
	.color-0 {
		background: #7d9e67;
	}
	.color-1 {
		background: #cfac63;
	}
	.color-2 {
		background: #899faf;
	}
	.column-title {
		border: 0;
		background: transparent;
		font-weight: 650;
		font-size: 13px;
		width: 100%;
		min-width: 0;
		padding: 4px 0;
	}
	.count {
		font-size: 10px;
		color: #8a947e;
		border-radius: 5px;
		background: #e3e7db;
		padding: 3px 7px;
	}
	.column-controls {
		display: flex;
		align-items: center;
		margin-top: 6px;
		margin-bottom: 12px;
	}
	.text-button {
		background: transparent;
		border: 0;
		color: #87977c;
		padding: 4px 7px;
		font-size: 12px;
		border-radius: 4px;
	}
	.text-button:hover {
		background: #e4e9dc;
	}
	.delete-column {
		font-size: 10px;
		margin-left: auto;
	}
	.cards {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 9px;
	}
	.card {
		position: relative;
		border: 1px solid #e0e4d7;
		border-radius: 7px;
		background: #fffef9;
		padding: 10px;
		box-shadow: 0 2px 3px #34433207;
	}
	.card.dragging {
		opacity: 0.4;
	}
	.column.drop-column {
		outline: 2px solid #477b59;
		outline-offset: -2px;
	}
	.drag-handle {
		position: absolute;
		top: 5px;
		right: 5px;
		width: 26px;
		height: 28px;
		text-align: center;
		font-size: 22px;
		color: #87977c;
		cursor: grab;
		user-select: none;
	}
	.drag-handle:active {
		cursor: grabbing;
	}
	.drop-indicator {
		position: absolute;
		top: -8px;
		left: 0;
		right: 0;
		height: 3px;
		background: #477b59;
		border-radius: 3px;
		pointer-events: none;
		z-index: 2;
	}
	.drop-indicator::before,
	.drop-indicator::after {
		content: '';
		position: absolute;
		top: -2px;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: #477b59;
	}
	.drop-indicator::before {
		left: -3px;
	}
	.drop-indicator::after {
		right: -3px;
	}
	.drop-end {
		position: absolute;
		bottom: -7px;
		left: 0;
		right: 0;
		pointer-events: none;
	}
	.drop-end .drop-indicator {
		top: 0;
	}
	.card-title {
		display: block;
		width: 100%;
		border: 0;
		background: transparent;
		font-size: 13px;
		line-height: 1.5;
		min-height: 24px;
		resize: none;
		overflow: hidden;
		padding: 0 24px 0 0;
	}
	.card-bottom {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
		margin-top: 7px;
	}
	.vote-controls {
		display: flex;
		gap: 4px;
		align-items: center;
	}
	.vote-button {
		border: 1px solid #dde4d5;
		background: #eef3e7;
		color: #688655;
		border-radius: 5px;
		width: 24px;
		height: 24px;
		padding: 0;
	}
	.minus {
		background: transparent;
	}
	.vote-total {
		font-size: 12px;
		min-width: 12px;
		text-align: center;
		color: #60764e;
		font-weight: 600;
	}
	.mine {
		font-size: 9px;
		color: #8f9d83;
		white-space: nowrap;
	}
	.move-menu {
		margin-left: auto;
		font-size: 10px;
		color: #98a08b;
	}
	.move-menu[open] {
		order: 1;
		flex-basis: 100%;
		margin-left: 0;
	}
	.move-menu summary {
		cursor: pointer;
		padding: 5px 0;
		white-space: nowrap;
	}
	.move-controls {
		display: flex;
		align-items: center;
		gap: 3px;
		margin-top: 7px;
	}
	.move-controls select {
		width: 100%;
		min-width: 0;
		border: 1px solid #e1e7d8;
		background: #f7f8f1;
		font-size: 10px;
		padding: 5px;
	}
	.empty-column {
		font-size: 11px;
		color: #a4ac98;
		padding: 30px 0 24px;
		text-align: center;
	}
	.add-card {
		margin-top: 12px;
	}
	.add-card textarea {
		display: block;
		width: 100%;
		background: #f9faf4;
		border: 1px dashed #d9dfd0;
		border-radius: 6px;
		padding: 8px 10px;
		font-size: 12px;
		line-height: 1.5;
		min-height: 38px;
		resize: none;
		overflow: hidden;
	}
	.add-card textarea::placeholder {
		color: #9ba58e;
	}
	.add-button {
		font-size: 11px;
		padding: 8px 10px;
		background: transparent;
		color: #6a8058;
		margin-top: 4px;
	}
	.add-column {
		flex: 0 0 175px;
		display: flex;
		flex-direction: column;
		gap: 11px;
		padding: 20px 0;
	}
	.add-column label {
		color: #8b9780;
		font-size: 11px;
	}
	.add-column input {
		border: 1px solid #dce2d4;
		padding: 11px;
		background: #fffef9;
		border-radius: 6px;
		width: 100%;
		font-size: 12px;
	}
	.add-column > .button {
		font-size: 11px;
		padding: 10px;
	}
	.actions {
		margin-top: 16px;
		padding: 24px;
		border: 1px solid #e1e5d9;
		border-radius: 11px;
		background: #fffef9;
	}
	.actions h2 {
		margin: 0;
		font-family: Georgia, serif;
		font-size: 26px;
		font-weight: 400;
	}
	.action-list {
		list-style: none;
		margin: 20px 0;
		padding: 0;
	}
	.action-list li + li {
		border-top: 1px solid #edf0e5;
	}
	.action-list li {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.action-item {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: flex-start;
		gap: 12px;
		padding: 14px 0;
		cursor: pointer;
		line-height: 1.6;
	}
	.action-item input {
		width: 18px;
		height: 18px;
		margin: 2px 0 0;
		flex-shrink: 0;
		accent-color: #284f3e;
		cursor: pointer;
	}
	.action-item span {
		min-width: 0;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}
	.action-item.completed span {
		text-decoration: line-through;
		color: #748070;
	}
	.remove-action {
		flex-shrink: 0;
		font-size: 20px;
		width: 32px;
		height: 32px;
	}
	.add-action {
		margin-top: 20px;
	}
	.add-action-controls {
		display: flex;
		gap: 10px;
	}
	.add-action input {
		flex: 1;
		min-width: 0;
		border: 1px solid #dce2d4;
		padding: 12px;
		background: #f9faf4;
		border-radius: 7px;
	}
	.add-action button {
		flex-shrink: 0;
	}
	.message {
		max-width: 100%;
		border: 1px solid #e4ddc8;
		background: #f7f1e0;
		padding: 12px 15px;
		border-radius: 7px;
		font-size: 12px;
		color: #877245;
		margin: 12px 0;
		line-height: 1.6;
	}
	.message.error {
		background: #faf0e9;
		color: #945a40;
		border-color: #ead6c9;
	}
	.toast {
		position: fixed;
		bottom: 25px;
		left: 50%;
		transform: translateX(-50%);
		padding: 14px 20px;
		background: #284f3e;
		color: #fffdf3;
		border-radius: 9px;
		font-size: 12px;
		box-shadow: 0 5px 20px #1d3a3325;
		z-index: 20;
		max-width: 90vw;
	}
	.share-modal::backdrop {
		background: #1d332d55;
	}
	.share-modal {
		background: #fffef9;
		border-radius: 12px;
		padding: 24px;
		max-width: 550px;
		width: calc(100% - 40px);
		border: 1px solid #dce3d1;
	}
	.share-modal h2 {
		font-family: Georgia, serif;
		font-weight: 400;
		font-size: 30px;
		margin: 0;
	}
	.share-modal p {
		color: #7d8b72;
		line-height: 1.6;
	}
	.delete-modal {
		max-width: 440px;
	}
	.dialog-actions {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
		margin-top: 24px;
	}
	.button.danger {
		background: #a74f3b;
		color: #fffef9;
		border-color: #a74f3b;
	}
	.share-modal textarea {
		width: 100%;
		height: 160px;
		border: 1px solid #dce3d1;
		padding: 10px;
		border-radius: 7px;
		word-break: break-all;
		font-size: 11px;
		margin-bottom: 15px;
	}
	@media (max-width: 1100px) {
		.session-bar {
			grid-template-columns: 1fr auto;
		}
		.session-timer {
			justify-self: end;
		}
		.voting {
			justify-self: start;
			justify-content: flex-start;
		}
	}
	@media (max-width: 900px) {
		.topbar {
			grid-template-columns: 1fr auto;
		}
		.retro-title {
			grid-column: 1 / -1;
			grid-row: 2;
			font-size: 16px;
		}
		.workspace-actions {
			grid-column: 2;
			grid-row: 1;
		}
	}
	@media (max-width: 700px) {
		.actions {
			padding: 20px 16px;
		}
		.add-action-controls {
			flex-direction: column;
		}
		.add-action button {
			align-self: flex-start;
		}
		.topbar {
			min-height: 73px;
			padding: 16px 20px;
			gap: 12px;
		}
		.workspace-actions {
			gap: 8px;
		}
		.landing {
			padding-top: 60px;
		}
		.landing > p {
			font-size: 14px;
		}
		.desktop {
			display: none;
		}
		.preview {
			gap: 9px;
			margin-top: 50px;
		}
		.preview-column {
			padding: 12px 8px;
		}
		.column-label {
			font-size: 9px;
			gap: 6px;
		}
		.preview-card {
			font-size: 10px;
			padding: 13px 8px;
		}
		.workspace {
			padding: 0 20px 26px;
		}
		.workspace-actions > .button,
		.export-dropdown > summary {
			font-size: 11px;
			padding: 11px 13px;
			gap: 10px;
		}
		.session-bar {
			gap: 14px;
		}
		.session-sort {
			grid-column: 2;
			grid-row: 1;
		}
		.session-timer {
			grid-column: 1 / -1;
			grid-row: 2;
			justify-self: center;
		}
		.voting {
			grid-column: 1 / -1;
		}
		.column {
			min-width: 270px;
			flex-basis: 270px;
		}
		.board {
			gap: 15px;
		}
	}
</style>
