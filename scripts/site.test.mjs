// The website's theme contract and static files, without an application window or external services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(root, 'docs');
const themeScript = readFileSync(join(site, 'web/theme.js'), 'utf8');
const pages = [join(site, 'index.html'), ...readdirSync(join(site, 'docs')).filter(f => f.endsWith('.html')).map(f => join(site, 'docs', f))];

function start({ saved = null, reduced = false, blocked = false } = {}) {
    const attrs = new Map();
    const img = {
        dataset: { lightSrc: 'assets/demo.gif', darkSrc: 'assets/dark/demo.gif', lightPoster: 'assets/demo-poster.png', darkPoster: 'assets/dark/demo-poster.png' },
        getAttribute: name => attrs.get(name), setAttribute: (name, value) => attrs.set(name, value),
    };
    const buttonAttrs = new Map();
    const label = { textContent: '' };
    const button = { setAttribute: (name, value) => buttonAttrs.set(name, value), querySelector: () => label };
    const root = { dataset: {} };
    const events = new Map();
    let changed;
    const motion = { matches: reduced, addEventListener: (_name, listener) => { changed = listener; } };
    const window = {};
    const storage = new Map([['markwork-web-theme', saved]]);
    runInNewContext(themeScript, {
        document: { documentElement: root, querySelectorAll: selector => selector.startsWith('img') ? [img] : [button], addEventListener: (name, listener) => events.set(name, listener) },
        window, matchMedia: () => motion,
        localStorage: { getItem: key => { if (blocked) throw new Error('Storage blocked'); return storage.get(key); }, setItem: (key, value) => { if (blocked) throw new Error('Storage blocked'); storage.set(key, value); } },
    });
    return { root, img, attrs, buttonAttrs, label, motion, window, storage, loaded: () => events.get('DOMContentLoaded')(), motionChanged: () => changed() };
}

test('a first visit defaults to dark before media are loaded', () => {
    const state = start();
    assert.equal(state.root.dataset.theme, 'dark');
    assert.equal(state.attrs.has('src'), false);
    state.loaded();
    assert.equal(state.attrs.get('src'), 'assets/dark/demo.gif');
    assert.equal(state.buttonAttrs.get('aria-label'), 'Switch to light theme');
});
test('a saved light choice controls the first media request', () => {
    const state = start({ saved: 'light' });
    assert.equal(state.root.dataset.theme, 'light');
    state.loaded();
    assert.equal(state.attrs.get('src'), 'assets/demo.gif');
});
test('an invalid preference falls back to dark', () => {
    assert.equal(start({ saved: 'unexpected' }).root.dataset.theme, 'dark');
});
test('switching themes changes the media, accessible control label, and saved choice together', () => {
    const state = start();
    state.loaded();
    state.window.markworkTheme.set('light');
    assert.equal(state.attrs.get('src'), 'assets/demo.gif');
    assert.equal(state.buttonAttrs.get('aria-pressed'), 'false');
    assert.equal(state.label.textContent, 'Dark appearance');
    assert.equal(state.storage.get('markwork-web-theme'), 'light');
    state.window.markworkTheme.set('dark');
    assert.equal(state.attrs.get('src'), 'assets/dark/demo.gif');
    assert.equal(state.storage.get('markwork-web-theme'), 'dark');
});
test('blocked storage still allows theme and media switching', () => {
    const state = start({ blocked: true });
    state.loaded();
    state.window.markworkTheme.set('light');
    assert.equal(state.root.dataset.theme, 'light');
    assert.equal(state.attrs.get('src'), 'assets/demo.gif');
});
test('reduced motion uses only a still image in the selected theme', () => {
    const state = start({ reduced: true });
    state.loaded();
    assert.equal(state.attrs.get('src'), 'assets/dark/demo-poster.png');
    state.window.markworkTheme.set('light');
    assert.equal(state.attrs.get('src'), 'assets/demo-poster.png');
    state.motion.matches = false;
    state.motionChanged();
    assert.equal(state.attrs.get('src'), 'assets/demo.gif');
});

test('all existing documentation URLs have the shared dark-first shell and retain their content', () => {
    assert.equal(pages.length, 25);
    for (const page of pages) {
        const html = readFileSync(page, 'utf8');
        assert.match(html, /<html lang="en" data-theme="dark">/, page);
        assert.equal((html.match(/<h1[ >]/g) ?? []).length, 1, page);
        for (const id of ['site-sidebar', 'site-header', 'site-tabs', 'main-content', 'site-status']) assert.ok(html.includes(`id="${id}"`), `${page}: ${id}`);
        assert.ok(html.indexOf('web/theme.js') < html.indexOf('web/tokens.css'), page);
    }
});
test('every application image has actual light and dark files and every animation has still alternatives', () => {
    for (const page of pages) {
        const html = readFileSync(page, 'utf8');
        for (const match of html.matchAll(/<img ([^>]*data-light-src[^>]*)>/g)) {
            const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
            assert.equal(Object.hasOwn(attrs, 'src'), false, 'Do not download a default image before resolving the theme');
            for (const attr of ['data-light-src', 'data-dark-src']) assert.ok(existsSync(resolve(dirname(page), attrs[attr])), `${page}: missing ${attrs[attr]}`);
            assert.notDeepEqual(readFileSync(resolve(dirname(page), attrs['data-light-src'])), readFileSync(resolve(dirname(page), attrs['data-dark-src'])), 'Capture both appearances rather than reusing the same image');
            if (attrs['data-light-src'].endsWith('.gif')) for (const attr of ['data-light-poster', 'data-dark-poster']) assert.ok(existsSync(resolve(dirname(page), attrs[attr])), `${page}: missing ${attr}`);
        }
    }
});
test('local styles, scripts, fonts, links, and media are present in the static site', () => {
    for (const page of pages) {
        const html = readFileSync(page, 'utf8');
        for (const [, url] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
            if (/^(?:https?:|data:|#)/.test(url)) continue;
            const path = resolve(dirname(page), url.split('#')[0]);
            assert.ok(existsSync(path), `${page}: missing ${url}`);
        }
    }
});
test('web color tokens are generated from the current application theme', () => {
    const source = readFileSync(join(root, 'electron/renderer/styles/globals.css'), 'utf8');
    const web = readFileSync(join(site, 'web/tokens.css'), 'utf8');
    for (const pattern of [/^:root \{[\s\S]*?^\}/m, /^:root\[data-theme="dark"\] \{[\s\S]*?^\}/m]) assert.ok(web.includes(source.match(pattern)[0]), 'Run npm run site:build after changing the application tokens');
});
test('the approved landing page omits the removed approval section and link', () => {
    const html = readFileSync(join(site, 'index.html'), 'utf8');
    assert.doesNotMatch(html, /A capable agent|How approval works|BUILT AROUND YOUR APPROVAL/);
});
test('icons are inline geometry from a classic script, so opening the site as a local file needs no SVG requests', () => {
    const window = {};
    runInNewContext(readFileSync(join(site, 'web/icons.js'), 'utf8'), { window });
    const shell = readFileSync(join(site, 'web/site.js'), 'utf8');
    assert.doesNotMatch(shell, /<use\b|icons\.svg/);
    const names = new Set([...shell.matchAll(/icon\('([a-z-]+)'\)/g)].map(m => m[1]));
    for (const page of pages) {
        const html = readFileSync(page, 'utf8');
        const script = html.match(/<script src="[^\"]*web\/icons\.js"[^>]*>/)?.[0];
        assert.ok(script && !script.includes('type="module"'), page);
        assert.ok(html.indexOf(script) < html.indexOf('web/site.js'), page);
        for (const [, name] of html.matchAll(/data-lucide="([a-z-]+)"/g)) names.add(name);
    }
    for (const name of names) assert.match(window.markworkIcons[name] ?? '', /^<(?:path|circle|rect|line|polyline|polygon|ellipse)\b/, name);
    for (const glyph of Object.values(window.markworkIcons)) assert.doesNotMatch(glyph, /\b(?:href|src)=|<use\b/);
});
