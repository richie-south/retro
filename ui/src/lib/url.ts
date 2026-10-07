import { roomPattern, validateSnapshot, type Snapshot } from './state';

export type Session = { state: Snapshot; secret: string };
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

export function base64url(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i += 8192)
		binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
export function unbase64url(value: string): Uint8Array<ArrayBuffer> {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid link encoding.');
	return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
		c.charCodeAt(0)
	);
}
export function newRoom(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
		b.toString(16).padStart(2, '0')
	).join('');
}
export function newSecret(): string {
	return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function encodeSession(session: Session): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(session.state));
	const compressed = await new Response(
		new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))
	).arrayBuffer();
	return `#v=1&r=${session.state.room}&k=${session.secret}&s=${base64url(new Uint8Array(compressed))}`;
}

export async function decodeSession(hash: string): Promise<Session> {
	try {
		const params = new URLSearchParams(hash.replace(/^#/, ''));
		const room = params.get('r'),
			secret = params.get('k'),
			data = params.get('s');
		if (
			params.get('v') !== '1' ||
			!room ||
			!roomPattern.test(room) ||
			!secret ||
			!/^[A-Za-z0-9_-]{43}$/.test(secret) ||
			!data ||
			data.length > MAX_SNAPSHOT_BYTES * 2
		)
			throw new Error('Invalid or unsupported link.');
		if (unbase64url(secret).length !== 32) throw new Error('Invalid session secret.');
		const reader = new Blob([unbase64url(data)])
			.stream()
			.pipeThrough(new DecompressionStream('gzip'))
			.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				size += value.length;
				if (size > MAX_SNAPSHOT_BYTES)
					throw new Error('This snapshot is too large to open safely.');
				chunks.push(value);
			}
		} finally {
			await reader.cancel();
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		const state = validateSnapshot(
			JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
		);
		if (
			state.room !== room ||
			!state.registers['settings:title'] ||
			!state.registers['settings:limit']
		)
			throw new Error('This snapshot is incomplete.');
		return { state, secret };
	} catch (error) {
		throw new Error(
			error instanceof Error
				? `Cannot open retrospective: ${error.message}`
				: 'Cannot open this retrospective.'
		);
	}
}

/** Serializes only the latest revision, including when compression finishes out of order. */
export class URLWriter {
	private revision = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private latest?: Session;
	constructor(
		private apply: (hash: string) => void,
		private report: (message: string) => void,
		private encode = encodeSession
	) {}
	schedule(session: Session) {
		this.latest = structuredClone(session);
		this.revision++;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			void this.flush().catch(() => {});
		}, 150);
	}
	async flush(): Promise<string> {
		clearTimeout(this.timer);
		while (this.latest) {
			const revision = this.revision;
			let hash: string;
			try {
				hash = await this.encode(this.latest);
			} catch (error) {
				this.report('Could not encode the latest snapshot. Keep this tab open and try again.');
				throw error;
			}
			if (revision !== this.revision) continue;
			try {
				this.apply(hash);
			} catch (error) {
				this.report('Could not update the URL. Keep this tab open so your changes are preserved.');
				throw error;
			}
			return hash;
		}
		throw new Error('No retrospective is open.');
	}
	destroy() {
		clearTimeout(this.timer);
		this.latest = undefined;
		this.revision++;
	}
}
