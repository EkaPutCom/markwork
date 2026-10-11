// The Assistant panel's settings popover: the API key (stored, replaced, or forgotten), the model, thinking mode,
// and whether conversations are saved to the work folder.

import Gtk from 'gi://Gtk?version=4.0';
import type { KeySource } from '../agent/apikey.js';
import type { ChatController } from '../agent/chatcontroller.js';
import { DEEPSEEK_MODELS } from '../agent/deepseek.js';
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

export class ChatSettings {
    // What the user changed, for the window to remember in its settings.
    onModelChanged: (model: string) => void = () => {};
    onThinkingChanged: (thinking: boolean) => void = () => {};
    onSaveChanged: (save: boolean) => void = () => {};

    constructor(private readonly w: SettingsWidgets, private readonly controller: ChatController) {
        w.popover.connect('show', () => void this.refreshKeyStatus());
        w.saveKeyButton.connect('clicked', () => void this.saveKey());
        w.keyEntry.connect('activate', () => void this.saveKey());
        w.forgetKeyButton.connect('clicked', () => void this.forgetKey());
        w.modelDrop.set_model(Gtk.StringList.new(DEEPSEEK_MODELS));
        w.modelDrop.connect('notify::selected', () => {
            const id = DEEPSEEK_MODELS[w.modelDrop.get_selected()];
            if (!id || id === controller.model) return;
            controller.model = id;
            this.onModelChanged(id);
        });
        w.thinkingCheck.connect('toggled', () => {
            controller.session.thinking = w.thinkingCheck.active;
            this.onThinkingChanged(w.thinkingCheck.active);
        });
        w.saveCheck.active = controller.saveChats;
        w.saveCheck.connect('toggled', () => {
            controller.saveChats = w.saveCheck.active;
            this.onSaveChanged(controller.saveChats);
        });
    }

    // An old or unknown model name (e.g. from a settings version) is replaced with the default model.
    setModel(model: string): void {
        this.controller.setModel(model);
        this.w.modelDrop.set_selected(DEEPSEEK_MODELS.indexOf(this.controller.model));
    }

    setThinking(thinking: boolean): void {
        this.w.thinkingCheck.set_active(thinking);
        this.controller.session.thinking = thinking;
    }

    setSaveChats(save: boolean): void {
        this.w.saveCheck.set_active(save);
        this.controller.saveChats = save;
    }

    private async refreshKeyStatus(): Promise<void> {
        const found = await this.controller.keyStore.get();
        this.w.keyStatus.set_text(found ? SOURCE_TEXT[found.source] : _('No key yet. Create one at platform.deepseek.com.'));
    }

    private async saveKey(): Promise<void> {
        const key = this.w.keyEntry.text.trim();
        if (!key) return;
        try {
            const source = await this.controller.keyStore.set(key);
            this.w.keyEntry.set_text('');
            this.w.keyStatus.set_text(SOURCE_TEXT[source]);
        } catch (e) {
            this.w.keyStatus.set_text(fmt(_('Failed to save: {error}'), { error: e instanceof Error ? e.message : String(e) }));
        }
    }

    private async forgetKey(): Promise<void> {
        await this.controller.keyStore.clear();
        await this.refreshKeyStatus();
    }
}
