export type ExportFormat = 'markdown' | 'csv';

export function exportFilename(title: string, format: ExportFormat): string {
	const name = title
		.normalize('NFKC')
		.replace(/[<>:"/\\|?*\p{Cc}]/gu, '-')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.slice(0, 100)
		.replace(/^[. -]+|[. -]+$/g, '');
	return `${name || 'retrospective'}.${format === 'markdown' ? 'md' : 'csv'}`;
}
