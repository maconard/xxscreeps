import type * as Provider from 'xxscreeps/engine/db/storage/provider';
import type { MaybePromises } from './responder';
import * as Fn from 'xxscreeps/utility/functional';
import * as Path from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';
import { listen } from 'xxscreeps/utility/async';
import { Responder, connect, makeClient, makeHost } from './responder';
import { registerStorageProvider } from '..';

registerStorageProvider('file', 'blob', url =>
	connect(`${url}`, LocalBlobClient, LocalBlobHost, () => LocalBlobResponder.create(url)));

class LocalBlobResponder extends Responder implements MaybePromises<Provider.BlobProvider> {
	private bufferedBlobs = new Map<string, Readonly<Uint8Array>>();
	private bufferedDeletes = new Set<string>();
	private readonly knownPaths = new Set<string>();
	private readonly exitEffect = listen(process, 'exit', () => this.checkMissingFlush());

	constructor(private readonly path: string) {
		super();
	}

	static async create(url: URL) {
		const path = fileURLToPath(url);
		await LocalBlobResponder.initializeDirectory(path);
		return new LocalBlobResponder(path);
	}

	private static async initializeDirectory(path: string) {
		// Ensure directory exists, or make it
		await fs.mkdir(path, { recursive: true });

		// Lock file maker
		const lockFile = Path.join(path, '.lock');
		const tryLock = async() => {
			const file = await fs.open(lockFile, 'wx');
			await file.write(`${process.pid}`);
			await file.close();
		};

		await (async() => {
			// Try lock
			try {
				await tryLock();
				return;
			} catch (err) {}

			// On failure get locked pid
			const pid = await async function() {
				try {
					return JSON.parse(await fs.readFile(lockFile, 'utf8'));
				} catch (err) {
					// Lock format unrecognized
				}
			}();

			// See if process still exists
			if (pid !== undefined) {
				const exists = function() {
					try {
						process.kill(pid, 0); // does *not* kill the process, just tries to send a signal
						return true;
					} catch (err) {
						return false;
					}
				}();
				if (exists) {
					throw new Error(`pid ${pid} has locked ${path}`);
				}
			}

			// The lock is dead and can be removed
			// nb: This unlink is definitely a race condition
			await fs.unlink(lockFile);

			// Try once more
			await tryLock();
		})();
	}

	async copy(from: string, to: string, options?: Provider.Copy) {
		this.check(to);
		const value = await this.getBuffer(from);
		if (options?.if === 'nx' && await this.getBuffer(to)) {
			return false;
		} else if (value === null) {
			return false;
		} else {
			this.bufferedBlobs.set(to, value);
			return true;
		}
	}

	async del(key: string) {
		this.check(key);
		// If it hasn't been written to disk yet it will just be removed from the buffer
		if (this.bufferedBlobs.has(key)) {
			this.bufferedBlobs.delete(key);
		} else {
			// Ensure it actually exists on disk
			const path = Path.join(this.path, key);
			try {
				await fs.stat(path);
			} catch (err) {
				return false;
			}
			this.bufferedDeletes.add(key);
		}
		return true;
	}

	async getBuffer(key: string) {
		this.check(key);
		// Check in-memory buffer
		const buffered = this.bufferedBlobs.get(key);
		if (buffered !== undefined) {
			return buffered;
		} else if (this.bufferedDeletes.has(key)) {
			return null;
		}
		// Load from file system
		const path = Path.join(this.path, key);
		try {
			const handle = await fs.open(path, 'r');
			try {
				const { size } = await handle.stat();
				const buffer = new Uint8Array(new SharedArrayBuffer(size));
				if ((await handle.read(buffer, 0, size)).bytesRead !== size) {
					throw new Error('Read partial file');
				}
				return buffer;
			} finally {
				await handle.close();
			}
		} catch (err) {
			return null;
		}
	}

	async reqBuffer(key: string) {
		const value = await this.getBuffer(key);
		if (value === null) {
			throw new Error(`"${key}" does not exist`);
		}
		return value;
	}

	set(key: string, value: Readonly<Uint8Array>) {
		this.check(key);
		this.bufferedDeletes.delete(key);
		this.bufferedBlobs.set(key, function() {
			if (value.buffer instanceof SharedArrayBuffer) {
				return value;
			}
			const copy = new Uint8Array(new SharedArrayBuffer(value.length));
			copy.set(value);
			return copy;
		}());
	}

	async flushdb() {
		this.bufferedBlobs.clear();
		this.bufferedDeletes.clear();
		this.knownPaths.clear();
		await fs.rm(this.path, { recursive: true });
		await LocalBlobResponder.initializeDirectory(this.path);
	}

	async save() {
		// Reset buffers
		const blobs = this.bufferedBlobs;
		const deletes = this.bufferedDeletes;
		this.bufferedBlobs = new Map;
		this.bufferedDeletes = new Set;

		// Run saves and deletes in parallel
		await Promise.all([

			// Saves all buffered data to disk
			await Promise.all(Fn.map(blobs.entries(), async([ fragment, blob ]) => {
				const path = Path.join(this.path, fragment);
				const dirname = Path.dirname(path);
				if (!this.knownPaths.has(dirname)) {
					try {
						await fs.mkdir(dirname, { recursive: true });
					} catch (err) {
						if (err.code !== 'EEXIST') {
							throw err;
						}
					}
					this.knownPaths.add(dirname);
				}
				await fs.writeFile(path, blob as Uint8Array);
			})),

			// Dispatches buffered deletes
			await Promise.all(Fn.map(deletes.values(), async fragment => {
				const path = Path.join(this.path, fragment);
				await fs.unlink(path);
			})),
		]);

		// Also remove empty directories after everything has flushed
		const unlinkedDirectories = new Set<string>();
		await Promise.all(Fn.map(deletes.values(), async fragment => {
			const path = Path.join(this.path, fragment);
			for (let dir = Path.dirname(path); dir !== this.path; dir = Path.dirname(dir)) {
				if (unlinkedDirectories.has(dir)) {
					break;
				}
				try {
					unlinkedDirectories.add(dir);
					await fs.rmdir(dir);
					this.knownPaths.delete(dir);
				} catch (err) {
					break;
				}
			}
		}));
	}

	protected override release() {
		this.exitEffect();
		this.checkMissingFlush();
		fs.unlink(Path.join(this.path, '.lock')).catch(() => {});
	}

	private check(fragment: string) {
		// Safety check before writing random file names based on user input
		if (!/^[a-zA-Z0-9/_-]+$/.test(fragment)) {
			throw new Error(`Unsafe blob id: ${fragment}`);
		}
	}

	private checkMissingFlush() {
		const size = this.bufferedBlobs.size + this.bufferedDeletes.size;
		if (size !== 0) {
			console.warn(`Blob storage shut down with ${size} pending write(s)`);
		}
	}
}

class LocalBlobClient extends makeClient(LocalBlobResponder) {}
class LocalBlobHost extends makeHost(LocalBlobResponder) {}
