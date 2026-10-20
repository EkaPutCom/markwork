// A picture shown large over the window. A small picture opens at 100%, a large one
// fitted to the window. Keys: + and − zoom by 1.25 (5% to 800%), 0 is 100%, F fits, Escape closes. The wheel zooms at the
// pointer, dragging moves the picture, a double click alternates between fit and 100%, a click outside the picture closes.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useClient, useStore } from './useClient.js';

const STEP = 1.25, MIN = 0.05, MAX = 8;
const clamp = (scale: number) => Math.min(MAX, Math.max(MIN, scale));

interface View { scale: number; x: number; y: number }   // x, y: where the picture's centre is from the window's centre

export function ImageViewer() {
    const client = useClient();
    const { image } = useStore();
    const area = useRef<HTMLDivElement>(null);
    const natural = useRef({ w: 0, h: 0 });
    const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
    const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

    const fitScale = useCallback((): number => {
        const box = area.current?.getBoundingClientRect(), { w, h } = natural.current;
        return box && w && h ? Math.min(box.width / w, box.height / h) : 1;
    }, []);
    // Zoom to `scale` keeping the picture point under (px, py), measured from the window's centre.
    const zoomTo = useCallback((scale: number, px = 0, py = 0) => setView(v => {
        const next = clamp(scale), k = next / v.scale;
        return { scale: next, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    }), []);

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
            else setView({ scale: clamp(fitScale()), x: 0, y: 0 });
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [image, client, view.scale, zoomTo, fitScale]);

    if (!image) return null;
    const centre = (event: { clientX: number; clientY: number }) => {
        const box = area.current!.getBoundingClientRect();
        return [event.clientX - box.left - box.width / 2, event.clientY - box.top - box.height / 2];
    };
    return (
        <div className="image-viewer" role="dialog" aria-label={image.title}
            onClick={event => { if (event.target === event.currentTarget || event.target === area.current) client.closeImage(); }}>
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
                    onLoad={event => {
                        const img = event.currentTarget;
                        natural.current = { w: img.naturalWidth, h: img.naturalHeight };
                        setView({ scale: Math.min(1, fitScale()), x: 0, y: 0 });
                    }}
                    onDoubleClick={() => {
                        const fit = clamp(fitScale());
                        setView(v => ({ scale: Math.abs(v.scale - fit) < 0.01 ? 1 : fit, x: 0, y: 0 }));
                    }} />
            </div>
            <div className="caption">{image.title} · {Math.round(view.scale * 100)}%</div>
        </div>
    );
}
