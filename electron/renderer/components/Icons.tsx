// The window's icons, from Lucide (the icon set of shadcn/ui), drawn inline so they take the text color. The names are
// the window's own (what an icon stands for), so a component never names a Lucide export.

import {
    ArrowUp, BetweenHorizontalEnd, BetweenVerticalEnd, Bold, BookOpen, Calendar, ChartColumn, ChartGantt, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown, ChevronUp,
    CircleAlert, CircleCheck, CircleMinus, Code, CodeXml, Columns2, Command, Copy, Ellipsis, EllipsisVertical, ExternalLink, FileOutput, FileText, Folder, GitPullRequest, GripVertical, Heading1, Heading2, Heading3, History, House,
    Image, Info, Italic, LayoutGrid, Link, List, ListOrdered, ListTodo, ListTree, MessageSquare, Minus, Package, PanelLeft, Pencil, Plus, Redo2, RefreshCw, Rows2, Search, Settings, SlidersHorizontal, Sparkles,
    Square, SquareCode, SquareKanban, SquareTerminal, Strikethrough, Table, TextCursorInput, TextQuote, TextSearch, Trash2, TriangleAlert, Type, Undo2, X, ZoomIn, ZoomOut,
    type IconNode,
} from 'lucide';

const ICONS = {
    'sidebar-show': PanelLeft,
    'document-new': Plus,
    'folder': Folder,
    'pan-down': ChevronDown,
    'pan-end': ChevronRight,
    'search': Search,
    'view-refresh': RefreshCw,
    'outline': ListTree,
    'open-menu': Ellipsis,
    'window-close': X,
    'text-x-generic': FileText,
    'emblem-ok': Check,
    'go-previous': ChevronLeft,
    'go-next': ChevronRight,
    'chevron-up': ChevronUp,
    'chevron-down': ChevronDown,
    'chevrons-up-down': ChevronsUpDown,
    'go-up': ArrowUp,
    'media-playback-stop': Square,
    'edit-copy': Copy,
    'edit-clear': Trash2,
    'utilities-terminal': SquareTerminal,
    'document-open-recent': History,
    'emblem-system': Settings,
    'insert-text': TextCursorInput,
    'dialog-warning': TriangleAlert,
    'chat-message-new': Sparkles,
    'pull-request': GitPullRequest,
    'list-add': Plus,
    'dialog-error': CircleAlert,
    'dialog-information': Info,
    'view-dual': SquareKanban,
    'view-list': List,
    'x-office-calendar': Calendar,
    'view-continuous': ChartGantt,
    'view-grid': LayoutGrid,
    'view-sort-descending': ChartColumn,
    'x-office-spreadsheet': Table,
    'system-run': Command,
    'edit-find': TextSearch,
    'document-send': FileOutput,
    'edit-undo': Undo2,
    'view-more': EllipsisVertical,
    'view-more-horizontal': Ellipsis,
    'list-remove': Minus,
    'list-drag-handle': GripVertical,
    'preferences-system': SlidersHorizontal,
    'user-available': MessageSquare,
    'zoom-in': ZoomIn,
    'zoom-out': ZoomOut,
    'sparkle': Sparkles,
    'home': House,
    'journal': BookOpen,
    'programs': Package,
    'program-ok': CircleCheck,
    'program-optional': CircleMinus,
    'external-link': ExternalLink,
    'edit-redo': Redo2,
    'split-right': Columns2,
    'split-down': Rows2,
    'format-bold': Bold,
    'format-italic': Italic,
    'format-strike': Strikethrough,
    'format-code': Code,
    'format-link': Link,
    'format-text': Type,
    'format-h1': Heading1,
    'format-h2': Heading2,
    'format-h3': Heading3,
    'format-quote': TextQuote,
    'format-codeblock': SquareCode,
    'list-bullet': List,
    'list-numbered': ListOrdered,
    'list-todo': ListTodo,
    'insert-image': Image,
    'insert-divider': Minus,
    'table-row': BetweenHorizontalEnd,
    'table-column': BetweenVerticalEnd,
    'mode-visual': Pencil,
    'mode-markdown': CodeXml,
} satisfies Record<string, IconNode>;

export type IconName = keyof typeof ICONS;

const STROKE = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
    return (
        <svg className={`icon-svg${className ? ` ${className}` : ''}`} width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
            {ICONS[name].map(([tag, attrs], i) => {
                const Tag = tag as 'path';
                return <Tag key={i} {...(attrs as object)} />;
            })}
        </svg>
    );
}

// The same icon as a DOM element, for the parts drawn without React (the editor's find bar).
export function iconElement(name: IconName, size = 16): SVGSVGElement {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    for (const [k, v] of [['class', 'icon-svg'], ['width', String(size)], ['height', String(size)], ['viewBox', '0 0 24 24'], ['fill', 'none'],
        ['stroke', 'currentColor'], ['stroke-width', '2'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']]) svg.setAttribute(k, v);
    for (const [tag, attrs] of ICONS[name]) {
        const element = document.createElementNS(ns, tag);
        for (const [k, v] of Object.entries(attrs)) if (v !== undefined) element.setAttribute(k, String(v));
        svg.append(element);
    }
    return svg;
}
