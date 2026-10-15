<script lang="ts">
	import Avatar from './Avatar.svelte';
	import Markdown from './Markdown.svelte';
	import type { Bot } from '$lib/types';

	/**
	 * The company profile dressed up as a fake LinkedIn card: banner,
	 * overlapping avatar, headline, then About / Experience / Skills.
	 *
	 * One implementation, used by both the bot's card (BotDetail) and the bot's
	 * main profile (BotForm), so the two cannot drift into two renderings of
	 * the same file. It is a pure view of `profile` plus the bot it belongs to;
	 * fetching and editing stay with whoever owns the file.
	 */
	let { bot, profile }: { bot: Bot; profile: string } = $props();

	/**
	 * Everything below is a pure view of `profile`: lines starting with `## `
	 * become Experience cards (title + markdown body), `### ` lines inside one
	 * become sub-rows, `- ` bullets anywhere become skill chips, and any
	 * other text before the first `## ` is the About section. A profile
	 * with no `## ` at all shows as About with its bullets as chips.
	 */
	type ProfileSection = { title: string; subs: { title: string; body: string[] }[]; body: string[] };
	const linked = $derived.by(() => {
		const lines = profile.split('\n');
		const about: string[] = [];
		const sections: ProfileSection[] = [];
		const chips: string[] = [];
		let current: ProfileSection | null = null;
		let currentSub: { title: string; body: string[] } | null = null;
		for (const line of lines) {
			if (line.startsWith('## ')) {
				current = { title: line.slice(3).trim(), subs: [], body: [] };
				currentSub = null;
				sections.push(current);
			} else if (line.startsWith('### ') && current) {
				currentSub = { title: line.slice(4).trim(), body: [] };
				current.subs.push(currentSub);
			} else if (line.trim().startsWith('- ')) {
				chips.push(line.trim().slice(2).trim());
			} else if (currentSub) {
				currentSub.body.push(line);
			} else if (current) {
				current.body.push(line);
			} else {
				about.push(line);
			}
		}
		// First non-empty line doubles as the headline under the name.
		const headline = (lines.find((l) => l.trim()) ?? '').replace(/^#+\s*/, '').trim();
		// Deterministic fake connections: scales with length, stable per text.
		let hash = 0;
		for (let i = 0; i < profile.length; i++) hash = (Math.imul(hash, 31) + profile.charCodeAt(i)) | 0;
		const connections = 100 + (Math.abs(hash) % 400) + Math.min(400, profile.length >> 3);
		return {
			headline,
			connections,
			aboutMd: about.join('\n').trim(),
			sections: sections.map((s) => ({
				title: s.title,
				bodyMd: s.body.join('\n').trim(),
				subs: s.subs.map((sub) => ({ title: sub.title, bodyMd: sub.body.join('\n').trim() }))
			})),
			chips: [...new Set(chips)].filter(Boolean)
		};
	});
</script>

<div class="li">
	<div
		class="li-banner"
		style:background={`linear-gradient(120deg, ${bot.color}, color-mix(in srgb, ${bot.color} 40%, black))`}
	></div>
	<div class="li-head">
		<span class="li-avatar"><Avatar color={bot.color} seed={bot.id} size={56} hat={bot.hat} /></span>
		<div class="li-id">
			<strong>{bot.name}</strong>
			{#if linked.headline}<span class="li-headline">{linked.headline}</span>{/if}
			<span class="li-meta">The Lounge · {linked.connections} connections</span>
		</div>
	</div>
	{#if linked.sections.length}
		{#if linked.aboutMd}
			<div class="li-card">
				<h4>About</h4>
				<div class="li-about"><Markdown source={linked.aboutMd} /></div>
			</div>
		{/if}
		<div class="li-card">
			<h4>Experience</h4>
			{#each linked.sections as s, si (si)}
				<div class="li-exp">
					<strong>{s.title}</strong>
					{#if s.bodyMd}<div class="li-about"><Markdown source={s.bodyMd} /></div>{/if}
					{#each s.subs as sub, subi (`${si}-${subi}`)}
						<div class="li-sub">
							<span>{sub.title}</span>
							{#if sub.bodyMd}<div class="li-about"><Markdown source={sub.bodyMd} /></div>{/if}
						</div>
					{/each}
				</div>
			{/each}
		</div>
		{#if linked.chips.length}
			<div class="li-card">
				<h4>Skills</h4>
				<div class="li-chips">
					{#each linked.chips as chip (chip)}
						<span class="li-chip">{chip}</span>
					{/each}
				</div>
			</div>
		{/if}
	{:else}
		<div class="li-card">
			<h4>About</h4>
			<div class="li-about"><Markdown source={profile} /></div>
		</div>
		{#if linked.chips.length}
			<div class="li-card">
				<h4>Skills</h4>
				<div class="li-chips">
					{#each linked.chips as chip (chip)}
						<span class="li-chip">{chip}</span>
					{/each}
				</div>
			</div>
		{/if}
	{/if}
</div>

<style>
	/* The company profile as a fake LinkedIn card: banner, overlapping
	   avatar, Experience cards, skill chips. */
	.li {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 0.6rem;
		padding-bottom: 0.6rem;
		overflow: hidden;
	}
	.li-banner {
		height: 5rem;
	}
	.li-head {
		display: flex;
		align-items: flex-end;
		gap: 0.6rem;
		padding: 0 0.7rem;
	}
	.li-avatar {
		margin-top: -1.5rem;
		background: var(--bg-raised);
		border-radius: 50%;
		padding: 2px;
		line-height: 0;
	}
	.li-id {
		display: flex;
		flex-direction: column;
		min-width: 0;
		padding-bottom: 0.1rem;
	}
	.li-id strong {
		font-size: 0.95rem;
	}
	.li-headline {
		font-size: 0.78rem;
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.li-meta {
		font-size: 0.7rem;
		color: var(--text-muted);
	}
	.li-card {
		margin: 0 0.6rem;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 0.6rem;
		padding: 0.55rem 0.7rem;
	}
	.li-card h4 {
		margin: 0 0 0.35rem;
		font-size: 0.72rem;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.li-exp {
		padding: 0.45rem 0;
		border-top: 1px solid var(--border);
	}
	.li-exp:first-of-type {
		border-top: none;
		padding-top: 0;
	}
	.li-exp > strong {
		font-size: 0.84rem;
	}
	.li-sub {
		margin-top: 0.35rem;
		padding-left: 0.6rem;
		border-left: 2px solid var(--border);
	}
	.li-sub > span {
		font-size: 0.78rem;
		font-weight: 600;
	}
	.li-about {
		font-size: 0.84rem;
		line-height: 1.5;
	}
	.li-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
	}
	.li-chip {
		font-size: 0.72rem;
		padding: 0.15rem 0.6rem;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--bg-hover);
		color: var(--text);
	}
</style>
