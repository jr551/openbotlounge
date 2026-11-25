import { describe, expect, it } from 'vitest';
import { parseDraftReply } from './bot-draft';

describe('parseDraftReply', () => {
	it('parses a plain DESCRIPTION / PERSONA reply', () => {
		const out = parseDraftReply('DESCRIPTION - A friendly helper\nPERSONA - You are Maple. You help.');
		expect(out.description).toBe('A friendly helper');
		expect(out.persona).toBe('You are Maple. You help.');
	});

	it('parses bold-marked keywords', () => {
		const out = parseDraftReply(
			'**DESCRIPTION** - A friendly helper\n**PERSONA** - You are Maple. You help.'
		);
		expect(out.description).toBe('A friendly helper');
		expect(out.persona).toBe('You are Maple. You help.');
	});

	it('parses colon separators', () => {
		const out = parseDraftReply('DESCRIPTION: A friendly helper\nPERSONA: You are Maple.');
		expect(out.description).toBe('A friendly helper');
		expect(out.persona).toBe('You are Maple.');
	});

	it('leaves persona empty when only a description parsed', () => {
		const out = parseDraftReply('DESCRIPTION - A friendly helper');
		expect(out.description).toBe('A friendly helper');
		expect(out.persona).toBe('');
	});

	it('keeps the whole reply as persona when no markers exist', () => {
		const out = parseDraftReply('You are Maple. You help.');
		expect(out.description).toBe('');
		expect(out.persona).toBe('You are Maple. You help.');
	});

	it('returns empty drafts for an empty reply', () => {
		const out = parseDraftReply('   ');
		expect(out.description).toBe('');
		expect(out.persona).toBe('');
	});
});
