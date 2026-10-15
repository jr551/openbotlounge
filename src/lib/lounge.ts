/**
 * Markers the lounge's social rounds record in a bot's activity log.
 *
 * Shared so the room and the picture cannot drift apart: the scheduler writes
 * these and the panel decides whether to draw the bots on the play gym by
 * reading the newest one.
 */
export const ON_THE_GYM = 'on the play gym';
export const OFF_THE_GYM = 'off the play gym';

/** Same pair for the Wetherspoons under the gym: a bot with a treat on the table. */
export const IN_THE_PUB = 'in the Wetherspoons';
export const OUT_OF_THE_PUB = 'out of the Wetherspoons';
