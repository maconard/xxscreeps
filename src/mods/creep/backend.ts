import * as Fn from 'xxscreeps/utility/functional';
import { bindMapRenderer, bindRenderer } from 'xxscreeps/backend';
import { renderStore } from 'xxscreeps/mods/resource/backend';
import { Creep } from './creep';

bindMapRenderer(Creep, creep => creep.owner);

bindRenderer(Creep, (creep, next) => {
	const actionLog: Record<string, any> = Fn.fromEntries(creep['#actionLog'], action =>
		[ action.action, { x: action.x, y: action.y } ]);
	const saying = creep.saying;
	if (saying) {
		actionLog.say = {
			isPublic: true,
			message: saying,
		};
	}
	return {
		...next(),
		...renderStore(creep.store),
		name: creep.name,
		body: creep.body,
		hits: creep.hits,
		hitsMax: 100,
		spawning: creep.spawning,
		fatigue: creep.fatigue,
		ageTime: creep['#ageTime'],
		user: creep['#user'],
		actionLog,
	};
});
