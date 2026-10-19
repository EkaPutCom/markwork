// A picture shown large over the window (the GTK image viewer, ui/imageviewer.ts): a click or Escape closes it.

import { useEffect } from 'react';
import { useClient, useStore } from './useClient.js';

export function ImageViewer() {
    const client = useClient();
    const { image } = useStore();
    useEffect(() => {
        if (!image) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            client.closeImage();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [image, client]);
    if (!image) return null;
    return (
        <div className="image-viewer" role="dialog" aria-label={image.title} onClick={() => client.closeImage()}>
            <img src={image.src} alt={image.title} />
            <div className="caption">{image.title}</div>
        </div>
    );
}
