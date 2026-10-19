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

export function unwired<T extends object>(members: object): T {
    return new Proxy(members, {
        get: (target, key) => key in target ? (target as never)[key] : typeof key === 'symbol' || key === 'then' ? undefined : nothing(),
    }) as T;
}
