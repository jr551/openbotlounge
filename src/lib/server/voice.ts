import net from 'node:net';

/**
 * Speech for bots, through the household Piper TTS server (Wyoming
 * protocol): text in, 16-bit mono WAV out for the browser to play.
 *
 * Piper lives in the Home Assistant guest as a Wyoming satellite service;
 * the lounge reaches it over the LAN. Nothing here is configured by default -
 * with no PIPER_HOST the TTS route answers 503 and the UI hides the speaker
 * buttons, so a box without a voice server still works as a text lounge.
 * Voice choice is a name from Piper's own list (see piperVoices); unset
 * means the first English voice, else the first voice the server has.
 */

const DEFAULT_PORT = 10200;
/** One TTS request may not hold the socket longer than this. */
const TTS_TIMEOUT_MS = 30_000;
/** Longest text one request synthesises; the UI chunks longer replies. */
export const TTS_TEXT_MAX = 1000;

export interface PiperConfig {
	host: string;
	port: number;
	voice: string;
}

export function piperConfig(): PiperConfig {
	return {
		host: (process.env.PIPER_HOST ?? '').trim(),
		port: Number(process.env.PIPER_PORT ?? DEFAULT_PORT) || DEFAULT_PORT,
		voice: (process.env.PIPER_VOICE ?? '').trim()
	};
}

/** A single Wyoming event: header line, JSON data, optional binary payload. */
interface WyomingEvent {
	type: string;
	data: Record<string, unknown> | null;
	payload: Buffer | null;
}

/**
 * One Wyoming connection with a strict reader: header line, then exactly
 * data_length bytes of JSON data, then exactly payload_length bytes of
 * binary. Audio PCM arrives as the payload of audio-chunk events; the rate
 * comes from the audio-start data. Never throws the socket away mid-event:
 * every byte is accounted for by the lengths, so binary audio containing
 * newlines cannot desynchronise the stream.
 */
class WyomingConnection {
	private sock: net.Socket;
	private buf = Buffer.alloc(0);
	/** Parsed events no caller has asked for yet; bursty servers send several per turn. */
	private queue: WyomingEvent[] = [];
	private waiters: Array<{
		resolve: (e: WyomingEvent) => void;
		reject: (e: Error) => void;
		timer: NodeJS.Timeout;
	}> = [];
	private failed: Error | null = null;

	private constructor(sock: net.Socket) {
		this.sock = sock;
		sock.on('data', (c: Buffer) => {
			this.buf = Buffer.concat([this.buf, c]);
			this.pump();
		});
		sock.on('error', (e) => this.fail(e));
		sock.on('close', () => this.fail(new Error('connection closed')));
	}

	static connect(host: string, port: number, timeoutMs: number): Promise<WyomingConnection> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('connect timeout')), timeoutMs);
			const sock = net.connect(port, host);
			sock.once('connect', () => {
				clearTimeout(timer);
				resolve(new WyomingConnection(sock));
			});
			sock.once('error', (e) => {
				clearTimeout(timer);
				reject(e);
			});
		});
	}

	private fail(e: Error): void {
		if (this.failed) return;
		this.failed = e;
		while (this.waiters.length) {
			const w = this.waiters.shift();
			if (w) {
				clearTimeout(w.timer);
				w.reject(e);
			}
		}
		this.sock.destroy();
	}

	private pump(): void {
		for (;;) {
			const nl = this.buf.indexOf(0x0a);
			if (nl < 0) return;
			let header: { type?: string; data_length?: number; payload_length?: number };
			try {
				header = JSON.parse(this.buf.subarray(0, nl).toString('utf8')) as typeof header;
			} catch {
				this.fail(new Error('bad event header'));
				return;
			}
			const dataLen = header.data_length ?? 0;
			const payloadLen = header.payload_length ?? 0;
			if (this.buf.length < nl + 1 + dataLen + payloadLen) return;
			let data: Record<string, unknown> | null = null;
			if (dataLen) {
				try {
					data = JSON.parse(this.buf.subarray(nl + 1, nl + 1 + dataLen).toString('utf8')) as Record<string, unknown>;
				} catch {
					this.fail(new Error('bad event data'));
					return;
				}
			}
			const payload = payloadLen ? this.buf.subarray(nl + 1 + dataLen, nl + 1 + dataLen + payloadLen) : null;
			this.buf = this.buf.subarray(nl + 1 + dataLen + payloadLen);
			const event: WyomingEvent = { type: String(header.type ?? ''), data, payload };
			const w = this.waiters.shift();
			if (!w) {
				// Nobody is waiting yet (a bursty server answered several
				// events to one request); hold it for the next next().
				this.queue.push(event);
				continue;
			}
			clearTimeout(w.timer);
			w.resolve(event);
		}
	}

	send(obj: unknown): void {
		this.sock.write(JSON.stringify(obj) + '\n');
	}

	next(timeoutMs: number): Promise<WyomingEvent> {
		return new Promise((resolve, reject) => {
			if (this.failed) {
				reject(this.failed);
				return;
			}
			const queued = this.queue.shift();
			if (queued) {
				resolve(queued);
				return;
			}
			const timer = setTimeout(() => {
				const i = this.waiters.findIndex((w) => w.timer === timer);
				if (i >= 0) this.waiters.splice(i, 1);
				reject(new Error('read timeout'));
			}, timeoutMs);
			this.waiters.push({ resolve, reject, timer });
			this.pump();
		});
	}

	close(): void {
		this.fail(new Error('closed'));
	}
}

export interface PiperVoice {
	name: string;
	languages: string[];
}

/** The voices the configured Piper server has installed. */
export async function piperVoices(cfg: PiperConfig = piperConfig()): Promise<PiperVoice[]> {
	if (!cfg.host) throw new Error('Piper is not configured (PIPER_HOST is empty)');
	const conn = await WyomingConnection.connect(cfg.host, cfg.port, TTS_TIMEOUT_MS);
	try {
		conn.send({ type: 'describe' });
		for (;;) {
			const ev = await conn.next(TTS_TIMEOUT_MS);
			if (ev.type === 'info' && ev.data) {
				const tts = (ev.data['tts'] as Array<{ voices?: Array<{ name?: string; languages?: string[] }> }> | undefined) ?? [];
				return tts.flatMap((s) => s.voices ?? []).map((v) => ({ name: String(v.name ?? ''), languages: (v.languages ?? []).map(String) })).filter((v) => v.name);
			}
			if (ev.type === 'error') throw new Error('Piper refused the describe request');
		}
	} finally {
		conn.close();
	}
}

export interface SynthResult {
	/** Sample rate the audio was rendered at. */
	rate: number;
	/** Complete WAV file (44-byte header + PCM16 mono) ready to serve. */
	wav: Buffer;
	/** Voice that spoke. */
	voice: string;
}

function wavHeader(dataLen: number, rate: number, channels = 1, width = 2): Buffer {
	const h = Buffer.alloc(44);
	h.write('RIFF', 0);
	h.writeUInt32LE(36 + dataLen, 4);
	h.write('WAVE', 8);
	h.write('fmt ', 12);
	h.writeUInt32LE(16, 16);
	h.writeUInt16LE(1, 20);
	h.writeUInt16LE(channels, 22);
	h.writeUInt32LE(rate, 24);
	h.writeUInt32LE(rate * channels * width, 28);
	h.writeUInt16LE(channels * width, 32);
	h.writeUInt16LE(width * 8, 34);
	h.write('data', 36);
	h.writeUInt32LE(dataLen, 40);
	return h;
}

/**
 * Speak text through Piper and return a WAV. Picks the configured voice,
 * else the first English voice, else whatever the server has first.
 */
export async function synthesizeSpeech(text: string, cfg: PiperConfig = piperConfig(), voice?: string): Promise<SynthResult> {
	const clean = text.trim().slice(0, TTS_TEXT_MAX);
	if (!clean) throw new Error('nothing to say');
	if (!cfg.host) throw new Error('Piper is not configured (PIPER_HOST is empty)');
	const conn = await WyomingConnection.connect(cfg.host, cfg.port, TTS_TIMEOUT_MS);
	try {
		conn.send({ type: 'describe' });
		let voices: PiperVoice[] = [];
		for (;;) {
			const ev = await conn.next(TTS_TIMEOUT_MS);
			if (ev.type === 'info' && ev.data) {
				const tts = (ev.data['tts'] as Array<{ voices?: Array<{ name?: string; languages?: string[] }> }> | undefined) ?? [];
				voices = tts.flatMap((s) => s.voices ?? []).map((v) => ({ name: String(v.name ?? ''), languages: (v.languages ?? []).map(String) })).filter((v) => v.name);
				break;
			}
			if (ev.type === 'error') throw new Error('Piper refused the describe request');
		}
		if (!voices.length) throw new Error('Piper has no voices installed');
		const pick = voice?.trim() || cfg.voice || voices.find((v) => v.name.startsWith('en_'))?.name || voices[0].name;
		const known = voices.some((v) => v.name === pick);
		const conn2 = await WyomingConnection.connect(cfg.host, cfg.port, TTS_TIMEOUT_MS);
		try {
			conn2.send({ type: 'synthesize', data: { text: clean, voice: { name: known ? pick : voices[0].name } } });
			const chunks: Buffer[] = [];
			let rate = 16000;
			for (;;) {
				const message = await conn2.next(TTS_TIMEOUT_MS);
				const ev = { type: message.type, data: message.data };
				const payload = message.payload;
				if (ev.type === 'audio-start') {
					const d = ev.data ?? {};
					rate = Number(d['rate'] ?? 16000) || 16000;
				} else if (ev.type === 'audio-chunk' && payload) {
					chunks.push(payload);
				} else if (ev.type === 'audio-stop') {
					break;
				} else if (ev.type === 'error') {
					throw new Error('Piper refused to synthesise this text');
				}
			}
			const pcm = Buffer.concat(chunks);
			if (!pcm.length) throw new Error('Piper returned no audio');
			return { rate, wav: Buffer.concat([wavHeader(pcm.length, rate), pcm]), voice: known ? pick : voices[0].name };
		} finally {
			conn2.close();
		}
	} finally {
		conn.close();
	}
}
