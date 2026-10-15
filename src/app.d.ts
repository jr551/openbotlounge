import type { IncomingMessage } from 'node:http';

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			/** Render the mobile shell for this request (see $lib/mobile). */
			mobile: boolean;
		}
		// interface PageData {}
		// interface PageState {}
		interface Platform {
			/**
			 * The raw node request adapter-node hands every SSR call. Its socket
			 * knows the http server serving the app, which is where the screen
			 * panel's websocket relay attaches (see $lib/server/vnc-proxy).
			 */
			req: IncomingMessage;
		}
	}
}

export {};
