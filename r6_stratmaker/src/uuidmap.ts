import * as uuid from 'uuid';

export class Uuid {
    readonly data: string;
    constructor(data?: string) {
        if (data) {
            this.data = data;
        } else {
            this.data = uuid.v4();
        }
    }
};

export class UuidMap<V> {
    private inner: Map<string, V> = new Map();

    keys(): Iterable<Uuid> {
        return Array.from(this.inner.keys()).map((data) => new Uuid(data));
    }

    get(key: Uuid): V | undefined {
        if (key) {
            return this.inner.get(key.data);
        }
    }

    set(key: Uuid, value: V) {
        if (key) {
            this.inner.set(key.data, value);
        }
    }

    /** Returns whether or not an item with `key` existed and was removed */
    delete(key: Uuid): boolean {
        if (key) {
            return this.inner.delete(key.data);
        } else {
            return false;
        }
    }

    forEach(cb: (value: V, key: Uuid) => void) {
        this.inner.forEach((value, key) => {
            cb(value, new Uuid(key))
        })
    }

    *[Symbol.iterator](): Iterator<[Uuid, V]> {
        for (let [k, v] of this.inner) {
            yield [new Uuid(k), v];
        }
    }
}