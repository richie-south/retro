import { describe, expect, it } from 'vitest';
import {
	between,
	comparePosition,
	createSnapshot,
	difference,
	merge,
	Model,
	MAX_TIMER_SECONDS,
	timerRemainingSeconds,
	validateSnapshot
} from './state';
const room = 'a'.repeat(32);
const alice = '00000000-0000-4000-8000-000000000001';
const bob = '00000000-0000-4000-8000-000000000002';
const voter = '00000000-0000-4000-8000-000000000003';
function base() {
	return createSnapshot(room);
}

describe('snapshot merging', () => {
	it('preserves concurrent additions and is commutative, associative and idempotent', () => {
		const start = base(),
			a = new Model(start, alice),
			b = new Model(start, bob),
			c = new Model(start, voter);
		const column = a.columns()[0].id;
		a.addCard(column, 'Alice');
		b.addCard(column, 'Bob');
		c.addColumn('Ideas');
		expect(merge(a.state, b.state)).toEqual(merge(b.state, a.state));
		expect(merge(merge(a.state, b.state), c.state)).toEqual(
			merge(a.state, merge(b.state, c.state))
		);
		expect(merge(a.state, a.state)).toEqual(a.state);
		const result = new Model(merge(merge(a.state, b.state), c.state));
		expect(
			result
				.cards()
				.map((c) => c.title)
				.sort()
		).toEqual(['Alice', 'Bob']);
		expect(result.columns()).toHaveLength(4);
	});
	it('merges edits to different fields, and resolves matching clocks by actor ID', () => {
		const start = base();
		const a = new Model(start, alice, () => 0),
			b = new Model(start, bob, () => 0);
		a.setTitle('A');
		b.setTitle('B');
		expect(a.state.registers['settings:title'].clock.slice(0, 2)).toEqual(
			b.state.registers['settings:title'].clock.slice(0, 2)
		);
		expect(new Model(merge(a.state, b.state)).title).toBe('B');
		b.renameColumn(b.columns()[0].id, 'Good things');
		a.receive(b.state);
		a.setTitle('After receiving');
		expect(new Model(merge(b.state, a.state)).title).toBe('After receiving');
		expect(a.columns()[0].title).toBe('Good things');
	});
	it('latest titles win while atomic locations survive concurrent edits', () => {
		const original = new Model(base(), alice);
		const card = original.addCard(original.columns()[0].id, 'Start');
		const timestamp = Date.now() + 1000;
		const a = new Model(original.state, alice, () => timestamp),
			b = new Model(original.state, bob, () => timestamp + 1);
		a.renameCard(card, 'Earlier');
		b.renameCard(card, 'Later');
		a.moveCard(card, a.columns()[1].id);
		const merged = new Model(merge(a.state, b.state));
		expect(merged.cards()[0].title).toBe('Later');
		expect(merged.cards()[0].location.columnId).toBe(a.columns()[1].id);
	});
	it('keeps deletions through stale snapshots and hides concurrent children of deleted columns', () => {
		const initial = new Model(base(), alice),
			column = initial.columns()[0].id;
		const card = initial.addCard(column, 'Old');
		const stale = new Model(initial.state, bob);
		initial.deleteColumn(column);
		stale.renameCard(card, 'Still old');
		stale.addCard(column, 'Concurrent');
		const merged = new Model(merge(initial.state, stale.state));
		expect(merged.columns().some((c) => c.id === column)).toBe(false);
		expect(merged.cards()).toHaveLength(0);
		expect(new Model(merge(merged.state, stale.state)).cards()).toHaveLength(0);
	});
	it('forwards only changed registers and ignores duplicate deliveries', () => {
		const start = base(),
			a = new Model(start, alice),
			b = new Model(start, bob);
		a.setTitle('Updated');
		const delta = difference(a.state, start);
		expect(Object.keys(delta.registers)).toEqual(['settings:title']);
		expect(Object.keys(b.receive(delta).registers)).toHaveLength(1);
		expect(Object.keys(b.receive(delta).registers)).toHaveLength(0);
		expect(() => merge(start, { ...start, room: 'b'.repeat(32) })).toThrow();
	});
	it('rejects invalid clocks, keys and locations', () => {
		const state = base();
		expect(validateSnapshot(state)).toEqual(state);
		expect(() => validateSnapshot({ ...state, version: 2 })).toThrow();
		expect(() =>
			validateSnapshot({
				...state,
				registers: {
					__proto__: { value: 'bad', clock: [1, 0, alice] },
					'bad:key': { value: 'bad', clock: [1, 0, alice] }
				}
			})
		).toThrow();
		expect(() =>
			validateSnapshot({
				...state,
				registers: { 'settings:limit': { value: 5, clock: [-1, 0, alice] } }
			})
		).toThrow();
	});
});

describe('shared actions', () => {
	it('creates trimmed actions, ignores blank input and allows checking and unchecking', () => {
		const m = new Model(base(), alice);
		expect(m.actions()).toEqual([]);
		const before = structuredClone(m.state);
		expect(m.addAction('  \n ')).toBeUndefined();
		m.setActionCompleted(voter, true);
		expect(m.state).toEqual(before);
		const first = m.addAction('  Schedule a follow-up  ')!;
		const second = m.addAction('x'.repeat(501))!;
		expect(m.actions()).toEqual([
			{ id: first, title: 'Schedule a follow-up', completed: false },
			{ id: second, title: 'x'.repeat(500), completed: false }
		]);
		m.setActionCompleted(first, true);
		expect(m.actions()[0].completed).toBe(true);
		m.setActionCompleted(first, false);
		expect(m.actions()[0].completed).toBe(false);
		expect(validateSnapshot(m.state)).toEqual(m.state);
	});
	it('preserves concurrent additions in the same order and resolves completion changes across peers', () => {
		const start = base(),
			a = new Model(start, alice, () => 0),
			b = new Model(start, bob, () => 0);
		const first = a.addAction('Plan focus time')!;
		b.addAction('Review the release process');
		const aState = structuredClone(a.state);
		a.receive(validateSnapshot(difference(b.state, start)));
		b.receive(validateSnapshot(difference(aState, start)));
		expect(a.actions()).toEqual(b.actions());
		expect(a.actions().map((action) => action.title)).toEqual([
			'Plan focus time',
			'Review the release process'
		]);
		const stale = structuredClone(a.state);
		a.setActionCompleted(first, true);
		b.receive(validateSnapshot(difference(a.state, stale)));
		expect(b.actions()[0].completed).toBe(true);
		b.setActionCompleted(first, false);
		a.receive(b.state);
		a.receive(stale);
		expect(a.actions()).toEqual(b.actions());
		expect(a.actions()[0].completed).toBe(false);
		const completed = new Model(a.state, alice, () => 0),
			unchecked = new Model(a.state, bob, () => 0);
		completed.setActionCompleted(first, true);
		unchecked.setActionCompleted(first, true);
		unchecked.setActionCompleted(first, false);
		expect(merge(completed.state, unchecked.state)).toEqual(
			merge(unchecked.state, completed.state)
		);
		expect(new Model(merge(completed.state, unchecked.state)).actions()[0].completed).toBe(false);
	});
	it('syncs deletions and keeps stale snapshots and concurrent completion changes from restoring actions', () => {
		const original = new Model(base(), alice);
		const removed = original.addAction('Remove this next step')!;
		const kept = original.addAction('Keep this next step')!;
		const stale = structuredClone(original.state);
		const peer = new Model(stale, bob);
		peer.setActionCompleted(removed, true);
		original.deleteAction(removed);
		peer.receive(validateSnapshot(difference(original.state, stale)));
		original.receive(peer.state);
		original.receive(stale);
		expect(original.actions()).toEqual([
			{ id: kept, title: 'Keep this next step', completed: false }
		]);
		expect(peer.actions()).toEqual(original.actions());
		const after = structuredClone(original.state);
		original.setActionCompleted(removed, true);
		original.deleteAction(removed);
		original.deleteAction(voter);
		expect(original.state).toEqual(after);
		expect(new Model(validateSnapshot(original.state)).actions()).toEqual(original.actions());
	});
	it('validates action titles, completion and deletion in snapshots and partial updates', () => {
		for (const [field, value] of [
			['title', ''],
			['title', '   '],
			['title', 'x'.repeat(501)],
			['title', false],
			['completed', 'true'],
			['completed', 1],
			['completed', null],
			['deleted', false],
			['deleted', 'true'],
			['unknown', true]
		]) {
			expect(() =>
				validateSnapshot({
					version: 1,
					room,
					registers: { [`action:${alice}:${field}`]: { value, clock: [1, 0, bob] } }
				})
			).toThrow();
		}
		for (const value of [true, false]) {
			const delta = {
				version: 1,
				room,
				registers: { [`action:${alice}:completed`]: { value, clock: [1, 0, bob] } }
			};
			expect(validateSnapshot(delta)).toEqual(delta);
		}
	});
});

describe('shared timer', () => {
	it('shares an absolute deadline, counts down without writes and allows editing and voting after expiry', () => {
		let now = Date.now();
		const m = new Model(base(), alice, () => now);
		expect(m.timer).toEqual({ duration: 180, endsAt: null });
		expect(timerRemainingSeconds(m.timer, now)).toBe(180);
		const before = structuredClone(m.state);
		m.startTimer(300);
		const peer = new Model(before, bob, () => now);
		peer.receive(validateSnapshot(difference(m.state, before)));
		expect(peer.timer).toEqual({ duration: 300, endsAt: now + 300_000 });
		const started = structuredClone(m.state);
		now += 1500;
		expect(timerRemainingSeconds(peer.timer, now)).toBe(299);
		now += 300_000;
		expect(timerRemainingSeconds(peer.timer, now)).toBe(0);
		expect(m.state).toEqual(started);
		const card = peer.addCard(peer.columns()[0].id, 'After expiry');
		peer.renameCard(card, 'Still editable');
		expect(peer.vote(voter, card, 1)).toBe(true);
		expect(peer.cards()[0].title).toBe('Still editable');
		peer.startTimer();
		m.receive(peer.state);
		expect(m.timer).toEqual({ duration: 300, endsAt: now + 300_000 });
		expect(timerRemainingSeconds(m.timer, now)).toBe(300);
	});
	it('freezes and resumes the shared remaining time, while allowing a fresh round with the configured duration', () => {
		let now = Date.now();
		const m = new Model(base(), alice, () => now),
			peer = new Model(m.state, bob, () => now);
		m.startTimer(300);
		peer.receive(m.state);
		now += 1250;
		peer.stopTimer();
		m.receive(validateSnapshot(peer.state));
		expect(m.timer).toEqual({ duration: 300, endsAt: null, remaining: 299 });
		now += 120_000;
		expect(timerRemainingSeconds(m.timer, now)).toBe(299);
		expect(timerRemainingSeconds(peer.timer, now)).toBe(299);
		const stopped = structuredClone(m.state);
		m.stopTimer();
		expect(m.state).toEqual(stopped);
		m.resumeTimer();
		peer.receive(validateSnapshot(m.state));
		expect(peer.timer).toEqual({ duration: 300, endsAt: now + 299_000 });
		expect(timerRemainingSeconds(peer.timer, now)).toBe(299);
		const resumed = structuredClone(m.state);
		m.resumeTimer();
		expect(m.state).toEqual(resumed);
		now += 1000;
		expect(timerRemainingSeconds(peer.timer, now)).toBe(298);
		m.startTimer();
		peer.receive(m.state);
		expect(peer.timer).toEqual({ duration: 300, endsAt: now + 300_000 });
	});
	it('resolves concurrent restarts atomically and does not restore a stale timer', () => {
		const start = base(),
			now = Date.now() + 1000;
		const a = new Model(start, alice, () => now),
			b = new Model(start, bob, () => now);
		a.startTimer(300);
		b.startTimer(60);
		expect(merge(a.state, b.state)).toEqual(merge(b.state, a.state));
		const m = new Model(merge(a.state, b.state), alice, () => now + 1000);
		expect(m.timer).toEqual(b.timer);
		const stale = structuredClone(m.state);
		m.startTimer(120);
		m.receive(stale);
		expect(m.timer).toEqual({ duration: 120, endsAt: now + 121_000 });
		expect(new Model(validateSnapshot(m.state)).timer).toEqual(m.timer);
	});
	it('rejects invalid duration and deadline data', () => {
		const m = new Model(base(), alice);
		const before = structuredClone(m.state);
		for (const duration of [0, -1, 1.5, NaN, Infinity, MAX_TIMER_SECONDS + 1]) {
			m.startTimer(duration);
			expect(m.state).toEqual(before);
		}
		for (const value of [
			{ duration: 0, endsAt: null },
			{ duration: MAX_TIMER_SECONDS + 1, endsAt: 1 },
			{ duration: 300, endsAt: -1 },
			{ duration: 300, endsAt: 1.5 },
			{ duration: 300, endsAt: Number.MAX_SAFE_INTEGER + 1 },
			{ duration: 300 },
			{ duration: 300, endsAt: null, remaining: -1 },
			{ duration: 300, endsAt: null, remaining: 301 },
			{ duration: 300, endsAt: null, remaining: 1.5 },
			{ duration: 300, endsAt: 5000, remaining: 100 },
			'300'
		]) {
			expect(() =>
				validateSnapshot({
					...before,
					registers: {
						'settings:timer': { value, clock: [1, 0, alice] }
					}
				})
			).toThrow();
		}
		m.startTimer(MAX_TIMER_SECONDS);
		expect(validateSnapshot(m.state)).toEqual(m.state);
	});
});

describe('voting', () => {
	it('supports stacking, removal, limits and restoring hidden slots', () => {
		const m = new Model(base(), alice),
			card = m.addCard(m.columns()[0].id, 'Vote here');
		for (let i = 0; i < 5; i++) expect(m.vote(voter, card, 1)).toBe(true);
		expect(m.vote(voter, card, 1)).toBe(false);
		expect(m.votes(card)).toBe(5);
		expect(m.remaining(voter)).toBe(0);
		m.setLimit(2);
		expect(m.votes(card)).toBe(2);
		expect(m.vote(voter, card, -1)).toBe(true);
		expect(m.remaining(voter)).toBe(1);
		m.setLimit(5);
		expect(m.votes(card)).toBe(4);
		m.deleteCard(card);
		expect(m.votes(card)).toBe(0);
		expect(m.remaining(voter)).toBe(5);
	});
	it('concurrent tabs sharing an identity cannot exceed the budget', () => {
		const start = new Model(base()),
			column = start.columns()[0].id;
		const first = start.addCard(column, 'First'),
			second = start.addCard(column, 'Second');
		start.setLimit(1);
		const a = new Model(start.state, alice, () => Date.now() + 100),
			b = new Model(start.state, bob, () => Date.now() + 100);
		a.vote(voter, first, 1);
		b.vote(voter, second, 1);
		const merged = new Model(merge(a.state, b.state));
		expect(merged.votes(first) + merged.votes(second)).toBe(1);
		expect(merged.remaining(voter)).toBe(0);
	});
});

describe('ordering', () => {
	it('sorts every column by total votes, preserves ties and syncs through snapshots', () => {
		const m = new Model(base(), alice),
			column = m.columns()[0].id,
			otherColumn = m.columns()[1].id;
		const zero = m.addCard(column, 'No votes'),
			firstTie = m.addCard(column, 'First tie'),
			secondTie = m.addCard(column, 'Second tie'),
			most = m.addCard(column, 'Most votes');
		const otherZero = m.addCard(otherColumn, 'Other no votes'),
			otherMost = m.addCard(otherColumn, 'Other most votes');
		m.vote(voter, otherMost, 1);
		m.vote(voter, firstTie, 1);
		m.vote(bob, secondTie, 1);
		m.vote(voter, most, 1);
		m.vote(bob, most, 1);
		const before = structuredClone(m.state),
			peer = new Model(before, bob);
		m.sortCardsByVotes();
		expect(m.cards(column).map((card) => card.id)).toEqual([most, firstTie, secondTie, zero]);
		expect(m.cards(otherColumn).map((card) => card.id)).toEqual([otherMost, otherZero]);
		peer.receive(difference(m.state, before));
		expect(peer.cards()).toEqual(m.cards());
		expect(new Model(validateSnapshot(m.state)).cards()).toEqual(m.cards());
		const sorted = structuredClone(m.state);
		m.sortCardsByVotes();
		expect(m.state).toEqual(sorted);
		m.moveCard(zero, column, most);
		expect(m.cards(column).map((card) => card.id)).toEqual([zero, most, firstTie, secondTie]);
	});
	it('sorts using only votes counted under the current allowance', () => {
		const m = new Model(base(), alice),
			column = m.columns()[0].id;
		const hidden = m.addCard(column, 'Hidden votes'),
			counted = m.addCard(column, 'Counted vote');
		m.vote(voter, counted, 1);
		m.vote(voter, hidden, 1);
		m.vote(voter, hidden, 1);
		m.setLimit(1);
		m.sortCardsByVotes();
		expect(m.cards(column).map((card) => card.id)).toEqual([counted, hidden]);
	});
	it('inserts between concurrent entities that share an ordering token', () => {
		const start = new Model(base()),
			column = start.columns()[0].id;
		const original = start.addCard(column, 'Original');
		const a = new Model(start.state, alice),
			b = new Model(start.state, bob);
		a.addCard(column, 'Concurrent A');
		b.addCard(column, 'Concurrent B');
		a.receive(b.state);
		const tied = a.cards(column).filter((card) => card.id !== original);
		expect(tied[0].location.position).toBe(tied[1].location.position);
		a.moveCard(original, column, tied[1].id);
		expect(a.cards(column).map((card) => card.id)).toEqual([tied[0].id, original, tied[1].id]);
		expect(validateSnapshot(a.state)).toEqual(a.state);
	});
	it('can insert repeatedly without floating-point exhaustion', () => {
		let position = '1/1';
		for (let i = 0; i < 100; i++) position = between('0/1', position);
		expect(comparePosition('0/1', position)).toBe(-1);
		expect(comparePosition(position, '1/1')).toBe(-1);
	});
	it('moves columns and cards through accessible ordering controls', () => {
		const m = new Model(base()),
			columns = m.columns(),
			column = columns[0].id;
		m.moveColumn(column, 1);
		expect(m.columns()[1].id).toBe(column);
		const a = m.addCard(column, 'A'),
			b = m.addCard(column, 'B');
		m.moveCard(b, column, a);
		expect(m.cards(column).map((c) => c.id)).toEqual([b, a]);
		m.moveCard(a, columns[2].id);
		expect(m.cards(columns[2].id)[0].id).toBe(a);
	});
});
