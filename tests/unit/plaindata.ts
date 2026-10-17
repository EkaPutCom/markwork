// A check that runs at typecheck time, not at test time: what the application layer hands a frontend, and what it asks
// of it, must be plain data (docs/design/protocol.md, section 4.4), so a frontend in another process can be given the
// same thing as JSON. A member of AppFrontend is a view (an object of methods) or a method; each method may take and
// return only plain data, a Promise of it (an ask), or nothing. A callback, a class instance, a Set, a Map, a Date, or
// a live object such as a Doc with its editor is not plain.
//
// KNOWN lists the members that break the rule today, as "view.member". It must equal what the check finds: adding a
// member that breaks the rule fails the typecheck, and so does fixing one without removing it here, so the list can
// only shrink. Each entry is one row of section 13 of the design.

import type { TextEditor } from '../../src/app/document.js';
import type { AppDialogs, AppFrontend } from '../../src/app/session.js';

type Primitive = string | number | boolean | null | undefined | void;

// Plain data: primitives, arrays of plain data, and objects whose fields are all plain data (no methods). A union is
// plain when each of its members is (`string[] | undefined`).
type IsPlainOne<T, Depth extends unknown[]> =
    Depth['length'] extends 8 ? true
    : [T] extends [Primitive] ? true
    : [T] extends [(...args: never[]) => unknown] ? false
    : [T] extends [ReadonlySet<unknown> | ReadonlyMap<unknown, unknown> | Date | RegExp | Promise<unknown>] ? false
    : [T] extends [readonly (infer U)[]] ? IsPlain<U, [...Depth, 1]>
    : [T] extends [object] ? (false extends { [K in keyof T]-?: IsPlain<T[K], [...Depth, 1]> }[keyof T] ? false : true)
    : false;
type IsPlain<T, Depth extends unknown[] = []> = false extends (T extends unknown ? IsPlainOne<T, Depth> : never) ? false : true;

type AllPlain<Ts extends readonly unknown[]> = false extends { [I in keyof Ts]: IsPlain<Ts[I]> }[number] ? false : true;
type Returned<R> = R extends Promise<infer U> ? U : R;

// A method is fine when its parameters and its result (or the result of its Promise) are plain.
type MethodOk<F> = F extends (...args: infer A) => infer R ? (AllPlain<A> extends true ? IsPlain<Returned<R>> : false) : false;

// The members of one view that break the rule, as "view.member". A method is checked as a method; a field must be
// plain data, unless it is itself a view (an object with methods, like the pages in `layouts`), which is checked the same
// way one level down.
type HasMethods<T> = true extends { [K in keyof T]-?: [T[K]] extends [(...args: never[]) => unknown] ? true : false }[keyof T] ? true : false;
type ViewOffenders<V, Name extends string, Depth extends unknown[] = []> = {
    [K in keyof V & string]-?: [V[K]] extends [(...args: never[]) => unknown]
        ? (MethodOk<V[K]> extends true ? never : `${Name}.${K}`)
        : IsPlain<V[K]> extends true ? never
        : [V[K]] extends [object] ? (HasMethods<V[K]> extends true
            ? (Depth['length'] extends 2 ? `${Name}.${K}` : ViewOffenders<V[K], `${Name}.${K}`, [...Depth, 1]>)
            : `${Name}.${K}`)
        : `${Name}.${K}`;
}[keyof V & string];

// A member of the frontend host is either a method of the host itself or a view (an object of methods).
type HostOffenders<H> = {
    [K in keyof H & string]-?: [H[K]] extends [(...args: never[]) => unknown]
        ? (MethodOk<H[K]> extends true ? never : `host.${K}`)
        : [H[K]] extends [object] ? ViewOffenders<H[K], K> : never;
}[keyof H & string];

type DialogOffenders<D> = { [K in keyof D & string]-?: ViewOffenders<D[K], `dialogs.${K}`> }[keyof D & string];

type Frontend = AppFrontend<TextEditor>;
type Found = HostOffenders<Frontend['host']> | ViewOffenders<Frontend['documents'], 'documents'> | DialogOffenders<AppDialogs>;

type KNOWN = never;

// Fails to typecheck, naming the members, when Found and KNOWN differ in either direction.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
export const frontendIsPlainData: Equal<Found, KNOWN> extends true ? true : { new: Exclude<Found, KNOWN>; fixed: Exclude<KNOWN, Found> } = true;
