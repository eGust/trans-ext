import type { JSX } from 'solid-js';
export function Icon(props: {
	name: 'settings' | 'arrow' | 'copy' | 'volume' | 'stop' | 'close' | 'check' | 'shield';
	size?: number;
}) {
	const paths: Record<typeof props.name, JSX.Element> = {
		settings: (
			<>
				<path d="m9 3-.6 2.1-1.7 1-2.1-.5-2 3.5L4.1 11v2L2.6 15l2 3.5 2.1-.5 1.7 1L9 21h4l.6-2.1 1.7-1 2.1.5 2-3.5-1.5-1.9v-2l1.5-1.9-2-3.5-2.1.5-1.7-1L13 3Z" />
				<circle cx="11" cy="12" r="3" />
			</>
		),
		arrow: (
			<>
				<path d="M4 12h16m-5-5 5 5-5 5" />
			</>
		),
		copy: (
			<>
				<rect x="8" y="8" width="12" height="12" rx="2" />
				<path d="M15 8V4H4v11h4" />
			</>
		),
		volume: (
			<>
				<path d="m11 4-6 5H2v6h3l6 5V4Zm4 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" />
			</>
		),
		stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
		close: <path d="m6 6 12 12M6 18 18 6" />,
		check: <path d="m5 12 4 4L19 6" />,
		shield: (
			<>
				<path d="m12 3 8 3v6c0 4-5 8-8 9-3-1-8-5-8-9V6l8-3Z" />
				<path d="m8 12 3 3 5-6" />
			</>
		),
	};
	return (
		<svg
			width={props.size ?? 18}
			height={props.size ?? 18}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.6"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			{paths[props.name]}
		</svg>
	);
}
export function Brand() {
	return (
		<div class="brand">
			<img src="icons/32.png" width="32" height="32" alt="" />
			<div>
				<strong>AI Translate</strong>
				<span>YOUR BROWSER. YOUR WORDS.</span>
			</div>
		</div>
	);
}
