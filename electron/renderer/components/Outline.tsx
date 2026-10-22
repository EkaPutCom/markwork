// The headings of the active document, indented by level; a click jumps to one: the body of the Files view's Outline section.

import { useClient, useStore } from '../lib/useClient.js';

export function OutlineList() {
    const client = useClient();
    const { outline } = useStore();
    if (outline.length === 0) return <p className="empty">No headings in this document.</p>;
    return (
        <ul className="outline" role="list">
            {outline.map((heading, i) => (
                <li key={i}>
                    <button className="row" style={{ paddingLeft: 12 + (heading.level - 1) * 14 }} onClick={() => client.jumpToHeading(i)}>
                        <span className="label">{heading.text}</span>
                    </button>
                </li>
            ))}
        </ul>
    );
}
