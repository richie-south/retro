export type Clock = [number, number, string];
export type Location = { columnId: string; position: string };
export type Timer = { duration: number; endsAt: number | null; remaining?: number };
export type Register = { value: string | number | boolean | Location | Timer | null; clock: Clock };
export type Snapshot = { version: 1; room: string; registers: Record<string, Register> };
export type Column = { id: string; title: string; position: string };
export type Card = { id: string; title: string; location: Location };
export type Action = { id: string; title: string; completed: boolean };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const roomPattern = /^[0-9a-f]{32}$/;
export const MAX_VOTES = 100;
export const MAX_TIMER_SECONDS = 24 * 60 * 60;
const tokenPattern = /^-?\d{1,512}\/[1-9]\d{0,511}$/;

export function timerRemainingSeconds(timer: Timer, now: number): number {
	return timer.endsAt === null
		? (timer.remaining ?? timer.duration)
		: Math.max(0, Math.ceil((timer.endsAt - now) / 1000));
}

function fraction(token: string): [bigint, bigint] {
	const [n, d] = token.split('/').map(BigInt);
	return [n, d];
}
function gcd(a: bigint, b: bigint): bigint {
	a = a < 0n ? -a : a;
	while (b) [a, b] = [b, a % b];
	return a || 1n;
}
function token(n: bigint, d: bigint): string {
	const divisor = gcd(n, d);
	return `${n / divisor}/${d / divisor}`;
}
export function between(left?: string, right?: string): string {
	if (!left && !right) return '0/1';
	if (!right) {
		const [n, d] = fraction(left!);
		return token(n + d, d);
	}
	if (!left) {
		const [n, d] = fraction(right);
		return token(n - d, d);
	}
	const [a, b] = fraction(left),
		[c, d] = fraction(right);
	return token(a * d + c * b, 2n * b * d);
}
export function comparePosition(a: string, b: string): number {
	const [an, ad] = fraction(a),
		[bn, bd] = fraction(b);
	const diff = an * bd - bn * ad;
	return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}
export function compareClock(a: Clock, b: Clock): number {
	return a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
}
function newer(a: Register, b?: Register): boolean {
	if (!b) return true;
	const comparison = compareClock(a.clock, b.clock);
	return comparison > 0 || (comparison === 0 && JSON.stringify(a.value) > JSON.stringify(b.value));
}
function validToken(v: unknown): v is string {
	return typeof v === 'string' && tokenPattern.test(v);
}
function object(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate snapshots and partial snapshots using the same boundary checks. */
export function validateSnapshot(input: unknown): Snapshot {
	if (
		!object(input) ||
		input.version !== 1 ||
		typeof input.room !== 'string' ||
		!roomPattern.test(input.room) ||
		!object(input.registers)
	) {
		throw new Error('This link contains an invalid or unsupported retrospective.');
	}
	const registers: Record<string, Register> = {};
	for (const [key, raw] of Object.entries(input.registers)) {
		if (!object(raw) || !Array.isArray(raw.clock) || raw.clock.length !== 3)
			throw new Error('Invalid change timestamp.');
		const [time, counter, actor] = raw.clock;
		if (
			!Number.isSafeInteger(time) ||
			time < 0 ||
			!Number.isSafeInteger(counter) ||
			counter < 0 ||
			typeof actor !== 'string' ||
			!uuid.test(actor)
		)
			throw new Error('Invalid change timestamp.');
		const parts = key.split(':');
		const value = raw.value;
		let valid = false;
		if (key === 'settings:title')
			valid = typeof value === 'string' && value.trim().length > 0 && value.length <= 120;
		if (key === 'settings:limit')
			valid = Number.isInteger(value) && Number(value) >= 0 && Number(value) <= MAX_VOTES;
		if (key === 'settings:timer')
			valid =
				object(value) &&
				Number.isInteger(value.duration) &&
				Number(value.duration) > 0 &&
				Number(value.duration) <= MAX_TIMER_SECONDS &&
				(value.endsAt === null ||
					(Number.isSafeInteger(value.endsAt) && Number(value.endsAt) >= 0)) &&
				(value.remaining === undefined ||
					(value.endsAt === null &&
						Number.isInteger(value.remaining) &&
						Number(value.remaining) >= 0 &&
						Number(value.remaining) <= Number(value.duration)));
		if (parts.length === 3 && uuid.test(parts[1])) {
			if (parts[0] === 'action') {
				if (parts[2] === 'title')
					valid = typeof value === 'string' && value.trim().length > 0 && value.length <= 500;
				if (parts[2] === 'completed') valid = typeof value === 'boolean';
				if (parts[2] === 'deleted') valid = value === true;
			}
			if (parts[0] === 'column' || parts[0] === 'card') {
				if (parts[2] === 'title')
					valid =
						typeof value === 'string' &&
						value.trim().length > 0 &&
						value.length <= (parts[0] === 'column' ? 120 : 500);
				if (parts[2] === 'deleted') valid = value === true;
				if (parts[0] === 'column' && parts[2] === 'position') valid = validToken(value);
				if (parts[0] === 'card' && parts[2] === 'location')
					valid =
						object(value) &&
						typeof value.columnId === 'string' &&
						uuid.test(value.columnId) &&
						validToken(value.position);
			}
			if (parts[0] === 'vote' && /^(0|[1-9]\d?)$/.test(parts[2]))
				valid = value === null || (typeof value === 'string' && uuid.test(value));
		}
		if (!valid) throw new Error('Invalid retrospective content.');
		registers[key] = {
			value: structuredClone(value) as Register['value'],
			clock: [time, counter, actor]
		};
	}
	return { version: 1, room: input.room, registers };
}

export function merge(a: Snapshot, b: Snapshot): Snapshot {
	if (a.room !== b.room) throw new Error('Cannot merge different retrospectives.');
	const registers = { ...a.registers };
	for (const [key, value] of Object.entries(b.registers))
		if (newer(value, registers[key])) registers[key] = value;
	return { version: 1, room: a.room, registers };
}
export function difference(after: Snapshot, before: Snapshot): Snapshot {
	return {
		version: 1,
		room: after.room,
		registers: Object.fromEntries(
			Object.entries(after.registers).filter(([key, value]) => newer(value, before.registers[key]))
		)
	};
}

export class Model {
	state: Snapshot;
	private time = 0;
	private counter = 0;
	constructor(
		state: Snapshot,
		readonly actor = crypto.randomUUID(),
		private now = () => Date.now()
	) {
		this.state = structuredClone(state);
		this.observe(state);
	}
	private observe(state: Snapshot) {
		for (const {
			clock: [time, counter]
		} of Object.values(state.registers)) {
			if (time > this.time) {
				this.time = time;
				this.counter = counter;
			} else if (time === this.time) this.counter = Math.max(counter, this.counter);
		}
	}
	private write(key: string, value: Register['value']) {
		const now = this.now();
		if (now > this.time) {
			this.time = now;
			this.counter = 0;
		} else this.counter++;
		this.state.registers[key] = { value, clock: [this.time, this.counter, this.actor] };
	}
	receive(state: Snapshot): Snapshot {
		const before = this.state;
		this.state = merge(before, state);
		this.observe(state);
		return difference(this.state, before);
	}
	get title(): string {
		return String(this.state.registers['settings:title']?.value ?? 'Retrospective');
	}
	get limit(): number {
		return Number(this.state.registers['settings:limit']?.value ?? 5);
	}
	setTitle(value: string) {
		if (value.trim()) this.write('settings:title', value.trim().slice(0, 120));
	}
	setLimit(value: number) {
		if (Number.isInteger(value) && value >= 0 && value <= MAX_VOTES)
			this.write('settings:limit', value);
	}
	get timer(): Timer {
		return (
			(this.state.registers['settings:timer']?.value as Timer | undefined) ?? {
				duration: 3 * 60,
				endsAt: null
			}
		);
	}
	startTimer(duration = this.timer.duration) {
		const endsAt = this.now() + duration * 1000;
		if (
			Number.isInteger(duration) &&
			duration > 0 &&
			duration <= MAX_TIMER_SECONDS &&
			Number.isSafeInteger(endsAt) &&
			endsAt >= 0
		)
			// Duration and deadline must resolve together when users restart concurrently.
			this.write('settings:timer', { duration, endsAt });
	}
	stopTimer() {
		const timer = this.timer;
		if (timer.endsAt === null) return;
		this.write('settings:timer', {
			duration: timer.duration,
			endsAt: null,
			remaining: Math.min(timer.duration, timerRemainingSeconds(timer, this.now()))
		});
	}
	resumeTimer() {
		const timer = this.timer;
		if (timer.endsAt !== null) return;
		const remaining = timer.remaining ?? timer.duration;
		const endsAt = this.now() + remaining * 1000;
		if (remaining > 0 && Number.isSafeInteger(endsAt) && endsAt >= 0)
			this.write('settings:timer', { duration: timer.duration, endsAt });
	}
	private deleted(kind: string, id: string): boolean {
		return this.state.registers[`${kind}:${id}:deleted`]?.value === true;
	}
	actions(): Action[] {
		return Object.keys(this.state.registers)
			.filter(
				(key) =>
					key.startsWith('action:') &&
					key.endsWith(':title') &&
					!this.deleted('action', key.split(':')[1])
			)
			.sort(
				(a, b) =>
					compareClock(this.state.registers[a].clock, this.state.registers[b].clock) ||
					a.localeCompare(b)
			)
			.map((key) => {
				const id = key.split(':')[1];
				return {
					id,
					title: String(this.state.registers[key].value),
					completed: this.state.registers[`action:${id}:completed`]?.value === true
				};
			});
	}
	addAction(title: string): string | undefined {
		const trimmed = title.trim().slice(0, 500);
		if (!trimmed) return;
		const id = crypto.randomUUID();
		this.write(`action:${id}:title`, trimmed);
		this.write(`action:${id}:completed`, false);
		return id;
	}
	setActionCompleted(id: string, completed: boolean) {
		if (!this.state.registers[`action:${id}:title`] || this.deleted('action', id)) return;
		if ((this.state.registers[`action:${id}:completed`]?.value === true) === completed) return;
		this.write(`action:${id}:completed`, completed);
	}
	deleteAction(id: string) {
		if (!this.state.registers[`action:${id}:title`] || this.deleted('action', id)) return;
		this.write(`action:${id}:deleted`, true);
	}
	columns(): Column[] {
		return Object.keys(this.state.registers)
			.filter((k) => k.startsWith('column:') && k.endsWith(':title'))
			.map((k) => {
				const id = k.split(':')[1];
				return {
					id,
					title: String(this.state.registers[k].value),
					position: String(this.state.registers[`column:${id}:position`]?.value ?? '0/1')
				};
			})
			.filter((c) => !this.deleted('column', c.id))
			.sort((a, b) => comparePosition(a.position, b.position) || a.id.localeCompare(b.id));
	}
	cards(columnId?: string): Card[] {
		const liveColumns = new Set(this.columns().map((c) => c.id));
		return Object.keys(this.state.registers)
			.filter((k) => k.startsWith('card:') && k.endsWith(':title'))
			.map((k) => {
				const id = k.split(':')[1];
				return {
					id,
					title: String(this.state.registers[k].value),
					location: this.state.registers[`card:${id}:location`]?.value as Location
				};
			})
			.filter(
				(c) =>
					c.location &&
					!this.deleted('card', c.id) &&
					liveColumns.has(c.location.columnId) &&
					(!columnId || c.location.columnId === columnId)
			)
			.sort(
				(a, b) =>
					comparePosition(a.location.position, b.location.position) || a.id.localeCompare(b.id)
			);
	}
	addColumn(title: string): string {
		const id = crypto.randomUUID(),
			columns = this.columns();
		this.write(`column:${id}:title`, title.trim().slice(0, 120) || 'New column');
		this.write(`column:${id}:position`, between(columns.at(-1)?.position));
		return id;
	}
	renameColumn(id: string, title: string) {
		if (title.trim()) this.write(`column:${id}:title`, title.trim().slice(0, 120));
	}
	deleteColumn(id: string) {
		for (const card of this.cards(id)) this.deleteCard(card.id);
		this.write(`column:${id}:deleted`, true);
	}
	moveColumn(id: string, direction: -1 | 1) {
		const columns = this.columns(),
			index = columns.findIndex((c) => c.id === id),
			target = index + direction;
		if (index < 0 || target < 0 || target >= columns.length) return;
		const others = columns.filter((c) => c.id !== id);
		// Concurrent inserts can share a token. Spread tied neighbors before inserting between them.
		if (
			others[target - 1] &&
			others[target] &&
			comparePosition(others[target - 1].position, others[target].position) === 0
		) {
			others.forEach((column, index) => {
				column.position = `${index}/1`;
				this.write(`column:${column.id}:position`, column.position);
			});
		}
		this.write(
			`column:${id}:position`,
			between(others[target - 1]?.position, others[target]?.position)
		);
	}
	addCard(columnId: string, title: string): string {
		const id = crypto.randomUUID();
		this.write(`card:${id}:title`, title.trim().slice(0, 500) || 'New card');
		this.write(`card:${id}:location`, {
			columnId,
			position: between(this.cards(columnId).at(-1)?.location.position)
		});
		return id;
	}
	renameCard(id: string, title: string) {
		if (title.trim()) this.write(`card:${id}:title`, title.trim().slice(0, 500));
	}
	deleteCard(id: string) {
		this.write(`card:${id}:deleted`, true);
	}
	sortCardsByVotes() {
		for (const { id: columnId } of this.columns()) {
			const cards = this.cards(columnId);
			const sorted = cards
				.map((card) => ({ card, votes: this.votes(card.id) }))
				.sort((a, b) => b.votes - a.votes);
			if (sorted.every(({ card }, index) => card.id === cards[index].id)) continue;
			for (const [index, { card }] of sorted.entries()) {
				this.write(`card:${card.id}:location`, { columnId, position: `${index}/1` });
			}
		}
	}
	moveCard(id: string, columnId: string, beforeId?: string) {
		const cards = this.cards(columnId).filter((c) => c.id !== id);
		const index = beforeId ? cards.findIndex((c) => c.id === beforeId) : cards.length;
		if (index < 0) return;
		if (
			cards[index - 1] &&
			cards[index] &&
			comparePosition(cards[index - 1].location.position, cards[index].location.position) === 0
		) {
			cards.forEach((card, position) => {
				card.location = { columnId, position: `${position}/1` };
				this.write(`card:${card.id}:location`, card.location);
			});
		}
		this.write(`card:${id}:location`, {
			columnId,
			position: between(cards[index - 1]?.location.position, cards[index]?.location.position)
		});
	}
	private ballot(voter: string, slot: number): string | null {
		const value = this.state.registers[`vote:${voter}:${slot}`]?.value;
		return typeof value === 'string' && this.cards().some((c) => c.id === value) ? value : null;
	}
	votes(cardId: string, voter?: string): number {
		const live = this.cards().some((c) => c.id === cardId);
		if (!live) return 0;
		return Object.entries(this.state.registers).filter(([key, reg]) => {
			const [kind, owner, index] = key.split(':');
			return (
				kind === 'vote' &&
				(!voter || owner === voter) &&
				Number(index) < this.limit &&
				reg.value === cardId
			);
		}).length;
	}
	remaining(voter: string): number {
		let used = 0;
		for (let slot = 0; slot < this.limit; slot++) if (this.ballot(voter, slot)) used++;
		return this.limit - used;
	}
	vote(voter: string, cardId: string, direction: -1 | 1): boolean {
		if (!this.cards().some((c) => c.id === cardId)) return false;
		if (direction === 1) {
			for (let slot = 0; slot < this.limit; slot++)
				if (!this.ballot(voter, slot)) {
					this.write(`vote:${voter}:${slot}`, cardId);
					return true;
				}
		} else {
			for (let slot = this.limit - 1; slot >= 0; slot--)
				if (this.ballot(voter, slot) === cardId) {
					this.write(`vote:${voter}:${slot}`, null);
					return true;
				}
		}
		return false;
	}
}

export function createSnapshot(room: string): Snapshot {
	const model = new Model({ version: 1, room, registers: {} });
	model.setTitle('Team retrospective');
	model.setLimit(5);
	for (const title of ['Went well', 'Could improve', 'Actions']) model.addColumn(title);
	return model.state;
}
