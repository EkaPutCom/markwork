(() => {
    const docs = document.body.dataset.page === 'docs';
    const base = docs ? '../' : '';
    const icon = name => `<svg data-icon="${name}" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${window.markworkIcons[name]}</svg>`;
    const sidebar = document.getElementById('site-sidebar');
    const heading = document.querySelector('main h1');
    const title = docs ? heading.textContent.trim() : 'Welcome.md';
    const section = document.querySelector('main .eyebrow')?.textContent.trim() || 'Documentation';

    sidebar.innerHTML = `
        <a class="brand" href="${base}index.html"><span class="monogram">M</span><span>Markwork<small>Markdown, put to work.</small></span></a>
        <button class="sidebar-close icon-control" aria-label="Close navigation">${icon('x')}</button>
        <div class="workspace">${icon('folder-open')}<span>markwork.id</span>${icon('chevrons-up-down')}</div>
        <nav aria-label="Website">
            <a class="nav-row${docs ? '' : ' active'}" href="${base}index.html"${docs ? '' : ' aria-current="page"'}>${icon('house')}Overview</a>
            <a class="nav-row${docs ? ' active' : ''}" href="${base}docs/"${docs ? ' aria-current="true"' : ''}>${icon('book-open')}Documentation</a>
            <a class="nav-row" href="https://github.com/EkaPutCom/markwork">${icon('git-branch')}GitHub<span class="end">${icon('arrow-up-right')}</span></a>
        </nav>
        ${docs ? '<nav id="doc-navigation" aria-label="Documentation navigation"></nav>' : `
        <nav class="landing-navigation" aria-label="Page sections"><p class="section-label">In this workspace</p>
            <a class="file-row selected" href="#welcome">${icon('file-text')}Welcome.md</a>
            <a class="file-row" href="#workflow">${icon('workflow')}The workflow</a>
            <a class="file-row" href="#download">${icon('download')}Get Markwork</a>
        </nav>`}
        <div class="sidebar-bottom">
            ${docs ? '' : `<div class="local-note">${icon('folder-heart')}<strong>Your files. Your workspace.</strong><p>Plain Markdown on your computer.<br>Changes you can review.</p></div>`}
            <a class="nav-row" href="https://github.com/EkaPutCom/markwork/releases">${icon('download')}All releases<span class="end">${icon('arrow-up-right')}</span></a>
            <button class="nav-row" data-theme-toggle>${icon('moon')}<span data-theme-label>Light appearance</span></button>
        </div>`;
    const header = document.getElementById('site-header');
    header.innerHTML = `<button class="icon-control" id="nav-toggle" aria-label="Toggle navigation" aria-controls="site-sidebar" aria-expanded="false">${icon('panel-left')}</button>
        <div class="breadcrumb"><a href="${base}index.html">Markwork</a>${icon('chevron-right')}<span></span></div>
        <a class="control primary top-download" href="${base}index.html#download">${icon('download')}<span>Get Markwork</span></a>`;
    header.querySelector('.breadcrumb span').textContent = title;
    document.getElementById('site-tabs').innerHTML = `<a href="${base}index.html"${docs ? '' : ' class="active" aria-current="page"'}>${icon('file-text')}Welcome.md</a>
        <a href="${base}docs/"${docs ? ' class="active" aria-current="true"' : ''}>${icon('book-open')}Documentation</a>
        <span class="tab-hint">A workspace for humans & AI agents</span>`;
    const status = document.getElementById('site-status');
    status.innerHTML = `<span>${icon('folder')}<span></span></span><span>Markdown workspace for humans and AI agents</span><a href="https://github.com/EkaPutCom/markwork">Open source · MIT</a>`;
    status.querySelector('span span').textContent = docs ? `website / docs / ${title}` : 'website / Welcome.md';

    for (const placeholder of document.querySelectorAll('[data-lucide]')) {
        placeholder.outerHTML = icon(placeholder.dataset.lucide);
    }
    for (const button of document.querySelectorAll('[data-theme-toggle]')) {
        button.addEventListener('click', () => window.markworkTheme.set(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
    }
    window.markworkTheme.updateMedia();

    const toggle = document.getElementById('nav-toggle');
    const backdrop = document.getElementById('nav-backdrop');
    const narrow = matchMedia('(max-width: 760px)');
    function closeNavigation(restoreFocus = false) {
        document.body.classList.remove('nav-open');
        toggle.setAttribute('aria-expanded', String(!narrow.matches && !document.body.classList.contains('nav-collapsed')));
        backdrop.hidden = true;
        sidebar.inert = narrow.matches;
        if (restoreFocus) toggle.focus();
    }
    toggle.addEventListener('click', () => {
        if (!narrow.matches) {
            document.body.classList.toggle('nav-collapsed');
            toggle.setAttribute('aria-expanded', String(!document.body.classList.contains('nav-collapsed')));
        } else if (document.body.classList.contains('nav-open')) closeNavigation(true);
        else {
            document.body.classList.add('nav-open');
            toggle.setAttribute('aria-expanded', 'true');
            sidebar.inert = false;
            backdrop.hidden = false;
            sidebar.querySelector('.sidebar-close').focus();
        }
    });
    sidebar.querySelector('.sidebar-close').addEventListener('click', () => closeNavigation(true));
    backdrop.addEventListener('click', () => closeNavigation(true));
    sidebar.addEventListener('click', e => { if (e.target.closest('a')) closeNavigation(); });
    document.addEventListener('keydown', e => {
        if (!document.body.classList.contains('nav-open')) return;
        if (e.key === 'Escape') { e.preventDefault(); closeNavigation(true); }
        if (e.key === 'Tab') {
            const focusable = [...sidebar.querySelectorAll('a, button, input')].filter(el => !el.closest('[hidden]') && el.getBoundingClientRect().height > 0);
            const first = focusable[0], last = focusable.at(-1);
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    });
    narrow.addEventListener('change', () => closeNavigation());
    closeNavigation();

    function outline() {
        const toc = document.getElementById('toc');
        const heads = [...document.querySelectorAll('main h2')];
        if (!toc || heads.length === 0) return;
        const label = document.createElement('p');
        label.className = 'section-label';
        label.textContent = 'On this page';
        toc.replaceChildren(label);
        const links = heads.map((h, i) => {
            if (!h.id) h.id = `section-${i}-${h.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
            const a = document.createElement('a');
            a.href = `#${h.id}`;
            a.textContent = h.textContent;
            toc.append(a);
            return a;
        });
        links[0].classList.add('current');
        const observer = new IntersectionObserver(entries => {
            for (const entry of entries) if (entry.isIntersecting) links.forEach((link, i) => link.classList.toggle('current', heads[i] === entry.target));
        }, { rootMargin: '-80px 0px -60% 0px' });
        heads.forEach(h => observer.observe(h));
    }

    function documentation(pages) {
        const navigation = document.getElementById('doc-navigation');
        const filter = document.createElement('label');
        filter.className = 'filter';
        filter.innerHTML = `${icon('search')}<input type="search" placeholder="Filter pages…" aria-label="Filter documentation">`;
        navigation.append(filter);
        const here = location.pathname.split('/').pop() || 'index.html';
        const flat = pages.flatMap(([, items]) => items).filter(([href]) => !href.startsWith('../'));
        const groups = [];
        for (const [name, items] of pages) {
            const group = document.createElement('section');
            const label = document.createElement('h2');
            label.className = 'section-label';
            label.textContent = name;
            group.append(label);
            for (const [href, title] of items) {
                const a = document.createElement('a');
                a.href = href;
                a.className = 'file-row doc-link';
                a.innerHTML = icon(href.startsWith('../') ? 'book-open' : 'file-text');
                a.append(document.createTextNode(title));
                if (here === href) { a.classList.add('selected'); a.setAttribute('aria-current', 'page'); }
                group.append(a);
            }
            navigation.append(group);
            groups.push(group);
        }
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.hidden = true;
        empty.textContent = 'No page matches.';
        empty.setAttribute('role', 'status');
        navigation.append(empty);
        filter.querySelector('input').addEventListener('input', e => {
            const query = e.target.value.trim().toLowerCase();
            let visible = 0;
            for (const group of groups) {
                let matches = 0;
                for (const a of group.querySelectorAll('a')) { a.hidden = !a.textContent.toLowerCase().includes(query); if (!a.hidden) matches++; }
                group.hidden = matches === 0;
                visible += matches;
            }
            empty.hidden = visible !== 0;
        });
        const crumb = document.createElement('div');
        crumb.className = 'doc-crumb';
        const link = document.createElement('a');
        link.href = 'index.html';
        link.textContent = 'Documentation';
        crumb.append(link);
        crumb.insertAdjacentHTML('beforeend', icon('chevron-right'));
        crumb.append(document.createTextNode(section));
        document.querySelector('main').prepend(crumb);
        const index = flat.findIndex(([href]) => href === here);
        if (index >= 0) {
            const pager = document.createElement('nav');
            pager.className = 'pager';
            pager.setAttribute('aria-label', 'Previous and next page');
            for (const [item, cls, label] of [[flat[index - 1], 'prev', '← Previous'], [flat[index + 1], 'next', 'Next →']]) {
                if (!item) continue;
                const a = document.createElement('a');
                a.href = item[0];
                a.className = cls;
                const small = document.createElement('small');
                small.textContent = label;
                a.append(small, document.createTextNode(item[1]));
                pager.append(a);
            }
            document.querySelector('main').append(pager);
        }
        outline();
    }
    window.markworkSite = { documentation };
})();
