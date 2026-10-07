import type { Model } from './state';

function cell(value: string | number): string {
	const text = String(value);
	return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function boardCSV(model: Model): string {
	const rows: (string | number)[][] = [['Card', 'Column', 'Votes', 'Order']];
	for (const column of model.columns()) {
		for (const [index, card] of model.cards(column.id).entries()) {
			rows.push([card.title, column.title, model.votes(card.id), index + 1]);
		}
	}
	return rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
