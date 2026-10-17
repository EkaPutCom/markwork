// The Assistant panel's settings popover: the API key (stored, replaced, or forgotten), the model, thinking mode,
// and whether conversations are saved to the work folder.

import Gtk from 'gi://Gtk?version=4.0';
import type { KeySource } from '../agent/apikey.js';
import { DEEPSEEK_MODELS } from '../agent/models.js';
import { _, fmt } from '../i18n.js';

const SOURCE_TEXT: Record<KeySource, string> = {
    env: _('Using the key from the DEEPSEEK_API_KEY environment variable.'),
    keyring: _('The key is stored in the system keyring.'),
    file: _('The key is stored in ~/.config/markwork/deepseek.key (keyring unavailable).'),
};

export interface SettingsWidgets {
    popover: Gtk.Popover;
    keyEntry: Gtk.Entry;
    keyStatus: Gtk.Label;
    saveKeyButton: Gtk.Button;
    forgetKeyButton: Gtk.Button;
    modelDrop: Gtk.DropDown;
    thinkingCheck: Gtk.CheckButton;
    saveCheck: Gtk.CheckButton;
}

// What the popover reports; the Assistant (app/assistant.ts) keeps the settings and the key store.
export interface SettingsActions {
    model(model: string): void;
    thinking(thinking: boolean): void;
    saveChats(save: boolean): void;
    keyStatus(): Promise<KeySource | null>;
    saveKey(key: string): Promise<KeySource>;
    forgetKey(): Promise<void>;
}

export class ChatSettings {
    private model = DEEPSEEK_MODELS[0];

    constructor(private readonly w: SettingsWidgets, private readonly actions: SettingsActions) {
        w.popover.connect('show', () => void this.refreshKeyStatus());
        w.saveKeyButton.connect('clicked', () => void this.saveKey());
        w.keyEntry.connect('activate', () => void this.saveKey());
        w.forgetKeyButton.connect('clicked', () => void this.forgetKey());
        w.modelDrop.set_model(Gtk.StringList.new(DEEPSEEK_MODELS));
        w.modelDrop.connect('notify::selected', () => {
            const id = DEEPSEEK_MODELS[w.modelDrop.get_selected()];
            if (!id || id === this.model) return;
            this.model = id;
            actions.model(id);
        });
        w.thinkingCheck.connect('toggled', () => actions.thinking(w.thinkingCheck.active));
        w.saveCheck.connect('toggled', () => actions.saveChats(w.saveCheck.active));
    }

    // The settings as the core has them; a widget that already shows its value is left alone, so nothing is reported back.
    show(settings: { model: string; thinking: boolean; saveChats: boolean }): void {
        this.model = settings.model;
        const index = DEEPSEEK_MODELS.indexOf(settings.model);
        if (index >= 0 && this.w.modelDrop.get_selected() !== index) this.w.modelDrop.set_selected(index);
        if (this.w.thinkingCheck.active !== settings.thinking) this.w.thinkingCheck.set_active(settings.thinking);
        if (this.w.saveCheck.active !== settings.saveChats) this.w.saveCheck.set_active(settings.saveChats);
    }

    private async refreshKeyStatus(): Promise<void> {
        const source = await this.actions.keyStatus();
        this.w.keyStatus.set_text(source ? SOURCE_TEXT[source] : _('No key yet. Create one at platform.deepseek.com.'));
    }

    private async saveKey(): Promise<void> {
        const key = this.w.keyEntry.text.trim();
        if (!key) return;
        try {
            const source = await this.actions.saveKey(key);
            this.w.keyEntry.set_text('');
            this.w.keyStatus.set_text(SOURCE_TEXT[source]);
        } catch (e) {
            this.w.keyStatus.set_text(fmt(_('Failed to save: {error}'), { error: e instanceof Error ? e.message : String(e) }));
        }
    }

    private async forgetKey(): Promise<void> {
        await this.actions.forgetKey();
        await this.refreshKeyStatus();
    }
}
