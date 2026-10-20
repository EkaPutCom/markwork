import { Icon } from './Icons.js';
import { useClient, useStore } from './useClient.js';

// The tab bar, shown once there is more than one document, with the tabs sharing its width.
export function Tabs() {
    const client = useClient();
    const { tabs, active } = useStore();
    if (tabs.length < 2) return null;
    return (
        <div className="tabs" role="tablist" aria-label="Open documents">
            {tabs.map(t => (
                <div key={t.id} role="tab" aria-selected={t.id === active} className={`tab${t.id === active ? ' active' : ''}`}
                    title={t.file ?? t.name} onClick={() => client.selectTab(t.id)} onAuxClick={e => { if (e.button === 1) client.closeTab(t.id); }}>
                    <span className="label">{t.mirror.modified ? '• ' : ''}{t.name}</span>
                    <button className="button flat circular close" aria-label={`Close ${t.name}`} onClick={e => { e.stopPropagation(); client.closeTab(t.id); }}>
                        <Icon name="window-close" />
                    </button>
                </div>
            ))}
        </div>
    );
}
