// Run before the stylesheet: the website defaults to dark, and remembers an explicit choice across its pages.
(() => {
    const root = document.documentElement;
    let saved;
    try { saved = localStorage.getItem('markwork-web-theme'); } catch { /* The site works when storage is unavailable. */ }
    root.dataset.theme = saved === 'light' ? 'light' : 'dark';

    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    function updateMedia() {
        const dark = root.dataset.theme === 'dark';
        for (const img of document.querySelectorAll('img[data-light-src]')) {
            const next = motion.matches && img.dataset.lightPoster
                ? (dark ? img.dataset.darkPoster : img.dataset.lightPoster)
                : (dark ? img.dataset.darkSrc : img.dataset.lightSrc);
            if (img.getAttribute('src') !== next) img.setAttribute('src', next);
        }
        for (const button of document.querySelectorAll('[data-theme-toggle]')) {
            button.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
            button.setAttribute('aria-pressed', String(dark));
            const label = button.querySelector('[data-theme-label]');
            if (label) label.textContent = dark ? 'Light appearance' : 'Dark appearance';
        }
    }
    function set(theme) {
        root.dataset.theme = theme === 'light' ? 'light' : 'dark';
        try { localStorage.setItem('markwork-web-theme', root.dataset.theme); } catch { /* Optional preference. */ }
        updateMedia();
    }
    window.markworkTheme = { set, updateMedia };
    motion.addEventListener('change', updateMedia);
    // Pictures have no src until the theme is resolved, so loading the page never downloads both variants.
    document.addEventListener('DOMContentLoaded', updateMedia);
})();
