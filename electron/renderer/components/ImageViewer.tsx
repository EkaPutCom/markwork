// A picture shown large, in a window of its own over the window: the title and the picture's size in pixels in its header,
// the picture on a dark canvas, and the zoom under it (− the zoom +). The window is as large as the picture,
// at most the window it is over; a small picture opens at 100%, a large one fitted. Keys: + and − zoom by 1.25 (5% to
// 800%), 0 is 100%, F fits, Escape closes. The wheel zooms at the pointer, dragging moves the picture, a double click
// alternates between fit and 100%, a click outside the window closes. The header moves the window and its edges and corner resize it.

import type { PointerEvent as ReactPointerEvent } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './Icons';
import { IconButton } from '../ui/icon-button';
import { useClient, useStore } from '../lib/useClient';

const STEP = 1.25, MIN = 0.05, MAX = 8;
const PAD = 20, HEAD = 50, BAR = 50, MARGIN = 32;   // the canvas around the picture, the header, the zoom bar, the room left around the window
const clamp = (scale: number) => Math.min(MAX, Math.max(MIN, scale));

interface Box { x: number; y: number; w: number; h: number }   // the window, once the user has moved or resized it
const MIN_W = 320, MIN_H = 220;

interface View { scale: number; x: number; y: number }   // x, y: where the picture's centre is from the canvas's centre

export function ImageViewer() {
    const client = useClient();
    const { image } = useStore();
    const area = useRef<HTMLDivElement>(null);
    const [natural, setNatural] = useState({ w: 0, h: 0 });
    const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
    const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
    const [box, setBox] = useState<Box | null>(null);
    useEffect(() => { setBox(null); }, [image?.src, image?.svg]);
    useEffect(() => { setNatural(image?.svg ? { w: image.width ?? 0, h: image.height ?? 0 } : { w: 0, h: 0 }); }, [image?.src, image?.svg, image?.width, image?.height]);

    const fitScale = useCallback((): number => {
        const box = area.current?.getBoundingClientRect(), { w, h } = natural;
        return box && w && h ? Math.min((box.width - PAD * 2) / w, (box.height - PAD * 2) / h) : 1;
    }, [natural]);
    // Zoom to `scale` keeping the picture point under (px, py), measured from the canvas's centre.
    const zoomTo = useCallback((scale: number, px = 0, py = 0) => setView(v => {
        const next = clamp(scale), k = next / v.scale;
        return { scale: next, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    }), []);
    const fit = useCallback(() => setView({ scale: clamp(fitScale()), x: 0, y: 0 }), [fitScale]);
    // Once the window has the picture's size: a small picture at 100%, a large one fitted.
    useLayoutEffect(() => { if (natural.w) setView({ scale: Math.min(1, fitScale()), x: 0, y: 0 }); }, [natural, fitScale]);

    useEffect(() => {
        if (!image) return;
        const onKey = (event: KeyboardEvent) => {
            const handled = ['Escape', '+', '=', '-', '_', '0', 'f', 'F'].includes(event.key);
            if (!handled) return;
            event.preventDefault();
            event.stopPropagation();
            if (event.key === 'Escape') client.closeImage();
            else if (event.key === '+' || event.key === '=') zoomTo(view.scale * STEP);
            else if (event.key === '-' || event.key === '_') zoomTo(view.scale / STEP);
            else if (event.key === '0') setView({ scale: 1, x: 0, y: 0 });
            else fit();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [image, client, view.scale, zoomTo, fit]);

    if (!image) return null;
    const centre = (event: { clientX: number; clientY: number }) => {
        const box = area.current!.getBoundingClientRect();
        return [event.clientX - box.left - box.width / 2, event.clientY - box.top - box.height / 2];
    };
    const width = natural.w ? Math.min(window.innerWidth - MARGIN * 2, Math.max(420, natural.w + PAD * 2)) : 480;
    const height = natural.h ? Math.min(window.innerHeight - MARGIN * 2, Math.max(260, natural.h + PAD * 2 + HEAD + BAR)) : 360;
    const fitted: Box = { w: width, h: height, x: (window.innerWidth - width) / 2, y: (window.innerHeight - height) / 2 };
    const frame = box ?? fitted;
    // Move or resize the window while the pointer is down: edges says which sides follow it (none = the whole window moves).
    const reshape = (event: ReactPointerEvent, edges: { left?: boolean; right?: boolean; bottom?: boolean; top?: boolean } | null) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const start = { px: event.clientX, py: event.clientY, x0: frame.x, y0: frame.y, w: frame.w, h: frame.h };
        const move = (e: PointerEvent) => {
            const dx = e.clientX - start.px, dy = e.clientY - start.py;
            if (!edges) { setBox({ x: start.x0 + dx, y: start.y0 + dy, w: start.w, h: start.h }); return; }
            const w = Math.max(MIN_W, start.w + (edges.right ? dx : edges.left ? -dx : 0));
            const h = Math.max(MIN_H, start.h + (edges.bottom ? dy : edges.top ? -dy : 0));
            setBox({ x: edges.left ? start.x0 + start.w - w : start.x0, y: edges.top ? start.y0 + start.h - h : start.y0, w, h });
        };
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    };
    return (
        <div className="image-viewer" role="dialog" aria-label={image.title}
            onClick={event => { if (event.target === event.currentTarget) client.closeImage(); }}>
            <div className="viewer-window" style={{ width: frame.w, height: frame.h, left: frame.x, top: frame.y }}>
                <header className="viewer-head" onPointerDown={event => { if (!(event.target as HTMLElement).closest('button')) reshape(event, null); }}>
                    <span className="titles">
                        <span className="name">{image.title}</span>
                        {natural.w > 0 && <span className="size">{natural.w} × {natural.h} px</span>}
                    </span>
                    <IconButton size="icon-xs" label="Close" shortcut="Esc" onClick={() => client.closeImage()}><Icon name="window-close" /></IconButton>
                </header>
                <div className={`area${image.svg ? ' diagram' : ''}`} ref={area}
                    onWheel={event => { const [px, py] = centre(event); zoomTo(view.scale * (event.deltaY < 0 ? STEP : 1 / STEP), px, py); }}
                    onMouseDown={event => { if (event.button === 0 && event.target instanceof HTMLImageElement) drag.current = { x: event.clientX, y: event.clientY, moved: false }; }}
                    onMouseMove={event => {
                        const d = drag.current;
                        if (!d) return;
                        const dx = event.clientX - d.x, dy = event.clientY - d.y;
                        d.x = event.clientX; d.y = event.clientY; d.moved ||= dx !== 0 || dy !== 0;
                        setView(v => ({ ...v, x: v.x + dx, y: v.y + dy }));
                    }}
                    onMouseUp={() => { drag.current = null; }}
                    onMouseLeave={() => { drag.current = null; }}>
                    {image.svg
                        ? <div className="cm-md-diagram viewer-diagram" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }} dangerouslySetInnerHTML={{ __html: image.svg }}
                            onMouseDown={event => { if (event.button === 0) drag.current = { x: event.clientX, y: event.clientY, moved: false }; }}
                            onDoubleClick={() => {
                            const fitted = clamp(fitScale());
                            setView(v => ({ scale: Math.abs(v.scale - fitted) < 0.01 ? 1 : fitted, x: 0, y: 0 }));
                        }} />
                        : <img src={image.src} alt={image.title} draggable={false}
                      style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
                      onLoad={event => { const img = event.currentTarget; setNatural({ w: img.naturalWidth, h: img.naturalHeight }); }}
                      onDoubleClick={() => {
                          const fitted = clamp(fitScale());
                          setView(v => ({ scale: Math.abs(v.scale - fitted) < 0.01 ? 1 : fitted, x: 0, y: 0 }));
                      }} />}
                </div>
                <div className="zoom-bar">
                    <IconButton variant="outline" size="icon-sm" label="Zoom out" shortcut="−" onClick={() => zoomTo(view.scale / STEP)}>−</IconButton>
                    <span className="zoom-level" aria-live="polite">{Math.round(view.scale * 100)}%</span>
                    <IconButton variant="outline" size="icon-sm" label="Zoom in" shortcut="+" onClick={() => zoomTo(view.scale * STEP)}>+</IconButton>
                </div>
                <div className="resize right" onPointerDown={event => reshape(event, { right: true })} />
                <div className="resize bottom" onPointerDown={event => reshape(event, { bottom: true })} />
                <div className="resize left" onPointerDown={event => reshape(event, { left: true })} />
                <div className="resize top" onPointerDown={event => reshape(event, { top: true })} />
                <div className="resize corner" onPointerDown={event => reshape(event, { right: true, bottom: true })} />
            </div>
        </div>
    );
}
