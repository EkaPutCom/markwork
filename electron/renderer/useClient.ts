import { createContext, useContext, useSyncExternalStore } from 'react';
import type { Client, State } from './client.js';

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
