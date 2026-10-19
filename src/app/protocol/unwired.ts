// The members of AppFrontend that are not carried over the wire yet. A call does nothing and answers nothing, and so does
// a call on whatever it returns or any member of an object that is missing (a view's `showX`, a dialog's question), so a
// feature whose view or dialog is absent is silent rather than broken: a question counts as "no", a view is not drawn.
// Each member that gets a message leaves this list by being given explicitly. The list shrinks; it does not grow.

// Callable and indexable, and nothing happens. It never looks like a Promise, so `await` does not wait on it.
function nothing(): never {
    return new Proxy(function () {}, {
        get: (_target, key) => typeof key === 'symbol' || key === 'then' ? undefined : nothing(),
        apply: () => undefined,
        set: () => true,
    }) as never;
}

// The members that were reached and are not wired, as "host.screen.showHome": tests/unit/protocol.ts compares them with
// the list of what is still to carry over, so the list can only shrink.
const touched = new Set<string>();
export const unwiredTouched = (): string[] => [...touched].sort();

// name: where the object sits in AppFrontend ("host.screen"), for the record of what was reached.
export function unwired<T extends object>(members: object, name = ''): T {
    return new Proxy(members, {
        get: (target, key) => {
            if (key in target) return (target as never)[key];
            if (typeof key === 'symbol' || key === 'then') return undefined;
            touched.add(name ? `${name}.${key}` : key);
            return nothing();
        },
    }) as T;
}
