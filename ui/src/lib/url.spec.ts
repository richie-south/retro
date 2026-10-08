import { describe, expect, it } from 'vitest';
import { createSnapshot, Model } from './state';
import { decodeSession, encodeRoomLink, encodeSession, newSecret, URLWriter } from './url';
const room = 'a'.repeat(32);
describe('URL snapshots', () => {
	it('joins a short room link with no registers to overwrite the live state', async () => {
		const secret = newSecret();
		const hash = encodeRoomLink(room, secret);
		expect(new URLSearchParams(hash.slice(1)).has('s')).toBe(false);
		const session = await decodeSession(hash);
		expect(session).toEqual({ state: { version: 1, room, registers: {} }, secret });
		const host = new Model(createSnapshot(room));
		host.setTitle('Live room');
		host.setLimit(2);
		host.addCard(host.columns()[0].id, 'Existing card');
		const original = structuredClone(host.state);
		host.receive(session.state);
		expect(host.state).toEqual(original);
		const guest = new Model(session.state);
		guest.receive(host.state);
		expect(guest.state).toEqual(original);
	});
	it('validates room links and rejects an explicitly empty snapshot', async () => {
		const secret = newSecret();
		for (const hash of [
			encodeRoomLink('bad-room', secret),
			encodeRoomLink(room, 'bad-secret'),
			`#v=2&r=${room}&k=${secret}`,
			`#v=1&r=${room}`,
			`${encodeRoomLink(room, secret)}&s=`
		]) {
			await expect(decodeSession(hash)).rejects.toThrow('Cannot open retrospective');
		}
	});
	it('round-trips full Unicode state including votes and tombstones', async () => {
		const m = new Model(createSnapshot(room));
		const column = m.columns()[0].id;
		m.setTitle('Rétro 🌱 — 日本語');
		m.startTimer(300);
		m.stopTimer();
		const card = m.addCard(column, 'Hej 👋');
		const action = m.addAction('Boka uppföljning 🌱')!;
		m.setActionCompleted(action, true);
		m.addAction('Review 日本語 notes');
		const deletedAction = m.addAction('Removed next step')!;
		m.deleteAction(deletedAction);
		m.vote(crypto.randomUUID(), card, 1);
		const deleted = m.addCard(column, 'Gone');
		m.deleteCard(deleted);
		const session = { state: m.state, secret: newSecret() };
		expect(await decodeSession(await encodeSession(session))).toEqual(session);
	});
	it('rejects corrupt, unsupported and mismatched snapshots', async () => {
		await expect(decodeSession('#v=2&r=x')).rejects.toThrow();
		await expect(
			decodeSession('#v=1&r=' + room + '&k=' + newSecret() + '&s=broken')
		).rejects.toThrow();
		const hash = await encodeSession({ state: createSnapshot(room), secret: newSecret() });
		await expect(decodeSession(hash.replace('r=' + room, 'r=' + 'b'.repeat(32)))).rejects.toThrow();
	});
	it('restores an older saved link independently of later edits', async () => {
		const m = new Model(createSnapshot(room)),
			secret = newSecret();
		const old = await encodeSession({ state: m.state, secret });
		m.setTitle('Newer');
		const reopened = new Model((await decodeSession(old)).state);
		expect(reopened.title).toBe('Team retrospective');
		reopened.receive(m.state);
		expect(reopened.title).toBe('Newer');
	});
	it('cannot apply an older encoding after a newer revision', async () => {
		let finishOld!: (value: string) => void;
		const applied: string[] = [];
		const m = new Model(createSnapshot(room));
		const writer = new URLWriter(
			(hash) => applied.push(hash),
			() => {},
			(session) =>
				session.state.registers['settings:title'].value === 'Old'
					? new Promise((resolve) => (finishOld = resolve))
					: Promise.resolve('#new')
		);
		m.setTitle('Old');
		writer.schedule({ state: m.state, secret: newSecret() });
		const old = writer.flush();
		m.setTitle('New');
		writer.schedule({ state: m.state, secret: newSecret() });
		await writer.flush();
		finishOld('#old');
		await old;
		expect(applied).toEqual(['#new', '#new']);
		writer.destroy();
	});
	it('reports history failures without claiming a saved link', async () => {
		let report = '';
		const writer = new URLWriter(
			() => {
				throw new Error('History failed');
			},
			(message) => (report = message),
			async () => '#snapshot'
		);
		writer.schedule({ state: createSnapshot(room), secret: newSecret() });
		await expect(writer.flush()).rejects.toThrow('History failed');
		expect(report).toContain('Could not update the URL');
		writer.destroy();
	});
});
