import { config } from './config';
import { listSettings } from './db';

/**
 * Model for autonomous bot-to-bot chatter. Older builds treated the absent
 * setting as the literal model id `free`, which only works through gateways
 * that define that alias. Blank and legacy `free` settings now follow the
 * configured provider model; an explicit social model still wins.
 */
export function socialChatModel(): string {
	const selected = listSettings().social_model?.trim();
	return !selected || selected === 'free' ? config.model : selected;
}
