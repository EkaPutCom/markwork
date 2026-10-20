import { Icon } from './Icons.js';
import { useClient, useStore } from './useClient.js';

// The tab bar, shown once there is more than one document: shadcn's Tabs, centered over the editor. A document with
// changes not saved has a dot before its name, and the tab says so to a screen reader.
export function Tabs() {
    const client = useClient();
    const { tabs, active } = useStore();
    if (tabs.length < 2) return null;
    return (
        <div className="tabs">
            <div className="tab-list" role="tablist" aria-label="Open documents">
                {tabs.map(t => (
                    <div key={t.id} role="tab" aria-selected={t.id === active} className={`tab${t.id === active ? ' active' : ''}`}
                        title={t.file ?? t.name} onClick={() => client.selectTab(t.id)} onAuxClick={e => { if (e.button === 1) client.closeTab(t.id); }}>
                        {t.mirror.modified && <span className="dot" role="img" aria-label="Unsaved" />}
                        <span className="label">{t.name}</span>
                        <button className="button flat circular close" aria-label={`Close ${t.name}`} onClick={e => { e.stopPropagation(); client.closeTab(t.id); }}>
                            <Icon name="window-close" size={14} />
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
}
