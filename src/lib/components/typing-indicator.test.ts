import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import TypingIndicator from './TypingIndicator.svelte';
import TypingLine from './TypingLine.svelte';

describe('TypingIndicator', () => {
	it('renders one accessible status with three decorative dots', () => {
		const { body } = render(TypingIndicator, { props: { label: 'Maple is typing' } });
		expect(body).toContain('role="status"');
		expect(body).toContain('aria-label="Maple is typing"');
		expect(body.match(/class="dot\b/g)).toHaveLength(3);
		expect(body).toContain('class="sr-only');
	});
});

describe('TypingLine', () => {
	it('shows only the latest tail and a caret, with no stale prefix', () => {
		const text = `stale-prefix:${'x'.repeat(220)}:fresh-tail`;
		const { body } = render(TypingLine, { props: { text } });
		expect(body).toContain('fresh-tail');
		expect(body).not.toContain('stale-prefix');
		expect(body).toContain('class="caret');
		expect(body).toContain('aria-hidden="true"');
	});
});
