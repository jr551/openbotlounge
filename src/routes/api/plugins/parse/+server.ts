import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { streamChat, defaultModel } from '$lib/server/llm';
import { readJson, strField } from '$lib/server/http';
import { DEFAULT_ICON_SVG, sanitizeIconSvg } from '$lib/server/plugins';

interface Draft {
	name: string;
	description: string;
	kind: 'tool' | 'hook';
	hook_point: string;
	parameters: string;
	code: string;
	icon_svg: string;
}

/**
 * Turn one sentence into a plugin draft, the same way routines are drafted:
 * the model writes the code, the user reads it before anything is saved.
 */
export const POST: RequestHandler = async ({ request }) => {
	const text = (strField(await readJson(request), 'text', 2000) ?? '').trim();
	if (!text) throw error(400, 'text required');
	if (!defaultModel()) throw error(400, 'no model configured');

	// Streamed: the draft is a model call that can take a minute, and a silent
	// hang reads as broken. The raw tokens are fanned out as SSE `delta`
	// events so the wizard can show the draft being written, then a final
	// `draft` event carries the parsed result.
	const stream = new ReadableStream<string>({
		async start(controller) {
			const send = (event: string, data: unknown) =>
				controller.enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
			try {
				const gen = streamChat({
					model: defaultModel(),
					messages: [
						{
							role: 'system',
							content:
								'You write small JavaScript plugins for a chat bot. Reply with JSON only:\n' +
								'{"name": snake_case identifier,\n' +
								' "description": one sentence for the model,\n' +
								' "kind": "tool" or "hook",\n' +
								' "parameters": a JSON-schema string for the tool arguments ("{}" for hooks),\n' +
								' "code": the async function BODY only,\n' +
								' "icon_svg": an animated SVG icon for the plugin}\n\n' +
								'A tool receives `args` (matching its schema) and `fetch`, and must return a string. ' +
								'A hook receives `args.message` and returns replacement text, or "" to leave it alone. ' +
								'No imports, no requires, no markdown fences - just the body statements.\n\n' +
								'For icon_svg, personalize this template to what the plugin does - keep the comment ' +
								'block and obey every rule in it:\n' +
								DEFAULT_ICON_SVG
						},
						{ role: 'user', content: text }
					]
				});
				let raw = '';
				for (;;) {
					const next = await gen.next();
					if (next.done) {
						raw = next.value.text;
						break;
					}
					raw += next.value;
					send('delta', next.value);
				}

				let parsed: Partial<Draft>;
				try {
					parsed = JSON.parse(raw.replace(/^```(?:json)?|```$/g, '').trim());
				} catch {
					send('error', { message: 'the model did not return a usable plugin' });
					controller.close();
					return;
				}

				const kind: Draft['kind'] = parsed.kind === 'hook' ? 'hook' : 'tool';
				const hook = String(parsed.hook_point ?? '');
				const code = String(parsed.code ?? '').trim();
				if (!code) {
					send('error', { message: 'the model produced no code' });
					controller.close();
					return;
				}

				let parameters = '{"type":"object","properties":{}}';
				if (kind === 'tool' && parsed.parameters !== undefined) {
					const candidate =
						typeof parsed.parameters === 'string' ? parsed.parameters : JSON.stringify(parsed.parameters);
					try {
						const obj: unknown = JSON.parse(candidate);
						if (obj && typeof obj === 'object' && !Array.isArray(obj)) parameters = candidate;
					} catch {
						// Keep the empty schema; the code still works without declared args.
					}
				}

				const draft: Draft = {
					name: String(parsed.name ?? text.slice(0, 24))
						.toLowerCase()
						.replace(/[^a-z0-9]+/g, '_')
						.replace(/^_+|_+$/g, '')
						.slice(0, 60),
					description: String(parsed.description ?? '').slice(0, 500),
					kind,
					hook_point: kind === 'hook' && (hook === 'before_reply' || hook === 'after_reply') ? hook : '',
					parameters,
					code: code.slice(0, 20000),
					icon_svg:
						(typeof parsed.icon_svg === 'string' && sanitizeIconSvg(parsed.icon_svg)) ||
						DEFAULT_ICON_SVG
				};
				if (!draft.name) draft.name = 'new_plugin';
				if (draft.kind === 'hook' && !draft.hook_point) draft.hook_point = 'before_reply';

				send('draft', draft);
			} catch (e) {
				send('error', { message: e instanceof Error ? e.message : 'draft failed' });
			}
			controller.close();
		}
	});

	return new Response(stream.pipeThrough(new TextEncoderStream()), {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
};
