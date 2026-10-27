import { createContext, useContext, useSyncExternalStore } from 'react';
import type { Client, State } from './client';
import type { ChatState } from './chatmodel';

export const ClientContext = createContext<Client | null>(null);

export function useClient(): Client {
    const client = useContext(ClientContext);
    if (!client) throw new Error('no client');
    return client;
}

export function useStore(): State {
    const client = useClient();
    return useSyncExternalStore(client.subscribe, client.getState);
}

// The Assistant panel has a store of its own: an answer streams in many small notices, and only the panel draws again for them.
export function useChat(): ChatState {
    const { chat } = useClient();
    return useSyncExternalStore(chat.subscribe, chat.getState);
}
