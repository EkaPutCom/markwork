// A value that may only become available later: the real dialog returns a Promise, its stand-in in tests a plain value.
export type Awaitable<T> = T | Promise<T>;

// Continue with a value that may still be a Promise. A plain value (dialog stand-in in tests, or a path that
// does not need to ask) is processed immediately so the result is synchronous too; a Promise is processed once it resolves.
export function after<T, R>(value: Awaitable<T>, next: (value: T) => Awaitable<R>): Awaitable<R> {
    return value instanceof Promise ? value.then(next) : next(value);
}
