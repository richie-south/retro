import { type Snapshot, validateSnapshot } from './state';
import { base64url, unbase64url, MAX_SNAPSHOT_BYTES } from './url';

export type ConnectionStatus = {
	status: string;
	participants: number;
	connected: boolean;
	error: string;
};
type Callbacks = {
	snapshot: () => Snapshot;
	receive: (state: Snapshot) => Snapshot;
	status: (status: ConnectionStatus) => void;
};
type Message = {
	type: string;
	id?: string;
	members?: string[];
	from?: string;
	to?: string;
	payload?: string;
	error?: string;
};

/** Go relays encrypted snapshots and updates. The URL remains the durable state. */
export class SocketNetwork {
	private socket?: WebSocket;
	private key?: CryptoKey;
	private id = '';
	private members = new Set<string>();
	private stopped = false;
	private blocked = false;
	private failures = 0;
	private reconnect?: ReturnType<typeof setTimeout>;
	private refresh?: ReturnType<typeof setInterval>;
	private error = '';
	private joined = false;
	constructor(
		private room: string,
		private secret: string,
		private callbacks: Callbacks
	) {}
	async start() {
		try {
			this.key = await crypto.subtle.importKey('raw', unbase64url(this.secret), 'AES-GCM', false, [
				'encrypt',
				'decrypt'
			]);
			if (this.stopped) return;
			this.connect();
			this.refresh = setInterval(() => this.broadcast(this.callbacks.snapshot()), 60_000);
		} catch {
			if (this.stopped) return;
			this.error = 'Cannot initialize synchronization. You can still edit and save your URL.';
			this.publish();
		}
	}
	private publish() {
		if (this.stopped) return;
		this.callbacks.status({
			status: this.joined
				? this.members.size
					? 'Connected'
					: 'Connected · just you'
				: 'Offline · editing locally',
			participants: this.members.size + 1,
			connected: this.joined,
			error: this.error
		});
	}
	private connect() {
		if (this.stopped || this.blocked) return;
		const socket = new WebSocket(
			`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/socket`
		);
		this.socket = socket;
		let incoming = Promise.resolve();
		socket.onopen = () => {
			if (this.stopped || this.socket !== socket) return;
			socket.send(JSON.stringify({ type: 'join', room: this.room }));
		};
		socket.onmessage = (event) => {
			// Decryption is asynchronous; process frames in their WebSocket delivery order.
			incoming = incoming
				.then(async () => {
					if (this.socket !== socket || this.stopped) return;
					if (typeof event.data !== 'string' || event.data.length > MAX_SNAPSHOT_BYTES * 2)
						throw new Error('Invalid message.');
					await this.handle(JSON.parse(event.data), socket);
				})
				.catch(() => {
					if (this.socket !== socket || this.stopped) return;
					this.error = 'Ignored invalid or unauthenticated session data.';
					this.publish();
				});
		};
		socket.onclose = (event) => {
			if (this.socket !== socket || this.stopped) return;
			this.joined = false;
			this.id = '';
			this.members.clear();
			if (event.code === 1008) this.blocked = true;
			if (!this.blocked) {
				this.error =
					'Connection lost. Changes are saved in your URL and will merge when reconnected.';
				this.reconnect = setTimeout(
					() => this.connect(),
					Math.min(30_000, 1000 * 2 ** this.failures++) + Math.random() * 250
				);
			}
			this.publish();
		};
		socket.onerror = () => {
			if (this.socket !== socket || this.stopped) return;
			this.error = 'The sync server is unavailable. You can still edit and save your URL.';
			this.publish();
		};
		this.publish();
	}
	private async handle(message: Message, socket: WebSocket) {
		if (message.type === 'welcome' && message.id && Array.isArray(message.members ?? [])) {
			this.id = message.id;
			this.members = new Set(message.members ?? []);
			this.joined = true;
			this.failures = 0;
			this.error = '';
			// Returning clients contribute their complete snapshot, including offline changes.
			this.send(this.callbacks.snapshot());
		} else if (message.type === 'member-joined' && message.id) {
			this.members.add(message.id);
			this.send(this.callbacks.snapshot(), message.id);
		} else if (message.type === 'member-left' && message.id) {
			this.members.delete(message.id);
		} else if (message.type === 'error') {
			this.error = message.error ?? 'Synchronization error.';
		} else if (message.type === 'state' && message.from && typeof message.payload === 'string') {
			const bytes = unbase64url(message.payload);
			if (bytes.length < 28 || bytes.length > MAX_SNAPSHOT_BYTES + 28)
				throw new Error('Invalid encrypted snapshot.');
			const plaintext = await crypto.subtle.decrypt(
				{
					name: 'AES-GCM',
					iv: bytes.slice(0, 12),
					additionalData: new TextEncoder().encode(
						`${this.room}:${message.from}:${message.to || '*'}`
					)
				},
				this.key!,
				bytes.slice(12)
			);
			if (this.socket !== socket || this.stopped) return;
			this.callbacks.receive(
				validateSnapshot(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)))
			);
		} else throw new Error('Invalid message.');
		this.publish();
	}
	private send(state: Snapshot, to?: string) {
		const socket = this.socket,
			id = this.id;
		if (!this.joined || !socket || socket.readyState !== WebSocket.OPEN || this.stopped) return;
		const plaintext = new TextEncoder().encode(JSON.stringify(state));
		if (plaintext.length > MAX_SNAPSHOT_BYTES) {
			this.error =
				'This session is too large to synchronize safely. Your URL still holds your state.';
			this.publish();
			return;
		}
		// A periodic snapshot repairs a skipped update if a slow socket is backpressured.
		if (socket.bufferedAmount > 1024 * 1024) return;
		const iv = crypto.getRandomValues(new Uint8Array(12));
		void crypto.subtle
			.encrypt(
				{
					name: 'AES-GCM',
					iv,
					additionalData: new TextEncoder().encode(`${this.room}:${id}:${to || '*'}`)
				},
				this.key!,
				plaintext
			)
			.then((ciphertext) => {
				if (
					this.socket !== socket ||
					!this.joined ||
					socket.readyState !== WebSocket.OPEN ||
					this.stopped
				)
					return;
				const encrypted = new Uint8Array(12 + ciphertext.byteLength);
				encrypted.set(iv);
				encrypted.set(new Uint8Array(ciphertext), 12);
				socket.send(JSON.stringify({ type: 'state', to, payload: base64url(encrypted) }));
			})
			.catch(() => {
				if (this.stopped || this.socket !== socket) return;
				this.error = 'Could not send an update. It remains in your URL and will retry during sync.';
				this.publish();
			});
	}
	broadcast(state: Snapshot) {
		this.send(state);
	}
	stop() {
		this.stopped = true;
		clearTimeout(this.reconnect);
		clearInterval(this.refresh);
		this.socket?.close();
		this.members.clear();
	}
}
