import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const base = 'http://127.0.0.1:18080';
let server;
let browser;
let logs = '';
async function waitFor(check, message, timeout = 20000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(typeof message === 'function' ? message() : message);
}
async function addCard(page, column, title) {
	await page.getByRole('textbox', { name: `New card in ${column}`, exact: true }).fill(title);
	await page
		.getByRole('region', { name: column, exact: true })
		.getByRole('button', { name: 'Add card', exact: false })
		.click();
}
async function newRetro(page) {
	await page.goto(base);
	await page.getByRole('button', { name: 'New retrospective', exact: false }).last().click();
	await waitFor(() => Promise.resolve(page.url().includes('#v=1')), 'snapshot URL was not created');
	return page.url();
}
async function connected(page) {
	try {
		await waitFor(
			() =>
				page
					.locator('.connection')
					.innerText()
					.then((t) => /^\d+ participants?$/.test(t.trim())),
			'WebSocket did not connect'
		);
	} catch (error) {
		throw new Error(
			`${error.message}: ${await page.locator('.session-bar').innerText()} ${await page.locator('.message').allTextContents()}`
		);
	}
}
async function cardTitles(page) {
	return page
		.getByRole('textbox', { name: 'Card title', exact: true })
		.evaluateAll((nodes) => nodes.map((node) => node.value).sort());
}

before(async () => {
	server = spawn('go', ['run', '.'], {
		cwd: resolve(root, 'backend'),
		env: {
			...process.env,
			ADDR: '127.0.0.1:18080',
			STATIC_DIR: resolve(root, 'ui/build'),
			ALLOWED_ORIGINS: ''
		},
		detached: true,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	server.stdout.on('data', (chunk) => (logs += chunk));
	server.stderr.on('data', (chunk) => (logs += chunk));
	await waitFor(
		() =>
			fetch(base + '/healthz')
				.then((r) => r.ok)
				.catch(() => false),
		() => logs,
		30000
	);
	browser = await chromium.launch({ headless: true });
});
after(async () => {
	await browser?.close();
	if (server?.pid) {
		try {
			process.kill(-server.pid, 'SIGTERM');
		} catch {}
	}
});

test('brand returns to the start page and browser Back restores the retrospective', async () => {
	const context = await browser.newContext();
	try {
		const page = await context.newPage();
		const saved = await newRetro(page);
		await page.getByRole('link', { name: 'Retro home', exact: true }).click();
		await page.getByRole('heading', { name: 'Good teams keep reflecting.' }).waitFor();
		assert.equal(page.url(), `${base}/`);
		assert.equal(await page.getByRole('textbox', { name: 'Retrospective title' }).count(), 0);
		await page.goBack();
		await page.getByRole('textbox', { name: 'Retrospective title' }).waitFor();
		assert.equal(new URL(page.url()).hash, new URL(saved).hash);
	} finally {
		await context.close();
	}
});

test('two browsers merge stale links, votes, moves and continue after creator leaves', async () => {
	const a = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] }),
		b = await browser.newContext();
	try {
		const p = await a.newPage(),
			q = await b.newPage(),
			errors = [];
		p.on('pageerror', (error) => errors.push(error.message));
		q.on('pageerror', (error) => errors.push(error.message));
		const stale = await newRetro(p);
		await addCard(p, 'Went well', 'We shipped together');
		await q.goto(stale);
		await connected(p);
		await connected(q);
		await waitFor(
			() => cardTitles(q).then((t) => t.includes('We shipped together')),
			'stale link did not receive newer content'
		);
		await addCard(q, 'Could improve', 'More focus time');
		await waitFor(() => cardTitles(p).then((t) => t.length === 2), 'bidirectional update failed');
		const draftTitle = q
			.getByRole('article', { name: 'More focus time', exact: true })
			.getByRole('textbox', { name: 'Card title', exact: true });
		await draftTitle.fill('A draft being typed');
		for (let i = 0; i < 5; i++)
			await p.getByRole('button', { name: 'Add vote to We shipped together', exact: true }).click();
		assert.equal(
			await p
				.getByRole('button', { name: 'Add vote to We shipped together', exact: true })
				.isDisabled(),
			true
		);
		await waitFor(
			() =>
				q
					.locator('.vote-total')
					.first()
					.innerText()
					.then((t) => t === '5'),
			'votes did not synchronize'
		);
		assert.equal(
			await draftTitle.inputValue(),
			'A draft being typed',
			'incoming votes must not overwrite a focused draft'
		);
		await draftTitle.press('Tab');
		await waitFor(
			() => cardTitles(p).then((t) => t.includes('A draft being typed')),
			'title edit did not commit'
		);
		const committedTitle = q
			.getByRole('article', { name: 'A draft being typed', exact: true })
			.getByRole('textbox', { name: 'Card title', exact: true });
		await committedTitle.fill('More focus time');
		await committedTitle.press('Tab');
		await waitFor(
			() => cardTitles(p).then((t) => t.includes('More focus time')),
			'title restoration did not sync'
		);
		await q.getByLabel('Votes per person', { exact: true }).fill('2');
		await q.getByLabel('Votes per person', { exact: true }).press('Tab');
		await waitFor(
			() =>
				p
					.locator('.vote-total')
					.first()
					.innerText()
					.then((t) => t === '2'),
			'lower allowance did not cap votes'
		);
		await q.getByLabel('Votes per person', { exact: true }).fill('5');
		await q.getByLabel('Votes per person', { exact: true }).press('Tab');
		await waitFor(
			() =>
				p
					.locator('.vote-total')
					.first()
					.innerText()
					.then((t) => t === '5'),
			'raising allowance did not restore votes'
		);
		await p
			.getByRole('button', { name: 'Remove your vote from We shipped together', exact: true })
			.click();
		await waitFor(
			() =>
				q
					.locator('.vote-total')
					.first()
					.innerText()
					.then((t) => t === '4'),
			'vote removal did not sync'
		);
		await q
			.getByRole('article', { name: 'More focus time', exact: true })
			.getByText('Move card', { exact: true })
			.click();
		await q
			.getByRole('combobox', { name: 'Move More focus time to column', exact: true })
			.selectOption({ label: 'Actions' });
		await waitFor(
			() =>
				p
					.getByRole('region', { name: 'Actions', exact: true })
					.getByRole('textbox', { name: 'Card title', exact: true })
					.count()
					.then((n) => n === 1),
			'card move did not sync'
		);
		await p
			.getByRole('article', { name: 'We shipped together', exact: true })
			.locator('.drag-handle')
			.dragTo(p.getByRole('region', { name: 'Actions', exact: true }));
		await waitFor(
			() =>
				q
					.getByRole('region', { name: 'Actions', exact: true })
					.getByRole('textbox', { name: 'Card title', exact: true })
					.count()
					.then((n) => n === 2),
			'drag-and-drop did not sync'
		);
		await p.getByRole('button', { name: 'Copy link', exact: false }).click();
		await p.getByText('Latest link copied. Anyone with it can join.', { exact: true }).waitFor();
		const saved = await p.evaluate(() => navigator.clipboard.readText());
		assert.match(saved, /#v=1/);
		await a.close();
		await addCard(q, 'Actions', 'Follow up next week');
		await q.getByRole('button', { name: 'Copy link', exact: false }).click();
		await waitFor(
			() =>
				q
					.locator('.toast, dialog')
					.count()
					.then((n) => n > 0),
			'remaining peer could not save its latest link'
		);
		const latest = q.url();
		await b.close();
		const returning = await browser.newContext();
		const r = await returning.newPage();
		await r.goto(latest);
		await waitFor(
			() => cardTitles(r).then((t) => t.length === 3),
			'saved link did not restore with no peers'
		);
		assert.deepEqual(await cardTitles(r), [
			'Follow up next week',
			'More focus time',
			'We shipped together'
		]);
		const storage = await r.evaluate(() => Object.keys(localStorage));
		assert.equal(
			storage.every((key) => key.startsWith('retro:voter:')),
			true
		);
		assert.deepEqual(errors, []);
		await r.screenshot({ path: '/tmp/retro-board.png', fullPage: true });
		await r.setViewportSize({ width: 390, height: 844 });
		await r.screenshot({ path: '/tmp/retro-mobile.png', fullPage: true });
		await returning.close();
	} finally {
		await a.close();
		await b.close();
	}
});

test('disconnected browsers preserve independent additions and merge on reconnection', async () => {
	const a = await browser.newContext(),
		b = await browser.newContext();
	try {
		const p = await a.newPage(),
			q = await b.newPage();
		const link = await newRetro(p);
		await q.goto(link);
		await connected(p);
		await connected(q);
		let offline = true;
		const intercept = (ws) => {
			if (offline) ws.close({ code: 1013, reason: 'offline test' });
			else ws.connectToServer();
		};
		await a.routeWebSocket('**/api/socket', intercept);
		await b.routeWebSocket('**/api/socket', intercept);
		// Reload closes the existing sockets; only synchronization is temporarily unavailable.
		await p.reload();
		await q.reload();
		await waitFor(
			() =>
				p
					.locator('.connection')
					.innerText()
					.then((text) => text.includes('Offline')),
			'first socket did not disconnect'
		);
		await waitFor(
			() =>
				q
					.locator('.connection')
					.innerText()
					.then((text) => text.includes('Offline')),
			'second socket did not disconnect'
		);
		await addCard(p, 'Went well', 'Offline A');
		await addCard(q, 'Went well', 'Offline B');
		offline = false;
		await connected(p);
		await connected(q);
		await waitFor(
			() =>
				Promise.all([cardTitles(p), cardTitles(q)]).then(
					([x, y]) => x.length === 2 && y.length === 2
				),
			'offline additions did not merge'
		);
		assert.deepEqual(await cardTitles(p), ['Offline A', 'Offline B']);
		assert.deepEqual(await cardTitles(q), ['Offline A', 'Offline B']);
	} finally {
		await a.close();
		await b.close();
	}
});

test('identity survives reopening and malformed links are recoverable', async () => {
	const context = await browser.newContext();
	try {
		const p = await context.newPage();
		await newRetro(p);
		await addCard(p, 'Went well', 'Remember me');
		await p.getByRole('button', { name: 'Add vote to Remember me', exact: true }).click();
		await waitFor(
			() =>
				p
					.locator('.mine')
					.innerText()
					.then((t) => t === '1 yours'),
			'own vote missing'
		);
		await p.getByRole('button', { name: 'Copy link', exact: false }).click();
		await waitFor(
			() =>
				p
					.locator('.toast, dialog')
					.count()
					.then((n) => n > 0),
			'copy did not complete'
		);
		const saved = p.url();
		await p.close();
		const q = await context.newPage();
		await q.goto(saved);
		await waitFor(
			() =>
				q
					.locator('.mine')
					.innerText()
					.then((t) => t === '1 yours'),
			'vote identity was not remembered'
		);
		await q.goto(base + '/#v=99');
		await q.getByRole('alert').waitFor();
		assert.match(await q.getByRole('alert').innerText(), /Cannot open retrospective/);
		await q.getByRole('button', { name: 'New retrospective', exact: false }).last().click();
		await waitFor(
			() =>
				q
					.getByRole('region', { name: 'Went well', exact: true })
					.count()
					.then((n) => n === 1),
			'cannot recover from bad link'
		);
	} finally {
		await context.close();
	}
});

test('WebSocket synchronization works when WebRTC is unavailable', async () => {
	const a = await browser.newContext(),
		b = await browser.newContext();
	try {
		for (const context of [a, b])
			await context.addInitScript(() => {
				window.RTCPeerConnection = undefined;
			});
		const p = await a.newPage(),
			q = await b.newPage();
		const requests = [];
		p.on('request', (request) => requests.push(request.url()));
		q.on('request', (request) => requests.push(request.url()));
		const link = await newRetro(p);
		await q.goto(link);
		await connected(p);
		await connected(q);
		await addCard(p, 'Went well', 'Just a regular socket');
		await waitFor(
			() => cardTitles(q).then((t) => t.includes('Just a regular socket')),
			'WebSocket update did not arrive'
		);
		assert.equal(
			requests.some((url) => url.includes('/api/rtc-config')),
			false
		);
	} finally {
		await a.close();
		await b.close();
	}
});

test('cards and columns require OK; Cancel and Escape leave shared state intact', async () => {
	const a = await browser.newContext(),
		b = await browser.newContext();
	try {
		const p = await a.newPage(),
			q = await b.newPage();
		const link = await newRetro(p);
		await q.goto(link);
		await connected(p);
		await connected(q);
		await addCard(p, 'Went well', 'Keep until confirmed');
		await waitFor(() => cardTitles(q).then((titles) => titles.length === 1), 'card did not sync');
		await q.getByRole('button', { name: 'Delete card Keep until confirmed', exact: true }).click();
		const cardDialog = q.getByRole('dialog', { name: 'Delete card?', exact: true });
		await cardDialog.waitFor();
		assert.equal(await q.evaluate(() => document.activeElement.textContent.trim()), 'Cancel');
		assert.match(await cardDialog.innerText(), /cannot be undone/);
		assert.deepEqual(await cardTitles(p), ['Keep until confirmed']);
		await cardDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
		assert.deepEqual(await cardTitles(q), ['Keep until confirmed']);
		await q.getByRole('button', { name: 'Delete card Keep until confirmed', exact: true }).click();
		await q.keyboard.press('Escape');
		assert.equal(await q.getByRole('dialog').count(), 0);
		assert.deepEqual(await cardTitles(q), ['Keep until confirmed']);
		await q.getByRole('button', { name: 'Delete card Keep until confirmed', exact: true }).click();
		await cardDialog.getByRole('button', { name: 'OK', exact: true }).click();
		await waitFor(
			() => cardTitles(p).then((titles) => titles.length === 0),
			'confirmed deletion did not sync'
		);
		await addCard(p, 'Could improve', 'First card');
		await addCard(p, 'Could improve', 'Second card');
		await p.getByRole('button', { name: 'Delete Could improve', exact: true }).click();
		const columnDialog = p.getByRole('dialog', { name: 'Delete column?', exact: true });
		assert.match(await columnDialog.innerText(), /column and all its cards for everyone/);
		await columnDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
		assert.equal(await p.getByRole('region', { name: 'Could improve', exact: true }).count(), 1);
		assert.equal((await cardTitles(p)).length, 2);
		await p.getByRole('button', { name: 'Delete Could improve', exact: true }).click();
		await columnDialog.getByRole('button', { name: 'OK', exact: true }).click();
		await waitFor(
			() =>
				q
					.getByRole('region', { name: 'Could improve', exact: true })
					.count()
					.then((n) => n === 0),
			'column deletion did not sync'
		);
		assert.deepEqual(await cardTitles(q), []);
		for (const text of [
			'YOUR SHARED SPACE',
			'Everyone has a voice. Everyone can edit.',
			'Your URL holds this snapshot. Copy it before leaving.'
		])
			assert.equal(await p.getByText(text, { exact: true }).count(), 0);
		await p.screenshot({ path: '/tmp/retro-clean-board.png', fullPage: true });
	} finally {
		await a.close();
		await b.close();
	}
});

test('board sort ranks total votes in every column, preserves ties and shares the saved order', async () => {
	const a = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] }),
		b = await browser.newContext();
	try {
		const p = await a.newPage(),
			q = await b.newPage();
		const link = await newRetro(p);
		await q.goto(link);
		await connected(p);
		await connected(q);
		const sort = p.getByRole('button', { name: 'Sort by votes', exact: true });
		assert.equal(await sort.count(), 1);
		assert.equal(await sort.isDisabled(), true);
		for (const title of ['No votes', 'First tie', 'Second tie', 'Most votes'])
			await addCard(p, 'Went well', title);
		await addCard(p, 'Actions', 'Leave here');
		await addCard(p, 'Actions', 'Top action');
		await waitFor(() => cardTitles(q).then((titles) => titles.length === 6), 'cards did not sync');
		await p.getByRole('button', { name: 'Add vote to Top action', exact: true }).click();
		await p.getByRole('button', { name: 'Add vote to First tie', exact: true }).click();
		await q.getByRole('button', { name: 'Add vote to Second tie', exact: true }).click();
		for (const page of [p, q])
			await page.getByRole('button', { name: 'Add vote to Most votes', exact: true }).click();
		await p
			.getByRole('article', { name: 'Most votes', exact: true })
			.getByLabel('2 votes')
			.waitFor();
		await p
			.getByRole('article', { name: 'Second tie', exact: true })
			.getByLabel('1 votes')
			.waitFor();
		const order = (page, column = 'Went well') =>
			page
				.getByRole('region', { name: column, exact: true })
				.getByRole('textbox', { name: 'Card title', exact: true })
				.evaluateAll((nodes) => nodes.map((node) => node.value));
		assert.deepEqual(await order(p), ['No votes', 'First tie', 'Second tie', 'Most votes']);
		await sort.focus();
		await sort.press('Enter');
		const expected = ['Most votes', 'First tie', 'Second tie', 'No votes'];
		assert.deepEqual(await order(p), expected);
		await waitFor(
			() => order(q).then((titles) => titles.join() === expected.join()),
			'sort did not sync'
		);
		assert.equal(await sort.evaluate((node) => document.activeElement === node), true);
		await waitFor(
			() => order(q, 'Actions').then((titles) => titles.join() === 'Top action,Leave here'),
			'other column sort did not sync'
		);
		assert.deepEqual(await order(p, 'Actions'), ['Top action', 'Leave here']);
		await p.getByRole('button', { name: 'Copy link', exact: false }).click();
		await p.getByRole('status').filter({ hasText: 'Latest link copied' }).waitFor();
		const saved = p.url();
		await p.screenshot({ path: '/tmp/retro-sort-by-votes.png', fullPage: true });
		await p.close();
		await q.close();
		const restored = await a.newPage();
		await restored.goto(saved);
		await restored.getByRole('article', { name: 'Most votes', exact: true }).waitFor();
		assert.deepEqual(await order(restored), expected);
		assert.deepEqual(await order(restored, 'Actions'), ['Top action', 'Leave here']);
	} finally {
		await a.close();
		await b.close();
	}
});

test('Pragmatic drag indicators match insertion, cancellation clears them, and keyboard controls restore focus', async () => {
	const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
	try {
		const page = await context.newPage();
		const errors = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await newRetro(page);
		for (const title of ['One', 'Two', 'Three']) await addCard(page, 'Went well', title);
		const column = page.getByRole('region', { name: 'Went well', exact: true });
		const order = () =>
			column
				.getByRole('textbox', { name: 'Card title', exact: true })
				.evaluateAll((nodes) => nodes.map((node) => node.value));
		async function startDrag(title, target, bottom = false) {
			const source = await page
				.getByRole('article', { name: title, exact: true })
				.locator('.drag-handle')
				.boundingBox();
			const box = await target.boundingBox();
			await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
			await page.mouse.down();
			await page.mouse.move(source.x + source.width / 2 + 10, source.y + source.height / 2 + 10);
			await page.mouse.move(box.x + box.width / 2, bottom ? box.y + box.height - 8 : box.y + 8, {
				steps: 10
			});
			await page.mouse.move(box.x + box.width / 2 + 1, bottom ? box.y + box.height - 8 : box.y + 8);
			await page.locator('.drop-indicator').waitFor({ state: 'visible' });
		}
		await startDrag('Three', page.getByRole('article', { name: 'One', exact: true }));
		await page
			.getByRole('article', { name: 'One', exact: true })
			.locator('.drop-indicator')
			.waitFor({ state: 'visible' });
		assert.equal(
			await page
				.getByRole('article', { name: 'One', exact: true })
				.locator('.drop-indicator')
				.count(),
			1
		);
		await page.screenshot({ path: '/tmp/retro-drop-target.png', fullPage: true });
		await page.mouse.up();
		await waitFor(
			() => order().then((titles) => titles.join() === 'Three,One,Two'),
			'top insertion failed'
		);
		assert.equal(await page.locator('.drop-indicator').count(), 0);
		await startDrag('Three', page.getByRole('article', { name: 'Two', exact: true }), true);
		await column.locator('.drop-end .drop-indicator').waitFor({ state: 'visible' });
		assert.equal(await column.locator('.drop-end .drop-indicator').count(), 1);
		await page.mouse.up();
		await waitFor(
			() => order().then((titles) => titles.join() === 'One,Two,Three'),
			'bottom insertion failed'
		);
		await startDrag('Three', page.getByRole('region', { name: 'Actions', exact: true }));
		await page
			.getByRole('region', { name: 'Actions', exact: true })
			.locator('.drop-indicator')
			.waitFor({ state: 'visible' });
		assert.equal(
			await page
				.getByRole('region', { name: 'Actions', exact: true })
				.locator('.drop-indicator')
				.count(),
			1
		);
		await page.mouse.up();
		await page
			.getByRole('region', { name: 'Actions', exact: true })
			.getByRole('article', { name: 'Three', exact: true })
			.waitFor();
		await startDrag('Three', page.getByRole('article', { name: 'One', exact: true }));
		await page.mouse.move(5, 5, { steps: 5 });
		await page.mouse.up();
		await waitFor(
			() =>
				page
					.locator('.drop-indicator')
					.count()
					.then((n) => n === 0),
			'cancelled drag indicator remained'
		);
		assert.deepEqual(await order(), ['One', 'Two']);
		const menu = page.getByRole('article', { name: 'One', exact: true }).locator('summary');
		await menu.focus();
		await menu.press('Enter');
		const down = page.getByRole('button', { name: 'Move One down', exact: true });
		await down.focus();
		await down.press('Enter');
		await waitFor(
			() => order().then((titles) => titles.join() === 'Two,One'),
			'keyboard reorder failed'
		);
		assert.equal(await menu.evaluate((node) => document.activeElement === node), true);
		const select = page.getByRole('combobox', { name: 'Move One to column', exact: true });
		await select.focus();
		// Use Playwright's native-select API; OS option popups are outside the page.
		await select.selectOption({ label: 'Could improve' });
		await page
			.getByRole('region', { name: 'Could improve', exact: true })
			.getByRole('article', { name: 'One', exact: true })
			.waitFor();
		assert.equal(
			await page
				.getByRole('article', { name: 'One', exact: true })
				.locator('summary')
				.evaluate((node) => document.activeElement === node),
			true
		);
		await page.getByRole('status').filter({ hasText: 'Moved One to Could improve' }).waitFor();
		assert.deepEqual(errors, []);
	} finally {
		await context.close();
	}
});

test('shared countdown syncs starts, stops, late joins and reloads; popover dismisses without restricting the board', async () => {
	const a = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] }),
		b = await browser.newContext(),
		c = await browser.newContext();
	try {
		const p = await a.newPage(),
			q = await b.newPage(),
			r = await c.newPage();
		const errors = [];
		for (const page of [p, q, r]) page.on('pageerror', (error) => errors.push(error.message));
		const stale = await newRetro(p);
		await q.goto(stale);
		await connected(p);
		await connected(q);
		const remaining = (page) =>
			page
				.getByRole('timer')
				.innerText()
				.then((text) => {
					const [minutes, seconds] = text.split(':').map(Number);
					return minutes * 60 + seconds;
				});
		assert.equal(await remaining(p), 180);
		assert.equal(
			await p.getByRole('button', { name: 'Start timer', exact: true }).isEnabled(),
			true
		);
		await p.getByLabel('Set countdown duration', { exact: true }).click();
		await p.getByLabel('Minutes', { exact: true }).waitFor({ state: 'visible' });
		await p.getByLabel('Minutes', { exact: true }).click();
		assert.equal(await p.locator('.timer-settings').isVisible(), true);
		await p.getByLabel('Retrospective title', { exact: true }).click();
		assert.equal(await p.locator('.timer-settings').isVisible(), false);
		assert.equal(await remaining(p), 180, 'dismissing popover must not start timer');
		await p.getByLabel('Set countdown duration', { exact: true }).click();
		await p.getByLabel('Minutes', { exact: true }).focus();
		await p.keyboard.press('Escape');
		assert.equal(await p.locator('.timer-settings').isVisible(), false);
		assert.equal(
			await p
				.getByLabel('Set countdown duration', { exact: true })
				.evaluate((node) => node === document.activeElement),
			true
		);
		await p.getByLabel('Set countdown duration', { exact: true }).click();
		await p.getByRole('button', { name: 'Start', exact: true }).click();
		await waitFor(
			() => q.getByRole('button', { name: 'Stop timer', exact: true }).isEnabled(),
			'start did not sync'
		);
		await waitFor(() => remaining(q).then((seconds) => seconds < 180), 'countdown did not tick');
		await q.getByRole('button', { name: 'Stop timer', exact: true }).click();
		await waitFor(
			() => p.getByRole('button', { name: 'Start timer', exact: true }).isEnabled(),
			'stop did not sync'
		);
		const stopped = await remaining(q);
		assert.equal(await remaining(p), stopped);
		await r.goto(stale);
		await connected(r);
		await waitFor(
			() => remaining(r).then((seconds) => seconds === stopped),
			'late join did not receive stopped timer'
		);
		await q.reload();
		await connected(q);
		assert.equal(await remaining(q), stopped, 'stopped timer resumed on reload');
		await new Promise((resolve) => setTimeout(resolve, 1100));
		assert.equal(await remaining(p), stopped, 'stopped timer kept ticking');
		assert.equal(await remaining(q), stopped);
		assert.equal(await remaining(r), stopped);
		await p.getByRole('button', { name: 'Start timer', exact: true }).click();
		await waitFor(
			() => q.getByRole('button', { name: 'Stop timer', exact: true }).isEnabled(),
			'resume did not sync'
		);
		assert.ok(
			(await remaining(q)) <= stopped && (await remaining(q)) >= stopped - 1,
			'resume reset duration'
		);
		await q.getByLabel('Set countdown duration', { exact: true }).click();
		assert.equal(await q.getByLabel('Minutes', { exact: true }).inputValue(), '3');
		await q.getByLabel('Minutes', { exact: true }).fill('0');
		assert.equal(await q.getByRole('button', { name: 'Start', exact: true }).isDisabled(), true);
		await q.getByLabel('Seconds', { exact: true }).fill('8');
		await q.getByRole('button', { name: 'Start', exact: true }).click();
		await waitFor(
			() => remaining(p).then((seconds) => seconds > 0 && seconds <= 8),
			'duration did not sync'
		);
		await r.goto(stale);
		await connected(r);
		await waitFor(
			() => remaining(r).then((seconds) => seconds > 0 && seconds <= 8),
			'late join reset countdown'
		);
		await q.reload();
		await connected(q);
		assert.ok((await remaining(q)) <= 8, 'reload reset countdown');
		await addCard(p, 'Went well', 'During countdown');
		await p.getByRole('button', { name: 'Add vote to During countdown', exact: true }).click();
		await waitFor(
			() =>
				Promise.all([p, q, r].map(remaining)).then((values) =>
					values.every((value) => value === 0)
				),
			'countdown did not settle at zero'
		);
		assert.equal(await p.getByRole('dialog').count(), 0);
		await p
			.getByRole('article', { name: 'During countdown', exact: true })
			.getByLabel('1 votes', { exact: true })
			.waitFor();
		await addCard(q, 'Went well', 'After countdown');
		await q.getByRole('button', { name: 'Add vote to After countdown', exact: true }).click();
		const title = q
			.getByRole('article', { name: 'After countdown', exact: true })
			.getByRole('textbox', { name: 'Card title', exact: true });
		await title.fill('Still editable');
		await title.press('Tab');
		await waitFor(
			() => cardTitles(p).then((titles) => titles.includes('Still editable')),
			'editing was blocked after expiry'
		);
		await p
			.getByRole('article', { name: 'Still editable', exact: true })
			.getByLabel('1 votes', { exact: true })
			.waitFor();
		await q.getByLabel('Set countdown duration', { exact: true }).click();
		await q.getByLabel('Minutes', { exact: true }).fill('5');
		await q.getByLabel('Seconds', { exact: true }).fill('0');
		await q.getByRole('button', { name: 'Start', exact: true }).click();
		await waitFor(() => remaining(p).then((seconds) => seconds >= 299), 'next round did not sync');
		await p.getByRole('button', { name: 'Copy link', exact: false }).click();
		await p.getByRole('status').filter({ hasText: 'Latest link copied' }).waitFor();
		const saved = p.url();
		await p.screenshot({ path: '/tmp/retro-timer.png', fullPage: true });
		await p.setViewportSize({ width: 390, height: 844 });
		await p.getByLabel('Set countdown duration', { exact: true }).click();
		await p.screenshot({ path: '/tmp/retro-timer-mobile.png', fullPage: true });
		await p.close();
		await q.close();
		await r.close();
		const restored = await a.newPage();
		await restored.goto(saved);
		await restored.getByRole('timer').waitFor();
		assert.equal(
			await restored.getByRole('button', { name: 'Stop timer', exact: true }).isEnabled(),
			true
		);
		assert.ok((await remaining(restored)) > 290 && (await remaining(restored)) <= 300);
		assert.deepEqual(errors, []);
	} finally {
		await a.close();
		await b.close();
		await c.close();
	}
});

test('export dropdown downloads Markdown and CSV with current edits and shared votes', async () => {
	const a = await browser.newContext(),
		b = await browser.newContext();
	try {
		const p = await a.newPage(),
			q = await b.newPage();
		const link = await newRetro(p);
		await q.goto(link);
		await connected(p);
		await connected(q);
		await addCard(p, 'Went well', 'First | card\nSecond line');
		await addCard(p, 'Went well', 'No votes');
		await addCard(p, 'Actions', 'Follow up');
		await q.getByRole('article', { name: 'First | card\nSecond line', exact: true }).waitFor();
		await q
			.getByRole('button', { name: 'Add vote to First | card\nSecond line', exact: true })
			.click();
		await p
			.getByRole('article', { name: 'First | card\nSecond line', exact: true })
			.getByLabel('1 votes')
			.waitFor();
		// Export must include the title committed by blurring directly onto the export button.
		await p.getByLabel('Retrospective title', { exact: true }).fill('Sprint 12: review');
		const toggle = p.getByLabel('Export', { exact: true });
		await toggle.click();
		const pending = p.waitForEvent('download');
		await p.getByRole('button', { name: 'Markdown (.md)', exact: true }).click();
		const download = await pending;
		assert.equal(download.suggestedFilename(), 'Sprint-12-review.md');
		assert.equal(await download.failure(), null);
		assert.equal(
			await readFile(await download.path(), 'utf8'),
			[
				'# Sprint 12: review',
				'',
				'Votes per person: 5',
				'Total votes: 1',
				'',
				'| Went well | Could improve | Actions |',
				'| --- | --- | --- |',
				'| First &#124; card<br>Second line<br>**1 vote** |  | Follow up<br>**0 votes** |',
				'| No votes<br>**0 votes** |  |  |',
				''
			].join('\n')
		);
		await p.getByRole('status').filter({ hasText: 'Markdown exported.' }).waitFor();
		assert.equal(
			await p.getByRole('group', { name: 'Export formats', exact: true }).isVisible(),
			false
		);
		assert.equal(await toggle.evaluate((node) => node === document.activeElement), true);
		// Keyboard users can open the dropdown, tab to either format, and dismiss it.
		await toggle.press('Enter');
		await p.getByRole('button', { name: 'CSV (.csv)', exact: true }).waitFor({ state: 'visible' });
		await p.keyboard.press('Escape');
		assert.equal(
			await p.getByRole('group', { name: 'Export formats', exact: true }).isVisible(),
			false
		);
		assert.equal(await toggle.evaluate((node) => node === document.activeElement), true);
		await toggle.press('Enter');
		await p.keyboard.press('Tab');
		assert.equal(
			await p
				.getByRole('button', { name: 'Markdown (.md)', exact: true })
				.evaluate((node) => node === document.activeElement),
			true
		);
		await p.keyboard.press('Tab');
		const pendingCSV = p.waitForEvent('download');
		await p.keyboard.press('Enter');
		const csv = await pendingCSV;
		assert.equal(csv.suggestedFilename(), 'Sprint-12-review.csv');
		assert.equal(await csv.failure(), null);
		assert.equal(
			await readFile(await csv.path(), 'utf8'),
			'Card,Column,Votes,Order\r\n"First | card\nSecond line",Went well,1,1\r\nNo votes,Went well,0,2\r\nFollow up,Actions,0,1\r\n'
		);
		await p.getByRole('status').filter({ hasText: 'CSV exported.' }).waitFor();
		await toggle.click();
		await p.getByLabel('Retrospective title', { exact: true }).click();
		assert.equal(
			await p.getByRole('group', { name: 'Export formats', exact: true }).isVisible(),
			false
		);
		await p.setViewportSize({ width: 390, height: 844 });
		assert.equal(await toggle.isVisible(), true);
		await toggle.click();
		await p.getByRole('button', { name: 'CSV (.csv)', exact: true }).waitFor({ state: 'visible' });
		const menu = await p.getByRole('group', { name: 'Export formats', exact: true }).boundingBox();
		assert.ok(
			menu.x >= 0 && menu.x + menu.width <= 390,
			'export options overflow the mobile viewport'
		);
		const actions = await p.locator('.workspace-actions').boundingBox();
		assert.ok(actions.x + actions.width <= 370, 'board actions overflow the mobile workspace');
		await p.screenshot({ path: '/tmp/retro-export-mobile.png', fullPage: true });
	} finally {
		await a.close();
		await b.close();
	}
});

test('actions synchronize creation, completion and removal and restore from saved links', async () => {
	const a = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] }),
		b = await browser.newContext();
	try {
		const p = await a.newPage(),
			q = await b.newPage(),
			errors = [];
		p.on('pageerror', (error) => errors.push(error.message));
		q.on('pageerror', (error) => errors.push(error.message));
		const stale = await newRetro(p);
		await connected(p);
		const actions = p.getByRole('region', { name: 'Action items', exact: true });
		assert.equal(await actions.getByRole('checkbox').count(), 0);
		assert.equal(
			await actions.getByRole('button', { name: 'Add action', exact: false }).isDisabled(),
			true
		);
		await actions.getByLabel('New action', { exact: true }).fill('   ');
		assert.equal(
			await actions.getByRole('button', { name: 'Add action', exact: false }).isDisabled(),
			true
		);
		await actions.getByLabel('New action', { exact: true }).fill('  Schedule a follow-up 🌱  ');
		await actions.getByLabel('New action', { exact: true }).press('Enter');
		const checkbox = (page) =>
			page.getByRole('checkbox', { name: 'Schedule a follow-up 🌱', exact: true });
		await checkbox(p).waitFor();
		assert.equal(await actions.getByLabel('New action', { exact: true }).inputValue(), '');
		assert.equal(await checkbox(p).isChecked(), false);
		await checkbox(p).check();
		await q.goto(stale);
		await connected(q);
		await checkbox(q).waitFor();
		await waitFor(() => checkbox(q).isChecked(), 'late join did not receive completed action');
		await checkbox(q).uncheck();
		await waitFor(
			() =>
				checkbox(p)
					.isChecked()
					.then((value) => !value),
			'unchecking did not sync'
		);
		await q.getByLabel('New action', { exact: true }).fill('Review the release process');
		await q.getByRole('button', { name: 'Add action', exact: false }).click();
		await p.getByRole('checkbox', { name: 'Review the release process', exact: true }).waitFor();
		await checkbox(p).focus();
		await p.keyboard.press('Space');
		await waitFor(() => checkbox(q).isChecked(), 'keyboard checking did not sync');
		await q.reload();
		await connected(q);
		await waitFor(() => checkbox(q).isChecked(), 'reload lost completion status');
		await q
			.getByRole('button', { name: 'Remove action Review the release process', exact: true })
			.click();
		await p
			.getByRole('checkbox', { name: 'Review the release process', exact: true })
			.waitFor({ state: 'detached' });
		await q.goto(stale);
		await connected(q);
		await checkbox(q).waitFor();
		assert.equal(await q.getByRole('checkbox').count(), 1);
		const boardBounds = await p.locator('.board').boundingBox(),
			actionBounds = await actions.boundingBox();
		assert.ok(
			actionBounds.y >= boardBounds.y + boardBounds.height,
			'actions must be below the columns'
		);
		await p.screenshot({ path: '/tmp/retro-actions.png', fullPage: true });
		await p.setViewportSize({ width: 390, height: 844 });
		await actions.scrollIntoViewIfNeeded();
		const form = await actions.locator('.add-action-controls').boundingBox();
		assert.ok(
			form.x >= 0 && form.x + form.width <= 390,
			'action form overflows the mobile viewport'
		);
		await p.screenshot({ path: '/tmp/retro-actions-mobile.png', fullPage: true });
		await p.getByRole('button', { name: 'Copy link', exact: false }).click();
		await p.getByRole('status').filter({ hasText: 'Latest link copied' }).waitFor();
		const saved = p.url();
		await p.close();
		await q.close();
		const restored = await a.newPage();
		await restored.goto(saved);
		await checkbox(restored).waitFor();
		assert.equal(await checkbox(restored).isChecked(), true);
		assert.equal(await restored.getByRole('checkbox').count(), 1);
		await checkbox(restored).uncheck();
		assert.equal(await checkbox(restored).isChecked(), false);
		await restored.getByRole('button', { name: 'New retrospective', exact: false }).click();
		await waitFor(
			() =>
				restored
					.getByRole('checkbox')
					.count()
					.then((count) => count === 0),
			'actions leaked into a new room'
		);
		assert.deepEqual(errors, []);
	} finally {
		await a.close();
		await b.close();
	}
});

test('touch users can move cards through the accessible controls', async () => {
	const context = await browser.newContext({
		viewport: { width: 390, height: 844 },
		isMobile: true,
		hasTouch: true
	});
	try {
		const page = await context.newPage();
		await newRetro(page);
		await addCard(page, 'Went well', 'Touch one');
		await addCard(page, 'Went well', 'Touch two');
		await page.getByRole('article', { name: 'Touch one', exact: true }).locator('summary').tap();
		await page.getByRole('button', { name: 'Move Touch one down', exact: true }).tap();
		const titles = await page
			.getByRole('region', { name: 'Went well', exact: true })
			.getByRole('textbox', { name: 'Card title', exact: true })
			.evaluateAll((nodes) => nodes.map((node) => node.value));
		assert.deepEqual(titles, ['Touch two', 'Touch one']);
	} finally {
		await context.close();
	}
});
