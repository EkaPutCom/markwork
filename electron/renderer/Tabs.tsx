import { useClient, useStore } from './useClient.js';

export function Tabs() {
    const client = useClient();
    const { tabs, active, root } = useStore();
    const current = tabs.find(t => t.id === active);
    const crumbs = current?.file ? (root && current.file.startsWith(root) ? [root.split(/[\\/]/).pop()!, ...current.file.slice(root.length + 1).split('/')] : [current.name]) : current ? [current.name] : [];
    return (
        <>
            <div className="tabs" role="tablist" aria-label="Open editors">
                {tabs.map(t => (
                    <div key={t.id} role="tab" aria-selected={t.id === active} className={`tab${t.id === active ? ' active' : ''}${t.mirror.modified ? ' dirty' : ''}`}
                        title={t.file ?? t.name} onClick={() => client.selectTab(t.id)} onAuxClick={e => { if (e.button === 1) client.closeTab(t.id); }}>
                        <i className="codicon codicon-markdown icon" />
                        <span className="label">{t.name}</span>
                        <button className="close" aria-label={`Close ${t.name}`} onClick={e => { e.stopPropagation(); client.closeTab(t.id); }}>
                            <i className={`codicon codicon-${t.mirror.modified ? 'circle-filled' : 'close'}`} />
                        </button>
                    </div>
                ))}
            </div>
            {crumbs.length > 0 && (
                <div className="breadcrumbs" aria-label="Breadcrumbs">
                    {crumbs.map((c, i) => <span key={i} className="crumb">{i > 0 && <i className="codicon codicon-chevron-right" />}{c}</span>)}
                </div>
            )}
        </>
    );
}
