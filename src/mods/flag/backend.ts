import * as C from 'xxscreeps/game/constants';
import * as Fn from 'xxscreeps/utility/functional';
import * as Id from 'xxscreeps/engine/schema/id';
import { RoomPosition } from 'xxscreeps/game/position';
import { registerBackendRoute, registerRoomSocketHandler } from 'xxscreeps/backend';
import { checkCreateFlag } from './flag';
import { getFlagChannel, loadUserFlags } from './model';

registerRoomSocketHandler(async(shard, userId, roomName) => {
	if (!userId) {
		return;
	}

	// Subscribe to flag channel
	let lastTime = shard.time;
	const unlisten = await getFlagChannel(shard, userId).listen(message => {
		if (message.type === 'updated') {
			lastTime = message.time;
		}
	});

	let string = '';
	return [
		unlisten,
		async time => {
			// Update flag payload if needed
			if (time <= lastTime) {
				const flags = await loadUserFlags(shard, userId);
				const flagsInThisRoom = Fn.filter(Object.values(flags), flag => flag.pos.roomName === roomName);
				string = Fn.join(Fn.map(flagsInThisRoom, flag =>
					`${flag.name}~${flag.color}~${flag.secondaryColor}~${flag.pos.x}~${flag.pos.y}`), '|');
			}
			return { flags: string };
		},
	];
});

registerBackendRoute({
	path: '/api/game/create-flag',
	method: 'post',

	async execute(context) {
		const { userId } = context.state;
		if (!userId) {
			return;
		}
		const { name, color, secondaryColor, room, x, y } = context.request.body;
		const pos = new RoomPosition(x, y, room);
		if (checkCreateFlag({}, pos, name, color, secondaryColor) === C.OK) {
			await getFlagChannel(context.shard, userId).publish({
				type: 'intent',
				intent: {
					type: 'create',
					params: [
						name, pos['#id'],
						color, secondaryColor,
					],
				},
			});
			return { ok: 1 };
		} else {
			return { error: 'Invalid intent' };
		}
	},
});

registerBackendRoute({
	path: '/api/game/gen-unique-flag-name',
	method: 'post',

	async execute(context) {
		const { userId } = context.state;
		if (!userId) {
			return;
		}
		try {
			const flags = await loadUserFlags(context.shard, userId);
			for (let ii = 0; ii < 100; ++ii) {
				const name = `Flag${ii}`;
				// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
				if (!flags[name]) {
					return { ok: 1, name };
				}
			}
			return { ok: 1, name: `Flag${Id.generateId(6)}` };
		} catch (err) {
			return { ok: 1, name: 'Flag1' };
		}
	},
});

registerBackendRoute({
	path: '/api/game/remove-flag',
	method: 'post',

	async execute(context) {
		const { userId } = context.state;
		if (!userId) {
			return;
		}
		const { name } = context.request.body;
		await getFlagChannel(context.shard, userId)
			.publish({
				type: 'intent',
				intent: {
					type: 'remove',
					params: [ name ],
				},
			});
		return { ok: 1 };
	},
});
