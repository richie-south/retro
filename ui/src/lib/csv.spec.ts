import { describe, expect, it } from 'vitest';
import { boardCSV } from './csv';
import { exportFilename } from './export';
import { createSnapshot, Model } from './state';

const room = 'a'.repeat(32);
const voter = '00000000-0000-4000-8000-000000000001';

describe('CSV export', () => {
	it('preserves column and card order and counted votes without changing the board', () => {
		const model = new Model(createSnapshot(room));
		const [well, improve, actions] = model.columns();
		const first = model.addCard(well.id, 'First');
		const second = model.addCard(well.id, 'Second');
		model.addCard(actions.id, 'Follow up');
		const deleted = model.addCard(well.id, 'Deleted card');
		model.addCard(improve.id, 'Deleted column card');
		model.vote(voter, second, 1);
		model.vote(voter, second, 1);
		model.setLimit(1);
		model.deleteCard(deleted);
		model.deleteColumn(improve.id);
		model.moveColumn(actions.id, -1);
		model.moveCard(second, well.id, first);
		const before = structuredClone(model.state);
		expect(boardCSV(model)).toBe(
			'Card,Column,Votes,Order\r\nFollow up,Actions,0,1\r\nSecond,Went well,1,1\r\nFirst,Went well,0,2\r\n'
		);
		expect(model.state).toEqual(before);
	});

	it('quotes commas, double quotes and line breaks while preserving Unicode and literal text', () => {
		const model = new Model(createSnapshot(room));
		const column = model.columns()[0];
		model.renameColumn(column.id, 'Ideas, "next"');
		model.addCard(column.id, 'Rétro 日本語\nOne, "two"\r\nThree\rFour | *five*');
		expect(boardCSV(model)).toBe(
			'Card,Column,Votes,Order\r\n"Rétro 日本語\nOne, ""two""\r\nThree\rFour | *five*","Ideas, ""next""",0,1\r\n'
		);
	});

	it('exports just the header when the board has no cards or columns', () => {
		const model = new Model(createSnapshot(room));
		expect(boardCSV(model)).toBe('Card,Column,Votes,Order\r\n');
		for (const column of model.columns()) model.deleteColumn(column.id);
		expect(boardCSV(model)).toBe('Card,Column,Votes,Order\r\n');
	});
});

describe('export filenames', () => {
	it('uses the selected extension and a portable title, preserving Unicode with a fallback', () => {
		expect(exportFilename('Sprint 12: review / next?', 'markdown')).toBe(
			'Sprint-12-review-next.md'
		);
		expect(exportFilename('Sprint 12: review / next?', 'csv')).toBe('Sprint-12-review-next.csv');
		expect(exportFilename('Rétro 日本語', 'csv')).toBe('Rétro-日本語.csv');
		expect(exportFilename('../', 'markdown')).toBe('retrospective.md');
		expect(exportFilename('../', 'csv')).toBe('retrospective.csv');
		expect(exportFilename('a'.repeat(120), 'markdown')).toBe(`${'a'.repeat(100)}.md`);
	});
});
