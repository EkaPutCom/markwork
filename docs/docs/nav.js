// Shared documentation navigation: the sidebar, the page filter, the table of contents, and the previous/next buttons.
// Adding a new page only needs an entry in PAGES; the order also decides the pager.
const PAGES = [
  ['Getting started', [
    ['index.html', 'Quick start'],
    ['concepts.html', 'Basic concepts'],
  ]],
  ['Agent', [
    ['assistant.html', 'The Assistant panel'],
    ['context.html', 'Context and privacy'],
    ['browsing.html', 'Browsing files and Git'],
    ['proposals.html', 'Proposals and approval'],
    ['work.html', 'Plans and verification'],
    ['history.html', 'History, journal, and log'],
    ['orchestrator.html', 'The pi orchestrator'],
  ]],
  ['Workspace', [
    ['editor.html', 'The Markdown editor'],
    ['diagram.html', 'Mermaid and DBML diagrams'],
    ['kanban.html', 'The kanban board'],
    ['inbox.html', 'Inbox'],
    ['home.html', 'Home'],
    ['journal.html', 'The daily journal'],
    ['files.html', 'Files, tabs, and the sidebar'],
    ['git.html', 'Git history'],
    ['collaboration.html', 'Collaboration'],
  ]],
  ['Reference', [
    ['tools.html', 'Agent tool list'],
    ['shortcuts.html', 'Shortcuts'],
    ['settings.html', 'Settings'],
    ['limitations.html', 'Limitations'],
  ]],
  ['For developers', [
    ['../learn-agent.html', 'Learn to build an agent'],
    ['../learn-performance.html', 'Learn performance'],
  ]],
];

const here = location.pathname.split('/').pop() || 'index.html';
const flat = PAGES.flatMap(([, items]) => items).filter(([href]) => !href.startsWith('../'));

function el(tag, attrs = {}, text) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
}

// Sidebar and filter
const side = document.getElementById('side');
if (side) {
  const search = el('input', { type: 'search', placeholder: 'Filter pages…', 'aria-label': 'Filter pages' });
  side.append(search);
  const groups = [];
  for (const [title, items] of PAGES) {
    const h = el('h4', {}, title);
    const ul = el('ul');
    for (const [href, label] of items) {
      const a = el('a', { href }, label);
      if (href === here) a.setAttribute('aria-current', 'page');
      const li = el('li');
      li.append(a);
      ul.append(li);
    }
    side.append(h, ul);
    groups.push([h, ul]);
  }
  const empty = el('p', { class: 'empty', hidden: '' }, 'No page matches.');
  side.append(empty);
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    let any = false;
    for (const [h, ul] of groups) {
      let shown = 0;
      for (const li of ul.children) {
        const ok = !q || li.textContent.toLowerCase().includes(q);
        li.hidden = !ok;
        if (ok) shown++;
      }
      h.hidden = ul.hidden = shown === 0;
      any ||= shown > 0;
    }
    empty.hidden = any;
  });
}

// The menu button on a narrow screen
const menuBtn = document.querySelector('.menu-btn');
menuBtn?.addEventListener('click', () => {
  const open = document.body.classList.toggle('nav-open');
  menuBtn.setAttribute('aria-expanded', String(open));
});
side?.addEventListener('click', (e) => {
  if (e.target.closest('a')) document.body.classList.remove('nav-open');
});

// The table of contents from h2, with a marker for the section being read
const toc = document.getElementById('toc');
const heads = [...document.querySelectorAll('main.doc h2')];
if (toc && heads.length > 1) {
  toc.append(el('p', {}, 'On this page'));
  const links = heads.map((h) => {
    if (!h.id) h.id = h.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const a = el('a', { href: `#${h.id}` }, h.textContent);
    toc.append(a);
    return a;
  });
  const mark = () => {
    let i = 0;
    heads.forEach((h, j) => { if (h.getBoundingClientRect().top < 120) i = j; });
    links.forEach((a, j) => a.classList.toggle('on', j === i));
  };
  addEventListener('scroll', mark, { passive: true });
  mark();
}

// Previous / next
const main = document.querySelector('main.doc');
const idx = flat.findIndex(([href]) => href === here);
if (main && idx >= 0) {
  const pager = el('nav', { class: 'pager', 'aria-label': 'Previous and next page' });
  const add = (item, cls, label) => {
    if (!item) return;
    const a = el('a', { href: item[0], class: cls });
    a.append(el('small', {}, label), document.createTextNode(item[1]));
    pager.append(a);
  };
  add(flat[idx - 1], 'prev', '← Previous');
  add(flat[idx + 1], 'next', 'Next →');
  main.append(pager);
}
