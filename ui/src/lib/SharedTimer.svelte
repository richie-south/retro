<script lang="ts">
	import { onMount } from 'svelte';
	import { MAX_TIMER_SECONDS, timerRemainingSeconds, type Timer } from './state';

	let {
		timer,
		onstart,
		onstop,
		onresume
	}: {
		timer: Timer;
		onstart: (duration: number) => void;
		onstop: () => void;
		onresume: () => void;
	} = $props();
	let now = $state(Date.now());
	let open = $state(false);
	let minutes = $state<number | undefined>(3);
	let seconds = $state<number | undefined>(0);
	let summary: HTMLElement;
	let settings: HTMLDetailsElement;
	const remaining = $derived(timerRemainingSeconds(timer, now));
	const countdown = $derived(
		`${Math.floor(remaining / 60)
			.toString()
			.padStart(2, '0')}:${(remaining % 60).toString().padStart(2, '0')}`
	);
	const duration = $derived((minutes ?? 0) * 60 + (seconds ?? 0));
	const validDuration = $derived(
		Number.isInteger(minutes) &&
			Number.isInteger(seconds) &&
			minutes! >= 0 &&
			seconds! >= 0 &&
			seconds! < 60 &&
			duration > 0 &&
			duration <= MAX_TIMER_SECONDS
	);

	function start(duration: number) {
		now = Date.now();
		onstart(duration);
		open = false;
	}

	onMount(() => {
		const interval = setInterval(() => (now = Date.now()), 250);
		return () => clearInterval(interval);
	});
</script>

<svelte:window
	onclick={(event) => {
		if (open && event.target instanceof Node && !settings.contains(event.target)) open = false;
	}}
	onkeydown={(event) => {
		if (open && event.key === 'Escape') {
			open = false;
			summary.focus();
		}
	}}
/>

<div class="shared-timer">
	<details
		bind:this={settings}
		bind:open
		ontoggle={() => {
			if (open) {
				minutes = Math.floor(timer.duration / 60);
				seconds = timer.duration % 60;
			}
		}}
	>
		<summary bind:this={summary} aria-label="Set countdown duration" title="Set countdown duration">
			<span role="timer" aria-live="off" aria-label="Countdown">{countdown}</span>
		</summary>
		<form
			class="timer-settings"
			onsubmit={(event) => {
				event.preventDefault();
				if (validDuration) {
					start(duration);
					summary.focus();
				}
			}}
		>
			<label
				>Minutes<input
					type="number"
					min="0"
					max={MAX_TIMER_SECONDS / 60}
					step="1"
					required
					bind:value={minutes}
				/></label
			>
			<label
				>Seconds<input
					type="number"
					min="0"
					max="59"
					step="1"
					required
					bind:value={seconds}
				/></label
			>
			<button type="submit" disabled={!validDuration}>Start</button>
		</form>
	</details>
	<button
		class="timer-control"
		aria-label={timer.endsAt === null ? 'Start timer' : 'Stop timer'}
		title={timer.endsAt === null ? 'Start timer' : 'Stop timer'}
		disabled={remaining === 0}
		onclick={() => {
			now = Date.now();
			if (timer.endsAt === null) onresume();
			else onstop();
			open = false;
		}}
	>
		<span aria-hidden="true">{timer.endsAt === null ? '▶' : '■'}</span>
	</button>
</div>

<style>
	.shared-timer {
		display: flex;
		align-items: center;
		gap: 6px;
		color: #385442;
	}
	details {
		position: relative;
	}
	summary {
		list-style: none;
		cursor: pointer;
		border: 1px solid #d8dfd1;
		background: #fffef9;
		border-radius: 6px;
		padding: 7px 11px;
		font-size: 16px;
		font-weight: 650;
		font-variant-numeric: tabular-nums;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	.timer-control {
		background: transparent;
		border: 1px solid #d8dfd1;
		color: inherit;
		border-radius: 6px;
		width: 34px;
		height: 34px;
		font-size: 18px;
	}
	.timer-control:hover,
	summary:hover {
		background: #e8eddf;
	}
	.timer-settings {
		position: absolute;
		top: calc(100% + 8px);
		left: 50%;
		transform: translateX(-50%);
		z-index: 5;
		display: flex;
		align-items: flex-end;
		gap: 10px;
		padding: 14px;
		border: 1px solid #d8dfd1;
		border-radius: 8px;
		background: #fffef9;
		box-shadow: 0 5px 20px #1d3a3325;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 6px;
		font-size: 11px;
	}
	input {
		width: 64px;
		border: 1px solid #d8dfd1;
		border-radius: 5px;
		background: #fffef9;
		padding: 7px;
	}
	.timer-settings button {
		border: 0;
		border-radius: 5px;
		padding: 9px 12px;
		background: #284f3e;
		color: #fffdf3;
	}
</style>
