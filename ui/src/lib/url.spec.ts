import { describe, expect, it } from 'vitest';
import { createSnapshot, Model } from './state';
import { decodeSession, encodeSession, newSecret, URLWriter } from './url';
const room = 'a'.repeat(32);
describe('URL snapshots', () => {
	it('round-trips full Unicode state including votes and tombstones', async () => {
		const m = new Model(createSnapshot(room));
		const column = m.columns()[0].id;
		m.setTitle('Rétro 🌱 — 日本語');
		m.startTimer(300);
		m.stopTimer();
		const card = m.addCard(column, 'Hej 👋');
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
