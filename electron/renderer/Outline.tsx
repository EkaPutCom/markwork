// The Outline panel (ui/outline.ts): the headings of the active document, indented by level; a click jumps to one.

import { useClient, useStore } from './useClient.js';

export function Outline() {
    const client = useClient();
    const { outline } = useStore();
    return (
        <aside className="sidebar" aria-label="Outline">
            <div className="side-title">OUTLINE</div>
            {outline.length === 0 ? (
                <div className="placeholder"><p>No headings</p></div>
            ) : (
                <ul className="outline" role="list">
                    {outline.map((heading, i) => (
                        <li key={i}>
                            <button className="row" style={{ paddingLeft: 12 + (heading.level - 1) * 14 }} onClick={() => client.jumpToHeading(i)}>
                                <span className="label">{heading.text}</span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </aside>
    );
}
