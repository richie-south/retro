import { describe, expect, it } from 'vitest';
import { boardMarkdown } from './markdown';
import { createSnapshot, Model } from './state';

const room = 'a'.repeat(32);
const voter = '00000000-0000-4000-8000-000000000001';

describe('Markdown export', () => {
	it('preserves column and card order, empty cells and anonymous vote totals without changing state', () => {
		const model = new Model(createSnapshot(room));
		const [well, improve, actions] = model.columns();
		model.setTitle('Sprint 12');
		const first = model.addCard(well.id, 'Shipped together');
		const second = model.addCard(well.id, 'Helpful reviews');
		model.addCard(actions.id, 'Pair more');
		model.vote(voter, first, 1);
		model.vote(voter, first, 1);
		model.vote(voter, second, 1);
		model.moveColumn(actions.id, -1);
		model.moveCard(second, well.id, first);
		const before = structuredClone(model.state);
		expect(boardMarkdown(model)).toBe(
			[
				'# Sprint 12',
				'',
				'Votes per person: 5',
				'Total votes: 3',
				'',
				`| ${well.title} | ${actions.title} | ${improve.title} |`,
				'| --- | --- | --- |',
				'| Helpful reviews<br>**1 vote** | Pair more<br>**0 votes** |  |',
				'| Shipped together<br>**2 votes** |  |  |',
				''
			].join('\n')
		);
		expect(model.state).toEqual(before);
	});

	it('exports only live content and votes counted under the current allowance', () => {
		const model = new Model(createSnapshot(room));
		const [well, improve] = model.columns();
		const live = model.addCard(well.id, 'Live');
		const removed = model.addCard(well.id, 'Removed card');
		model.addCard(improve.id, 'Removed column card');
		model.vote(voter, live, 1);
		model.vote(voter, live, 1);
		model.vote(voter, removed, 1);
		model.setLimit(1);
		model.deleteCard(removed);
		model.deleteColumn(improve.id);
		const markdown = boardMarkdown(model);
		expect(markdown).toContain('Votes per person: 1\nTotal votes: 1');
		expect(markdown).toContain('Live<br>**1 vote**');
		expect(markdown).not.toContain('Removed');
		expect(markdown).not.toContain('Could improve');
		expect(markdown).not.toContain(voter);
		expect(markdown).not.toContain(room);
	});

	it('keeps multiline text, pipes, HTML and Markdown syntax literal inside the table', () => {
		const model = new Model(createSnapshot(room));
		const column = model.columns()[0];
		model.setTitle('Review *today*');
		model.renameColumn(column.id, 'A | B & <C>');
		model.addCard(
			column.id,
			'Line one\r\nLine two\rLine three\n*bold* [link](url) `code` \\ | <br> &amp;'
		);
		const markdown = boardMarkdown(model);
		expect(markdown).toContain('# Review \\*today\\*');
		expect(markdown).toContain('| A &#124; B &amp; &lt;C&gt; |');
		expect(markdown).toContain(
			'Line one<br>Line two<br>Line three<br>\\*bold\\* \\[link\\](url) \\`code\\` \\\\ &#124; &lt;br&gt; &amp;amp;<br>**0 votes**'
		);
		expect(markdown.split('\n').filter((line) => line.startsWith('|'))).toHaveLength(3);
	});

	it('exports headers for empty columns and readable output when there are no columns', () => {
		const model = new Model(createSnapshot(room));
		expect(boardMarkdown(model)).toContain(
			'| Went well | Could improve | Actions |\n| --- | --- | --- |\n'
		);
		for (const column of model.columns()) model.deleteColumn(column.id);
		expect(boardMarkdown(model)).toBe(
			'# Team retrospective\n\nVotes per person: 5\nTotal votes: 0\n\nNo columns.\n'
		);
	});
});
