import type { Model } from './state';

// Keep user text literal, and keep every table cell on a single Markdown line.
function text(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/[\\`*_[\]~]/g, '\\$&')
		.replace(/\|/g, '&#124;')
		.replace(/\r\n?|\n/g, '<br>');
}

export function boardMarkdown(model: Model): string {
	const columns = model.columns();
	const cards = columns.map((column) =>
		model.cards(column.id).map((card) => ({ title: card.title, votes: model.votes(card.id) }))
	);
	const total = cards.flat().reduce((sum, card) => sum + card.votes, 0);
	const lines = [
		`# ${text(model.title)}`,
		'',
		`Votes per person: ${model.limit}`,
		`Total votes: ${total}`,
		''
	];
	if (columns.length) {
		const row = (cells: string[]) => `| ${cells.join(' | ')} |`;
		lines.push(row(columns.map((column) => text(column.title))), row(columns.map(() => '---')));
		const height = Math.max(0, ...cards.map((column) => column.length));
		for (let index = 0; index < height; index++) {
			lines.push(
				row(
					cards.map((column) => {
						const card = column[index];
						return card
							? `${text(card.title)}<br>**${card.votes} ${card.votes === 1 ? 'vote' : 'votes'}**`
							: '';
					})
				)
			);
		}
	} else {
		lines.push('No columns.');
	}
	return lines.join('\n') + '\n';
}
