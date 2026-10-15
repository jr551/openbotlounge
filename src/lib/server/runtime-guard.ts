/**
 * The runtime the app needs, checked before anything depends on it.
 *
 * The database layer is built on `node:sqlite`, which only exists from Node 22.
 * On an older runtime that import fails with "No such built-in module:
 * node:sqlite" - a message that names neither the cause nor the fix, and reads
 * like a broken checkout rather than the wrong Node. This module is imported
 * ahead of it so the operator gets the one sentence they can act on.
 *
 * Kept in its own file on purpose: an ES import is hoisted, so a version check
 * written inline in db.ts would run *after* node:sqlite had already thrown.
 */
const [major] = process.versions.node.split('.').map(Number);

if (!Number.isFinite(major) || major < 22) {
	throw new Error(
		`OpenBotLounge needs Node 22 or newer (this is ${process.version}). The database ` +
			'layer uses the built-in node:sqlite module, which older releases do not ship. ' +
			'Install Node 22+, or run the container image, which pins the version it was ' +
			'built and tested against.'
	);
}
