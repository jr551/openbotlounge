import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { piperVoices, synthesizeSpeech, type PiperConfig } from './voice';

/** A scripted fake Piper: describe/info, then fixed audio for any synth. */
interface Script {
	voices: Array<{ name: string; languages: string[] }>;
	pcm: Buffer;
	rate: number;
}

function startFakePiper(script: Script): Promise<{ port: number; close: () => void; seen: { voice?: string; text?: string } }> {
	const seen: { voice?: string; text?: string } = {};
	return new Promise((resolve) => {
		const server = net.createServer((sock) => {
			let buf = Buffer.alloc(0);
			const send = (obj: unknown, data?: unknown, payload?: Buffer) => {
				const dataBytes = data !== undefined ? Buffer.from(JSON.stringify(data)) : null;
				const header: Record<string, unknown> = { type: (obj as { type: string }).type };
				if (dataBytes) header.data_length = dataBytes.length;
				if (payload) header.payload_length = payload.length;
				sock.write(JSON.stringify(header) + '\n');
				if (dataBytes) sock.write(dataBytes);
				if (payload) sock.write(payload);
			};
			sock.on('data', (chunk: Buffer) => {
				buf = Buffer.concat([buf, chunk]);
				for (;;) {
					const nl = buf.indexOf(0x0a);
					if (nl < 0) return;
					const ev = JSON.parse(buf.subarray(0, nl).toString('utf8')) as { type: string; data?: { text?: string; voice?: { name?: string } } };
					buf = buf.subarray(nl + 1);
					if (ev.type === 'describe') {
						send({ type: 'info' }, { tts: [{ name: 'piper', voices: script.voices }] });
					} else if (ev.type === 'synthesize') {
						seen.voice = ev.data?.voice?.name;
						seen.text = ev.data?.text;
						send({ type: 'audio-start' }, { rate: script.rate, width: 2, channels: 1, timestamp: null });
						// Payload deliberately contains newline bytes to prove framing.
						send({ type: 'audio-chunk' }, { rate: script.rate, width: 2, channels: 1, timestamp: null }, script.pcm);
						send({ type: 'audio-stop' }, { rate: script.rate, width: 2, channels: 1, timestamp: null });
					}
				}
			});
		});
		server.listen(0, '127.0.0.1', () => {
			const port = (server.address() as net.AddressInfo).port;
			resolve({ port, close: () => server.close(), seen });
		});
	});
}

let fake: { port: number; close: () => void; seen: { voice?: string; text?: string } } | null = null;
const pcmWithNewlines = Buffer.from([0x0a, 0x00, 0x0d, 0x0a, 0x01, 0x02, 0x0a, 0xff]);

beforeEach(async () => {
	fake = await startFakePiper({
		voices: [
			{ name: 'en_GB-alan-low', languages: ['en_GB'] },
			{ name: 'de_DE-thorsten-low', languages: ['de_DE'] }
		],
		pcm: pcmWithNewlines,
		rate: 16000
	});
});

afterEach(() => {
	fake?.close();
	fake = null;
});

const cfg = (): PiperConfig => ({ host: '127.0.0.1', port: fake?.port ?? 1, voice: '' });

describe('piperVoices', () => {
	it('lists the installed voices', async () => {
		const voices = await piperVoices(cfg());
		expect(voices.map((v) => v.name)).toEqual(['en_GB-alan-low', 'de_DE-thorsten-low']);
	});

	it('refuses without a configured host', async () => {
		await expect(piperVoices({ host: '', port: 10200, voice: '' })).rejects.toThrow(/PIPER_HOST/);
	});
});

describe('synthesizeSpeech', () => {
	it('returns a valid WAV of the server PCM', async () => {
		const out = await synthesizeSpeech('Hello.', cfg());
		expect(out.rate).toBe(16000);
		expect(out.wav.subarray(0, 4).toString()).toBe('RIFF');
		expect(out.wav.subarray(8, 12).toString()).toBe('WAVE');
		expect(out.wav.readUInt32LE(24)).toBe(16000);
		expect(out.wav.readUInt32LE(40)).toBe(pcmWithNewlines.length);
		expect(out.wav.subarray(44)).toEqual(pcmWithNewlines);
	});

	it('prefers the configured voice and falls back to English', async () => {
		const out = await synthesizeSpeech('Hello.', { ...cfg(), voice: 'de_DE-thorsten-low' });
		expect(out.voice).toBe('de_DE-thorsten-low');
		expect(fake?.seen.voice).toBe('de_DE-thorsten-low');
		const def = await synthesizeSpeech('Hello.', cfg());
		expect(def.voice).toBe('en_GB-alan-low');
	});

	it('falls back to the first voice for an unknown configured voice', async () => {
		const out = await synthesizeSpeech('Hello.', { ...cfg(), voice: 'xx-nope' });
		expect(out.voice).toBe('en_GB-alan-low');
	});

	it('refuses empty text and missing configuration', async () => {
		await expect(synthesizeSpeech('   ', cfg())).rejects.toThrow(/nothing to say/);
		await expect(synthesizeSpeech('Hi', { host: '', port: 10200, voice: '' })).rejects.toThrow(/PIPER_HOST/);
	});

	it('fails fast against a dead server', async () => {
		await expect(synthesizeSpeech('Hi', { host: '127.0.0.1', port: 1, voice: '' })).rejects.toThrow();
	});
});
