import type { OneOrMany } from 'xxscreeps/utility/types';
import type { Goal, SearchOptions } from 'xxscreeps/game/path-finder';
import type { World } from 'xxscreeps/game/map';
import { RoomPosition, generateRoomNameFromId, parseRoomNameToId } from 'xxscreeps/game/position';
import { getBuffer } from 'xxscreeps/game/terrain';
import { clamp } from 'xxscreeps/utility/utility';
import pf from '@xxscreeps/path-finder';

function flattenPosition(pos: any): number {
	// Internal position bits
	const positionInteger = pos['#id'];
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
	if (positionInteger !== undefined) {
		return positionInteger | 0;
	}

	// Try to cast to RoomPosition
	return flattenPosition(new RoomPosition(pos.x, pos.y, pos.roomName));
}

export function search(origin: RoomPosition, goal: OneOrMany<Goal>, userOptions: SearchOptions = {}) {

	// Inject defaults
	const options = {
		plainCost: userOptions.plainCost ?? 1,
		swampCost: userOptions.swampCost ?? 5,
		heuristicWeight: userOptions.heuristicWeight ?? 1,
		maxOps: userOptions.maxOps ?? 2000,
		maxCost: userOptions.maxCost ?? 0xffffffff,
		maxRooms: userOptions.maxRooms ?? 64,
	};

	const plainCost = clamp(1, 254, options.plainCost | 0);
	const swampCost = clamp(1, 254, options.swampCost | 0);
	// eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
	const heuristicWeight = clamp(1, 9, options.heuristicWeight || 0);
	const maxOps = clamp(1, 2000, options.maxOps | 0);
	const maxCost = clamp(1, 0xffffffff, options.maxCost >>> 0);
	const maxRooms = clamp(1, 64, options.maxRooms | 0);
	const flee = userOptions.flee ?? false;

	// Convert one-or-many goal into standard format for native extension
	const goals = (Array.isArray(goal) ? goal : [ goal ]).map((goal: any) => {
		if (goal.x !== undefined && goal.y !== undefined && goal.roomName !== undefined) {
			return {
				pos: flattenPosition(goal),
				range: 0,
			};
		} else {
			// This case detects `Goal` and `RoomObject`. The path finder was never meant to accept game
			// objects but it did by accident, so I guess here we are.
			return {
				pos: flattenPosition(goal.pos),
				range: Math.max(0, goal.range | 0),
			};
		}
	});
	if (goals.length === 0) {
		return { path: [], ops: 0, cost: 0, incomplete: true };
	}

	// Setup room callback
	const { roomCallback } = userOptions;
	const callback = roomCallback === undefined ? undefined : (roomId: number) => {
		const ret = roomCallback(generateRoomNameFromId(roomId));
		if (ret === false) {
			return ret;
		} else if (ret) {
			return ret._bits;
		}
	};

	// Invoke native code
	const ret = pf.search(
		flattenPosition(origin), goals,
		callback,
		plainCost, swampCost,
		maxRooms, maxOps, maxCost,
		flee,
		heuristicWeight,
	);

	// Translate results
	if (ret === undefined) {
		return { path: [], ops: 0, cost: 0, incomplete: false };
	} else if (ret === -1) {
		return { path: [], ops: 0, cost: 0, incomplete: true };
	}
	return {
		...ret,
		path: ret.path.map(pos => RoomPosition['#create'](pos)).reverse(),
	};
}

export function loadTerrain(world: World) {
	const rooms: Record<string, Readonly<Uint8Array>> = {};
	for (const [ name, terrain ] of world.entries()) {
		rooms[parseRoomNameToId(name)] = getBuffer(terrain);
	}
	pf.loadTerrain(rooms);
}

export function locateModule() {
	return pf.path;
}
