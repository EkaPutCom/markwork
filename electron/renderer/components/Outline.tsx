// The headings of the active document, indented by level; a click jumps to one: the body of the Files view's Outline section.

import type { CSSProperties } from 'react';
import { useClient, useStore } from '../lib/useClient.js';
import { Button } from '../ui/button.js';

export function OutlineList() {
    const client = useClient();
    const { outline } = useStore();
    if (outline.length === 0) return <p className="empty">No headings in this document.</p>;
    return (
        <ul className="m-0 flex list-none flex-col p-0" aria-label="Headings">
            {outline.map((heading, i) => (
                <li key={i}>
                    <Button
                        variant="ghost" size="sm"
                        className="w-full justify-start pr-2 pl-[calc(0.75rem+var(--depth)*0.75rem)] text-ui font-normal hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                        style={{ '--depth': heading.level - 1 } as CSSProperties}
                        onClick={() => client.jumpToHeading(i)}
                    >
                        <span className="min-w-0 truncate" title={heading.text}>{heading.text}</span>
                    </Button>
                </li>
            ))}
        </ul>
    );
}
