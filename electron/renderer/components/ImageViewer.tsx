// A picture shown large, in a window of its own over the window: the title and the picture's size in pixels in its header,
// the picture on a dark canvas, and the zoom under it (− the zoom +, Fit, 100%). The window is as large as the picture,
// at most the window it is over; a small picture opens at 100%, a large one fitted. Keys: + and − zoom by 1.25 (5% to
// 800%), 0 is 100%, F fits, Escape closes. The wheel zooms at the pointer, dragging moves the picture, a double click
// alternates between fit and 100%, a click outside the window closes.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './Icons.js';
import { useClient, useStore } from '../lib/useClient.js';

const STEP = 1.25, MIN = 0.05, MAX = 8;
const PAD = 20, HEAD = 50, BAR = 50, MARGIN = 32;   // the canvas around the picture, the header, the zoom bar, the room left around the window
const clamp = (scale: number) => Math.min(MAX, Math.max(MIN, scale));

interface View { scale: number; x: number; y: number }   // x, y: where the picture's centre is from the canvas's centre

export function ImageViewer() {
    const client = useClient();
    const { image } = useStore();
    const area = useRef<HTMLDivElement>(null);
    const [natural, setNatural] = useState({ w: 0, h: 0 });
    const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
    const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
    useEffect(() => { setNatural({ w: 0, h: 0 }); }, [image?.src]);

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
    return (
        <div className="image-viewer" role="dialog" aria-label={image.title}
            onClick={event => { if (event.target === event.currentTarget) client.closeImage(); }}>
            <div className="viewer-window" style={{ width, height }}>
                <header className="viewer-head">
                    <span className="titles">
                        <span className="name">{image.title}</span>
                        {natural.w > 0 && <span className="size">{natural.w} × {natural.h} px</span>}
                    </span>
                    <button className="button circular" aria-label="Close" title="Close" onClick={() => client.closeImage()}><Icon name="window-close" /></button>
                </header>
                <div className="area" ref={area}
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
                    <img src={image.src} alt={image.title} draggable={false}
                        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
                        onLoad={event => { const img = event.currentTarget; setNatural({ w: img.naturalWidth, h: img.naturalHeight }); }}
                        onDoubleClick={() => {
                            const fitted = clamp(fitScale());
                            setView(v => ({ scale: Math.abs(v.scale - fitted) < 0.01 ? 1 : fitted, x: 0, y: 0 }));
                        }} />
                </div>
                <div className="zoom-bar">
                    <button className="button" aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoomTo(view.scale / STEP)}>−</button>
                    <span className="zoom-level" aria-live="polite">{Math.round(view.scale * 100)}%</span>
                    <button className="button" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomTo(view.scale * STEP)}>+</button>
                    <button className="button" title="Fit to the window (F)" onClick={fit}>Fit</button>
                    <button className="button" title="Actual size (0)" onClick={() => setView({ scale: 1, x: 0, y: 0 })}>100%</button>
                </div>
            </div>
        </div>
    );
}
